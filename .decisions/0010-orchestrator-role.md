# 0010 How does the orchestrator role pass from one agent to the next?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture
- Builds on: 0009

## Decision

**A: Retire at a threshold.** The orchestrator watches its own context; past a set size, or on your word, it writes a handoff memo, closes or reassigns its threads, and the hub starts its successor.

## Context

The orchestrator is a role, not a session. When an agent's context grows large it should retire and a new one take over seamlessly, with the board as the shared memory. The question is when and how the swap happens.

## Options

### A: Retire at a threshold (chosen) (recommended)

The orchestrator watches its own context; past a set size, or on your word, it writes a handoff memo, closes or reassigns its threads, and the hub starts its successor.
- Pro: Keeps context between rounds while it is cheap to
- Pro: One clear moment to check the handoff memo
- Con: Anything not yet written to the board is lost if it crashes
- Con: Needs a reliable sense of its own context size
- Effort: Small to medium

### B: Stateless: new agent every round

Every time there is something to handle, the hub starts a fresh orchestrator that reads the board index, acts, writes back and exits.
- Pro: Nothing ever lives only in a context, so no handoff can go wrong
- Pro: Forces the board to be complete
- Con: Re-reads the board every round: more tokens and slower
- Con: Loses the short-term thread of a busy hour
- Effort: Small

### C: Overlap handoff

At the threshold, the successor starts, reads the board and memo, and shadows one round; the old orchestrator answers its questions, then retires.
- Pro: Catches whatever the memo missed
- Pro: Smoothest for you: no gap in the conversation
- Con: Two orchestrators at once need a rule for who answers
- Con: Costs a round of double work
- Effort: Medium

## Recommendation

A (lean). Retiring at a threshold keeps cheap context while it helps and makes the handoff memo the single checkpoint; requiring every decision and requirement to hit the board as it happens covers the crash case.

What would change this: If the board index stays small enough to read every round cheaply, stateless (B) is simpler and safer.
