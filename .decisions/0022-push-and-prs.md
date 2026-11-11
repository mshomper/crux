# 0022 May the orchestrator and workers push branches and open PRs?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: research
- Builds on: 0007, 0021
- Settles: agent git push authority = agents may push feature branches and open PRs; merge, push to main, force push and branch deletion stay with the human

## Decision

**A: Feature branches and PRs.** The orchestrator or workers may push feature branches and open PRs. Merging, pushing to main, force-pushing and deleting branches stay with Matt.

Reason: Pushing and opening PRs is a task that you or the workers can do

## Context

Decision 7 kept push, merge and delete with Matt. Pushing a feature branch and opening a PR is low risk (a PR is easy to close) and was costing Matt busywork. Amends decision 7 on push only; merging and deleting stay with Matt.

## Options

### A: Feature branches and PRs (chosen) (recommended)

The orchestrator or workers may push feature branches and open PRs. Merging, pushing to main, force-pushing and deleting branches stay with Matt.
- Pro: Removes the push busywork
- Pro: A PR is easy to close
- Con: Work becomes visible on GitHub without a fresh OK
- Effort: Small

### B: Push only when told

Push a branch only when Matt says so in chat.
- Pro: Matt sees every push
- Con: Still a message per branch
- Effort: Small

### C: Keep decision 7 as is

All pushes go to Matt.
- Pro: Nothing leaves the machine without Matt
- Con: Busywork for Matt
- Effort: None

## Recommendation

A (lean). Saves the most busywork; merging is the step that matters and it stays with Matt.
