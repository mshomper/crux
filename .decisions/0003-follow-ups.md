# 0003 When the orchestrator sends work back, which agent gets it?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture
- Builds on: 0001, 0007

## Decision

**C: Same for fixes, new for new scope.** Fixes go back to the same agent; new scope, or an agent near its context limit, gets a new agent that starts from the board and a handoff memo.

## Context

After reading a summary, the orchestrator sends an agent back for fixes or the next step. It can continue with the same agent, which keeps context but grows long, or start a new one from the board, which is clean but loses what the agent learned.

## Options

### A: Always the same agent

Fixes and next steps go back to the agent that did the work.
- Pro: Keeps what the agent learned
- Con: Long agents slow down and lose focus
- Effort: None

### B: New agent per step

Each next step starts a new agent that reads the board.
- Pro: Clean context; tests the board
- Con: Loses short-term context
- Con: More threads
- Effort: Small

### C: Same for fixes, new for new scope (chosen) (recommended)

Fixes go back to the same agent; new scope, or an agent near its context limit, gets a new agent that starts from the board and a handoff memo.
- Pro: Context where it helps, clean starts where not
- Pro: Workers retire the same way orchestrators do
- Con: The orchestrator must judge when to split
- Effort: Small

## Recommendation

C (lean). The same retire-and-handoff rule as the orchestrator role, applied to workers: fixes stay, new scope starts clean from the board.
