# 0055 What may the Conductor, the agent above the project orchestrators, do?

- Status: decided
- Date: 2026-11-13, decided 2026-11-14
- Lenses: architecture, research and product
- Builds on: 0007, 0010, 0016, 0037, 0042
- Settles: cross-project agent authority = a Conductor above the project orchestrators reads every project and routes requests to orchestrators; it never edits, merges, pushes or answers permissions, and never carries details from one project into another

## In short

Pick how much the new Conductor agent does. I recommend A: it reads every project and passes your requests to the right orchestrator, but it never edits, merges or answers permissions, and it sleeps until you or a project's update wakes it. Confidence: medium.

For you:

- One thread in All projects you can ask "what's waiting on me?" or "start X in another project", and it routes the request
- It never carries details from one project into another, so employer work stays out of personal projects and the public repo
- Setup: Nothing to set up; it appears once the hub update is merged and the hub restarts
- Hard to undo: Easy to widen later (to B) or switch off; it holds no data of its own beyond its handoffs

## Decision

**A: Read and route, woken on demand.** Reads every project; briefs you on what waits across projects; passes requests to the right orchestrator; flags projects that settle the same thing differently and drafts the decision card; warns orchestrators when plan usage runs short; keeps reminders across days. Never edits files, merges, pushes or answers permissions. Sleeps until you message it or a project posts a summary or a card. Same retire-and-handoff rules as orchestrators.

## Context

Matt proposed one agent above all the project orchestrators and named it Conductor (memo M033). Today each project has its own orchestrator (decisions 7, 10) and All projects is a list column (decision 42) with no agent of its own. The Conductor would live in the All projects column, read every project's board index, latest handoff and Needs you, and talk only to orchestrators. Its main risk is that it sees everything: Matt's boundary rule (never move employer or confidential material across projects or into public repos) must hold inside it. Its icon and the All projects map are decisions 56 and 57.

## Options

### A: Read and route, woken on demand (chosen) (recommended)

Reads every project; briefs you on what waits across projects; passes requests to the right orchestrator; flags projects that settle the same thing differently and drafts the decision card; warns orchestrators when plan usage runs short; keeps reminders across days. Never edits files, merges, pushes or answers permissions. Sleeps until you message it or a project posts a summary or a card. Same retire-and-handoff rules as orchestrators.
- Pro: Smallest authority, so nothing new for the permission rules
- Pro: Costs almost nothing between briefs
- Con: Can't start or stop a project's orchestrator; you still do that from the project
- Effort: Medium: cross-project read and message tools, its own thread in All projects

### B: A, plus it runs the orchestrators

As A, and it may start, hand off or retire project orchestrators and pause work across projects when usage runs short.
- Pro: One place to steer every project from
- Con: A new layer of authority over the orchestrators, with more to review and more ways to go wrong
- Con: Pausing work on its own can surprise you mid-task
- Effort: Medium to large

### C: No agent: a hub-built brief

No Conductor agent. The hub itself writes a cross-project brief at the top of All projects (what's waiting, which agents are busy, usage), with no chat.
- Pro: Costs no plan usage; nothing that can wander
- Con: Can't route requests, spot conflicts or keep reminders; no one to talk to
- Effort: Small

## Recommendation

A (lean). A gives you the one place to ask and route without adding new authority over the orchestrators. Widening it to B later is a small change once it has earned trust.

What would change this: If you find yourself starting and stopping orchestrators by hand often, go B; if you rarely chat to it, C is enough.
