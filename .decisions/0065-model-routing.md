# 0065 Which model and effort does each agent run at, and how does the hub track it?

- Status: decided
- Date: 2026-11-15, decided 2026-11-15
- Lenses: architecture, data model
- Builds on: 0007, 0010, 0020, 0036, 0046, 0055
- Settles: agent model and effort routing = Sonnet medium default worker; Opus medium orchestrators; Opus high only for named hard-reasoning work; Fable as a one-shot advisor; Haiku for clerical work; raise one step after two failed attempts, change model before going past high, xhigh only on the ladder, max only by the human

## In short

Matt's own routing guide (v2): Sonnet at medium as the default worker, Opus kept for orchestrators (at medium) and named hard-reasoning work, Fable only as a one-shot advisor, Haiku for clerical work, with an escalation ladder; the hub tags usage by agent type and logs each raise so the routing can be measured.

For you:

- Workers default to Sonnet at medium; extra-high only comes from climbing the ladder, max only when you pick it
- 16 agent types in your home agents folder (calendar types only in the life project); routing rules in your profile
- The usage panel will show spend by type, advisor calls this week, and how often tasks finish at their starting type
- Setup: Orchestrators hand off at 30% (your setting); workers keep their own 60% mark
- Hard to undo: Defaults and types are plain files: easy to change back

## Decision

**A: Matt's routing guide, in full.** Defaults: Conductor Sonnet medium, orchestrator Opus medium, worker type implementer (Sonnet medium). 16 types (implementer, quick-fix, solver, test-writer, reviewer, deep-reviewer, advisor, researcher, gatherer, synthesizer, doc-editor, doc-reviewer, clerk, task-organizer, calendar-reader, calendar-planner). Ladder: clerk, quick-fix, implementer, implementer high, solver (Opus high), solver xhigh, advisor, then stop and tell Matt. Hub: usage events carry agentType, model and effort; post_summary gains an optional outcome; set_agent_settings logs raises with a reason; advisor calls counted; Fable amber warns orchestrators; effort refused by a model falls back to the highest it accepts.

Reason: Usage is the binding constraint; reviews catch problems anyway, so start cheaper.

## Context

Matt wrote 'Crux Hub - Model and Effort Routing Guide' v2 (2026-11-14) and asked for it to be implemented in full. On 14 Nov Opus was 90.7% of estimated spend (about $393 of $434), the crux orchestrator alone 28% of tokens, and 98% of tokens were cache re-reads of long contexts. Sections 3 to 7 (defaults, types, routing tables, ladder) are settings and profile text; section 9 adds hub code: effort ceiling per model, type and outcome on usage events, a raise log on set_agent_settings, advisor notice and count, a Fable meter warning to orchestrators, plus a neutral starter set and profile template in the public repo. Replaces the earlier rules of hub UI at high and permission checker work at Opus xhigh.

## Options

### A: Matt's routing guide, in full (chosen) (recommended)

Defaults: Conductor Sonnet medium, orchestrator Opus medium, worker type implementer (Sonnet medium). 16 types (implementer, quick-fix, solver, test-writer, reviewer, deep-reviewer, advisor, researcher, gatherer, synthesizer, doc-editor, doc-reviewer, clerk, task-organizer, calendar-reader, calendar-planner). Ladder: clerk, quick-fix, implementer, implementer high, solver (Opus high), solver xhigh, advisor, then stop and tell Matt. Hub: usage events carry agentType, model and effort; post_summary gains an optional outcome; set_agent_settings logs raises with a reason; advisor calls counted; Fable amber warns orchestrators; effort refused by a model falls back to the highest it accepts.
- Pro: Cuts the biggest cost (Opus workers at high) while keeping Opus where judgment matters
- Pro: Makes the routing measurable
- Con: Sonnet-first may need more raises on hard tasks; the raise log shows how often
- Effort: Settings done; hub changes one Sonnet worker

## Recommendation

A (firm). Matt's own plan, implemented as written.

What would change this: If the raise log shows tasks of one kind regularly climbing past implementer, lower that kind's starting point; if they pass first time five times running, propose lowering a type's default.
