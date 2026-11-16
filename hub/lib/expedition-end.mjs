// The end of an expedition (spec 4.8, plan phase 5), as logged steps. After a stop (the Lead's: passed or no-progress; the
// hub's: time, budget, the user's Stop) the hub does, in order:
//
//   report   REPORT.md = what the Lead wrote + the hub's generated part (claims check, parked as proposed next expeditions,
//            how it ran); test/ is checked against its frozen copy first, whatever the stop (M049 6)
//   commit   the build worktree expedition/<id> gets the report and everything the Builder left: one commit
//   push     the branch (never forced)
//   pr       a DRAFT pull request (never merged: the desk has no merge)
//   card     the one finished card (expedition_finished) for the user
//   summary  the Lead's one post_summary to the orchestrator (the Lead sends it when the hub says so; if it does not, the hub
//            posts it for the Lead)
//
// Every step logs an expedition_step event and is skipped if that event exists, so the end never runs twice, a restart
// between any two steps carries on at the next, and a step that was cut off between its work and its event does the work again
// harmlessly (every desk operation is safe to repeat). A git or gh failure is a RESULT, not a crash: it is logged on the step
// (ok: false, why) and the end goes on, so the card can say what is missing and the sequence is finite.
// After the summary every expedition agent is retired (conflict 8 of the plan: the one exception to C007).
import { Expedition } from './expedition.mjs';
import { HUB_STOPS } from './expedition-watchdog.mjs';
import { ExpeditionDesk } from './expedition-desk.mjs';
import { assembleReport, answerLine, proposalsOf, clipText } from './expedition-report.mjs';

export const END_WAIT_MS = 60 * 60 * 1000;   // a stop nobody finishes (no report_ready, no final turn) is ended by the hub after this long
const firstLine = e => String(e?.message || e).split('\n').find(l => l.trim())?.trim().slice(0, 240) || 'unknown error';
const busyNow = a => !!a && ['working', 'starting'].includes(a.state);

export class ExpeditionEnd {
  constructor(hub, { now = () => Date.now() } = {}) {
    this.hub = hub;
    this.now = now;
    this.running = new Map();      // "<project>/<id>" -> the end in flight
    this.reported = new Set();     // failures already said once
    this.deskFactory = null;       // tests: (p, ex) => a desk
    this.hook = null;              // tests: (when: 'before' | 'after', step) => void; a throw is a crash at that point
  }

  deskFor(p, ex) {
    if (this.deskFactory) return this.deskFactory(p, ex);
    // A test hub commits but never pushes or opens a pull request on the real GitHub (CRUX_HUB_EXPEDITION_PUSH=1 lets one do it).
    return new ExpeditionDesk({ ex, local: this.hub.noAgents && process.env.CRUX_HUB_EXPEDITION_PUSH !== '1' });
  }

  // ---------- who is busy, from the log (so a restart is read right) ----------
  lastBusy(p, name) { return p.log.events.findLast(e => e.type === 'agent_busy' && e.agent === name) || null; }
  leadBusy(p, lead) { return !!lead && (busyNow(lead) || !!this.lastBusy(p, lead.name)?.busy); }
  // Did the agent end a turn after this event? (a turn that started after it and has ended)
  turnEndedAfter(p, lead, ev) {
    const evs = p.log.events;
    const i = evs.findIndex(e => e === ev || (ev.id && e.id === ev.id));
    let ended = false, last = null;
    for (const e of evs.slice(i + 1)) if (e.type === 'agent_busy' && e.agent === lead.name) { last = e; if (!e.busy) ended = true; }
    return ended && !last.busy && !busyNow(lead);
  }
  anyLead(p, id) { return this.hub.expeditionLead(p, id) || [...p.agents.values()].findLast(a => a.expedition === id && a.expeditionRole === 'lead') || null; }

  // ---------- is it time? ----------
  // null (not yet) or the reason it is time, for the log and the tests. The Lead's own turn is never cut into: a Lead stop
  // waits for expedition_report_ready and the end of that turn; a hub stop waits for the end of the Lead's final turn.
  due(p, id, now = this.now()) {
    const ex = this.hub.expeditionOf(p, id), s = ex.state();
    if (s.phase !== 'stopped' || this.running.has(`${p.name}/${id}`)) return null;
    if (s.steps.has('card')) return 'summary';   // the sequence is done but for the Lead's summary: see afterCard
    const lead = this.hub.expeditionLead(p, id);
    if (!lead) return 'no lead';   // nobody left to write: the report is what the files hold
    if (this.leadBusy(p, lead)) return null;
    const hubStop = HUB_STOPS.includes(s.stopped.reason);
    if (hubStop && !s.finalNote) return now - Date.parse(s.stopped.ts) >= END_WAIT_MS ? 'stale' : null;   // the stop sequence is still running
    if (s.reportReadyNote) return 'report ready';
    if (hubStop && this.turnEndedAfter(p, lead, s.finalNote)) return 'final turn over';
    return now - Date.parse(s.stopped.ts) >= END_WAIT_MS ? 'stale' : null;
  }

  // The watchdog's check calls this for every project, every 30 seconds, and the Lead's turn end calls it for its expedition.
  // Starts what is due in the background. Returns what it started: [{ expedition, did }].
  sweep(p) {
    const out = [];
    for (const x of Expedition.all(p)) out.push(...this.consider(p, x.id, x.phase));
    return out;
  }
  consider(p, id, phase = null) {
    const ex = this.hub.expeditionOf(p, id), s = ex.state();
    phase ||= s.phase;
    if (phase === 'ended') return this.retireAll(p, id) ? [{ expedition: id, did: 'retire' }] : [];
    if (phase !== 'stopped') return [];
    const why = this.due(p, id);
    if (!why) return [];
    if (why === 'summary') return this.afterCard(p, id) ? [{ expedition: id, did: 'summary' }] : [];
    this.begin(p, id);
    return [{ expedition: id, did: 'end', why }];
  }

  begin(p, id) {
    const key = `${p.name}/${id}`;
    if (this.running.has(key)) return this.running.get(key);
    const run = this.run(p, id)
      .catch(e => this.failed(p, id, e))
      .finally(() => this.running.delete(key));
    this.running.set(key, run);
    return run;
  }
  failed(p, id, e) {
    console.warn(`Expedition end ${id}:`, e?.message || e);
    const key = `${p.name}/${id}/${firstLine(e)}`;
    if (this.reported.has(key)) return;   // said once; the next check tries again
    this.reported.add(key);
    const lead = this.anyLead(p, id);
    this.hub.notice(p, lead?.thread || 'orchestrator', `The end of expedition ${id} hit a problem and will be tried again: ${firstLine(e)}`);
  }
  // Resolves when every end in flight is over (tests, an orderly shutdown).
  async settled() { while (this.running.size) await Promise.all([...this.running.values()]); }

  // ---------- the sequence ----------
  // Runs the steps still missing, in order. Resolves to the steps it did. Throws only on a crash (the hook, a bug, a full
  // disk): a desk failure is logged on its step instead.
  async run(p, id) {
    const hub = this.hub, ex = hub.expeditionOf(p, id);
    const did = [];
    const step = async (name, f) => {
      if (ex.state().phase !== 'stopped' || ex.hasStep(name)) return;
      await this.hook?.('before', name);
      await f();
      did.push(name);
      await this.hook?.('after', name);
    };
    const s0 = ex.state();
    if (s0.phase !== 'stopped') return did;
    const hubStop = HUB_STOPS.includes(s0.stopped.reason);
    const question = s0.started?.question || '';
    await step('report', () => this.reportStep(p, ex, { hubStop, question }));
    await step('commit', () => this.commitStep(p, ex, question));
    await step('push', () => this.pushStep(p, ex));
    await step('pr', () => this.prStep(p, ex, question));
    await step('card', () => this.cardStep(p, ex, question, hubStop));
    this.afterCard(p, id);
    return did;
  }

  reportStep(p, ex, { hubStop, question }) {
    // M049 6: test/ is checked at the finish for a hub stop too (time, budget, the user's Stop), not only the Lead's own.
    const integrity = ex.checkFrozen('finish');
    const leadText = ex.read('REPORT.md');
    const verdict = ex.read('verify/VERDICT.md');
    const claims = verdict && /^#{1,4}\s.*(claims?|corrections?)/im.test(verdict) ? 'checked' : 'not checked';
    const md = assembleReport({ leadText, events: p.log.events, id: ex.id, question, claims, hubStop });
    ex.write('REPORT.md', md);
    ex.step('report', { file: 'REPORT.md', leadWrote: !!String(leadText || '').replace(/<!-- hub-generated[\s\S]*$/, '').trim(), claims, ...(integrity.checked && integrity.ok === false ? { integrity: integrity.restored ? 'restored' : 'not restored' } : {}) });
  }

  stepData(ex, name) { return ex.stepEvent(name); }

  async commitStep(p, ex, question) {
    const desk = this.deskFor(p, ex);
    const answer = answerLine(ex.read('REPORT.md')) || question || ex.id;
    let data;
    try { const r = await desk.commit(`Expedition ${ex.id}: ${clipText(answer, 72)}`); data = { ok: true, commit: r.commit, already: r.already, branch: ex.branch, report: desk.reportRel }; }
    catch (e) { data = { ok: false, error: firstLine(e), branch: ex.branch }; }
    ex.step('commit', data);
  }

  async pushStep(p, ex) {
    const commit = this.stepData(ex, 'commit');
    let data;
    if (!commit?.ok) data = { ok: false, skipped: true, error: 'there is no commit to push' };
    else {
      try { const r = await this.deskFor(p, ex).push(); data = r.local ? { ok: false, local: true, error: 'this is a test hub: nothing is pushed' } : { ok: true }; }
      catch (e) { data = { ok: false, error: firstLine(e) }; }
    }
    ex.step('push', { branch: ex.branch, ...data });
  }

  async prStep(p, ex, question) {
    const push = this.stepData(ex, 'push');
    let data;
    if (!push?.ok) data = { ok: false, skipped: true, local: !!push?.local, error: push?.local ? 'this is a test hub: no pull request is opened' : 'the branch is not pushed, so there is no pull request' };
    else {
      const answer = answerLine(ex.read('REPORT.md')) || question || ex.id;
      const body = [`Expedition ${ex.id}${question ? `: ${clipText(question, 200)}` : ''}`, '', `**Answer:** ${answer}`, `**Stopped:** ${ex.state().stopped?.reason}`, '',
        `The report is at ${this.deskFor(p, ex).reportRel} on this branch. This draft pull request was opened by the Crux hub when the expedition ended. The expedition never merges: read the report, then merge or close it yourself.`].join('\n');
      try { const r = await this.deskFor(p, ex).pr({ title: `Expedition ${ex.id}: ${clipText(answer, 70)}`, body }); data = { ok: true, url: r.url, number: r.number, draft: r.draft, existed: r.existed }; }
      catch (e) { data = { ok: false, error: firstLine(e) }; }
    }
    ex.step('pr', data);
  }

  // The card: one event, written once, then its step.
  async cardStep(p, ex, question, hubStop) {
    const s = ex.state();
    if (!s.finished) ex.record('expedition_finished', this.cardOf(p, ex, question, hubStop));
    ex.step('card', {});
  }

  cardOf(p, ex, question, hubStop) {
    const s = ex.state(), r = ex.read('REPORT.md');
    const commit = this.stepData(ex, 'commit'), push = this.stepData(ex, 'push'), pr = this.stepData(ex, 'pr'), rep = this.stepData(ex, 'report');
    const answer = answerLine(r) || question || '(no answer written)';
    const loops = s.loops, good = loops.filter(l => !l.tampered), passing = good.length ? good.at(-1).passing : null;
    const problem = !commit?.ok ? `The branch was not made: ${commit?.error || 'unknown'}.` : !push?.ok ? (push?.local ? 'Not pushed: this is a test hub.' : `Not pushed: ${push?.error || 'unknown'}. The commit is on ${ex.branch} in the project; push it yourself.`) : !pr?.ok ? `The draft pull request was not opened: ${pr?.error || 'unknown'}. The branch ${ex.branch} is pushed; open it from GitHub.` : null;
    return {
      thread: 'orchestrator', title: `Expedition finished: ${clipText(answer, 120)}`, question, answer, stopReason: s.stopped?.reason || null, hubStop,
      loops: loops.length, passing, decisions: s.decisions.length, parked: proposalsOf(p.log.events, ex.id).length, lessons: s.parked.filter(e => e.kind === 'lesson').length,
      claimsChecked: rep?.claims === 'checked', leadWrote: rep?.leadWrote !== false,
      branch: ex.branch, commit: commit?.commit || null, pushed: !!push?.ok, pr: pr?.ok ? { url: pr.url, number: pr.number, draft: pr.draft !== false } : null,
      problem, reportPath: commit?.report || null
    };
  }

  // ---------- after the card: the Lead's one summary, then everyone retires ----------
  // True when it did something. Tells the Lead it may send its summary (logged first, so once); if the Lead's turn after that
  // ended without one, the hub posts it for the Lead.
  afterCard(p, id) {
    const hub = this.hub, ex = hub.expeditionOf(p, id), s = ex.state();
    if (s.phase !== 'stopped' || !s.steps.has('card')) return false;
    const lead = hub.expeditionLead(p, id);
    if (!s.summaryGoNote) {
      ex.note('the end is done: the Lead may send its summary', { kind: 'summary-go' });
      if (lead) {
        const f = ex.state().finished;
        hub.notice(p, lead.thread, `The end of the expedition is done (report, branch, finished card). ${lead.name} may send its one summary.`);
        try { lead.send(goText(f)); } catch (e) { hub.notice(p, lead.thread, `The summary message could not be sent: ${e.message}`); }
        return true;
      }
    }
    const go = ex.state().summaryGoNote;
    if (go && (!lead || (!this.leadBusy(p, lead) && this.turnEndedAfter(p, lead, go)))) {
      const who = lead || this.anyLead(p, id);
      if (!who) return false;
      const f = ex.state().finished;
      hub.postSummary(p, who, forcedSummary(f));
      return true;
    }
    return false;
  }

  // Every expedition agent, the Lead included, retires once the summary is sent and the Lead's turn is over.
  retireAll(p, id) {
    const hub = this.hub;
    const lead = hub.expeditionLead(p, id);
    if (this.leadBusy(p, lead)) return false;
    let n = 0;
    for (const a of [...p.agents.values()]) {
      if (a.expedition !== id || a.state === 'retired') continue;
      try { hub.finishRetire(p, a); n++; } catch (e) { console.warn(`Could not retire ${a.name}:`, e?.message || e); }
    }
    return n > 0;
  }
}

export function goText(f) {
  const pr = f?.pr ? `draft PR ${f.pr.url || '#' + f.pr.number}` : 'no draft PR';
  return `[From the hub] The end is done: the report is on branch ${f?.branch || '(none)'} (${f?.pushed ? 'pushed' : 'not pushed'}), ${pr}, and the finished card is posted for the user${f?.problem ? ` (${f.problem})` : ''}. Send your one post_summary to the orchestrator now: the answer, the stop reason, the branch and the PR, what is parked. Then stop: nothing more is needed from you, and you retire after this turn.`;
}

// What the hub posts for a Lead that did not send its own summary.
export function forcedSummary(f) {
  const pr = f?.pr ? `draft PR ${f.pr.url || '#' + f.pr.number}` : 'no draft PR was opened';
  return {
    done: [`Expedition finished (${f?.stopReason || 'stopped'}): ${f?.answer || 'see the report'}`, `Branch ${f?.branch || '(none)'} ${f?.pushed ? 'pushed' : 'not pushed'}; ${pr}.`],
    changed: [f?.reportPath || 'REPORT.md'], questions: [], decisions_needed: [], blocked_on: f?.problem ? [f.problem] : [],
    next_step: 'Read the report; the parked items are proposed next expeditions in it. (Posted by the hub: the Lead did not send its own.)', outcome: 'done', visuals: [], approvals: [], open_questions: []
  };
}
