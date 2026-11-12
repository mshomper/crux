// A passkey made with node:crypto, for the write-guard tests (decision 47): a real ES256 (or RS256) key that answers
// the hub's registration and step-up challenges exactly as a browser would hand them over.
import { generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';

const b64 = buf => Buffer.from(buf).toString('base64url');
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
export const UP = 0x01, UV = 0x04;

export class FakePasskey {
  constructor({ alg = -7 } = {}) {
    this.alg = alg;
    const kp = alg === -7 ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = kp.privateKey;
    this.spki = kp.publicKey.export({ format: 'der', type: 'spki' });
    this.rawId = randomBytes(16);
    this.count = 0;
  }
  get id() { return b64(this.rawId); }
  authData(rpId, { flags = UP | UV, at = false, count = this.count } = {}) {
    const parts = [createHash('sha256').update(rpId).digest(), Buffer.from([flags | (at ? 0x40 : 0)]), u32(count)];
    // aaguid, credential id length, credential id, then the COSE key (CBOR), which the hub does not read
    if (at) parts.push(Buffer.alloc(16), u16(this.rawId.length), this.rawId, Buffer.from([0xa0]));
    return Buffer.concat(parts);
  }
  // What the page sends to /api/pair/finish.
  register({ challenge, origin, rpId, flags, type = 'webauthn.create' }) {
    const cd = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    return { id: this.id, rawId: this.id, type: 'public-key', clientDataJSON: b64(cd), authenticatorData: b64(this.authData(rpId, { flags, at: true })), publicKey: b64(this.spki), publicKeyAlgorithm: this.alg, transports: ['internal'] };
  }
  // What the page sends as stepUp.
  assert({ challenge, origin, rpId, flags, type = 'webauthn.get' }) {
    this.count++;
    const cd = Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
    const ad = this.authData(rpId, { flags });
    const data = Buffer.concat([ad, createHash('sha256').update(cd).digest()]);
    const signature = this.alg === -7 ? sign('sha256', data, { key: this.privateKey, dsaEncoding: 'der' }) : sign('sha256', data, this.privateKey);
    return { id: this.id, clientDataJSON: b64(cd), authenticatorData: b64(ad), signature: b64(signature) };
  }
}
