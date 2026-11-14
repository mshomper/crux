# 0063 May the Conductor start a project's orchestrator?

- Status: open
- Date: 2026-11-14
- Lenses: architecture
- Builds on: 0010, 0016, 0055, 0060, 0062

## In short

Pick what happens when the Conductor has a request for a project with no orchestrator running. I recommend A: its request starts a fresh orchestrator, which reads the latest handoff first and then answers. Confidence: medium.

For you:

- The Conductor can reach every project, even one whose orchestrator retired or never started; you no longer write in a project's thread just to wake it
- The new orchestrator works under that project's own rules and reads its handoff first, as if you had woken it
- Hard to undo: Changes one limit in decision 55 (the Conductor could not start orchestrators); it still can't start workers, retire anyone, merge or push

## Context

Matt: when an orchestrator retires it writes a handoff, but the successor only starts when he writes in that project's thread, so the Conductor can't wake it. Today a Conductor brief to a project without an orchestrator is refused on purpose (decision 55 A listed 'can't start or stop a project's orchestrator' as its limit), and the life project shows the cost: a tidy-up couldn't be sent. Decision 10 has the hub start the successor when an orchestrator retires; in practice a successor waits for a first message. Decision 62 adds replies to Conductor requests, so a started orchestrator also answers back.

## Options

### A: A Conductor request starts it (recommended)

When the Conductor briefs a project with no orchestrator running, the hub starts one. It reads the project's latest handoff (decision 16) and board index first, then handles the request and replies (decision 62). Nothing starts until the Conductor has something to ask.
- Pro: Costs nothing until needed
- Pro: Every project reachable from the Conductor
- Con: A project you'd left idle on purpose can be woken by a Conductor request (you'd see it in its chat)
- Effort: Small: allow the start in the Conductor's message path, tests

### B: Start successors at retirement

As decision 10 intended: the moment an orchestrator retires, the hub starts its successor, which reads the handoff and waits. Plus A for projects that never had one.
- Pro: A project always has an orchestrator ready
- Con: Uses plan usage for a successor that may sit idle for days
- Effort: Small

### C: Keep it as is

The Conductor tells you which project needs waking; you write in its thread.
- Pro: No change
- Con: You have to step into each project, which the Conductor was meant to spare you
- Effort: None

## Recommendation

A (lean). A makes every project reachable through the Conductor without paying for idle orchestrators, and the new orchestrator still follows its own project's rules and handoff.

What would change this: If you want projects warm and ready at all times, take B.
