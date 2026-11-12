# 0035 Where should Matt's picks from the hub page land?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture
- Builds on: 0002, 0034
- Settles: decision record landing = picks are committed to a standing docs/decisions branch with one rolling PR; never written into the main folder

## Decision

**A: A standing docs branch with one open PR.** The hub writes picks (and the orchestrator's drafts) into a standing worktree on docs/decisions, builds the pages there, commits, pushes, and keeps one rolling pull request open. The board reads the main folder plus the unmerged picks, so a pick shows as decided at once.

Reason: Picks must not write into the main folder (C005).

## Context

Picking a decision in the hub page wrote the record straight into the project's main folder and rebuilt the pages there. Convention C005 says no one works in main, so those files sat uncommitted until someone swept them into a branch. Builds on decision 2 (the board and its records) and decision 34 (agents work in their own folders).

## Options

### A: A standing docs branch with one open PR (chosen) (recommended)

The hub writes picks (and the orchestrator's drafts) into a standing worktree on docs/decisions, builds the pages there, commits, pushes, and keeps one rolling pull request open. The board reads the main folder plus the unmerged picks, so a pick shows as decided at once.
- Pro: The main folder is never touched
- Pro: Matt merges records like any other change
- Pro: Picks show at once
- Con: One more branch and PR to merge from time to time
- Effort: Small

### B: Committed straight to main by the hub

The hub commits each pick to main and pushes it.
- Pro: No PR to merge
- Con: Pushes to main without Matt's review
- Con: Breaks the rule that merges to main need his OK
- Effort: Small

### C: Left uncommitted in the main folder

As before: the record is written into the main folder and the next worker sweeps it into a branch.
- Pro: No change
- Con: Breaks C005
- Con: Records can sit uncommitted and be lost or committed by accident
- Effort: None

## Recommendation

A (strong). Keeps the main folder clean and every record reviewed, at the cost of one rolling PR.
