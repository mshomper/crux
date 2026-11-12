// Usage (decision 36): per-result accounting, and one hub-wide poller for the plan's limits.
//
// The Agent SDK's result carries running totals for one query, so each agent keeps the totals it saw last
// (UsageLedger) and logs only the difference, as one `usage` event per result. Plan windows come from the SDK's
// experimental usage call, asked of any live agent every few minutes, and from the rate_limit events agents stream.
// The latest plan snapshot stays in memory; it is logged (`plan_usage`) only when it changes meaningfully.
// If the call throws or gives nothing, the meters hide and the thread gets one notice.
import { totalsOf, diffTotals, sumCost, normalizePlan, readRateLimit, applyRateLimit, planChanged } from '../public/usage.js';

export const POLL_MS = 5 * 60 * 1000;
const CALL_TIMEOUT_MS = 15000;

// One agent's running totals, per query run. A resumed session already carries its earlier turns in its first
// result, so the first result of a run is measured against what the log last saw of that session (`baseline`),
// and with nothing logged it only sets the starting line: the old turns are not counted again as new.
export class UsageLedger {
  constructor() { this.totals = null; }

  // baseline: the totals after this session's last logged usage event, or null when the log has none.
  // fresh: the session started with this run, so its first result is all new.
  record(modelUsage, { baseline = null, fresh = false } = {}) {
    const cur = totalsOf(modelUsage);
    let prev = this.totals;
    let setsBaseline = false;
    if (!prev) {
      if (baseline) prev = baseline;
      else if (fresh) prev = {};
      else { prev = cur; setsBaseline = true; }
    }
    const { delta, reset } = diffTotals(prev, cur);
    this.totals = cur;
    return { delta, totals: cur, reset, baseline: setsBaseline, costUSD: sumCost(delta) };
  }
}

// The totals after a session's last usage event in a log, or null.
export function baselineFor(log, agent, sessionId) {
  if (!sessionId) return null;
  const last = log.events.findLast(e => e.type === 'usage' && e.agent === agent && e.sessionId === sessionId);
  return last?.totals || null;
}

export class Usage {
  constructor(hub, { everyMs = POLL_MS, now = () => Date.now() } = {}) {
    this.hub = hub;
    this.everyMs = everyMs;
    this.now = now;
    this.plan = null;          // the latest snapshot, or null when there is none to show
    this.available = null;     // null: not asked yet; true: plan limits answered; false: failed or not applicable
    this.statuses = {};        // allowed, allowed_warning or rejected, by window, from rate_limit events
    this.lastPoll = 0;
    this.noticed = false;
    this.timer = null;
    this.polling = null;
  }

  // Start-up: the last snapshot in any project's log shows (dimmed, with its time) until the first poll.
  restore() {
    let last = null;
    for (const p of this.hub.projects.values()) {
      const e = p.log.events.findLast(x => x.type === 'plan_usage' && x.plan);
      if (e && (!last || e.ts > last.ts)) last = e;
    }
    if (last) { this.plan = { ...last.plan, asOf: last.plan.asOf || last.ts }; this.statuses = { ...(last.plan.statuses || {}) }; this.available = true; }
  }

  start() {
    this.restore();
    this.stop();
    this.timer = setInterval(() => this.poll().catch(() => { }), this.everyMs);
    this.timer.unref?.();
  }
  stop() { clearInterval(this.timer); this.timer = null; }

  // The agents that can be asked, resting ones first (a busy one answers too, but there is no need to bother it).
  candidates() {
    const live = [];
    for (const p of this.hub.projects.values()) for (const a of p.agents.values()) if (a.q && typeof a.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET === 'function') live.push({ p, a });
    return live.sort((x, y) => (x.a.state === 'idle' ? 0 : 1) - (y.a.state === 'idle' ? 0 : 1));
  }

  // After any agent's result: ask at once if it is time, so the meters fill in soon after the first agent starts.
  note() {
    if (this.now() - this.lastPoll >= this.everyMs) this.poll().catch(() => { });
  }

  // One poll: the first live agent that answers. Throws or null from every agent: hide the meters, once say why.
  poll() {
    if (this.polling) return this.polling;
    this.polling = this.pollOnce().finally(() => { this.polling = null; });
    return this.polling;
  }

  async pollOnce() {
    const tried = this.candidates();
    if (!tried.length) return null;   // nobody live to ask: whatever is shown stays, dimmed once it is old
    this.lastPoll = this.now();
    let why = 'no answer';
    for (const { p, a } of tried.slice(0, 3)) {
      let timer;
      try {
        const resp = await Promise.race([
          a.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
          new Promise((_, no) => { timer = setTimeout(() => no(new Error('no answer in time')), CALL_TIMEOUT_MS); })
        ]);
        const plan = normalizePlan(resp, new Date(this.now()).toISOString());
        if (plan) return this.setPlan(plan, p);
        why = resp && resp.rate_limits_available === false ? 'plan limits do not apply to this login' : 'it returned no plan limits';
      } catch (e) { why = e?.message || 'the call failed'; }
      finally { clearTimeout(timer); }
    }
    this.fail(tried[0].p, why);
    return null;
  }

  setPlan(plan, p) {
    plan.statuses = { ...this.statuses };
    const before = this.plan;
    this.plan = plan;
    this.available = true;
    this.noticed = false;
    if (planChanged(before, plan) || !before) p.log.append('plan_usage', { plan });
    this.emit();
    return plan;
  }

  fail(p, why) {
    this.plan = null;
    this.available = false;
    if (!this.noticed) {
      this.noticed = true;
      this.hub.notice(p, 'orchestrator', `Plan usage is not available (${why}), so the usage meters are hidden. The hub tries again every ${Math.round(this.everyMs / 60000)} minutes.`);
    }
    this.emit();
  }

  // A streamed rate_limit_event: its status colours the meters now, and its percent updates a window we show.
  rateLimit(info, p) {
    const read = readRateLimit(info);
    if (!read) return;
    const before = this.plan;
    this.statuses = { ...this.statuses, ...read.statuses };
    if (before) {
      this.plan = applyRateLimit(before, read, new Date(this.now()).toISOString());
      if (planChanged(before, this.plan) && p) p.log.append('plan_usage', { plan: this.plan });
    }
    this.emit();
  }

  view() { return { plan: this.plan, available: this.available }; }

  emit() { this.hub.emit({ type: 'plan_usage', ...this.view() }); }
}
