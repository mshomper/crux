# 0034 How much may agents do without asking, per repo?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture
- Builds on: 0007, 0021, 0022
- Settles: agent permission mode = per-repo auto mode: anything contained to the project folder, worktree or temp folder is allowed without asking; hard stops (merge, push to main, force push, branch deletion, history rewrite, installs, writes outside the project, network beyond GitHub, secrets, the live hub) go to the human

## Decision

**A: Auto mode per repo.** A per-repo hub setting (auto, on for this repo). The hub allows at once anything whose effects stay inside the project folder, the agent's worktree or its own temp folder: edits, builds, tests, scripts, local git, feature-branch pushes and PRs, test hubs on other ports. Hard stops still go to Matt. The orchestrator is asked only about requests the hub can't classify, with the 2-minute fallback to Matt. Repos without the setting behave as in decision 21.

Reason: Act like Claude Code sessions under auto: broad authority for anything that touches their workflow inside their folder; fine to set it per repo.

## Context

Under decision 21 every non-read request went to the orchestrator for judgment. The flood of approvals showed that is still too much friction. Matt wants agents to behave like Claude Code sessions in auto mode: broad authority for anything in their workflow inside their folder, set per repo. Amends decision 21 (the orchestrator now handles only what the hub can't classify) and works within decisions 7 and 22.

## Options

### A: Auto mode per repo (chosen) (recommended)

A per-repo hub setting (auto, on for this repo). The hub allows at once anything whose effects stay inside the project folder, the agent's worktree or its own temp folder: edits, builds, tests, scripts, local git, feature-branch pushes and PRs, test hubs on other ports. Hard stops still go to Matt. The orchestrator is asked only about requests the hub can't classify, with the 2-minute fallback to Matt. Repos without the setting behave as in decision 21.
- Pro: Approvals nearly vanish
- Pro: Hard-to-undo actions still reach Matt
- Pro: Matt opts in per repo
- Con: Less review of ordinary commands
- Con: Relies on the hard-stop matcher being conservative
- Effort: Small on top of decision 21's work

## Recommendation

A (strong). Matt's own call.
