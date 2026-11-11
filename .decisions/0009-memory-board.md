# 0009 What lives on the memory board, and in what shape?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: data-model, architecture
- Builds on: 0006
- Settles: long-term agent memory = typed JSON entries (decision, requirement, convention, memo, thread) sharing the Crux status lifecycle; superseded, never deleted

## Decision

**B: Typed entries, one lifecycle.** Every entry is a JSON record with a type (decision, requirement, convention, memo, thread), a status lifecycle like decisions have, links between entries, and a one-line summary for the index.

## Context

The board is the long-term memory every agent reads: it is what lets an orchestrator retire and a new one pick up without loss. Crux's .decisions folder already does this for decisions (JSON records, a status lifecycle, superseded instead of deleted, readable summaries). The question is how far to widen it.

## Options

### A: Decisions plus free memos

Keep .decisions as it is and add a memos folder of plain Markdown notes (handoffs, requirements, how-to-work-here).
- Pro: Smallest change to Crux
- Pro: Memos are easy to write
- Con: Requirements and handoffs have no lifecycle, so they rot silently
- Con: Hard to build an index or interface on free text
- Effort: Small

### B: Typed entries, one lifecycle (chosen) (recommended)

Every entry is a JSON record with a type (decision, requirement, convention, memo, thread), a status lifecycle like decisions have, links between entries, and a one-line summary for the index.
- Pro: Everything can be superseded, parked or retired the same way
- Pro: One index and one interface for all of it
- Pro: Decisions can point at the requirements they serve
- Con: A schema to design and keep stable
- Con: Agents must write structured entries, not just notes
- Effort: Medium

### C: Living topic pages

A small wiki per project: one page per topic (architecture, data model, requirements) that agents keep editing, with decisions linked from them.
- Pro: Reads like documentation
- Pro: Compact: one page per topic, not hundreds of entries
- Con: Edits overwrite history unless versioned
- Con: Several agents editing one page collide
- Con: Loses Crux's nothing-is-deleted rule
- Effort: Medium

## Recommendation

B (lean). It is the Crux record widened to every kind of memory: one shape, one lifecycle, one index, and the nothing-is-deleted rule extends to requirements and handoffs for free.
