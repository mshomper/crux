# 0002 How do many agents write to the board without clobbering each other?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: data-model, architecture
- Builds on: 0009
- Settles: shared agent state writes = append-only event log; entries and index rebuilt from it

## Decision

**C: Append-only event log.** Every action (a message, a pick, a new requirement) is appended as an event; entries and the index are rebuilt from the log, as Crux pages are rebuilt from JSON today.

## Context

Orchestrators, workers and you will all post to the board at once: decisions, requirements, memos, thread messages. Crux today has one writer at a time and regenerates pages from JSON records.

## Options

### A: Any agent edits any entry

Agents read, change and save entries directly; last save wins.
- Pro: Simplest
- Con: Lost updates when two agents save together
- Con: No record of who changed what
- Effort: Small

### B: Orchestrator curates

Only the current orchestrator writes board entries; workers and you post into threads and it turns them into entries.
- Pro: One writer, consistent entries
- Con: Your own picks wait for the orchestrator
- Con: The orchestrator becomes a bottleneck
- Effort: Small

### C: Append-only event log (chosen) (recommended)

Every action (a message, a pick, a new requirement) is appended as an event; entries and the index are rebuilt from the log, as Crux pages are rebuilt from JSON today.
- Pro: No lost updates: appends never collide
- Pro: Full history of who did what, for free
- Pro: Messages and memory share one log
- Con: A rebuild step between log and board
- Con: Needs care to keep rebuilds fast as the log grows
- Effort: Medium

## Recommendation

C (lean). An append-only log makes concurrent writers safe and gives the conversation and the memory one source; it is the same records-in, pages-out pattern Crux already uses.
