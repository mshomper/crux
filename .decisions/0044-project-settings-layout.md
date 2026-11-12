# 0044 Where do you set each project's permissions and handoff numbers?

- Status: decided
- Date: 2026-11-12, decided 2026-11-12
- Lenses: ui, architecture
- Builds on: 0010, 0021, 0034, 0037

## Decision

**B: A card per project, opened from its level chip.** The project row's Ask/Auto switch becomes a level chip (ASK, AUTO, TRUSTED). Tapping it opens that project's settings card: pick the level, see what it allows (the always-to-you list folds open on request), and three plain number fields (idle minutes, idle floor %, handoff %) with the hub default under each. The few hub-wide settings (orchestrator answers requests, the 120 s wait, role defaults) go in a small Whole hub panel in the three-dots menu.

## Context

Matt asked for per-project settings in the hub's screen: how much room agents get in each repo (personal projects may get more than work ones) and the idle-handoff numbers per repo. Today the only on-screen setting per project is the Ask/Auto switch (plus connectors). Idle handoff (60 min, above 25% context) is in settings files only, the 60% handoff mark is a start flag that applies to every project, and the time before an unanswered request comes to Matt (120 s) has no screen. Mockups use made-up projects. The permission levels shown (Ask, Auto, Trusted) are drafted in decision 45. Builds on decisions 10 (retire at a threshold), 21 (who answers permissions), 34 (auto mode per repo) and 37 (idle handoff); per-project numbers amend 10 and 37.

## Options

### A: One Settings panel from the three-dots menu

A Settings dialog from the three-dots menu at the top, with the projects listed on the left plus a Whole hub entry. Each project shows its level, the three handoff numbers and connectors.
- Pro: Everything in one place
- Pro: Familiar: settings live where settings usually live
- Con: A big dialog; on the phone it is long
- Con: Two places show the level: the project row and the panel
- Effort: Medium

### B: A card per project, opened from its level chip (chosen) (recommended)

The project row's Ask/Auto switch becomes a level chip (ASK, AUTO, TRUSTED). Tapping it opens that project's settings card: pick the level, see what it allows (the always-to-you list folds open on request), and three plain number fields (idle minutes, idle floor %, handoff %) with the hub default under each. The few hub-wide settings (orchestrator answers requests, the 120 s wait, role defaults) go in a small Whole hub panel in the three-dots menu.
- Pro: One tap from where the project already shows its level
- Pro: Replaces today's switch instead of adding a new place
- Pro: Shortest on the phone
- Con: Project and hub settings live in two places
- Con: Comparing projects means opening each card
- Effort: Medium

### C: All projects in one table

One settings screen with a row per project (level, three numbers, connectors) and what each level allows underneath. On the phone each project becomes a card.
- Pro: Best for comparing work and personal projects side by side
- Con: Dense; a table of numbers is the least HUD of the three
- Con: A separate screen away from the project
- Effort: Medium

## Recommendation

B (lean). B puts the settings where the project already shows its level, one tap away, and is the shortest on the phone. Comparing projects can come later as a column in the All projects view if it matters. Either way: per-project numbers are saved on this computer like the level is today, and the 60% handoff mark stops being a start flag.
