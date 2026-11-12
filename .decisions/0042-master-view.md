# 0042 Where do you see every project's Needs you and agents at once?

- Status: open
- Date: 2026-11-12
- Lenses: ui
- Builds on: 0012, 0017, 0031, 0032, 0039

## Context

Today Needs you and the agent list are per project, so with several projects in the hub (three now) Matt has to switch projects to see what waits on him. He asked for one master view of every Needs you item and every orchestrator and agent across the projects the hub runs (not the wider roll-up). Answering a card there should work without switching project. Mockups were made on the real hub page with fake projects, at 1920 and 390 wide. Builds on decision 12 (main screen), 17 (live map strip), 31 (red is Matt's call), 32 (phone opens on Needs you) and 39 (split pinned columns, Needs you pinnable).

## Options

### A: An All projects entry that opens as a column (recommended)

A hub-wide row above the project switcher, pinnable like Needs you. It opens as a column: a count bar per project, then Needs you grouped by project with the real cards answerable in place, then every orchestrator and agent with its model colour, state, context ring (60% mark) and red counts. The map strip's Needs you counter shows the total across projects and opens it.
- Pro: Just another column, so it sits beside a conversation and fits the pinned columns already built
- Pro: Red items come first; the phone opens on it the same way as Needs you
- Pro: Smallest build: reuses the existing cards and columns
- Con: On a 1080-tall screen you scroll to reach the agents
- Con: With many cards the list gets long
- Con: The existing All projects link to the decisions roll-up gets renamed (All decisions)
- Effort: Small to medium: one cross-project data feed in the server, one new column in the page

### B: An overview dashboard, one column per project

A full screen with one column per project: its red cards on top, then the orchestrator tile with a larger ring, then agents (waiting ones first), under one merged count bar.
- Pro: Best at-a-glance read on a big screen
- Pro: Each project is one column you can scan
- Con: Takes over the whole conversation area, so it can't sit beside a chat
- Con: Past about four projects, or on a laptop screen, the columns get too narrow and need folding
- Con: On a phone it stacks into much the same thing as A
- Effort: Medium

### C: The live map strip shows every project

The strip shows one constellation per project (core with its context level, agents as stations with red badges). Its Needs you button opens the merged list from A; opening the strip shows the projects side by side.
- Pro: The most HUD of the three
- Pro: Every project visible at a glance without opening anything
- Con: Model, context and the latest line sit behind hover or the opened map, so it reads less plainly
- Con: On a phone each project shrinks to a small core and dots
- Con: Biggest build: the map is built around one project today
- Effort: Large

## Recommendation

A (strong). A reuses the cards and columns that already exist, is the only option that sits beside a conversation, and is the smallest build. It borrows one thing from C: the map strip's Needs you counter shows the total across projects and opens All projects.
