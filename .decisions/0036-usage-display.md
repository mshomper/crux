# 0036 How does the hub show Matt's usage?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: data-model, ui
- Builds on: 0002, 0017, 0020, 0031
- Settles: usage display = plan meters (5-hour, 7-day, per-model incl. Fable) in the always-on strip from the SDK usage method plus rate_limit events, per-turn usage events in the log, a usage panel on click; hide quietly if the experimental call fails

## Decision

**A: Plan meters plus per-model totals.** A hub-wide poller reads plan usage every few minutes through the experimental call and listens for rate_limit events. A usage event per turn goes into the append-only log, so totals survive restarts. The always-on strip carries 5-hour, 7-day and Fable meters, with a usage panel on click. If the experimental call fails, the meters hide quietly.

## Context

Matt wants to see his plan usage, and Fable usage in particular, in the hub's visual display. The Agent SDK gives per-turn tokens and estimated cost per model (stable), and the plan limits behind /usage (5-hour, 7-day, per-model weekly windows with reset times) through a method marked experimental, plus rate_limit events. The hub keeps none of it today.

## Options

### A: Plan meters plus per-model totals (chosen) (recommended)

A hub-wide poller reads plan usage every few minutes through the experimental call and listens for rate_limit events. A usage event per turn goes into the append-only log, so totals survive restarts. The always-on strip carries 5-hour, 7-day and Fable meters, with a usage panel on click. If the experimental call fails, the meters hide quietly.
- Pro: Answers how close Matt is to his limits, including Fable
- Pro: Totals survive restarts
- Pro: Degrades quietly
- Con: Relies on an experimental SDK method
- Con: Medium effort
- Effort: Medium

### B: Per-model totals only

Stable data only: today's and the session's tokens and estimated cost per agent and model, in a panel.
- Pro: Stable features only
- Con: No plan percentages or reset times
- Effort: Small

### C: Limit warnings only

No meters; an amber notice near a limit, red when work is blocked.
- Pro: Least effort
- Con: Least information
- Effort: Small

## Recommendation

A (lean). It answers what Matt asked, including Fable, and the quiet fallback makes the experimental risk acceptable.
