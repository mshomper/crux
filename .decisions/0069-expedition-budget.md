# 0069 How does "7% of the plan" become a budget the hub can stop on?

- Status: decided
- Date: 2026-11-16, decided 2026-11-16
- Lenses: architecture
- Builds on: 0036, 0065
- Settles: agent job budget cap = enforced in estimated dollars from a human-confirmed dollars-per-plan-percent figure, with a plan-meter guard beside it; spend counted during turns

## In short

Should the hub turn the budget percentage into dollars using one figure, dollars per 1% of your week, which it estimates from the logs and you confirm once? I recommend it, with the plan-meter guard beside it: you keep thinking in percent, and the launch screen shows the dollar figure before you launch.

For you:

- The launch screen shows the budget as a percentage with its dollar figure beside it; the run stops at whichever trips first: that dollar figure, or your week's meter rising by that many points
- Rough figures from Crux's own log: about $9 per point, so 7% is about $63; a full 6-hour run is estimated at $45 to $130 (judgement, not measured), so 7% may stop some runs early. Per-role costs get measured on the first small test run
- Spend counts while turns are still running, and stopped agents' last turns are counted, so the stop isn't late
- Setup: Once: keep or change the hub's estimate of dollars per 1% (one number in hub.json)
- With an API key the meters hide, so the screen shows dollars only

## Decision

**C: One confirmed figure, plus the meter guard.** The hub suggests dollars per 1% of your week from the logs; you keep or change it once. The cap is enforced in dollars, and the plan-meter guard (up 7 points since launch) runs beside it.

## Context

Spec section 12, question 1 (memo M044). The hub logs each turn's estimated list-price cost; the plan meter is polled every 5 minutes in tenths of a point and also moves with other work. Crux's own log gives a rough figure (first pass about $2.7 per point, second pass about $9, swinging widely per stretch); other projects' logs are not read. The advisor checkpoint (2026-11-16) found that spend shows only at turn end and that stopped turns are never logged; the build fixes both (spend counted during the turn; agents interrupted, then retired).

## Options

### A: A dollar figure you set once

The envelope is set in dollars, for example $20, not percent.
- Pro: Simple and exact
- Con: Not tied to your plan; you think in percent
- Effort: Small

### B: The hub calibrates by itself

The hub keeps measuring how far the meter moves per dollar and converts the percentage silently.
- Pro: Matches the spec's wording
- Con: The log is too noisy for this; a wrong factor over- or under-spends without you seeing it
- Effort: Medium

### C: One confirmed figure, plus the meter guard (chosen) (recommended)

The hub suggests dollars per 1% of your week from the logs; you keep or change it once. The cap is enforced in dollars, and the plan-meter guard (up 7 points since launch) runs beside it.
- Pro: You think in percent and see the dollars; two guards, as the spec wants; nothing hidden
- Con: One number to confirm, and it may need adjusting after the first runs
- Effort: Medium, inside the watchdog phase

## Recommendation

C (medium). C: keeps 'percent' as the thing you set while the stop works on dollars it can actually measure.

What would change this: If the first runs show the meter guard always trips first, the dollar figure can be raised; if the reverse, lowered.
