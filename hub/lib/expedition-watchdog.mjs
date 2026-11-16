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
    const ps = started.planStart;
    this.planStart = ps && Number.isFinite(Number(ps.sevenDayPct)) ? { pct: Number(ps.sevenDayPct), resetsAt: ps.resetsAt || null } : null;   // null: no plan readings (API key, or the meters had not loaded)
    this.meter = { pct: null, resetsAt: null, risen: 0 };
    this.settledUSD = 0;                  // the usage events' figures: results, which win
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
      else this.reserve = this.reserve || e;
    } else if (e.type === 'expedition_stopped') this.stopped = this.stopped || e;
    else if (e.type === 'expedition_loop') this.loops.push(e);
  }

  // A result's figure replaces everything estimated for that agent since its last one.
  settle(agent) {
    const ids = this.inflight.get(agent);
    if (!ids) return;
    const done = this.settledIds.get(agent) || new Set();
    for (const id of ids.keys()) done.add(id);
    while (done.size > KEEP_IDS) done.delete(done.values().next().value);
    this.settledIds.set(agent, done);
    this.inflight.delete(agent);
  }

  setPaused(on, tsMs) {
    if (on && this.pausedSince == null) this.pausedSince = Math.max(tsMs, this.startMs);
    else if (!on && this.pausedSince != null) { this.pausedMs += Math.max(0, tsMs - this.pausedSince); this.pausedSince = null; }
  }
  // Wall clock since the start, less the time the user held the project paused.
  activeMs(now) { return Math.max(0, now - this.startMs - this.pausedMs - (this.pausedSince != null ? Math.max(0, now - this.pausedSince) : 0)); }

  // One reading of the 7-day window ({ pct, resetsAt }). The rise since launch is added up reading by reading: inside one
  // window it is the climb; when the window has reset it began again at zero, so the new reading is all new. (What was
  // spent between the last old reading and the reset is not seen; the guard is conservative anyway, it also counts other work.)
  observePlan(w) {
    if (!this.planStart || !w || !Number.isFinite(w.pct)) return;
    const m = this.meter;
    if (m.pct == null) { m.pct = this.planStart.pct; m.resetsAt = this.planStart.resetsAt; }
    m.risen += sameWindow(m.resetsAt, w.resetsAt) ? Math.max(0, w.pct - m.pct) : w.pct;
    m.pct = w.pct; m.resetsAt = w.resetsAt || m.resetsAt;
  }

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
    ids.set(id, { model, tokens: merged, cost });
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
      meter: this.planStart ? this.meter.risen / this.percent : null
    };
  }
}

// One project's log, read once and forward: every Track is built from it.
class ProjectWatch {
  constructor(p) { this.p = p; this.cursor = 0; this.paused = false; this.tracks = new Map(); }
  ingest() {
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
  return `[From the hub] The expedition has stopped: ${why}. Everyone else on your team is retired and any gatherer still running was stopped, so no more results will come in. This is your final turn: write REPORT.md from what exists in the folder (the hub adds the generated "how it ran" section), say plainly what is unfinished, and say that the claims were not all checked if the Verifier's check did not finish. You may still start a Verifier (only that role) to check the report's numbers and claims. Do not send your post_summary yet: the hub tells you when the report, branch and card are done.`;
}

const realTimers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: x => clearTimeout(x), setInterval: (...a) => setInterval(...a), clearInterval: x => clearInterval(x) };

export class ExpeditionWatchdog {
  constructor(hub, { now = () => Date.now(), timers = realTimers, checkMs = CHECK_MS, stopWaitMs = STOP_WAIT_MS } = {}) {
    Object.assign(this, { hub, now, timers, checkMs, stopWaitMs });
    this.watches = new Map();
    this.timer = null;
  }

  // Rebuild from every project's log, finish any stop a restart cut short, then check every checkMs.
  start() {
    this.stop();
    this.check(this.now());   // reads the logs (the rebuild), sends nothing that was already sent, resumes a cut stop sequence
    this.timer = this.timers.setInterval(() => { try { this.check(this.now()); } catch (e) { console.warn('Expedition watchdog:', e?.message || e); } }, this.checkMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) this.timers.clearInterval(this.timer); this.timer = null; }

  watch(p) {
    let w = this.watches.get(p);
    if (!w) this.watches.set(p, w = new ProjectWatch(p));
    return w;
  }
  trackOf(p, id) { const w = this.watch(p); w.ingest(); return w.tracks.get(id) || null; }

  // The 7-day window as the hub's plan meters show it now: { pct, resetsAt }, or null (an API key, or not loaded yet).
  planWindow() {
    const w = this.hub.usage?.available === false ? null : this.hub.usage?.plan?.windows?.seven_day;
    return w && Number.isFinite(w.pct) ? { pct: w.pct, resetsAt: w.resetsAt || null } : null;
  }
  // What launchExpedition records at the start: the readings measure 2 counts from (null: measure 2 is absent).
  planStart() { const w = this.planWindow(); return w ? { sevenDayPct: w.pct, resetsAt: w.resetsAt } : null; }

  // ---------- counting (Agent.onMessage) ----------
  // Every assistant message of an expedition agent. Counted once per id; the limits are checked after each one.
  onAssistant(agent, m) {
    try {
      const w = this.watch(agent.project); w.ingest();
      const t = w.tracks.get(agent.expedition);
      if (!t || t.stopped || !t.countMessage(agent, m)) return;
      this.checkTrack(w, t, this.now());
    } catch (e) { console.warn('Expedition watchdog:', e?.message || e); }
  }
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
    t.observePlan(this.planWindow());
    const ex = this.hub.expeditionOf(p, t.id);
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
    return `the 7-day plan meter is up ${t.meter.risen.toFixed(1)} of ${t.percent} points since launch`;
  }
  totals(t, now, which = null) {
    return { ...howItRan(t.p.log.events, t.id).totals, spendUSD: Math.round(t.spendUSD(this.fallbackUSD(t)) * 10000) / 10000, activeMs: t.activeMs(now), pausedMs: t.pausedMs + (t.pausedSince != null ? Math.max(0, now - t.pausedSince) : 0), meterRisePoints: t.planStart ? Math.round(t.meter.risen * 10) / 10 : null, ...(which ? { detail: this.describe(t, which, now) } : {}) };
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
    // 4. The Lead's one final message: logged first, so it is never sent twice.
    const ex = hub.expeditionOf(p, t.id);
    if (ex.state().finalNote) return;
    const lead = hub.expeditionLead(p, t.id);
    ex.note('final', { kind: 'final', reason, lead: lead?.name || null }); this.watch(p).ingest();
    if (!lead) return;
    hub.notice(p, lead.thread, `The hub stopped the expedition (${reason}). Everyone but ${lead.name} is retired; ${lead.name} has its final turn to write the report.`);
    try { lead.send(finalText({ reason, detail })); } catch (e) { hub.notice(p, lead.thread, `The final message could not be sent: ${e.message}`); }
  }

  // Resolves true when none of these agents is in a turn, false after ms (the fallback timer).
  waitIdle(agents, ms) {
    const busy = () => agents.some(a => ['working', 'starting'].includes(a.state));
    if (!busy()) return Promise.resolve(true);
    return new Promise(resolve => {
      let off = () => { }, timer = null;
      const done = ok => { off(); this.timers.clearTimeout(timer); resolve(ok); };
      off = this.hub.on(ev => { if (ev.type === 'agent_state' && !busy()) done(true); });
      timer = this.timers.setTimeout(() => done(false), ms);
    });
  }
}
