# 0046 Who decides when a worker hands off before 60%?

- Status: decided
- Date: 2026-11-12, decided 2026-11-12
- Lenses: architecture
- Builds on: 0003, 0010, 0016, 0037
- Settles: worker handoff threshold = orchestrator may hand a worker off from 35% context at the end of a turn, with a one-line reason; automatic at 60%; never below 35%

## Decision

**A: Orchestrator's call between 35% and 60%, at the end of a turn.** Below 35% a worker is never handed off. From 35% the orchestrator may hand a worker off when its turn ends, if it judges a fresh agent cheaper or better; it notes the reason in one line. At 60% the hub still hands off automatically, as today. Never mid-turn.

## Context

Every agent hands off automatically at 60% of its context (decision 10); only the orchestrator also hands off after a long idle stretch (decision 37). Every step re-sends an agent's whole context, so the cost per step grows with it, and quality tends to drop in very long contexts. A fresh worker that reads the board and a handoff is cheaper. Matt wants an adaptive rule: the orchestrator decides when a worker hands off, within general bounds. Today the orchestrator can't see a worker's context level, and it can only retire a worker, not hand its task on. So whichever option is picked, the hub shows each worker's context % (and model) in the orchestrator's agent list, and gives it a hand-off tool that writes the handoff (decision 16) and starts the successor with the same model and effort. Things the orchestrator weighs (Claude's judgement): how much of the task is left, whether the next step needs the current context (a review-fix loop does), the model's price, and whether a lot of what the agent knows is still unwritten. Amends decisions 3 and 10.

## Options

### A: Orchestrator's call between 35% and 60%, at the end of a turn (chosen) (recommended)

Below 35% a worker is never handed off. From 35% the orchestrator may hand a worker off when its turn ends, if it judges a fresh agent cheaper or better; it notes the reason in one line. At 60% the hub still hands off automatically, as today. Never mid-turn.
- Pro: Adaptive, and nothing is ever cut off half done
- Pro: Small build: context % in the agent list plus one hand-off tool
- Pro: The 60% safety net stays
- Con: A worker deep in one long turn still runs to 60% before anyone can act
- Con: Relies on the orchestrator's judgement; a poor call loses some unwritten context
- Effort: Small to medium

### B: A, plus safe points mid-turn

As A. In addition, from 35% the orchestrator may ask a working worker to stop at its next safe point (work committed, tests passed), write its handoff and end the turn, and the successor carries on.
- Pro: Catches long single turns too
- Pro: Still never leaves half-made edits
- Con: The worker has to recognise a safe point and act on the request; more to build and test
- Con: A worker interrupted near the end of its task wastes the handoff
- Effort: Medium

### C: Orchestrator's call at any level, 60% cap

No lower bound: the orchestrator may hand a worker off at the end of any turn; the hub still hands off at 60%.
- Pro: Most freedom
- Con: Easy to churn: handoffs cost tokens to write and read, and early ones save little
- Effort: Small to medium

## Recommendation

A (lean). A gives the orchestrator the discretion with a floor that stops churn and the 60% net that already works; B can follow if long single turns turn out to be where the tokens go.
