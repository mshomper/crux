// Phone notifications from the hub itself (decision 19 A), sent as standard web push to the hub page that is
// installed on the phone's home screen. Each push says only what kind of card is waiting, a short title and the
// card's id. No command text and no file contents. The phone opens the hub over the tailnet to see the rest.
//
// VAPID keys and subscriptions live in ~/.crux-hub (or CRUX_HUB_DATA), never in a repo.
//
// Decision 58 A adds the desktop app as a target for the same cards and the same few words: the PC while it is in
// use, the phone as backup (see PC_IDLE_MS below). Security and restart notices (guard.mjs) stay phone-only.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { questionOpen } from '../public/questions.js';
import { HUB_THREAD } from '../public/all-projects.js';

const pad = n => String(n).padStart(4, '0');
export const QUESTION_GRACE_MS = 60 * 1000; // the orchestrator often answers a worker's question itself
const LOOK_FRESH_MS = 45 * 1000;             // a presence report older than this is stale
const LOOK_IDLE_MS = 2 * 60 * 1000;          // no clicks or keys for this long: you have walked away
// Decision 58 A: PC first, phone as backup. A card goes to the desktop app's notice while the PC is in use (input in
// the last 5 minutes, not locked); to the phone when the PC is idle, locked or asleep (no fresh report), and also to
// the phone when it is still waiting 3 minutes after a PC notice.
export const PC_IDLE_MS = 5 * 60 * 1000;
export const PHONE_FOLLOWUP_MS = 3 * 60 * 1000;
const DESK_FRESH_MS = 75 * 1000;              // the app reports every 30 s; older means asleep or gone

// Which card, if any, an event puts in front of you. `decisionOpen(id)` says whether a decision still waits.
export function cardsFor(ev, { decisionOpen = () => true } = {}) {
  const project = ev.project;
  // A request with the orchestrator (decision 21) buzzes your phone only once it comes to you: escalated or timed out.
  if ((ev.type === 'approval' && !ev.routedTo) || ev.type === 'approval_escalated') {
    return [{ kind: 'approval', card: `approval:${ev.approval}`, project, thread: ev.thread, title: `${ev.agent} is waiting for Allow`, body: `${project} · wants to use ${ev.tool}` }]; // kept minimal on purpose: it can show on a locked phone
  }
  // A project raised to Trusted (decision 45): always told, so a raise nobody made on purpose is seen at once.
  // Decision 47: with an Undo on the notification where the phone shows actions, and in the thread everywhere.
  if (ev.type === 'project_settings' && ev.permissionMode === 'trusted' && ev.raised) {
    return [{ kind: 'level', card: `level:${ev.id}`, project, thread: 'orchestrator', title: `${project} was raised to Trusted`, body: project, always: true, actions: ['undo'] }];
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
// All projects (decision 42) shows every project's waiting cards, so it counts for a card in any project.
export function isLooking(card, presences, now = Date.now()) {
  for (const p of presences) {
    const age = now - p.ts;
    if (age > LOOK_FRESH_MS || !p.visible || !p.focused) continue;
    if ((p.idleMs || 0) + age > LOOK_IDLE_MS) continue;
    if (p.thread === HUB_THREAD) return true;
    if (p.project !== card.project) continue;
    if (p.thread === 'needs' || p.thread === card.thread) return true;
  }
  return false;
}

// Is the card still waiting by the time we would send it? Questions follow the same rule as the Needs you list
// (public/questions.js): answered, dismissed, asked by an agent that has retired, or answered by your picks.
export function stillOpen(card, { approvals, decisionOpen, decisionStatus, events }) {
  if (card.kind === 'approval') return approvals.has(card.card.slice('approval:'.length));
  if (card.kind === 'decision') return decisionOpen(Number(card.card.slice('decision:'.length)));
  if (card.kind === 'question') return questionOpen(events, card.askedAt, { decisionStatus });
  if (card.kind === 'level' || card.kind === 'digest') return true;   // notices, not cards that get settled
  return false;
}

// close: notifications already sent for cards that have since been settled; the phone clears them from its lock
// screen when this push arrives (sw.js). A push of its own just to clear one is not sent: iPhone drops a device
// that receives pushes it does not show.
export function payloadOf(card, close = []) {
  const url = `/?project=${encodeURIComponent(card.project)}&card=${encodeURIComponent(card.card)}`;
  return { kind: card.kind, title: card.title, body: card.body, card: card.card, project: card.project, url, ...(card.actions ? { actions: card.actions } : {}), ...(close.length ? { close } : {}) };
}

// The card an event settles, if a notification may already be out for it.
export function settledCard(ev) {
  if (ev.type === 'approval_result') return `approval:${ev.approval}`;
  if (ev.type === 'pick') return `decision:${ev.decision}`;
  if (ev.type === 'question_dismissed' && ev.index == null) return `question:${ev.question}`;
  return null;
}

export class Push {
  constructor({ dir = process.env.CRUX_HUB_DATA || join(homedir(), '.crux-hub'), subject = process.env.CRUX_HUB_VAPID_SUBJECT || 'mailto:crux-hub@example.com', sender = null, timers = { setTimeout, clearTimeout }, log = s => console.log(`[notices] ${s}`) } = {}) {
    this.dir = dir;
    this.subject = subject;
    this.sender = sender; // web-push, loaded on first use so tests need not touch it
    this.timers = timers;
    this.log = log;             // one line per card: where it went, or why it was held (card ids only, no text)
    this.presences = new Map();
    this.sent = new Set();
    this.settled = new Set();   // cards notified about and then settled: cleared from the phone with the next push
    this.desktops = new Map();  // decision 58: desktop apps listening on this PC: client -> { write, idleMs, locked, ts }
    this.sentDesk = new Set();
    this.ctx = null;            // the hub's live state, from the latest handle() or resume()
    this.subsFile = join(dir, 'push-subscriptions.json');
    this.subs = existsSync(this.subsFile) ? safeJson(this.subsFile, []) : [];
    // PC notices whose 3-minute phone follow-up is still due: card id -> { card, due }. Kept on disk, so a hub restart
    // inside those 3 minutes does not lose the follow-up (resume() picks them up).
    this.followFile = join(dir, 'desk-followups.json');
    const saved = existsSync(this.followFile) ? safeJson(this.followFile, []) : [];
    this.follow = new Map((Array.isArray(saved) ? saved : []).filter(f => f?.card?.card && Number.isFinite(f.due)).map(f => [f.card.card, f]));
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

  // The push devices as the Devices panel lists them: a short id from the endpoint, never the endpoint itself.
  list() { return this.subs.map(s => ({ id: pushId(s.endpoint), label: s.label || 'A device', added: s.added || '' })); }
  byId(id) { return this.subs.find(s => pushId(s.endpoint) === String(id || '')) || null; }

  presence(client, info, now = Date.now()) {
    if (!client) return;
    if (info.gone) { this.presences.delete(client); return; }
    this.presences.set(client, { project: info.project, thread: info.thread, visible: !!info.visible, focused: !!info.focused, idleMs: Number(info.idleMs) || 0, ts: now });
    for (const [k, p] of this.presences) if (now - p.ts > 10 * 60 * 1000) this.presences.delete(k);
    this.onPresence?.();
  }

  // Decision 60 A: are you here at all? The PC in use (decision 58's rule), or a hub page open and showing, on any
  // device, with input in the last 5 minutes. Otherwise you are away: idle 5+ minutes, locked or asleep, the app not
  // connected, and no open page.
  present(now = Date.now()) {
    if (this.pcInUse(now)) return true;
    for (const p of this.presences.values()) {
      const age = now - p.ts;
      if (age <= LOOK_FRESH_MS && p.visible && (p.idleMs || 0) + age < PC_IDLE_MS) return true;
    }
    return false;
  }

  // Decision 60 A: one notice for the Conductor's digest after 30 minutes away, in place of one per card. It opens the
  // digest in All projects. info: { id (the digest event), count, projects }.
  digest(info, ctx = this.ctx) {
    const n = info.count, m = info.projects;
    const card = { kind: 'digest', card: `digest:${info.id}`, project: '~conductor', thread: HUB_THREAD,
      title: `${n} card${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you`, body: `The Conductor's digest · ${m} project${m === 1 ? '' : 's'}` };
    this.route(card, ctx);
  }

  // ---------- decision 58: the desktop app on this PC ----------
  // The app holds a stream open (GET /api/desktop/stream, this PC only) and reports every 30 s how long since the
  // PC last had keyboard or mouse input, and whether it is locked.
  // Attach returns the listener; detach takes it back, so a late close of an earlier stream with the same client id
  // never removes the newer, live one.
  desktopAttach(client, write) {
    if (!client) return null;
    const d = { write, idleMs: 0, locked: false, notices: true, ts: 0 };
    this.desktops.set(client, d);
    return d;
  }
  desktopDetach(client, d) { if (this.desktops.get(client) === d) this.desktops.delete(client); }
  // The app could not show a notice (Windows refused it): the phone gets the card now instead of 3 minutes later.
  desktopFailed(cardId) {
    if (!this.follow.has(cardId)) return false;
    this.log(`${cardId}: the PC could not show its notice, so the phone now`);
    this.followUp(cardId);
    return true;
  }
  // notices: whether Windows lets the app show notices (its master switch and the app's own switch in Settings).
  desktopPresence(client, { idleMs = 0, locked = false, notices = true } = {}, now = Date.now()) {
    const d = this.desktops.get(client);
    if (d) Object.assign(d, { idleMs: Math.max(0, Number(idleMs) || 0), locked: !!locked, notices: notices !== false, ts: now });
    if (d) this.onPresence?.();
    return !!d;
  }
  // The PC is in use and can show a notice: a desktop app reported recently, the PC is not locked, there was input
  // in the last 5 min, and Windows notices are on. Otherwise the phone gets the card at once.
  pcInUse(now = Date.now()) {
    for (const d of this.desktops.values()) {
      const age = now - d.ts;
      if (d.ts && age <= DESK_FRESH_MS && !d.locked && d.notices && d.idleMs + age < PC_IDLE_MS) return true;
    }
    return false;
  }
  // Somewhere a PC notice can show at all (used when no phone is set up).
  desktopCanShow() { for (const d of this.desktops.values()) if (d.notices) return true; return false; }
  toDesktops(event, data) {
    for (const [client, d] of this.desktops) { try { d.write(event, data); } catch { this.desktops.delete(client); } }
  }

  // Called for every logged hub event. `ctx` gives the live state: approvals, decisionOpen(project, id),
  // decisionStatus(project, id) and events(project).
  handle(ev, ctx) {
    this.ctx = ctx;
    const done = settledCard(ev);
    if (done && this.sent.has(done)) { this.settled.add(done); if (this.settled.size > 50) this.settled.delete(this.settled.values().next().value); }
    if (done && this.sentDesk.has(done)) { this.toDesktops('clear', { card: done }); this.unfollow(done); }   // the app takes the notice down
    if (!this.subs.length && !this.desktops.size) return;
    for (const card of cardsFor(ev, { decisionOpen: id => ctx.decisionOpen(ev.project, id) })) {
      if (this.sent.has(card.card) || this.sentDesk.has(card.card)) continue;
      const go = () => this.route(card, ctx);
      card.delayMs ? this.timers.setTimeout(go, card.delayMs) : go();
    }
  }

  // Does the card still wait for you (answered, picked, settled elsewhere)?
  open(card, ctx) {
    if (card.kind === 'digest') return true;   // a notice of its own; its cards are checked when it is drawn
    return stillOpen(card, { approvals: ctx.approvals, decisionOpen: id => ctx.decisionOpen(card.project, id), decisionStatus: id => ctx.decisionStatus?.(card.project, id), events: ctx.events(card.project) });
  }

  // Where one card goes, once its grace (if any) is over.
  route(card, ctx) {
    if (this.sent.has(card.card) || this.sentDesk.has(card.card)) return;
    const id = `${card.card} (${card.project})`;
    if (!this.open(card, ctx)) return this.log(`${id}: settled before it went out`);
    // Decision 60 A: while you are away and the Conductor is on, questions and decisions wait for its one digest
    // notice. Permission requests (they may need you now) and raises to Trusted still go at once.
    if ((card.kind === 'question' || card.kind === 'decision') && this.holdForDigest?.()) return this.log(`${id}: held for the Conductor's digest (you are away)`);
    const looking = isLooking(card, this.presences.values());
    // Decision 58 A: the PC while it is in use (or when no phone is set up).
    const desk = this.desktops.size > 0 && (this.pcInUse() || (!this.subs.length && this.desktopCanShow()));
    // Decision 45: a raise to Trusted reaches the phone at once, always, even while you look at it; the PC as well
    // while you are at it and not already looking. No follow-up: the phone already has it.
    if (card.always) {
      this.toPhone(card);
      if (desk && !looking) this.toDesk(card, { follow: false });
      return this.log(`${id}: phone${desk && !looking ? ' and PC' : ''} (always told)`);
    }
    if (looking) return this.log(`${id}: held, you are looking at it in an open hub page`);
    if (desk) {
      this.toDesk(card, { follow: this.subs.length > 0 });
      return this.log(`${id}: PC${this.subs.length ? ', phone in 3 minutes if it still waits' : ''}`);
    }
    this.toPhone(card);
    this.log(`${id}: phone${this.desktops.size ? ' (PC idle, locked, asleep or notices off)' : ''}`);
  }

  toDesk(card, { follow }) {
    this.sentDesk.add(card.card);
    if (this.sentDesk.size > 200) this.sentDesk.delete(this.sentDesk.values().next().value);
    this.toDesktops('notify', payloadOf(card));
    if (!follow) return;
    this.follow.set(card.card, { card, due: Date.now() + PHONE_FOLLOWUP_MS });
    this.saveFollow();
    this.timers.setTimeout(() => this.followUp(card.card), PHONE_FOLLOWUP_MS);
  }

  // The phone backup for a PC notice: the card still waits and nobody is looking at it.
  followUp(cardId) {
    const f = this.follow.get(cardId);
    if (!f) return;
    this.unfollow(cardId);
    const id = `${cardId} (${f.card.project})`;
    if (this.sent.has(cardId)) return;
    if (!this.ctx || !this.open(f.card, this.ctx)) return this.log(`${id}: settled, no phone follow-up`);
    if (isLooking(f.card, this.presences.values())) return this.log(`${id}: no phone follow-up, you are looking at it`);
    this.toPhone(f.card);
    this.log(`${id}: phone, as it still waits after the PC notice`);
  }

  unfollow(cardId) { if (this.follow.delete(cardId)) this.saveFollow(); }
  saveFollow() {
    try { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.followFile, JSON.stringify([...this.follow.values()]), { mode: 0o600 }); } catch { }
  }

  // At hub start: follow-ups still due from before a restart run at their time (at once if it has passed).
  resume(ctx, now = Date.now()) {
    this.ctx = ctx;
    for (const [cardId, f] of this.follow) {
      this.sentDesk.add(cardId);
      this.timers.setTimeout(() => this.followUp(cardId), Math.max(0, f.due - now));
    }
  }

  toPhone(card) {
    if (!this.subs.length || this.sent.has(card.card)) return;
    this.sent.add(card.card);
    const close = [...this.settled];
    this.settled.clear();
    this.send(payloadOf(card, close)).catch(e => console.warn(`Push failed: ${e.message}`));
  }

  async send(payload) {
    if (!this.subs.length) return 0;   // nothing to reach: no keys made, no library loaded
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
    if (gone) {
      const dropped = this.subs.filter(s => s.gone);
      this.subs = this.subs.filter(s => !s.gone); this.save();
      this.onDropped?.(dropped);   // decision 47: a change to the push devices is always told
    }
    return ok;
  }
}

function safeJson(file, dflt) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return dflt; } }
export const pushId = endpoint => createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 16);
