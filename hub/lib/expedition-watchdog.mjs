// The Expedition module's watchdog (spec 4.4, decisions 69 and 71, plan phase 3): the envelope the hub enforces on a
// running expedition. One ExpeditionWatchdog per hub watches every project's expeditions; each one is a Track whose state
// is rebuilt from the event log alone (expedition_started, usage, expedition_note, expedition_stopped, the pause and plan
// events), so a restart rebuilds the clock, the spend, whether the 90% note went and whether the stop was issued.
//
//   Time      wall clock from expedition_started. The user's Pause freezes this clock and nothing else.
//   Spend 1   the expedition's own spend against the dollar cap: the logged usage events (the result's figure, which wins)
//             plus an ESTIMATE for the messages since each agent's last result, counted once per message id.
//   Spend 2   the 7-day plan meter's rise since launch against the plan percent (7 points by default), re-based when the
//             window resets, absent under an API key (the meters hide there).
//   Reserve   at 90% of any of those: the Lead is told once to stop building, check claims and write up (expedition_note).
//   Stop      at 100%: expedition_stopped, then interrupt every expedition agent, wait for each result (60 s, then close()),
//             retire everyone but the Lead, and give the Lead one final message. The sequence's steps are safe to repeat, and
//             the final message is logged before it is sent, so a restart never sends the note or the final message twice.
//   Passed and no-progress stops are made by the Lead's tools (expedition_finish, expedition_loop_result) and retire no one;
//   the watchdog only keeps a no-progress check as a backstop and sees a stop already logged and does nothing.
//
// check(now) takes the clock as a parameter (the hub's own pattern: idleCheck(now), auditChecks(now)).
import { DEFAULT_ENVELOPE, ROLES } from './expedition.mjs';
import { howItRan } from './expedition-report.mjs';

export const CHECK_MS = 30 * 1000;        // the timer between messages
export const STOP_WAIT_MS = 60 * 1000;    // how long the stop waits for an interrupted agent's result before close()
export const RESERVE_AT = 0.9;            // the last 10% is held back for the report
export const HUB_STOPS = ['time', 'budget', 'Matt'];   // the reasons whose stop the watchdog carries out (passed, no-progress retire no one)

// ---------- estimates between results ----------
// ESTIMATES ONLY. Between two results an agent's spend is not known: the stream's assistant messages carry token counts
// but no dollars, and the hub keeps no price list of its own. These rates (USD per million tokens) are used to guess a
// message's cost, and every guess is thrown away and replaced by the figure in the next result (the usage event). They err
// HIGH on purpose: Opus is exact against the hub's own usage log (1216 results fit 4 / 20 / 0.20 / 8 to the cent); Sonnet
// fits the same shape within 1% (about 2 / 10 / 0.10 / 4); Haiku and Fable do not fit one set of ratios, so Haiku is
// priced as Sonnet (an upper bound for it) and Fable at twice Opus. An unknown model is priced as Fable. Measured in the
// phase 3 spike (memo M046).
export const PRICE_PER_MTOK_ESTIMATE = {
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 8 },
  sonnet: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 },
  haiku: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 4 },
  fable: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 16 }
};
export function priceFor(model) {
  const key = Object.keys(PRICE_PER_MTOK_ESTIMATE).find(k => new RegExp(k, 'i').test(String(model || '')));
  return PRICE_PER_MTOK_ESTIMATE[key || 'fable'];
}

// ESTIMATES ONLY, reconciled at each result. The stream hides an agent's thinking: a message's output_tokens count what it
// wrote, not what it thought (spike: 19 of 22 output tokens on a small message, 536 against 19 over a short Haiku run).
// Each counted message therefore adds this many output tokens on top, by the effort the agent runs at. High on purpose.
export const THINKING_ALLOWANCE_TOKENS_ESTIMATE = { low: 400, medium: 1000, high: 2000, xhigh: 4000, max: 6000 };
const thinkingAllowance = effort => THINKING_ALLOWANCE_TOKENS_ESTIMATE[effort] ?? THINKING_ALLOWANCE_TOKENS_ESTIMATE.medium;

// What one assistant message probably cost, from its usage block (input, output, cache read, cache write tokens).
export function messageCost(model, tokens, effort) {
  const p = priceFor(model);
  return (tokens.input * p.input + (tokens.output + thinkingAllowance(effort)) * p.output + tokens.cacheRead * p.cacheRead + tokens.cacheWrite * p.cacheWrite) / 1e6;
}

const num = x => (Number.isFinite(Number(x)) ? Number(x) : 0);
const at = ts => Date.parse(ts) || 0;
const usd = n => `$${n.toFixed(2)}`;
const hours = ms => `${+(ms / 3600000).toFixed(1)} h`;
// Two readings of the same plan window name the same reset time, give or take a little: a window is the same unless its
// reset time moved by more than an hour.
const SAME_WINDOW_MS = 3600 * 1000;
const sameWindow = (a, b) => !a || !b || Math.abs(at(a) - at(b)) < SAME_WINDOW_MS;
const KEEP_IDS = 400;   // message ids remembered per agent after their result, so a late repeated frame is not counted again

// ---------- one expedition ----------
class Track {
  constructor(project, started, paused) {
    this.p = project;
    this.id = started.expedition;
    this.startMs = at(started.ts);
    const env = started.envelope || {};
    this.limitMs = (num(env.hours) > 0 ? num(env.hours) : DEFAULT_ENVELOPE.hours) * 3600 * 1000;
    this.dollars = num(env.dollars) > 0 ? num(env.dollars) : null;      // null: no dollar cap set (decision 69: until the figure is confirmed)
    this.percent = num(env.percent) > 0 ? num(env.percent) : DEFAULT_ENVELOPE.percent;
    this.roles = started.roles || {};
    // started.planStart is the reading the launch saw: it can be minutes old, and null before the meters load or under an API
    // key, so it is only a record. Measure 2 counts from the first FRESH reading after the launch (a 'meter' note in the log).
    this.meter = { baseline: null, resetsAt: null, banked: 0, cur: 0 };   // this window's baseline and rise so far; the rise of windows that have reset
    this.settledUSD = 0;                  // the usage events' figures: results, which win
    this.runningTasks = new Set();        // the Lead's subagent tasks running now, from the expedition_subagent events
    this.pausedMs = 0;
    this.pausedSince = paused ? this.startMs : null;
    this.reserve = null; this.final = null; this.stopped = null;
    this.loops = [];
    this.inflight = new Map();            // agent name -> Map(message id -> estimate), what has not reached a result yet
    this.settledIds = new Map();          // agent name -> Set of ids a result already covers
    this.frameAgents = new Set();         // subagent ids whose own assistant frames reached us (else task_progress is the fallback)
    this.sequence = null;                 // the stop sequence while it runs
  }

  // One logged event of this expedition (the rebuild and the live pull are the same path).
  apply(e) {
    if (e.type === 'usage') {
      this.settledUSD += num(e.costUSD);
      this.settle(e.agent);
    } else if (e.type === 'expedition_note') {
      if (e.kind === 'final') this.final = this.final || e;
      else if (e.kind === 'meter') { if (this.meter.baseline == null && Number.isFinite(Number(e.pct))) this.setBaseline(Number(e.pct), e.resetsAt || null); }
      else if (!e.kind || e.kind === 'reserve') this.reserve = this.reserve || e;   // the end's notes (phase 5: report-ready, summary-go) are not the 90% note
    } else if (e.type === 'expedition_stopped') this.stopped = this.stopped || e;
    else if (e.type === 'expedition_loop') this.loops.push(e);
    else if (e.type === 'expedition_subagent') { if (e.phase === 'started') this.runningTasks.add(e.taskId); else this.runningTasks.delete(e.taskId); }
  }

  // A result's figure replaces everything estimated for that agent since its last one, except a gatherer's frames while that
  // gatherer is still running: it can outlive the Lead's turn, and a result that comes before it ends may not hold its spend
  // yet. Those estimates stand (high, on purpose) until the first result after the gatherer has ended.
  settle(agent) {
    const ids = this.inflight.get(agent);
    if (!ids) return;
    const done = this.settledIds.get(agent) || new Set();
    const keep = new Map();
    for (const [id, x] of ids) { if (x.taskId && this.runningTasks.has(x.taskId)) keep.set(id, x); else done.add(id); }
    while (done.size > KEEP_IDS) done.delete(done.values().next().value);
    this.settledIds.set(agent, done);
    if (keep.size) this.inflight.set(agent, keep); else this.inflight.delete(agent);
  }

  setPaused(on, tsMs) {
    if (on && this.pausedSince == null) this.pausedSince = Math.max(tsMs, this.startMs);
    else if (!on && this.pausedSince != null) { this.pausedMs += Math.max(0, tsMs - this.pausedSince); this.pausedSince = null; }
  }
  // Wall clock since the start, less the time the user held the project paused.
  activeMs(now) { return Math.max(0, now - this.startMs - this.pausedMs - (this.pausedSince != null ? Math.max(0, now - this.pausedSince) : 0)); }

  // Measure 2 (the 7-day plan meter). Readings are always percent 0 to 100 here: the usage call gives that, and a streamed
  // rate_limit event (a fraction of 1) is converted to it before the plan is stored (public/usage.js), so both sources
  // arrive as the same scale. The rise is NOT summed reading by reading (a meter that dips and recovers would count the
  // recovery again): inside one window it is the current reading minus the window's baseline. When the window resets, its
  // rise is banked and the new window starts from its first reading (what came before that first reading is not seen; the
  // guard is conservative anyway, it also counts other work in the window).
  setBaseline(pct, resetsAt) { this.meter.baseline = pct; this.meter.resetsAt = resetsAt || null; this.meter.cur = 0; }
  observePlan(w) {
    const m = this.meter;
    if (m.baseline == null || !w || !Number.isFinite(w.pct)) return;
    if (sameWindow(m.resetsAt, w.resetsAt)) { m.cur = Math.max(0, w.pct - m.baseline); if (!m.resetsAt) m.resetsAt = w.resetsAt || null; }
    else { m.banked += m.cur; this.setBaseline(w.pct, w.resetsAt); }
  }
  get risen() { return this.meter.banked + this.meter.cur; }

  // Count one assistant message of one of this expedition's agents (a subagent's frame too), once per message id. Several
  // frames of one message repeat the same usage and none is marked final, so the first sight counts and a later frame can
  // only raise a figure (the output count grows). Returns true when the total changed.
  countMessage(agent, m) {
    const msg = m.message, id = msg?.id, u = msg?.usage;
    if (!id || !u || this.settledIds.get(agent.name)?.has(id)) return false;
    const sub = !!(m.agent_id || m.parent_tool_use_id);
    if (m.agent_id) this.frameAgents.add(m.agent_id);
    const tokens = { input: num(u.input_tokens), output: num(u.output_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens) };
    const ids = this.inflight.get(agent.name) || new Map();
    const prev = ids.get(id);
    const merged = prev ? Object.fromEntries(Object.keys(tokens).map(k => [k, Math.max(tokens[k], prev.tokens[k])])) : tokens;
    const effort = sub ? this.roles.gatherer?.effort || 'low' : agent.effort || this.roles[agent.expeditionRole]?.effort || 'medium';
    const model = msg.model || prev?.model || agent.modelSeen || agent.model;
    const cost = messageCost(model, merged, effort);
    if (prev && cost <= prev.cost) return false;
    ids.set(id, { model, tokens: merged, cost, taskId: m.agent_id || null });
    this.inflight.set(agent.name, ids);
    return true;
  }
  inflightUSD() { let s = 0; for (const ids of this.inflight.values()) for (const x of ids.values()) s += x.cost; return s; }
  // fallback: dollars guessed for gatherers whose own frames never arrived (see Watchdog.fallbackUSD)
  spendUSD(fallback = 0) { return this.settledUSD + this.inflightUSD() + fallback; }

  // How far each limit is used, 0 to 1 and beyond; null for a limit that is not set (or a measure that is absent).
  fractions(now, fallback = 0) {
    return {
      time: this.activeMs(now) / this.limitMs,
      spend: this.dollars ? this.spendUSD(fallback) / this.dollars : null,
      meter: this.meter.baseline != null ? this.risen / this.percent : null
    };
  }
}

// One project's log, read once and forward: every Track is built from it.
class ProjectWatch {
  constructor(p) { this.p = p; this.cursor = 0; this.paused = false; this.tracks = new Map(); this.loads = p.log.loads; }
  ingest() {
    // The log was read again (an archive rotation swapped in a shorter list): start over from its first event, as at a
    // restart, so a position in the old list does not hide everything that comes after it.
    if (this.loads !== this.p.log.loads) { this.loads = this.p.log.loads; this.cursor = 0; this.paused = false; this.tracks = new Map(); }
    const evs = this.p.log.events;
    for (; this.cursor < evs.length; this.cursor++) this.apply(evs[this.cursor]);
  }
  apply(e) {
    if (e.type === 'project_settings' && typeof e.paused === 'boolean') {
      this.paused = e.paused;
      for (const t of this.tracks.values()) t.setPaused(e.paused, at(e.ts));
    } else if (e.type === 'expedition_started' && e.expedition) {
      if (!this.tracks.has(e.expedition)) this.tracks.set(e.expedition, new Track(this.p, e, this.paused));
    } else if (e.type === 'plan_usage') {
      const w = e.plan?.windows?.seven_day;
      if (w) for (const t of this.tracks.values()) t.observePlan(w);
    } else if (e.expedition) this.tracks.get(e.expedition)?.apply(e);
  }
}

// ---------- the words the Lead is sent ----------
export function reserveText({ which, detail }) {
  return `[From the hub] 90% of the expedition's ${which} is used (${detail}). Stop building now: no new build-verify loops and no new gatherers. Check the claims in your findings against their sources (the Verifier's job), then write up. At 100% the hub retires everyone but you and you get one last turn.`;
}
export function finalText({ reason, detail }) {
  const why = { time: `the time limit is used (${detail})`, budget: `the budget is used (${detail})`, Matt: 'the user pressed Stop' }[reason] || reason;
  return `[From the hub] The expedition has stopped: ${why}. Everyone else on your team is retired and any gatherer still running was stopped, so no more results will come in, and no agent or gatherer can be started now. This is your final turn: write REPORT.md from what exists in the folder (the hub adds the generated "how it ran" section), say plainly what is unfinished, and state in the report that the claims were not checked. When REPORT.md is written, end your turn (calling expedition_report_ready is fine too): the hub then copies it onto the branch, pushes, opens a draft pull request and posts the card. Do not send your post_summary yet: the hub tells you when the report, branch and card are done.`;
}

const realTimers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: x => clearTimeout(x), setInterval: (...a) => setInterval(...a), clearInterval: x => clearInterval(x) };

export class ExpeditionWatchdog {
  constructor(hub, { now = () => Date.now(), timers = realTimers, checkMs = CHECK_MS, stopWaitMs = STOP_WAIT_MS } = {}) {
    Object.assign(this, { hub, now, timers, checkMs, stopWaitMs });
    this.watches = new Map();
    this.timer = null;
  }

  // Rebuild from every project's log, then check every checkMs. firstCheck: also check now, which finishes a stop a restart cut
  // short (the hub passes false for a live hub and checks after it has resumed its agents, so a Lead never gets both its resume
  // message and its final message from one start). A failure is logged, never thrown: the watchdog must not take the hub down.
  start({ firstCheck = true } = {}) {
    this.stop();
    if (firstCheck) this.safeCheck();
    this.timer = this.timers.setInterval(() => this.safeCheck(), this.checkMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) this.timers.clearInterval(this.timer); this.timer = null; }
  safeCheck() { try { return this.check(this.now()); } catch (e) { console.warn('Expedition watchdog:', e?.message || e); return []; } }

  watch(p) {
    let w = this.watches.get(p);
    if (!w) this.watches.set(p, w = new ProjectWatch(p));
    return w;
  }
  trackOf(p, id) { const w = this.watch(p); w.ingest(); return w.tracks.get(id) || null; }

  // The 7-day window as the hub's plan meters show it now: { pct (0 to 100), resetsAt, asOfMs (when the plan was read) }, or
  // null (an API key, or not loaded yet).
  planWindow() {
    const plan = this.hub.usage?.available === false ? null : this.hub.usage?.plan;
    const w = plan?.windows?.seven_day;
    return w && Number.isFinite(w.pct) ? { pct: w.pct, resetsAt: w.resetsAt || null, asOfMs: at(plan.asOf) } : null;
  }
  // What launchExpedition records at the start, as a record only (it can be minutes old, or null before the meters load or
  // under an API key). Measure 2 counts from the first fresh reading after the launch instead (checkTrack).
  planStart() { const w = this.planWindow(); return w ? { sevenDayPct: w.pct, resetsAt: w.resetsAt } : null; }

  // ---------- counting (Agent.onMessage) ----------
  // Every assistant message of an expedition agent. Counted once per id; the limits are checked after each one. After a stop
  // the counting goes on (the Lead's final turn and the report's spend), with no limit left to check.
  onAssistant(agent, m) {
    try {
      const w = this.watch(agent.project); w.ingest();
      const t = w.tracks.get(agent.expedition);
      if (!t || !t.countMessage(agent, m)) return;
      if (!t.stopped) this.checkTrack(w, t, this.now());
    } catch (e) { console.warn('Expedition watchdog:', e?.message || e); }
  }

  // The expedition's spend as the watchdog counts it: results plus the estimate for messages since each agent's last result,
  // also after a stop (for the report's totals). null when the expedition is unknown.
  spendOf(p, id) { const t = this.trackOf(p, id); return t ? { spendUSD: t.spendUSD(this.fallbackUSD(t)), settledUSD: t.settledUSD, estimatedUSD: t.inflightUSD() } : null; }
  // After a result: its usage event is in the log now and replaces the estimate (Track.apply settles it).
  onResult(agent) {
    try {
      const w = this.watch(agent.project); w.ingest();
      const t = w.tracks.get(agent.expedition);
      if (t && !t.stopped) this.checkTrack(w, t, this.now());
    } catch (e) { console.warn('Expedition watchdog:', e?.message || e); }
  }

  // Gatherers whose own frames never reached us: the SDK's task_progress is all there is, and it is only the size of
  // their latest call, so (tool uses + 1) calls of that size, at the input price, is a rough lower bound priced high.
  // Normally nothing: the stream carries the gatherers' frames (spike M046).
  fallbackUSD(t) {
    const lead = this.hub.expeditionLead?.(t.p, t.id);
    let usdSum = 0;
    for (const [id, task] of lead?.subagents || []) if (!t.frameAgents.has(id) && task.tokens > 0) usdSum += ((task.toolUses ?? 0) + 1) * task.tokens * priceFor(t.roles.gatherer?.model || ROLES.gatherer.model).input / 1e6;
    return usdSum;
  }

  // ---------- the checks ----------
  // Every expedition of every project, with the clock given. Returns what it did: [{ expedition, did: 'note' | 'stop' | 'resume' | 'no-progress', ... }].
  check(now = this.now()) {
    if (this.hub.stopping) return [];
    const did = [];
    for (const p of this.hub.projects.values()) {
      const w = this.watch(p); w.ingest();
      for (const t of w.tracks.values()) { const x = this.checkTrack(w, t, now); if (x) did.push(x); }
      // Phase 5: an expedition that has stopped gets its end (report, branch, pull request, card, summary) once the Lead's turn
      // is over, and one that has ended retires its agents. The same pass finishes either after a restart. Not part of `did`.
      try { this.hub.expeditionEnd?.sweep(p); } catch (e) { console.warn('Expedition end:', e?.message || e); }
    }
    return did;
  }

  checkTrack(w, t, now) {
    const { p } = w;
    // A stop is on record. Passed and no-progress retire no one and are done (the backstop sees it and does nothing).
    // A hub stop whose sequence a restart cut short is carried on, once.
    if (t.stopped) {
      if (HUB_STOPS.includes(t.stopped.reason) && !t.final && !t.sequence) { this.beginSequence(p, t, t.stopped.reason, t.stopped.totals?.detail || ''); return { expedition: t.id, did: 'resume', reason: t.stopped.reason }; }
      return null;
    }
    const ex = this.hub.expeditionOf(p, t.id);
    // Measure 2: the baseline is the first reading taken after the launch (asOf newer than the start), written to the log as a
    // 'meter' note so a restart counts from the same place. No reading yet, or under an API key: measure 2 waits, it is not off.
    const reading = this.planWindow();
    if (reading && t.meter.baseline == null && reading.asOfMs >= t.startMs) { ex.note('meter baseline', { kind: 'meter', pct: reading.pct, resetsAt: reading.resetsAt, asOf: new Date(reading.asOfMs).toISOString() }); w.ingest(); }
    else t.observePlan(reading);
    // The backstop for the Lead's own no-progress stop (expedition_loop_result): only if two loops made no progress and
    // the stop is somehow not logged. No one is retired for it, as for the tool's own stop.
    const [a, b] = t.loops.slice(-2);
    if (a && b && !a.progress && !b.progress && ex.state().phase === 'running') {
      ex.stop({ reason: 'no-progress', totals: this.totals(t, now) }); w.ingest();
      return { expedition: t.id, did: 'no-progress' };
    }
    const f = t.fractions(now, this.fallbackUSD(t));
    const worst = [['time', f.time], ['spend', f.spend], ['meter', f.meter]].filter(([, v]) => v != null).sort((x, y) => y[1] - x[1])[0];
    if (!worst) return null;
    const [which, frac] = worst;
    if (frac >= 1) return this.stopTrack(w, t, which === 'time' ? 'time' : 'budget', now, which);
    if (frac >= RESERVE_AT && !t.reserve) return this.sendReserve(w, t, which, now);
    return null;
  }

  // Plain words for one measure: "2.4 h of 6 h", "$4.60 of $5.00", "6.4 of 7 points".
  describe(t, which, now) {
    if (which === 'time') return `${hours(t.activeMs(now))} of ${hours(t.limitMs)}`;
    if (which === 'spend') return `${usd(t.spendUSD(this.fallbackUSD(t)))} of ${usd(t.dollars)}, an estimate until each result`;
    return `the 7-day plan meter is up ${t.risen.toFixed(1)} of ${t.percent} points since launch`;
  }
  totals(t, now, which = null) {
    return { ...howItRan(t.p.log.events, t.id).totals, spendUSD: Math.round(t.spendUSD(this.fallbackUSD(t)) * 10000) / 10000, activeMs: t.activeMs(now), pausedMs: t.pausedMs + (t.pausedSince != null ? Math.max(0, now - t.pausedSince) : 0), meterRisePoints: t.meter.baseline != null ? Math.round(t.risen * 10) / 10 : null, ...(which ? { detail: this.describe(t, which, now) } : {}) };
  }

  // The 90% note: logged first, then sent, so it goes at most once, restart or not.
  sendReserve(w, t, which, now) {
    const lead = this.hub.expeditionLead(t.p, t.id);
    if (!lead) return null;   // nobody to tell yet: tried again at the next check
    const detail = this.describe(t, which, now);
    const label = { time: 'time', spend: 'budget', meter: 'budget (the 7-day plan meter)' }[which];
    this.hub.expeditionOf(t.p, t.id).note('90%', { kind: 'reserve', atPct: 90, measure: which, detail }); w.ingest();
    const text = reserveText({ which: label, detail });
    this.hub.notice(t.p, lead.thread, `The hub told the Lead: 90% of the ${label} is used (${detail}); stop building, check claims, write up.`);
    try { lead.send(text); } catch (e) { this.hub.notice(t.p, lead.thread, `The 90% note could not be sent: ${e.message}`); }
    return { expedition: t.id, did: 'note', measure: which };
  }

  // The user's Stop, or a limit: the stop is logged, then the sequence runs. Phase 5 puts a button on this.
  stopNow(p, id, reason = 'Matt', now = this.now()) {
    const w = this.watch(p); w.ingest();
    const t = w.tracks.get(id);
    if (!t) throw new Error(`No expedition ${id} in ${p.name}.`);
    if (t.stopped) return { expedition: id, did: 'already', reason: t.stopped.reason };
    return this.stopTrack(w, t, reason, now, null);
  }

  stopTrack(w, t, reason, now, which) {
    const ex = this.hub.expeditionOf(t.p, t.id);
    const totals = this.totals(t, now, which);
    ex.stop({ reason, totals }); w.ingest();
    this.beginSequence(t.p, t, reason, totals.detail || '');
    return { expedition: t.id, did: 'stop', reason, measure: which };
  }

  // ---------- the stop sequence ----------
  beginSequence(p, t, reason, detail) {
    if (t.sequence) return t.sequence;
    t.sequence = this.runSequence(p, t, reason, detail)
      .catch(e => {
        console.warn('Expedition stop sequence:', e?.message || e);
        const lead = this.hub.expeditionLead(p, t.id);   // never the orchestrator's thread: an expedition stays quiet until its end
        if (lead) this.hub.notice(p, lead.thread, `The stop sequence hit a problem: ${e?.message || e}`);
      })
      .finally(() => { t.sequence = null; });
    return t.sequence;
  }

  // Resolves when every running sequence has finished (tests; also an orderly shutdown).
  async settled() { for (const w of this.watches.values()) for (const t of w.tracks.values()) if (t.sequence) await t.sequence; }

  members(p, id) { return [...p.agents.values()].filter(a => a.expedition === id && a.state !== 'retired'); }

  async runSequence(p, t, reason, detail) {
    const { hub } = this;
    const agents = this.members(p, t.id);
    // 1. Interrupt every one that is in a turn. An idle agent gets no result from an interrupt, so it is not asked.
    await Promise.all(agents.map(a => a.interrupt?.().catch(() => false)));
    // 2. Wait for each result; after the fallback time the ones that never answered are closed.
    const ok = await this.waitIdle(agents, this.stopWaitMs);
    if (!ok) for (const a of agents) if (['working', 'starting'].includes(a.state)) { hub.notice(p, a.thread, `${a.name} did not stop within ${Math.round(this.stopWaitMs / 1000)} seconds, so the hub closed it.`); a.close(); }
    // The Lead's gatherers die with its interrupt; any task still open is stopped one by one.
    for (const a of agents) if (a.expeditionRole === 'lead') await (a.stopTasks?.().catch(() => 0));
    // 3. Retire everyone but the Lead (a Lead mid-handoff keeps both its holders).
    for (const a of this.members(p, t.id)) {
      if (a.expeditionRole === 'lead') continue;
      try { hub.finishRetire(p, a); } catch (e) { console.warn(`Could not retire ${a.name}:`, e?.message || e); }
    }
    // 4. A Lead that was writing its handoff when the stop came (its turn was interrupted above, so it will never finish
    // writing one) is settled NOW, not after the handoff timer (M049 4): with a handoff already written the successor starts
    // at once; without one the handoff is cancelled and the same Lead takes the final turn. Either way the final message goes
    // to whoever holds the role below, and the old Lead never gets a message the successor would miss.
    const ex = hub.expeditionOf(p, t.id);
    if (ex.state().finalNote) return;
    for (const a of [...p.agents.values()]) {
      if (a.expedition !== t.id || a.expeditionRole !== 'lead' || a.state === 'retired' || a.retiring !== 'writing') continue;
      if (a.leftHandoff) hub.startSuccessor(p, a);
      else { clearTimeout(a.retireTimer); a.retiring = false; hub.notice(p, a.thread, `The handoff was cancelled: the expedition has stopped, so ${a.name} writes the report itself.`); }
    }
    // 5. The Lead's one final message: logged first, so it is never sent twice.
    if (ex.state().finalNote) return;
    const lead = hub.expeditionLead(p, t.id);
    ex.note('final', { kind: 'final', reason, lead: lead?.name || null }); this.watch(p).ingest();
    if (!lead) return;
    hub.notice(p, lead.thread, `The hub stopped the expedition (${reason}). Everyone but ${lead.name} is retired; ${lead.name} has its final turn to write the report.`);
    try { lead.send(finalText({ reason, detail })); } catch (e) { hub.notice(p, lead.thread, `The final message could not be sent: ${e.message}`); }
  }

  // Resolves true when none of these agents is in a turn, false after ms (the fallback timer).
  waitIdle(agents, ms) { return this.waitUntil(() => !agents.some(a => ['working', 'starting'].includes(a.state)), ms); }

  // Resolves true as soon as done() holds (looked at again on every hub event), false after ms (the fallback timer).
  waitUntil(done, ms) {
    if (done()) return Promise.resolve(true);
    return new Promise(resolve => {
      let off = () => { }, timer = null;
      const finish = ok => { off(); this.timers.clearTimeout(timer); resolve(ok); };
      off = this.hub.on(() => { if (done()) finish(true); });
      timer = this.timers.setTimeout(() => finish(false), ms);
    });
  }
}
