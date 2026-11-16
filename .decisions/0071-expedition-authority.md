# 0071 What may an expedition do without asking Matt?

- Status: open
- Date: 2026-11-16
- Lenses: architecture
- Builds on: 0021, 0022, 0034, 0045, 0066
- Settles: autonomous job authority = an expedition never raises a card: unclear requests go to the permission check or are parked, hard stops are denied, merging is blocked; the launch is the OK for one branch push and draft PR

## In short

Should an expedition never reach you mid-run? Unclear requests would go to the permission check or be parked, destructive or outside-project ones denied, and at the end the hub pushes one branch and opens a draft PR. I recommend yes, as your spec describes; it makes exceptions to the older permission and push rules, for expeditions only.

For you:

- No cards or phone notices during a run; parked items show as a small amber count on the cluster and in the report
- Launching counts as your OK for that one branch push and draft PR; it never merges
- When it ends, its agents are retired at once, without waiting for your review on main
- Setup: The project must be at Auto or Trusted; at Ask the hub refuses to launch and says why

## Context

Described in Matt's Expedition module spec (2026-11-15, sections 1, 4.6 and 4.8; memo M044). It makes a deliberate exception, for expedition agents only, to: hard stops go to Matt (decisions 21, 34, 45, 66, R005); each push and PR needs Matt's OK (decision 22); keep workers until Matt has reviewed on main (C007). Scoping and the advisor checkpoint (2026-11-16) found the exceptions; they are keyed on the agent's expedition tag, which only the hub sets.

## Options

### B: Hard stops still come to Matt

Expedition agents follow today's rules: hard stops and the final push come to Matt as cards; everything else as in A.
- Pro: No exception to the older permission and push rules
- Con: Cards mid-run, and a run can stall waiting on Matt
- Effort: Smaller

### A: As the spec says (recommended)

For expedition agents: unclear requests go only to the one-shot check (allow runs, anything else is parked), never to the orchestrator; hard stops are denied without a card; a pause denies with 'wait'; merging is blocked even with a pass; at the end the hub pushes expedition/<id> and opens a draft PR; agents are retired when it stops.
- Pro: Matt is never pulled in mid-run; the orchestrator stays free
- Con: More work parks in a project where the check is off; the launch screen warns about it
- Effort: Part of phases 2, 4 and 5

## Recommendation

A (firm). A: Matt's spec.

What would change this: If parked items keep hiding things Matt needed to know (such as licence questions), add a quiet line for a short named list.
