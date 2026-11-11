# 0013 How does the memory keep growing without becoming unreadable?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: data-model, architecture
- Builds on: 0009, 0011
- Settles: agent memory layers = three layers: personal profile, cross-project conventions, project board; agents load each index first; tidy-ups and promotions proposed at every orchestrator handoff, profile changes batched for the human

## Decision

**B: Three layers, tidied at each handoff.** You (profile), all projects (conventions), this project (board). Agents load the three short indexes. When an orchestrator hands off, it also proposes tidy-ups: merge old memos, retire stale ones, and promote anything that holds beyond this project up a layer. Promotions into your profile come to you as one batch card.

## Context

Today each project has a board (decisions plus typed entries), and the Crux roll-up keeps a cross-project conventions list. Nothing yet holds what is known about you, and nothing tidies the board as it grows. Every new orchestrator reads the indexes first, so their size is what each agent pays to get started.

## Options

### A: Project boards only

Keep what exists. Each board grows on its own; the index-first loading from decision 11 keeps start-up cost down. Your profile is a separate file agents are told to read.
- Pro: No new moving parts
- Pro: Each project stays self-contained
- Con: A lesson learned in one project never reaches the others
- Con: Old memos pile up; nobody merges them
- Con: The profile is outside the system, so it goes stale
- Effort: None

### B: Three layers, tidied at each handoff (chosen) (recommended)

You (profile), all projects (conventions), this project (board). Agents load the three short indexes. When an orchestrator hands off, it also proposes tidy-ups: merge old memos, retire stale ones, and promote anything that holds beyond this project up a layer. Promotions into your profile come to you as one batch card.
- Pro: Lessons travel: a rule learned on Ebb reaches AcuLoad
- Pro: Tidying rides on handoffs, which already happen, so no extra agent or schedule
- Pro: You only see changes to your own profile, batched
- Con: Handoffs get a little longer
- Con: Tidy-ups only happen as often as handoffs do
- Effort: Medium

### C: Three layers plus a librarian agent

Same layers, but a separate low-cost agent runs on a schedule (say nightly) to turn the event log into entries, merge duplicates and propose promotions.
- Pro: Board stays tidy even on projects with few handoffs
- Pro: Can catch things the orchestrator never wrote down
- Con: One more agent spending your plan on a schedule
- Con: Reads everything, so it can promote things you never meant to keep
- Con: More to build and to trust
- Effort: Large

## Recommendation

B (lean). It gives the memory somewhere to grow (upward) and a regular moment to tidy itself, without a new scheduled agent. A librarian can be added later if boards outgrow handoffs.
