# 0015 What goes in your profile, and what does each agent load?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: data-model
- Builds on: 0013, 0014
- Settles: agent profile loading = short core loaded by every agent; one pack per project loaded only in that project; private section read only when a task needs it; new lessons dated and filed, core changes approved in a batch

## Decision

**B: Core plus project packs.** A short core every agent loads: how to talk to you, how approval and testing work, UI rules, git habits, and the boundaries between projects (stated as rules, without the confidential specifics). A pack per project, loaded only by agents in that project. Personal and contract details sit in a private section that agents read only when a task needs it. New lessons are dated and filed to the right place; changes to the core come to you as a batch.

## Context

The Claude.ai export is about 400 lines across 17 sections, and Claude Code memory holds 45 lessons about how you work. Loading all of it into every agent costs start-up context and puts private details in front of agents that are working on public repos. The orchestrator mainly needs your requirements: how you want work done and approved.

## Options

### A: One file, everyone loads it all

Merge everything into one profile; every agent reads it at start.
- Pro: Simplest
- Pro: No agent ever misses anything
- Con: Every agent pays for 400+ lines it mostly does not need
- Con: Private and confidential details reach agents on public repos, which can leak into commits or docs
- Effort: Small

### B: Core plus project packs (chosen) (recommended)

A short core every agent loads: how to talk to you, how approval and testing work, UI rules, git habits, and the boundaries between projects (stated as rules, without the confidential specifics). A pack per project, loaded only by agents in that project. Personal and contract details sit in a private section that agents read only when a task needs it. New lessons are dated and filed to the right place; changes to the core come to you as a batch.
- Pro: Small, fast start for every agent
- Pro: Private details stay out of unrelated work
- Pro: The orchestrator gets exactly your requirements
- Con: Packs need curating
- Con: An agent can miss something that was filed in the wrong pack
- Effort: Medium

### C: Core only; project knowledge moves to boards

Keep just the core in the profile. Each project's knowledge becomes requirements and conventions on that project's board.
- Pro: One source of truth per project
- Pro: Profile stays tiny
- Con: Only works where the hub runs; plain Claude Code or Claude.ai sessions lose the project context
- Con: A lot of seeding up front
- Effort: Large

## Recommendation

B (strong). The orchestrator needs your requirements, not your biography. A short core plus the right project pack gives it that, and keeps confidential material away from agents that have no reason to see it.
