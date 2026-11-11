# 0021 Who answers the agents' permission requests?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture, research
- Builds on: 0007, 0019
- Settles: agent permission authority = orchestrator answers permission prompts within human-set rules; push, merge, delete, installs, outside-project and network always go to the human; every answer logged

## Decision

**A: Orchestrator answers within rules Matt sets.** Requests go to the orchestrator first. A rules entry on the board says what it may allow (build, test, read, edits inside the project, local commits). Push, merge, delete, package installs, anything outside the project folder and network access always go to Matt. Every answer is logged in the orchestrator's thread, and Matt can change or revoke the rules at any time.

Reason: A is perfect

## Context

Every permission prompt from every agent (bash commands, file edits and so on) goes to Matt today, which makes him the bottleneck. The idea was always that these reach the orchestrator, which answers them under authority Matt grants, while he watches and can review. Extends decision 7: push, merge and delete stay with Matt.

## Options

### A: Orchestrator answers within rules Matt sets (chosen) (recommended)

Requests go to the orchestrator first. A rules entry on the board says what it may allow (build, test, read, edits inside the project, local commits). Push, merge, delete, package installs, anything outside the project folder and network access always go to Matt. Every answer is logged in the orchestrator's thread, and Matt can change or revoke the rules at any time.
- Pro: Removes almost all bash prompts
- Pro: Hard-to-undo actions stay with Matt
- Pro: Every answer is logged for audit
- Con: The orchestrator may misjudge a borderline request
- Effort: Medium

### B: Fixed allowlist, no judgment

The hub auto-approves anything matching a pattern list; the rest still goes to Matt.
- Pro: Predictable
- Con: Every new command shape is another prompt
- Con: Lists tend to grow loose
- Effort: Small

### C: Orchestrator answers everything except a short block list

Only push, merge, delete and work outside the project reach Matt.
- Pro: The fewest prompts
- Con: Installs and network access pass without Matt seeing them
- Effort: Small

## Recommendation

A (lean). Removes almost all the bash prompts while keeping Matt in charge of anything hard to undo, with a log to audit. B can be added later as a fast path for obviously safe commands.
