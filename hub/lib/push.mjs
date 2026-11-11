// Phone notifications from the hub itself (decision 19 A), sent as standard web push to the hub page that is
// installed on the phone's home screen. Each push says only what kind of card is waiting, a short title and the
// card's id. No command text and no file contents. The phone opens the hub over the tailnet to see the rest.
//
// VAPID keys and subscriptions live in ~/.crux-hub (or CRUX_HUB_DATA), never in a repo.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const pad = n => String(n).padStart(4, '0');
export const QUESTION_GRACE_MS = 60 * 1000; // the orchestrator often answers a worker's question itself
const LOOK_FRESH_MS = 45 * 1000;             // a presence report older than this is stale
const LOOK_IDLE_MS = 2 * 60 * 1000;          // no clicks or keys for this long: you have walked away

// Which card, if any, an event puts in front of you. `decisionOpen(id)` says whether a decision still waits.
export function cardsFor(ev, { decisionOpen = () => true } = {}) {
  const project = ev.project;
  if (ev.type === 'approval') {
    return [{ kind: 'approval', card: `approval:${ev.approval}`, project, thread: ev.thread, title: `${ev.agent} is waiting for Allow`, body: `${project} · wants to use ${ev.tool}` }]; // kept minimal on purpose: it can show on a locked phone
  }
  if (ev.type !== 'summary') return [];
  const out = [];
  for (const n of ev.decisions_needed || []) {
    const id = Number(n);
    if (!Number.isFinite(id) || !decisionOpen(id)) continue;
    out.push({ kind: 'decision', card: `decision:${id}`, project, thread: 'needs', title: `Decision D${pad(id)} is ready to pick`, body: project });
  }
  if (ev.questions?.length) {
    out.push({ kind: 'question', card: `question:${ev.id}`, project, thread: ev.thread, title: `${ev.from} has a question`, body: project, delayMs: QUESTION_GRACE_MS, asker: ev.from, askedAt: ev.id });
  }
  return out;
}

// Is someone already looking at this card in an open hub page? Pages report where they are and how long since
// the last click or key; a focused page with recent input that shows the card's thread (or Needs you) counts.
export function isLooking(card, presences, now = Date.now()) {
  for (const p of presences) {
    const age = now - p.ts;
    if (age > LOOK_FRESH_MS || !p.visible || !p.focused) continue;
    if ((p.idleMs || 0) + age > LOOK_IDLE_MS) continue;
    if (p.project !== card.project) continue;
    if (p.thread === 'needs' || p.thread === card.thread) return true;
  }
  return false;
}

// Is the card still waiting by the time we would send it?
export function stillOpen(card, { approvals, decisionOpen, events }) {
  if (card.kind === 'approval') return approvals.has(card.card.slice('approval:'.length));
  if (card.kind === 'decision') return decisionOpen(Number(card.card.slice('decision:'.length)));
  if (card.kind === 'question') {
    const i = events.findIndex(e => e.id === card.askedAt);
    if (i < 0) return false;
    return !events.slice(i + 1).some(e => e.thread === card.thread && e.type === 'message' && e.from !== card.asker);
  }
  return false;
}

export function payloadOf(card) {
  const url = `/?project=${encodeURIComponent(card.project)}&card=${encodeURIComponent(card.card)}`;
  return { kind: card.kind, title: card.title, body: card.body, card: card.card, project: card.project, url };
}

export class Push {
  constructor({ dir = process.env.CRUX_HUB_DATA || join(homedir(), '.crux-hub'), subject = process.env.CRUX_HUB_VAPID_SUBJECT || 'mailto:crux-hub@example.com', sender = null, timers = { setTimeout, clearTimeout } } = {}) {
    this.dir = dir;
    this.subject = subject;
    this.sender = sender; // web-push, loaded on first use so tests need not touch it
    this.timers = timers;
    this.presences = new Map();
    this.sent = new Set();
    this.subsFile = join(dir, 'push-subscriptions.json');
    this.subs = existsSync(this.subsFile) ? safeJson(this.subsFile, []) : [];
  }

  async lib() {
    if (!this.sender) this.sender = (await import('web-push')).default;
    return this.sender;
  }

  // Generated on this machine the first time, then reused. The private key never leaves ~/.crux-hub.
  async keys() {
    if (this._keys) return this._keys;
    const file = join(this.dir, 'vapid.json');
    let k = existsSync(file) ? safeJson(file, null) : null;
    if (!k?.publicKey || !k?.privateKey) {
      k = (await this.lib()).generateVAPIDKeys();
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, JSON.stringify(k, null, 2), { mode: 0o600 });
    }
    return (this._keys = k);
  }

  save() { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.subsFile, JSON.stringify(this.subs, null, 2), { mode: 0o600 }); }

  subscribe(sub, label = '') {
    if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Not a push subscription');
    this.subs = this.subs.filter(s => s.endpoint !== sub.endpoint);
    this.subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, label: String(label).slice(0, 60), added: new Date().toISOString() });
    this.save();
    return this.subs.length;
  }

  unsubscribe(endpoint) {
    const n = this.subs.length;
    this.subs = this.subs.filter(s => s.endpoint !== endpoint);
    if (this.subs.length !== n) this.save();
    return n - this.subs.length;
  }

  has(endpoint) { return this.subs.some(s => s.endpoint === endpoint); }

  presence(client, info, now = Date.now()) {
    if (!client) return;
    if (info.gone) return void this.presences.delete(client);
    this.presences.set(client, { project: info.project, thread: info.thread, visible: !!info.visible, focused: !!info.focused, idleMs: Number(info.idleMs) || 0, ts: now });
    for (const [k, p] of this.presences) if (now - p.ts > 10 * 60 * 1000) this.presences.delete(k);
  }

  // Called for every logged hub event. `ctx` gives the live state: approvals, decisionOpen(project, id), events(project).
  handle(ev, ctx) {
    if (!this.subs.length) return;
    const decisionOpen = id => ctx.decisionOpen(ev.project, id);
    for (const card of cardsFor(ev, { decisionOpen })) {
      if (this.sent.has(card.card)) continue;
      const go = () => {
        if (this.sent.has(card.card)) return;
        if (!stillOpen(card, { approvals: ctx.approvals, decisionOpen, events: ctx.events(ev.project) })) return;
        if (isLooking(card, this.presences.values())) return;
        this.sent.add(card.card);
        this.send(payloadOf(card)).catch(e => console.warn(`Push failed: ${e.message}`));
      };
      card.delayMs ? this.timers.setTimeout(go, card.delayMs) : go();
    }
  }

  async send(payload) {
    const lib = await this.lib();
    const k = await this.keys();
    const opts = { TTL: 6 * 3600, urgency: 'high', vapidDetails: { subject: this.subject, publicKey: k.publicKey, privateKey: k.privateKey } };
    let gone = false, ok = 0;
    await Promise.all(this.subs.map(async s => {
      try { await lib.sendNotification(s, JSON.stringify(payload), opts); ok++; }
      catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { s.gone = true; gone = true; } // the phone dropped it
        else console.warn(`Push to ${s.label || 'a device'} failed: ${e.statusCode || ''} ${e.body || e.message}`);
      }
    }));
    if (gone) { this.subs = this.subs.filter(s => !s.gone); this.save(); }
    return ok;
  }
}

function safeJson(file, dflt) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return dflt; } }
