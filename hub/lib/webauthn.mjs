// Passkey checks for the write guard (decision 47 B), with node:crypto only: no CBOR or WebAuthn library.
// The browser hands over the new passkey's public key as SPKI (AuthenticatorAttestationResponse.getPublicKey()),
// which node:crypto reads directly, and the authenticator data as raw bytes (getAuthenticatorData()), whose fixed
// layout needs no CBOR up to the credential id. Two algorithms: ES256 (-7, P-256) and RS256 (-257).
//
// No attestation is checked ('none'): nothing proves a key lives in Windows Hello or Face ID rather than in a script.
// So a registration is only as good as what let it happen (the pairing code from the hub's own window, or a step-up
// from a device already paired). After that, every assertion is checked in full: the hub's own challenge, the page's
// exact origin (port included), the address the passkey belongs to, user presence and user verification flags, and
// the signature over authenticator data + SHA-256(clientDataJSON).
import { createHash, createPublicKey, verify as cryptoVerify, constants } from 'node:crypto';

export const ES256 = -7, RS256 = -257;
export const ALGS = [ES256, RS256];
const FLAG_UP = 0x01, FLAG_UV = 0x04, FLAG_AT = 0x40;

export const b64u = buf => Buffer.from(buf).toString('base64url');
export const unb64u = s => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*={0,2}$/.test(s)) throw new Error('Not base64url');
  return Buffer.from(s, 'base64url');
};
export const sha256 = (...parts) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return h.digest(); };

// rpIdHash (32) | flags (1) | signCount (4, big-endian) | [attested credential data when AT: aaguid (16) |
// credentialIdLength (2) | credentialId | COSE public key (CBOR, not read here)] | [extensions].
export function parseAuthData(buf) {
  const b = Buffer.from(buf);
  if (b.length < 37) throw new Error('Authenticator data is too short');
  const out = { rpIdHash: b.subarray(0, 32), flags: b[32], signCount: b.readUInt32BE(33) };
  out.up = !!(out.flags & FLAG_UP); out.uv = !!(out.flags & FLAG_UV); out.at = !!(out.flags & FLAG_AT);
  if (out.at) {
    if (b.length < 55) throw new Error('Authenticator data has no room for a credential');
    const len = b.readUInt16BE(53);
    if (b.length < 55 + len) throw new Error('Authenticator data is cut short');
    out.credentialId = b.subarray(55, 55 + len);
  }
  return out;
}

function clientData(json, type, challenge, origin) {
  let cd;
  try { cd = JSON.parse(Buffer.from(json).toString('utf8')); } catch { throw new Error('Client data is not JSON'); }
  if (cd.type !== type) throw new Error(`Client data is for ${cd.type || 'nothing'}, not ${type}`);
  if (typeof cd.challenge !== 'string' || cd.challenge.replace(/=+$/, '') !== String(challenge).replace(/=+$/, '')) throw new Error('Not the challenge the hub issued');
  if (cd.origin !== origin) throw new Error(`Made on ${cd.origin}, not on ${origin}`);
  if (cd.crossOrigin === true) throw new Error('Made inside another site\'s frame');
  return cd;
}

// The challenge a clientDataJSON names, read before anything is trusted (to find the hub's record of it).
export function challengeOf(clientDataB64) {
  try { const cd = JSON.parse(unb64u(clientDataB64).toString('utf8')); return typeof cd.challenge === 'string' ? cd.challenge.replace(/=+$/, '') : null; } catch { return null; }
}

function checkAuth(ad, rpId) {
  if (!sha256(rpId).equals(ad.rpIdHash)) throw new Error(`The passkey is for another address, not ${rpId}`);
  if (!ad.up) throw new Error('No user presence');
  if (!ad.uv) throw new Error('No user verification (face, fingerprint or PIN)');
}

// The key's algorithm must be what it says: P-256 for ES256, RSA of 2048 bits or more for RS256.
export function publicKeyFor(spkiB64, alg) {
  let key;
  try { key = createPublicKey({ key: unb64u(spkiB64), format: 'der', type: 'spki' }); } catch { throw new Error('Not a public key'); }
  const d = key.asymmetricKeyDetails || {};
  if (alg === ES256 && !(key.asymmetricKeyType === 'ec' && d.namedCurve === 'prime256v1')) throw new Error('ES256 needs a P-256 key');
  if (alg === RS256 && !(key.asymmetricKeyType === 'rsa' && (d.modulusLength || 0) >= 2048)) throw new Error('RS256 needs an RSA key of 2048 bits or more');
  if (!ALGS.includes(alg)) throw new Error('Only ES256 and RS256 passkeys are accepted');
  return key;
}

// A new passkey: c = { rawId, clientDataJSON, authenticatorData, publicKey, publicKeyAlgorithm } (base64url strings,
// the algorithm a number). Returns { id, publicKey, alg, signCount }, or throws with a plain reason.
export function verifyRegistration(c, { challenge, origin, rpId }) {
  if (!c || typeof c !== 'object') throw new Error('No passkey was sent');
  const alg = Number(c.publicKeyAlgorithm);
  publicKeyFor(c.publicKey, alg);
  clientData(unb64u(c.clientDataJSON), 'webauthn.create', challenge, origin);
  const ad = parseAuthData(unb64u(c.authenticatorData));
  checkAuth(ad, rpId);
  if (!ad.at || !ad.credentialId) throw new Error('The passkey did not say its id');
  const rawId = unb64u(c.rawId);
  if (!rawId.length || rawId.length > 1023 || !ad.credentialId.equals(rawId)) throw new Error('The passkey id does not match');
  return { id: b64u(rawId), publicKey: b64u(unb64u(c.publicKey)), alg, signCount: ad.signCount };
}

// A step-up: a = { clientDataJSON, authenticatorData, signature } (base64url). cred = { publicKey, alg, signCount }.
// Returns the new signCount, or throws. As the WebAuthn spec says: once either counter is non-zero, a count that does
// not climb (0 included) points at a copied passkey. Passkeys that never count (both 0) pass.
export function verifyAssertion(a, cred, { challenge, origin, rpId }) {
  if (!a || typeof a !== 'object') throw new Error('No confirmation was sent');
  const cdBytes = unb64u(a.clientDataJSON), adBytes = unb64u(a.authenticatorData), sig = unb64u(a.signature);
  clientData(cdBytes, 'webauthn.get', challenge, origin);
  const ad = parseAuthData(adBytes);
  checkAuth(ad, rpId);
  if (!signatureOk(cred, adBytes, cdBytes, sig)) throw new Error('The signature does not check out');
  const stored = Number(cred.signCount) || 0;
  if ((ad.signCount || stored) && ad.signCount <= stored) throw new Error('The passkey counter went backwards (a copied passkey?)');
  return ad.signCount;
}

export function signatureOk(cred, adBytes, cdBytes, sig) {
  const key = publicKeyFor(cred.publicKey, Number(cred.alg));
  const data = Buffer.concat([adBytes, sha256(cdBytes)]);
  try {
    return Number(cred.alg) === ES256
      ? cryptoVerify('sha256', data, { key, dsaEncoding: 'der' }, sig)
      : cryptoVerify('sha256', data, { key, padding: constants.RSA_PKCS1_PADDING }, sig);
  } catch { return false; }
}
