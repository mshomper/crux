# 0068 Where does an expedition's team run: as hub agents under a Lead, or inside one agent?

- Status: open
- Date: 2026-11-16
- Lenses: architecture
- Builds on: 0020, 0065, 0066
- Settles: multi-agent job structure = a long-running team job runs each role as a visible hub agent under a lead with tools scoped to its own team

## In short

Should each expedition role run as its own hub agent, started by a Lead with a few scoped tools, rather than as hidden helpers inside one agent? I recommend hub agents, as your spec does: you see the whole team on the map and the report's figures are measured, not guessed.

For you:

- Each running expedition shows as one cluster on the live map and one folded row in the thread list; you can open any member
- Time, tokens and cost per role in the report come from the log, so the budget stop and the figures are real
- The orchestrator stays out of it until the one summary at the end
- Setup: Nothing to set up; the seven role files ship with the hub's starter types

## Context

Matt's Expedition module spec (2026-11-15, memo M044) leaves this open (section 12) and recommends a hub worker with scoped tools (section 4.1). The reference run used Claude Code subagents. Scoping (2026-11-16) found the subagent route can't meet two of the spec's own guarantees: usage per role (the SDK reports usage per model, not per subagent) and per-agent permission and freeze rules. The advisor checkpoint agreed with A.

## Options

### A: Hub agents under a Lead (recommended)

The orchestrator starts the Lead; the Lead starts the other roles as normal hub agents with four tools limited to its own expedition (start, message, retire, list). Every role has a thread, logs its own usage and goes through the permission check.
- Pro: Whole team visible on the map; measured cost per role; per-agent rules for the frozen test and no-merge
- Con: The largest build (phase 2 of 6); 7 to 10 agents per run need folding in the thread list
- Effort: Large: about two modules

### B: Helpers inside one agent

One hub agent, the Lead, runs every role as a Claude Code subagent, as in the reference run.
- Pro: Least hub work
- Con: Roles invisible on the map; cost per role can't be measured; every permission request lands on the Lead
- Effort: Small

### C: Mixed

Hub agents for Builder, Verifier, Skeptic and Advisor; gatherers as helpers inside the Lead.
- Pro: Fewer threads
- Con: The gatherers are the ones browsing the web, so their requests and spend are the part you most want separated
- Effort: Medium

## Recommendation

A (firm). A, as the spec recommends: it is the only option that keeps the budget stop and the per-role figures honest.

What would change this: If the phase 2 build turns out far larger than planned, a short B spike could come first, but not as the version you rely on.
