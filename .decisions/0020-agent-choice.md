# 0020 How do you choose each agent's model, effort and kind?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture, ui
- Builds on: 0007, 0010
- Settles: agent model and effort display = model as hue (Opus violet, Sonnet cyan, Haiku pink, Fable copper), effort as five pips in that hue; kept clear of red/amber/green/blue status colours; agent types = Claude Code agent files (.claude/agents/*.md, home or project) with model, effort, tools and standing instructions; per-agent picks override

## Decision

**B: Agent types, plus per-agent picks.** Everything in A, plus named agent types: "reviewer", "quick fix", "researcher" and so on, each with its model, effort, tool limits and standing instructions. They are written in Claude Code's own agent file format, so the same types work in plain Claude Code too, and live in your home folder (all projects) or a project (that project only). The orchestrator sees the list and picks a type for each subtask, or you name one ("put a reviewer on it").

Reason: Colours look good, go with your proposal.

## Context

Every hub agent today runs Claude Code's default (Opus 5.5) at default effort, orchestrator and workers alike. The Agent SDK the hub uses can set a model and an effort level per agent, switch a running agent's model, and run named agent types that carry their own model, tool limits and standing instructions. The question is how you make those choices, and how much the orchestrator may make on its own. Whichever option: every agent shows its model and effort in colour, on its thread, in the sidebar and on the live map. Each model has its own hue (Opus violet, Sonnet cyan, Haiku pink, Fable copper, chosen to stay clear of the hub's red, amber, green and blue status colours), and effort is a row of five pips in that hue, more of them lit the higher the effort.

## Options

### A: Pick per agent

A model and effort picker when you start an agent, defaults per role (orchestrator, worker) in the hub's settings, and a switch on each thread to change a running agent's model. The orchestrator can set model and effort when it starts a worker, and you can tell it which in plain words.
- Pro: Direct and easy to understand
- Pro: Everything you asked for is choosable
- Pro: Small to build
- Con: Each choice is made from scratch every time
- Con: No shared idea of "a reviewer" or "a quick fixer" to reuse
- Effort: Small

### B: Agent types, plus per-agent picks (chosen) (recommended)

Everything in A, plus named agent types: "reviewer", "quick fix", "researcher" and so on, each with its model, effort, tool limits and standing instructions. They are written in Claude Code's own agent file format, so the same types work in plain Claude Code too, and live in your home folder (all projects) or a project (that project only). The orchestrator sees the list and picks a type for each subtask, or you name one ("put a reviewer on it").
- Pro: Good choices are made once and reused
- Pro: The orchestrator can match the kind of agent to the subtask
- Pro: Shared with plain Claude Code sessions
- Pro: Per-agent picks still override anything
- Con: A few type files to write and keep
- Con: More for the orchestrator to weigh
- Effort: Medium

### C: The orchestrator decides from your rules

No pickers. Your core profile gets rules ("tricky or shared-system work: Opus at high effort; mechanical edits: a lighter model") and the orchestrator chooses for each worker. You override by saying so in chat.
- Pro: Nothing extra to click
- Pro: Choices follow your stated preferences
- Con: Choices happen out of sight unless shown
- Con: Harder to pin a specific model when you want one
- Effort: Small

## Recommendation

B (lean). You asked for everything to be choosable, and A gives that. Types are what let the orchestrator "spin up a reviewer" sensibly without you spelling out a model every time, and keeping them in Claude Code's own format means your other sessions benefit too. Each agent's model and effort would also show on its thread and on the live map.
