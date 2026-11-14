// The Conductor (decision 55 A): one hub-wide agent above the project orchestrators. It reads every project and routes
// requests to orchestrators. It is woken on demand: by your message, by a project's summary or a new card for you
// (batched, so a busy project does not wake it for every event), or by a reminder it set. It follows the orchestrator's
// retire-at-threshold, handoff and idle-handoff rules (decisions 10, 16, 37).
//
// Its log, board (handoffs only) and attachments live in the hub's own state folder (<data>/conductor, next to
// settings.json), never in a project. In the page it is the thread at the top of All projects (decision 42).
//
// Its authority is small on purpose, and the hub enforces it, not only the prompt: no built-in tools at all (no file
// reads or edits, no Bash or PowerShell, no subagents, no web), no settings, plugins or MCP servers from disk, and a
// permission callback that refuses anything but its own board tools. Its board tools only read projects; the one
// that writes into a project, message_agent, reaches that project's orchestrator and never a worker.
import { resolve, join } from 'node:path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { EventLog } from './events.mjs';
import { Board } from './board.mjs';
import { Attachments } from './attachments.mjs';
import { conductorPrompt, RESUME_MESSAGE } from './prompts.mjs';
import { waiting as waitingFor, pendingLessons } from '../public/all-projects.js';
import { openQuestions as openAsked } from '../public/questions.js';   // on events (the all-projects one takes a project)
import { CONNECTOR_SERVERS } from './permission-rules.mjs';
import { liftSpoken, sentences } from './voice-speech.mjs';

export const CONDUCTOR = '~conductor';          // its place name in URLs and live events; never a project folder's name
export const CONDUCTOR_THREAD = 'conductor';
export const CONDUCTOR_ROLE = 'conductor';
export const WAKE_MS = 2 * 60 * 1000;           // updates within this long of the first one wake it once
export const DIGEST_MS = 30 * 60 * 1000;         // decision 60 A: while you are away, one digest at most this often
export const MAX_AUTO_WAKES = 6;                 // automatic wakes (projects' updates) an hour at most
const HOUR_MS = 60 * 60 * 1000;
const REMINDER_CHECK_MS = 60 * 1000;
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;
const EVENTS_SHOWN = 400;                        // the page gets this many of its latest events
const REMINDER_MAX_DAYS = 400;
// Decision 61 A: in front of a message {{who}} said by voice. The hub has already snapped near-miss project and agent
// names to known ones; {{who}} sees the message with a mic mark and corrects it after if it was misheard (R011).
export const VOICE_NOTE = '[Hub: {{who}} said this by voice and the hub transcribed it. A word, name or number may be misheard: if it reads oddly, go by what {{who}} most likely meant, and ask when it matters. Begin the message that answers it with one line "Spoken: " and 1-3 short plain sentences to read aloud; then reply as usual.]';
// A spoken message's answer is read aloud only if it comes within this long.
export const VOICE_TURN_MS = 10 * 60 * 1000;

// Its board tools, by name. These and nothing else: the permission callback refuses every other tool.
export const CONDUCTOR_TOOLS = ['hub_overview', 'needs_you', 'board_index', 'board_read', 'latest_handoff', 'list_agents',
  'message_agent', 'plan_usage', 'profile_read', 'post_summary', 'propose_lesson', 'post_visual',
  'set_reminder', 'list_reminders', 'clear_reminder', 'write_handoff', 'stay_quiet', 'note_cards'];
// Tools that end its turn as soon as they succeed, with no text after them (Claude Code's CLAUDE_CODE_TERMINAL_MCP_TOOLS).
// Without this, a turn that ends with no text gets Claude Code's own follow-up, "Your previous response had no visible
// output. Please continue and produce a user-visible response", and the Conductor learned to write a needless line
// every time (Matt, 0.19.5: "nothing is waiting in crux"). stay_quiet does nothing else: it adds no authority.
// note_cards is not one: its notes may ride in front of your message or a due reminder, which it must still answer.
export const CONDUCTOR_QUIET_TOOLS = ['post_summary', 'stay_quiet'].map(n => `mcp__crux__${n}`);
// Claude Code's follow-up after a turn with no text (seen as a synthetic user message in the SDK stream).
export const isNoOutputNudge = m => m?.type === 'user' && !!m.isSynthetic
  && /^\[Your previous response had no visible output\b/.test([].concat(m.message?.content ?? []).map(b => typeof b === 'string' ? b : b?.text || '').join(''));
// Named as well as switched off (tools: []), so a later SDK default can never hand them back.
export const CONDUCTOR_DENIED = ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'Skill', 'SlashCommand',
  'TodoWrite', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree'];
export const conductorToolNames = agent => [...CONDUCTOR_TOOLS, ...(agent?.predecessor ? ['ask_predecessor'] : [])].map(n => `mcp__crux__${n}`);

// The Conductor's place: shaped like a project where the hub's shared code (agents, handoffs, notices) needs it,
// but it holds no repo, no decisions and no workers.
export class ConductorHome {
  constructor(dir) {
    this.dir = resolve(dir);
    this.name = CONDUCTOR;
    this.hubWide = true;
    this.log = new EventLog(this.dir);
    this.board = new Board(this.dir, this.log);
    this.attachments = new Attachments(this.dir);
    this.agents = new Map();
    this.generation = 0;
    this.desk = { usable: () => false, ready: () => false, commitPending() { }, local: true };
  }
  workers() { return []; }
  holder() { return [...this.agents.values()].find(a => a.role === CONDUCTOR_ROLE && a.state !== 'retired' && a.retiring !== 'overlap') || null; }
  orchestrator() { return this.holder(); }   // the hub's role code (retire, idle handoff) asks for "the holder" by this name
}

const when = ts => new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });

export class Conductor {
  constructor(hub, dir, { wakeMs = WAKE_MS } = {}) {
    this.hub = hub;
    this.home = new ConductorHome(dir);
    this.wakeMs = wakeMs;
    this.maxAutoWakes = MAX_AUTO_WAKES;
    this.digestMs = DIGEST_MS;
    // Lines waiting for the next wake: { line, cause, ts } or { line, reminder }. Update lines are logged as they come
    // (wake_pending), so a restart keeps them; due reminders are found again from the log, since they are marked done
    // only once delivered.
    this.pending = this.restorePending();
    this.timer = null;
    this.digestTimer = null;   // set while you are away and cards are held for one digest (decision 60 A)
    this.owed = [];            // cards events posted while it worked: it adds its notes at the end of its turn
    this.activity = '';
    this.off = hub.on(ev => this.heard(ev));
    this.reminderTimer = setInterval(() => this.dueReminders(), REMINDER_CHECK_MS);
    this.reminderTimer.unref?.();
    if (this.pending.length && this.wakesOn()) this.arm(this.wakeMs);
  }

  // The card lines not yet handed over: those after the last event that took them (a wake that carried them, your
  // message they rode along with, a cards post, or a skip). A reminder-only wake leaves held lines where they are.
  restorePending() {
    const evs = this.home.log.events;
    const from = evs.findLastIndex(e => (e.type === 'wake' && !e.noLines) || e.type === 'wake_taken' || e.type === 'cards');
    return evs.slice(from + 1).filter(e => e.type === 'wake_pending').map(e => ({ line: e.line, cause: e.cause || null, ts: Date.parse(e.ts) || Date.now() }));
  }

  stop() { this.off?.(); clearTimeout(this.timer); clearTimeout(this.digestTimer); clearInterval(this.reminderTimer); }
  holder() { return this.home.holder(); }

  // The holder, started if none: a fresh one reads the latest Conductor handoff. Model and effort come from hub.json's
  // defaults.conductor, else the orchestrator's; never an agent type (types carry tools it must not have).
  ensure() {
    const cur = this.holder();
    if (cur) return cur;
    const a = this.hub.createAgent(this.home, { role: CONDUCTOR_ROLE, settings: { type: null } });
    this.hub.notice(this.home, CONDUCTOR_THREAD, `${a.name} holds the Conductor role${this.home.board.latestHandoff(CONDUCTOR_ROLE) ? ', starting from the latest handoff' : ''}.`);
    return a;
  }

  // ---------- messages ----------
  // Yours, at once. Cards waiting for a batched wake (or held while you were away) go up first, above your message,
  // and its notes on them ride along in front of your message.
  // extra: more fields for the message event (answers: the Conductor's questions it answers, from its question card).
  fromYou(text, attachments = [], extra = {}) {
    this.prune();   // settled cards do not ride along with your message either
    const held = this.pending.filter(x => !x.reminder);
    let cards = null;
    if (held.length) {
      const digest = this.digestTimer || held.some(x => x.away) ? 'return' : null;
      this.unhold();
      this.pending = this.pending.filter(x => x.reminder);
      cards = this.postCards(held, { digest });
    }
    this.home.log.append('message', { thread: CONDUCTOR_THREAD, from: 'you', text, ...extra, ...(attachments.length ? { attachments } : {}) });
    const a = this.ensure();
    if (cards) a.noteForNextTurn(this.notesRequest(cards, 'message'));
    // Voice (decision 61 A): a spoken message was transcribed, so a name or number in it may be off; its answer is
    // read aloud on the page that sent it (expectVoice). A turn already running when it came is not its answer.
    if (extra.voice) {
      a.noteForNextTurn(VOICE_NOTE);
      this.voiceTurn = { client: this.voiceClient || '', at: Date.now(), busy: ['working', 'starting'].includes(a.state), last: null };
      this.voiceClient = '';
    }
    a.send(text, attachments);
  }

  // ---------- voice (decision 61 A): reading the answer to a spoken message aloud ----------
  // The page that sends the next spoken message; only it plays the answer.
  expectVoice(client) { this.voiceClient = String(client || '').slice(0, 64); }
  // A message the Conductor wrote, before it is logged: during a voice turn its Spoken line comes off. Returns the
  // text to log and the spoken words, or null outside a voice turn.
  // A Spoken line comes off any reply logged after the spoken message, even one from a turn that was already running:
  // Claude Code may take a message sent mid-turn into that turn, and the note asking for the line rides with it.
  voiceSaid(text) {
    const t = this.voiceTurn;
    if (!t) return null;
    if (Date.now() - t.at > VOICE_TURN_MS) { this.voiceTurn = null; return null; }
    return liftSpoken(text);
  }
  // After it is logged (ev, or null when the message was only the Spoken line): the words go up to be read. Without
  // one, a reply from a turn that started after the spoken message is kept for the end-of-turn fallback; a reply from
  // the turn already running is never read (it only shows that turn took the message in).
  voiceLogged(ev, { spoken }) {
    const t = this.voiceTurn;
    if (!t) return;
    if (spoken) { this.voiceTurn = null; this.say(ev?.id || null, sentences(spoken), t.client, 'spoken'); }
    else if (t.busy) t.sawInBusy = true;
    else if (ev) t.last = { id: ev.id, text: ev.text };
  }
  // The end of a turn. The turn that was running when you spoke: if it replied after your message, it took the message
  // in and gave no Spoken line, so nothing is read; if it did not, the next turn is the answer. Any other turn with no
  // Spoken line has its last reply's first sentences read. Past 10 minutes nothing is read.
  voiceTurnEnded() {
    const t = this.voiceTurn;
    if (!t) return;
    if (Date.now() - t.at > VOICE_TURN_MS) { this.voiceTurn = null; return; }
    if (t.busy) {
      if (t.sawInBusy) this.voiceTurn = null;
      else { t.busy = false; t.last = null; }
      return;
    }
    this.voiceTurn = null;
    const s = t.last ? sentences(t.last.text) : [];
    if (s.length) this.say(t.last.id, s, t.client, 'first sentences');
  }
  // One event per answer read aloud: its sentences (text only; the sound is made in memory and never kept).
  say(of, list, client, from) {
    if (!list.length) return;
    this.home.log.append('voice_say', { thread: CONDUCTOR_THREAD, of, sentences: list, client, from });
  }

  // message_agent: to a project's orchestrator only (never a worker). Logged in that project's orchestrator thread
  // (marked conductor, so it never counts as your answer to a question), and one line in the Conductor's own thread.
  // It reaches the holder of the role, resting or not; it never starts one (decision 55 A: no starting orchestrators).
  toOrchestrator(projectName, from, msg) {
    const p = this.project(projectName);
    msg = String(msg || '').trim();
    if (!msg) return 'Write the message first.';
    const orch = p.orchestrator();
    if (!orch) return `${p.name} has no orchestrator running, and the Conductor cannot start one. Nothing was sent. Tell {{who}}: an orchestrator starts when {{who}} writes in ${p.name}'s orchestrator thread.`;
    p.log.append('message', { thread: 'orchestrator', from, text: msg, conductor: true });
    this.hub.notice(this.home, CONDUCTOR_THREAD, `${from} sent a brief to ${p.name}'s orchestrator.`);
    orch.send(`[From the Conductor, ${from}, on {{who}}'s side]\n${msg}`);
    return `Sent to ${p.name}'s orchestrator.`;
  }

  project(name) {
    const p = this.hub.projects.get(String(name || '').trim());
    if (!p) throw new Error(`No project called "${name}". Projects: ${[...this.hub.projects.keys()].join(', ')}.`);
    return p;
  }

  // ---------- waking on demand, batched ----------
  // A project's event that should reach the Conductor, as one line, or null. Its own place is never a trigger.
  wakeLine(ev) {
    if (!ev?.logged || ev.project === CONDUCTOR || !this.hub.projects.has(ev.project)) return null;
    const asks = n => n ? `, ${n} question${n === 1 ? '' : 's'}` : '';
    if (ev.type === 'summary') {
      const ds = (ev.decisions_needed || []).length, qs = (ev.questions || []).length;
      // Only a summary that asks something of you: routine rounds are the orchestrator's, and you see them in the
      // project. Every one that does ask you is taken, even one answering a Conductor brief (decision 60 review):
      // its card goes into the chat, or into the digest whose notice stands in for the card's own.
      if (!ds && !qs) return null;
      return `- ${ev.project}: ${ev.from} posted a round summary${asks(qs)}${ds ? `, ${ds} decision${ds === 1 ? '' : 's'} to pick` : ''}`;
    }
    if ((ev.type === 'approval' && !ev.routedTo) || ev.type === 'approval_escalated') return `- ${ev.project}: a permission card from ${ev.agent} waits for {{who}}`;
    return null;
  }

  // Is this question or decision card held for the digest? (push.mjs asks, so a notice is held only for a card the
  // Conductor really took: one source of truth.) You are away and a card line covering it waits in the queue.
  holdsCard({ project, card }) {
    if (this.present() || !this.wakesOn()) return false;
    const i = String(card || '').indexOf(':'), kind = card.slice(0, i), id = card.slice(i + 1);
    return this.pending.some(x => {
      const c = x.cause;
      if (x.reminder || !c || c.project !== project || !c.summary) return false;
      const ev = this.hub.projects.get(project)?.log.events.find(e => e.id === c.summary);
      if (kind === 'question') return c.summary === id && !!ev?.questions?.length;
      return kind === 'decision' && (ev?.decisions_needed || []).some(n => Number(n) === Number(id));
    });
  }

  // Wakes need the switch on (settings conductorWakes, on by default) and more than one project: with one, the page
  // shows no All projects column, so a Conductor working there would be out of sight.
  wakesOn() { return this.hub.settings.get('conductorWakes') !== false && this.hub.projects.size > 1 && !this.hub.noAgents; }

  // Automatic wakes (from projects' updates) in the last hour, from the log, so a restart does not reset the count.
  // Your messages and due reminders are not counted and always wake it.
  autoWakes(now = Date.now()) { return this.home.log.ofType('wake').filter(e => e.auto !== false && now - Date.parse(e.ts) < HOUR_MS); }

  heard(ev) {
    if (ev?.project === CONDUCTOR && (ev.type === 'activity' || ev.type === 'agent_state')) {
      if (ev.type === 'activity') this.activity = `${ev.agent}: ${ev.text}`;
      else if (!['working', 'starting'].includes(ev.state)) this.activity = '';
      this.hub.emit({ type: 'conductor_state', conductor: this.view({ events: false }) });
      return;
    }
    const line = this.wakeLine(ev);
    if (!line || !this.wakesOn()) return;
    this.queue(line, ev.type === 'summary' ? { project: ev.project, summary: ev.id } : { project: ev.project, approval: ev.approval });
  }

  // cause: the card behind the line ({ project, summary } or { project, approval }), checked again before the wake.
  queue(line, cause = null) {
    // away: it came while you were away, so its card notice is held (push.mjs) and only a digest's notice stands in.
    this.pending.push({ line, cause, ts: Date.now(), away: !this.present() });
    this.home.log.append('wake_pending', { line, cause });
    this.arm(this.wakeMs);
  }

  // ---------- the cards behind the lines ----------
  // Does one card still wait for you? card: "approval:<id>", "question:<summary id>" or "decision:<n>". The same rules
  // as Needs you: a permission card while it waits, a question while it is open, a decision while open or found.
  cardWaiting({ project, card }) {
    const p = this.hub.projects.get(project);
    if (!p || typeof card !== 'string') return false;
    const i = card.indexOf(':'), kind = card.slice(0, i), id = card.slice(i + 1);
    const status = n => p.board.decision(n)?.status;
    if (kind === 'approval') return this.hub.approvals.has(id);
    if (kind === 'decision') return ['open', 'found'].includes(status(Number(id)));
    if (kind === 'question') return openAsked(p.log.events, { decisionStatus: status }).some(q => q.id === id);
    return false;
  }

  // The cards a line stands for that still wait: a permission card, or a summary's question card and its decisions.
  cardsOf(item) {
    const c = item.cause;
    const p = c && this.hub.projects.get(c.project);
    if (!p) return [];
    const cands = c.approval ? [`approval:${c.approval}`]
      : [`question:${c.summary}`, ...new Set((p.log.events.find(e => e.id === c.summary)?.decisions_needed || []).map(n => `decision:${Number(n)}`))];
    return cands.map(card => ({ project: p.name, card })).filter(x => this.cardWaiting(x));
  }

  // Does the card behind this line still wait for you? A wake comes up to the batching window after the card, and you
  // often settle it first (Matt, 0.19.4: replies like "nothing is waiting, it already left your list").
  stillWaiting(item) {
    if (item.reminder || !item.cause) return true;
    return this.cardsOf(item).length > 0;
  }

  // Lines whose cards are settled leave the queue. When no card line is left, nothing wakes it: no turn, no reply. A
  // marker in the log (no thread, so nothing shows) keeps a restart from bringing the settled lines back.
  prune() {
    const before = this.pending.length;
    this.pending = this.pending.filter(x => this.stillWaiting(x));
    const skipped = before - this.pending.length;
    if (skipped && !this.pending.some(x => !x.reminder)) this.home.log.append('wake_taken', { skipped, why: 'settled before the wake' });
    return skipped;
  }

  // ---------- decision 60 A: live while you are here, one digest when you have been away ----------
  // Are you here? The hub's presence (server.mjs: push.present(), decision 58's rule: the PC in use, or an open hub page
  // with recent input). With no presence wired in (tests, an older server) you count as here.
  present() { const f = this.hub.presence; return typeof f === 'function' ? f() !== false : true; }

  // You are away: the card lines wait for one digest, due 30 minutes after the oldest held line (and never sooner than
  // 30 minutes after the last digest). Your return posts it at once (presenceReport, fromYou).
  hold(now = Date.now()) {
    if (this.digestTimer) return;
    const held = this.pending.filter(x => !x.reminder);
    if (!held.length) return;
    const oldest = Math.min(...held.map(x => x.ts || now));
    const last = this.home.log.ofType('cards').filter(e => e.digest).at(-1);
    const due = Math.max(oldest, last ? Date.parse(last.ts) : 0) + this.digestMs;
    this.digestTimer = setTimeout(() => { this.digestTimer = null; this.flush({ digest: this.present() ? 'return' : 'away' }); }, Math.max(0, due - now));
    this.digestTimer.unref?.();
  }
  unhold() { clearTimeout(this.digestTimer); this.digestTimer = null; }
  holding() { return !!this.digestTimer; }

  // The hub calls this on every presence report (a hub page, the desktop app). Back while cards are held: the digest
  // goes up now.
  // Also a card that came while you were away and is still in the batching window (not yet held): it goes up as the
  // return digest, with its one notice, never live and silent.
  presenceReport() {
    if (!this.present() || !(this.digestTimer || this.pending.some(x => x.away))) return;
    this.unhold();
    clearTimeout(this.timer); this.timer = null;
    this.flush({ digest: 'return' });
  }

  // The real cards go into its thread (one "cards" event), grouped by project in the hub's order and, within one,
  // permission cards, questions, decisions. The hub draws them answerable in place; the Conductor only adds its notes
  // (note_cards). digest: 'return' (you came back) or 'away' (30 minutes away: one phone notice for the lot).
  // Null when no card still waits (a marker then keeps a restart from bringing the lines back).
  postCards(items, { digest = null } = {}) {
    // A card already put in its chat earlier (a decision named again by a later summary) is not put there twice.
    const seen = new Set(this.home.log.ofType('cards').flatMap(e => e.items.map(c => `${c.project}|${c.card}`))), list = [];
    for (const x of items) for (const c of this.cardsOf(x)) { const k = `${c.project}|${c.card}`; if (!seen.has(k)) { seen.add(k); list.push(c); } }
    if (!list.length) { this.home.log.append('wake_taken', { skipped: items.length, why: 'settled before the cards went up' }); return null; }
    const order = [...this.hub.projects.keys()], rank = c => ['approval', 'question', 'decision'].indexOf(c.card.slice(0, c.card.indexOf(':')));
    list.sort((a, b) => order.indexOf(a.project) - order.indexOf(b.project) || rank(a) - rank(b));
    const ev = this.home.log.append('cards', { thread: CONDUCTOR_THREAD, items: list, ...(digest ? { digest } : {}) });
    // One notice per digest, away or back (push.mjs routes it: none while a page shows All projects).
    if (digest) this.hub.digestNotice?.({ id: ev.id, count: list.length, projects: new Set(list.map(c => c.project)).size, digest });
    return ev;
  }

  // The words the Conductor reads about one card, to write its note: who asks what, or the decision and its options.
  cardDetail({ project, card }) {
    const p = this.hub.projects.get(project);
    const i = card.indexOf(':'), kind = card.slice(0, i), id = card.slice(i + 1);
    if (kind === 'approval') {
      const ev = p.log.events.find(e => e.type === 'approval' && e.approval === id);
      if (!ev) return 'a permission card';
      const what = String(ev.input?.description || ev.summary?.plain || `use ${ev.tool}`).split('\n')[0].slice(0, 160);
      const cmd = String(ev.input?.command || ev.input?.file_path || '').split('\n')[0].slice(0, 120);
      return `permission: ${ev.agent} wants to ${what}${cmd ? ` (${ev.tool}: ${cmd})` : ''}${ev.stops?.length ? `; always ${'{{who}}'}'s: ${ev.stops.join('; ')}` : ''}`;
    }
    if (kind === 'question') {
      const q = openAsked(p.log.events, { decisionStatus: n => p.board.decision(n)?.status }).find(x => x.id === id);
      if (!q) return 'a question';
      return `question from ${q.from}: ${q.open.map(x => q.open.length > 1 ? `(${x.i + 1}) ${x.text}` : x.text).join(' ')}`.slice(0, 900);
    }
    const d = p.board.decision(Number(id));
    if (!d) return 'a decision';
    return `decision D${String(d.id).padStart(4, '0')} "${d.title}": ${(d.options || []).map(o => `${o.key} ${o.name}`).join('; ')}${d.recommended ? `; the record recommends ${d.recommended}` : ''}${d.lead ? `. ${d.lead}` : ''}`.slice(0, 900);
  }

  // What the Conductor is asked to write about cards it has not noted yet (still waiting ones only), or ''.
  // then: what comes after the notes. 'quiet' (a turn only for the cards: stay_quiet, no reply), 'message' (your
  // message follows: answer it), 'reminder' (a due reminder came with them: deal with it).
  notesRequest(evs, then = 'quiet') {
    evs = [].concat(evs).filter(Boolean);
    const lines = evs.flatMap(ev => ev.items.filter(it => this.cardWaiting(it)).map(it => `- ${it.project} · ${it.card} · ${this.cardDetail(it)}`));
    if (!lines.length) return '';
    const digest = evs.some(e => e.digest);
    const after = { quiet: 'Then call stay_quiet and write nothing else.', message: '{{Who}}\'s message follows: after the notes, answer it as usual.', reminder: 'After the notes, deal with the reminder as usual.' }[then];
    return `[Hub: ${digest ? 'digest after time away' : 'new cards'} for {{who}}]
These cards now show in your thread, answerable in place. {{Who}} answers them; you never do. Add your notes with one
note_cards call: per card a one-line plain summary, your recommendation, and fill (what to pre-fill: a decision's
letter, "allow" or "deny" for a permission, or the reply text for a question).${digest ? ' Add intro: one or two lines on how the projects are moving.' : ''}
Use only each card's own project's details. ${after}
${lines.join('\n')}`;
  }

  // Ask for notes in a turn of their own (an automatic wake, so within the hourly cap; past it the cards show without).
  askNotes(evs, now = Date.now()) {
    const msg = this.notesRequest(evs, 'quiet');
    if (!msg || this.autoWakes(now).length >= this.maxAutoWakes) return false;
    const a = this.ensure();
    this.home.log.append('wake', { agent: a.name, auto: true, noLines: true, cards: [].concat(evs).map(e => e.id) });
    a.send(msg);
    return true;
  }

  // note_cards: its notes on cards in its thread, each attached to the latest cards event holding that card. Only cards
  // that are there; nothing is answered.
  noteCards(agent, { intro = '', items = [] } = {}) {
    const all = this.home.log.ofType('cards');
    const clip = (s, n) => String(s ?? '').trim().slice(0, n);
    const byEv = new Map();
    for (const it of items || []) {
      const ev = all.findLast(e => e.items.some(c => c.project === it.project && c.card === it.card));
      if (!ev) continue;
      if (!byEv.has(ev.id)) byEv.set(ev.id, []);
      byEv.get(ev.id).push({ project: it.project, card: it.card, summary: clip(it.summary, 240), recommend: clip(it.recommend, 160), fill: clip(it.fill, 400) });
    }
    const last = all.at(-1);
    intro = clip(intro, 300);
    if (intro && last && !byEv.has(last.id)) byEv.set(last.id, []);
    if (!byEv.size) return 'None of those cards is in your thread, so nothing was noted.';
    for (const [of, its] of byEv) this.home.log.append('cards_note', { of, from: agent.name, items: its, ...(intro && of === last?.id ? { intro } : {}) });
    const n = [...byEv.values()].reduce((k, v) => k + v.length, 0);
    return `Noted ${n} card${n === 1 ? '' : 's'}. If this turn was only for the cards, call stay_quiet now; if {{who}}'s message or a reminder came with them, answer it.`;
  }

  arm(ms) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(0, ms));
    this.timer.unref?.();
  }

  // The due reminders waiting, as one message, marked done now (not when they fell due, so a restart before delivery
  // finds them again). The wake event shows in its thread; noLines: it hands over no card lines.
  takeReminders(extra = {}) {
    const items = this.pending.filter(x => x.reminder);
    if (!items.length) return '';
    this.pending = this.pending.filter(x => !x.reminder);
    const msg = `[Hub: updates since you last heard]\n${[...new Set(items.map(x => x.line))].join('\n')}`;
    this.home.log.append('wake', { thread: CONDUCTOR_THREAD, text: msg, auto: false, noLines: true, ...extra });
    for (const r of items) this.home.log.append('reminder_done', { thread: CONDUCTOR_THREAD, reminder: r.reminder, why: 'due' });
    return msg;
  }

  // Everything queued, once the batching window is over (decision 60 A):
  // - You are here (or a digest is due): the cards go up in its thread at once, busy or not, and the Conductor is woken
  //   to add its notes (at the end of its turn if it is working; within the hourly cap of automatic wakes).
  // - You are away: the card lines wait for one digest (hold).
  // Due reminders wake it whatever your presence (never capped); a working holder gets them at the end of its turn.
  flush({ now = Date.now(), digest = null } = {}) {
    this.prune();
    if (!this.pending.length) return false;
    const showCards = !!digest || this.present();
    const cardLines = this.pending.filter(x => !x.reminder);
    if (cardLines.length && !showCards) { for (const x of cardLines) x.away = true; this.hold(now); }
    let cards = null;
    if (cardLines.length && showCards) {
      this.unhold();
      this.pending = this.pending.filter(x => x.reminder);
      // Lines that came or were held while you were away go up as a return digest: its one notice stands in for the
      // card notices push held for them.
      cards = this.postCards(cardLines, { digest: digest || (cardLines.some(x => x.away) ? 'return' : null) });
    }
    const cur = this.holder();
    if (cur && (['working', 'starting'].includes(cur.state) || cur.retiring || cur.capture)) {
      if (cards) this.owed.push(cards);
      return !!cards;
    }
    if (this.pending.some(x => x.reminder)) {
      const a = this.ensure();
      const msg = this.takeReminders({ agent: a.name });
      a.send([cards ? this.notesRequest(cards, 'reminder') : '', msg].filter(Boolean).join('\n\n'));
      return true;
    }
    if (cards) this.askNotes(cards, now);
    return !!cards;
  }

  // The hub calls this when the Conductor goes idle (Hub.onIdle): notes owed on cards posted while it worked, a due
  // reminder at once, card lines after the window.
  afterTurn() {
    this.voiceTurnEnded();
    if (this.owed.length) this.askNotes(this.owed.splice(0));
    if (!this.pending.length) return;
    if (this.pending.some(x => x.reminder)) { clearTimeout(this.timer); this.timer = null; this.flush(); }
    else if (!this.digestTimer) this.arm(this.wakeMs);
  }

  // ---------- reminders across days ----------
  reminders() {
    const done = new Set(this.home.log.ofType('reminder_done').map(e => e.reminder));
    return this.home.log.ofType('reminder').filter(e => !done.has(e.reminder)).map(e => ({ id: e.reminder, at: e.at, text: e.text, from: e.from }));
  }
  setReminder(at, msg, from) {
    const t = Date.parse(String(at || ''));
    if (!Number.isFinite(t)) return 'Give the time as a date and time, e.g. 2026-11-20T09:00 (your local time) or with a Z for UTC.';
    if (t <= Date.now()) return 'That time has passed. Give a time in the future.';
    if (t - Date.now() > REMINDER_MAX_DAYS * 864e5) return `Reminders go up to ${REMINDER_MAX_DAYS} days ahead.`;
    msg = String(msg || '').trim().slice(0, 400);
    if (!msg) return 'Say what to remind about.';
    const id = `rem-${(this.home.log.ofType('reminder').length + 1).toString().padStart(3, '0')}`;
    this.home.log.append('reminder', { thread: CONDUCTOR_THREAD, reminder: id, at: new Date(t).toISOString(), text: msg, from });
    return `Reminder ${id} set for ${when(t)}.`;
  }
  clearReminder(id, why = 'cleared') {
    const r = this.reminders().find(x => x.id === String(id || '').trim());
    if (!r) return `No reminder ${id} waiting.`;
    this.home.log.append('reminder_done', { thread: CONDUCTOR_THREAD, reminder: r.id, why });
    return `Reminder ${r.id} cleared.`;
  }
  // Due ones wake the Conductor at once (no batching, no hourly cap): they are rare and time matters. Each is marked
  // done only once it is delivered (take); a busy Conductor gets it at the end of its turn (afterTurn).
  dueReminders(now = Date.now()) {
    const queued = new Set(this.pending.map(x => x.reminder).filter(Boolean));
    const due = this.reminders().filter(r => Date.parse(r.at) <= now && !queued.has(r.id));
    if (!due.length || this.hub.noAgents) return due.length;
    for (const r of due) this.pending.push({ line: `- Reminder ${r.id} is due (set for ${when(r.at)}): ${r.text}`, reminder: r.id });
    clearTimeout(this.timer); this.timer = null;
    this.flush({ now });
    return due.length;
  }

  // ---------- what it reads ----------
  // A project as the page sees it, for the shared Needs you rules (public/all-projects.js).
  pageProject(p) {
    return { name: p.name, events: p.log.events, board: { decisions: p.board.decisions() }, agents: [...p.agents.values()].map(a => ({ name: a.name, role: a.role, thread: a.thread, state: a.state })), permissionMode: this.hub.permissionMode(p) };
  }
  pendingIds() { return new Set([...this.hub.approvals.keys()]); }

  // What waits for you in one project, most urgent first: permission cards, questions, decisions, then lessons.
  needsYou(p) {
    const w = waitingFor(this.pageProject(p), this.pendingIds());
    const items = [
      ...w.approvals.map(e => ({ kind: 'permission', from: e.agent, what: e.summary?.plain || e.input?.description || `use ${e.tool}`, since: e.ts })),
      ...w.questions.map(q => ({ kind: 'question', from: q.from, what: q.open.map(x => x.text), since: q.ts })),
      ...w.decisions.map(d => ({ kind: 'decision', id: `D${String(d.id).padStart(4, '0')}`, what: d.title, recommended: d.recommended || null, lead: d.lead || null })),
      ...(w.lessons.length ? [{ kind: 'lessons', what: `${w.lessons.length} lesson${w.lessons.length === 1 ? '' : 's'} for the core profile` }] : [])
    ];
    return { project: p.name, count: w.count, items };
  }

  overview() {
    const pending = this.pendingIds();
    return {
      projects: [...this.hub.projects.values()].map(p => {
        const w = waitingFor(this.pageProject(p), pending), o = p.orchestrator();
        const live = [...p.agents.values()].filter(a => a.state !== 'retired');
        return {
          name: p.name, level: { standard: 'Ask', auto: 'Auto', trusted: 'Trusted' }[this.hub.permissionMode(p)],
          waiting: { total: w.count, permissions: w.approvals.length, questions: w.questions.length, decisions: w.decisions.length, lessons: w.lessons.length },
          orchestrator: o ? { name: o.name, state: o.state, context_pct: o.contextPct ?? null } : null,
          workers: live.filter(a => a.role === 'worker').length,
          working: live.filter(a => ['working', 'starting'].includes(a.state)).length
        };
      }),
      plan_usage: this.hub.usage?.view?.() || null
    };
  }

  agents(p) {
    return [...p.agents.values()].filter(a => a.state !== 'retired').map(a => ({
      name: a.name, role: a.role, state: a.state, goal: a.goal || '', context_pct: a.contextPct ?? null, runs_as: this.hub.describeSettings(a)
    }));
  }

  // profile_read for the Conductor: the core, the conventions, or a pack. Never the private section.
  profile(section) {
    const s = String(section || '').trim();
    if (s === 'private') return 'The Conductor never reads the private section.';
    if (s === 'pack') return 'Name the pack: "pack:<name>".';
    return this.hub.memory.readSection(s, '') || `Nothing in "${s}". Sections: core, conventions, ${this.hub.memory.packs().map(n => 'pack:' + n).join(', ')}.`;
  }

  // ---------- the agent's set-up ----------
  // Its query options: its own prompt, its own tools, nothing from disk, and a callback that refuses everything else.
  options(agent) {
    const m = this.hub.memory;
    const append = m.personalize(conductorPrompt({
      generation: agent.generation, handoff: this.home.board.latestHandoff(CONDUCTOR_ROLE), core: m.core(), conventions: m.conventions(),
      projects: [...this.hub.projects.keys()], reminders: this.reminders()
    }));
    const allowed = conductorToolNames(agent);
    return {
      cwd: this.home.dir,
      systemPrompt: { type: 'preset', preset: 'claude_code', append },
      settingSources: [],          // no CLAUDE.md, settings, hooks or plugins from disk
      strictMcpConfig: true,       // only the hub's own MCP server
      tools: [],                   // no built-in tools at all
      mcpServers: { crux: this.tools(agent) },
      allowedTools: allowed,
      disallowedTools: [...CONDUCTOR_DENIED, ...CONNECTOR_SERVERS],
      settings: { disableClaudeAiConnectors: true },
      env: { CLAUDE_CODE_TERMINAL_MCP_TOOLS: CONDUCTOR_QUIET_TOOLS.join(',') },   // added to the clean env at start
      permissionMode: 'default',
      canUseTool: async (toolName, input) => this.decide(toolName, input, agent),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      ...(agent.sessionId ? { resume: agent.sessionId } : {})
    };
  }

  // The permission callback: its own board tools only. Never a card for you, never the orchestrator.
  decide(toolName, input, agent) {
    if (conductorToolNames(agent).includes(toolName)) return { behavior: 'allow', updatedInput: input };
    return { behavior: 'deny', message: `The Conductor cannot use ${toolName}. It reads projects and briefs their orchestrators (message_agent); file changes, commands, agents, permissions, merges and pushes stay with the projects and with {{who}}.`.replaceAll('{{who}}', this.hub.memory.userName() || 'the user') };
  }

  tools(agent) {
    const hub = this.hub, home = this.home;
    const out = s => text(hub.memory.personalize(typeof s === 'string' ? s : JSON.stringify(s, null, 1)));
    const safe = fn => async args => { try { return out(await fn(args)); } catch (e) { return out(`Not done: ${e.message}`); } };
    const list = z.array(z.string()).optional().default([]);
    const heading = what => z.array(z.string()).min(1).describe(`${what}. Write "none" if there is nothing.`);
    const project = z.string().describe('The project\'s name, as hub_overview lists it.');
    const tools = [
      tool('hub_overview', 'Every project at a glance: what waits for {{who}} by kind, its permission level, its orchestrator\'s state and context, how many workers and how many are working; plus the plan usage meters.', {},
        safe(() => this.overview())),
      tool('needs_you', hub.memory.personalize('What waits for {{who}}, most urgent first (permission cards, questions, decisions, lessons): in one project, or in every project when none is named.'),
        { project: z.string().optional().describe('Leave out for every project.') },
        safe(({ project: name }) => name ? this.needsYou(this.project(name)) : [...hub.projects.values()].map(p => this.needsYou(p)).filter(x => x.count).sort((a, b) => b.count - a.count))),
      tool('board_index', 'One line per active item on one project\'s memory board.', { project },
        safe(({ project: name }) => this.project(name).board.index())),
      tool('board_read', 'Read one board item of one project in full: a decision (D0007 or 7) or an entry (R003, C001, M002, H001).', { project, id: z.string() },
        safe(({ project: name, id }) => this.project(name).board.read(id) || `Nothing on ${name}'s board with id ${id}.`)),
      tool('latest_handoff', 'The latest orchestrator handoff of one project, in full.', { project },
        safe(({ project: name }) => this.project(name).board.latestHandoff() || `${name} has no orchestrator handoff yet.`)),
      tool('list_agents', 'One project\'s active agents: the orchestrator and its workers, with state, goal, context % and model.', { project },
        safe(({ project: name }) => this.agents(this.project(name)))),
      tool('message_agent', 'Send a brief to one project\'s ORCHESTRATOR (never a worker): a request from {{who}}, a usage warning, or a conflict to draft a decision card for. Carry only what that project needs, never details from another project.',
        { project, text: z.string().min(1) },
        safe(({ project: name, text: msg }) => this.toOrchestrator(name, agent.name, msg))),
      tool('plan_usage', 'The plan usage meters (5-hour, 7-day, per model), as the hub\'s strip shows them; null when not available.', {},
        safe(() => hub.usage?.view?.() || null)),
      tool('profile_read', hub.memory.personalize('Re-read part of {{who}}\'s profile: "core", "conventions" (the cross-project roll-up and its conflicts) or "pack:<name>". Never the private section.'),
        { section: z.string() }, safe(({ section }) => this.profile(section))),
      tool('post_summary', hub.memory.personalize('Post your round summary to your thread, where {{who}} sees it.'),
        {
          done: list, changed: list, questions: list.describe('Questions for {{who}}, in plain words.'),
          blocked_on: list, next_step: z.string().optional().default(''),   // no decisions_needed: decisions are the projects' cards
          visuals: list.describe('Ids from post_visual.'),
          handoff_notes: z.object({ in_flight: list, promises: list, risks: list, next_steps: list }).optional().describe('Your handoff judgement as of now, a line or two per heading. The hub keeps the newest as a rolling draft.'),
          approvals: list, open_questions: list
        },
        safe(args => {
          // A summary written only because Claude Code asked for visible output is not posted (see isNoOutputNudge).
          if (agent.quietTurn) return 'Not posted: this turn had already ended quietly. Stop here.';
          hub.postSummary(home, agent, args); return 'Summary posted. Stop here and wait.';
        })),
      tool('stay_quiet', hub.memory.personalize('End this turn without writing anything to {{who}}: for a wake or update that needs nothing from you. Nothing shows in your thread.'), {},
        safe(() => { home.log.append('quiet', { agent: agent.name }); return 'Turn ended quietly.'; })),
      tool('note_cards', hub.memory.personalize('Your notes on the cards the hub put in your thread for {{who}} (decision 60): per card a one-line plain summary, your recommendation, and what to pre-fill. {{Who}} answers the card; this answers nothing.'),
        {
          intro: z.string().max(300).optional().default('').describe('For a digest: one or two lines on how the projects are moving.'),
          items: z.array(z.object({
            project: z.string(), card: z.string().describe('As the hub listed it: "question:<id>", "decision:<n>" or "approval:<id>".'),
            summary: z.string().max(240).describe('One plain line: what is being asked.'),
            recommend: z.string().max(160).describe('Your recommendation in a few words, e.g. "A, Web Mercator" or "Yes, merge it".'),
            fill: z.string().max(400).optional().default('').describe('What to pre-fill: a decision\'s letter, "allow" or "deny", or the reply text for a question.')
          })).max(40)
        },
        safe(args => this.noteCards(agent, args))),
      tool('propose_lesson', hub.memory.personalize('Record a lasting lesson about how {{who}} wants work done across projects. It waits for {{who}}\'s OK before it joins the core profile.'),
        { lesson: z.string().max(400) }, safe(({ lesson }) => hub.proposeLesson(home, agent, 'core', lesson))),
      tool('post_visual', hub.memory.personalize('Show {{who}} a picture (png, jpg, gif, webp, svg) or a small self-contained HTML page from a file the hub can read. Returns an id for post_summary visuals.'),
        { path: z.string(), caption: z.string().max(200) },
        safe(({ path, caption }) => `Posted visual ${hub.postVisual(home, agent, path, caption).visual}.`)),
      tool('set_reminder', 'Set a reminder that may run across days: the hub wakes you with it when it is due. Time as a date and time (2026-11-20T09:00, local time) or with Z for UTC.',
        { at: z.string(), text: z.string().max(400) }, safe(({ at, text: msg }) => this.setReminder(at, msg, agent.name))),
      tool('list_reminders', 'The reminders still waiting, with their ids and times.', {},
        safe(() => this.reminders().map(r => ({ id: r.id, due: when(r.at), text: r.text })))),
      tool('clear_reminder', 'Clear a waiting reminder by its id.', { id: z.string() }, safe(({ id }) => this.clearReminder(id))),
      tool('write_handoff', 'Only when told you are retiring. The hub adds the facts it knows; you write the judgement under every heading.',
        {
          in_flight: heading('What is in flight and why'), promises: heading('Promises made that are not yet kept'),
          risks: heading('Risks and things easy to miss'), next_steps: heading('What you would do next, in order'),
          promote_to_core: list
        },
        safe(args => hub.writeHandoff(home, agent, args)))
    ];
    if (agent.predecessor) tools.push(tool('ask_predecessor', 'Ask the Conductor you took over from one short question (at most three in all).',
      { question: z.string().max(500) }, safe(({ question }) => hub.askPredecessor(home, agent, question))));
    return createSdkMcpServer({ name: 'crux', version: '0.3.0', tools });
  }

  // ---------- handoffs (decision 16): the facts half ----------
  facts(agent) {
    const evs = this.home.log.events, lines = [];
    const prev = this.home.board.latestHandoff(CONDUCTOR_ROLE);
    const since = prev ? Date.parse(prev.ts) : 0;
    const mine = evs.filter(e => e.thread === CONDUCTOR_THREAD && Date.parse(e.ts) >= since);
    const yours = mine.filter(e => e.type === 'message' && e.from === 'you').slice(-12);
    lines.push(`Messages from {{who}} (${prev ? `since handoff ${prev.entryId}` : 'all so far'}, the last ${yours.length}):`);
    lines.push(...(yours.length ? yours.map(e => `- [${when(e.ts)}] ${String(e.text).slice(0, 400)}`) : ['- none']));
    const sent = mine.filter(e => e.type === 'notice' && / sent a brief to /.test(e.text)).slice(-12);
    lines.push('Briefs sent to orchestrators:', ...(sent.length ? sent.map(e => `- [${when(e.ts)}] ${e.text}`) : ['- none']));
    const rs = this.reminders();
    lines.push('Reminders still waiting:', ...(rs.length ? rs.map(r => `- ${r.id} due ${when(r.at)}: ${r.text}`) : ['- none']));
    const qs = openAsked(this.home.log.events, {});
    lines.push('Questions still waiting on {{who}}:', ...(qs.length ? qs.flatMap(q => q.open.map(x => `- ${x.text}`)) : ['- none']));
    const lessons = pendingLessons({ events: evs });
    if (lessons.length) lines.push('Profile lessons waiting for {{who}}:', ...lessons.map(e => `- ${e.text}`));
    const o = this.overview();
    lines.push('Projects now:', ...o.projects.map(p => `- ${p.name}: ${p.waiting.total} waiting for {{who}}; orchestrator ${p.orchestrator ? `${p.orchestrator.name} (${p.orchestrator.state})` : 'none'}; ${p.working} of ${p.workers} workers working`));
    return lines.join('\n');
  }

  // ---------- after a restart (M014) ----------
  // Your last message, if the Conductor never acted on it, is delivered again; a turn cut short is resumed.
  resume(now = Date.now()) {
    const evs = this.home.log.events;
    const names = new Set([...this.home.agents.values()].map(a => a.name));
    const i = evs.findLastIndex(e => e.type === 'message' && e.thread === CONDUCTOR_THREAD && e.from === 'you');
    const m = evs[i];
    if (m && now - Date.parse(m.ts) <= RESUME_WINDOW_MS && !evs.slice(i + 1).some(e => !['agent_created', 'agent_session', 'agent_busy', 'notice', 'usage', 'plan_usage'].includes(e.type) && (names.has(e.from) || names.has(e.agent)))) {
      this.hub.notice(this.home, CONDUCTOR_THREAD, 'The hub restarted before your last message reached the Conductor, so it was delivered again.');
      const a = this.ensure();
      a.send(m.text, m.attachments || []);
      return 'message';
    }
    const a = this.holder();
    const busy = a && evs.findLast(e => e.type === 'agent_busy' && e.agent === a.name);
    if (a && busy?.busy) {
      if (now - Date.parse(busy.ts) <= RESUME_WINDOW_MS) { this.hub.notice(this.home, CONDUCTOR_THREAD, `The hub restarted while ${a.name} was working; it was asked to carry on.`); a.send(RESUME_MESSAGE); return 'working'; }
      this.home.log.append('agent_busy', { agent: a.name, busy: false, stale: true }); a.busyLogged = false;
    }
    return null;
  }

  // ---------- what the page gets (/api/state "conductor", and conductor_state on the live stream) ----------
  // state: 'asleep' (no one holds the role, or resting), 'starting', 'working', 'idle', 'error'. waiting: what in its
  // thread waits on you (its open questions, and its lesson card).
  // The page shows only the latest EVENTS_SHOWN events, so what waits on you comes whole, from the full log: its open
  // questions (questions, drawn as answerable cards) and its unanswered lessons (lessons). waiting counts exactly those.
  view({ events = true } = {}) {
    const a = this.holder();
    const evs = this.home.log.events;
    const questions = openAsked(evs, {}), lessons = pendingLessons({ events: evs });
    const waiting = questions.reduce((n, q) => n + q.open.length, 0) + (lessons.length ? 1 : 0);
    return {
      place: CONDUCTOR, thread: CONDUCTOR_THREAD, role: CONDUCTOR_ROLE,
      name: a?.name || null, state: a ? a.state : 'asleep', contextPct: a?.contextPct ?? null,
      model: a?.model || null, modelSeen: a?.modelSeen || null, effort: a?.effort || null, type: null,
      live: !!a?.live, retiring: a?.retiring || false, restartPending: !!a?.restartWhenIdle,
      retireAt: this.hub.retireAtFor(this.home), activity: this.activity, waiting,
      wakes: this.wakesOn(), pendingWake: this.pending.length, questions, lessons,
      digestMinutes: Math.round(this.digestMs / 60000), held: this.holding() ? this.pending.filter(x => !x.reminder).length : 0,
      ...(events ? { events: evs.slice(-EVENTS_SHOWN), olderEvents: Math.max(0, evs.length - EVENTS_SHOWN) } : {})
    };
  }
}
