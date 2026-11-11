# 0007 What may the orchestrator decide on its own?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: research, architecture
- Builds on: 0009
- Settles: orchestrator authority = routine answers and fixes alone; architecture-level choices as decision cards; push, merge and delete always to the human

## Decision

**B: Crux line.** It answers questions and sends fixes and next steps within the agreed requirements. Anything Crux would stop for (new dependency, data model, multi-module change, product direction, contradicting an active decision) comes to you as a decision card. Pushing, merging and deleting always come to you.

## Context

Whichever agent holds the orchestrator role reads summaries, answers questions and sends agents back. The line between what it settles and what reaches you is the heart of the hub, and the place where Crux's rule (Claude does the work around the decision, you make the call) applies. The rule must live on the board so every successor follows it.

## Options

### A: Drafts, you approve

Every reply is drafted for your approval.
- Pro: Nothing happens without you
- Con: You are the bottleneck again
- Effort: Small

### B: Crux line (chosen) (recommended)

It answers questions and sends fixes and next steps within the agreed requirements. Anything Crux would stop for (new dependency, data model, multi-module change, product direction, contradicting an active decision) comes to you as a decision card. Pushing, merging and deleting always come to you.
- Pro: A rule Crux already states
- Pro: Every escalation becomes a board entry
- Con: It will sometimes misjudge what is architecture-level
- Con: Needs a digest so you can audit
- Effort: Small

### C: Budgeted autonomy

Free within limits (rounds, cost, no push or merge), with a digest.
- Pro: Fastest
- Con: Real decisions slip past
- Effort: Small

## Recommendation

B (strong). Crux's rule applied to a new reader: routine answers flow, real decisions stop for you as cards, irreversible actions never leave your hands.
