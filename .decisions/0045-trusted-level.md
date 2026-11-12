# 0045 How much more may agents do in a project you trust?

- Status: decided
- Date: 2026-11-12, decided 2026-11-12
- Lenses: architecture
- Builds on: 0021, 0022, 0034
- Settles: agent permission levels = per repo: Ask, Auto, or Trusted (set only from the hub page); fixed stops at every level: force push, history rewrite, branch deletion, push to main, writes outside the project, secrets, the live hub, system-wide installs, outward connector actions

## Decision

**B: A, plus the orchestrator merges after a review.** As A, and in a Trusted project the orchestrator may merge a code pull request once a reviewer has passed it and the tests are green, reporting it in one line. You click-test on main afterwards.

## Context

Matt wants personal projects to give agents more room than work repos. Today each repo is Ask or Auto (decision 34); in Auto, contained work runs on its own, and the hard stops (rules entry R005) are the same in every repo and fixed in code. This decision sets what a third level, Trusted, adds. Whatever is picked, some stops stay at every level (Claude's judgement): force push, rewriting pushed history, deleting branches, pushing straight to main (C005), writes outside the project or its worktrees and temp folders (including ~/.claude and ~/crux), secrets, stopping or restarting the live hub, system-wide installers, and any send, share or delete through mail, calendar or drive (R006). Trusted can be set only from the hub page, never from the repo's own .crux-hub.json, so a cloned repo cannot trust itself. Amends decision 34 and rules entry R005; option B would also change the core rule that merges are always Matt's (decision 22).

## Options

### A: Installs and the open web, merges stay yours (recommended)

Trusted = Auto, plus installing packages into the project (npm, pip) and reading or downloading from any website into the project. Merging to main still comes to you.
- Pro: Removes the cards that slow personal work most (installs, looking things up)
- Pro: Keeps the core rule: you merge after click-testing
- Con: A package or a download can carry bad code into the project; you see it at review, not before
- Effort: Small to medium

### B: A, plus the orchestrator merges after a review (chosen)

As A, and in a Trusted project the orchestrator may merge a code pull request once a reviewer has passed it and the tests are green, reporting it in one line. You click-test on main afterwards.
- Pro: Personal projects move without waiting for your merge word
- Con: Breaks the core rule that you merge after click-testing, for those projects
- Con: Visible changes reach main before you have seen them
- Effort: Medium

### C: No Trusted level for now

Keep Ask and Auto; just move the settings onto the screen (decision 44).
- Pro: Nothing new to trust
- Con: Personal projects keep the same install and web cards as work repos
- Effort: None beyond 44

## Recommendation

A (lean). A removes the cards that slow personal projects without touching the merge rule you settled; B can follow later for a project where you want it.
