# 0067 At Auto, should a script a worker wrote or changed run without anyone reading it?

- Status: decided
- Date: 2026-11-15, decided 2026-11-15
- Lenses: architecture
- Builds on: 0034, 0066
- Settles: auto mode and worker-written scripts = where the permission check is on, running a script that is not committed and unchanged from main goes to the check even at Auto; committed project scripts stay allowed

## In short

Once the permission check is on for a project, running a script a worker wrote or changed goes to the check, which reads it first; committed, unchanged project scripts stay allowed at once.

For you:

- Closes the gap where a freshly written script could run unread at Auto
- Those runs wait about 2 to 5 seconds for the check; committed scripts and everything else are unchanged
- Setup: Only applies when the check is on; in shadow it is logged, not enforced
- Hard to undo: Turning the check off restores today's Auto behaviour

## Decision

**A: Worker-written scripts go to the check.** With the check on, a request Auto would allow only because it runs a script inside the project goes to the check when that script (or anything it loads or starts) is not committed and unchanged from main. The check sees the full text or, if it can't, may not allow. In shadow mode the request is allowed as today and the check's answer is logged.

Reason: Matt: 'Sure' (2026-11-15).

## Context

The deep review of the one-shot permission check (decision 66, PR #91) found that at Auto the hub's own rules allow `node <project>/x.mjs` or `bash ./x.sh` for any script inside the project, including one a worker has just written, without reading it (permission-rules.mjs, auto mode). Those requests never reach the check, so its rule that an unread script can't be allowed only protected Ask-level projects. Matt agreed on 2026-11-15. Amends decision 34 for projects where the check is on.

## Options

### A: Worker-written scripts go to the check (chosen) (recommended)

With the check on, a request Auto would allow only because it runs a script inside the project goes to the check when that script (or anything it loads or starts) is not committed and unchanged from main. The check sees the full text or, if it can't, may not allow. In shadow mode the request is allowed as today and the check's answer is logged.
- Pro: No script runs at Auto without either being reviewed code or being read
- Con: A few seconds' wait on those runs; more check calls
- Effort: A small change in routeFor, inside PR #91

### B: Leave Auto as it is

Scripts inside the project keep running unread at Auto; the check only sees what the rules are unsure about.
- Pro: No extra wait
- Con: A worker can run anything by writing it to a file first
- Effort: None

## Recommendation

A (firm). A: it is the gap the plan's script rule was meant to close, at the cost of a few seconds on those runs.

What would change this: If shadow mode shows these runs make up most check calls and are all harmless, revisit with a narrower rule.
