# 0011 How much of the board does a new agent read before it starts?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture, data-model
- Builds on: 0009
- Settles: agent start-up reading = one-line index, project brief and latest handoff; full entries on demand

## Decision

**B: Index first, details on demand.** Every agent reads a short index (one line per active entry), the project brief and the latest handoff; it opens full entries with a tool when it needs them.

## Context

The board only grows. A new orchestrator or worker needs enough to act correctly without spending its context on history. This sets the reading rule for every agent the hub starts.

## Options

### A: All active entries

Every entry that is not superseded or retired, in full.
- Pro: Nothing relevant is missed
- Pro: Simple rule
- Con: Grows without limit; eventually too big to load
- Con: Most of it irrelevant to any one task
- Effort: Small

### B: Index first, details on demand (chosen) (recommended)

Every agent reads a short index (one line per active entry), the project brief and the latest handoff; it opens full entries with a tool when it needs them.
- Pro: Small, predictable start-up cost
- Pro: Same pattern Crux and Claude's own memory use
- Con: An agent may skip an entry it should have opened
- Con: The one-line summaries must be good
- Effort: Small to medium

### C: Role and area digests

Entries are tagged by area; the orchestrator reads the whole index, workers read only entries for their area, plus anything marked project-wide.
- Pro: Workers start lean
- Pro: Scales to large projects
- Con: Tagging has to be right, or a worker misses a constraint
- Con: More rules to explain
- Effort: Medium

## Recommendation

B (lean). An index plus the brief and handoff keeps start-up small however big the board gets; area tags (C) can be layered on once projects get large.
