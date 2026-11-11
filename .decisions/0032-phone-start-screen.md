# 0032 What does the hub show first when you open it on your phone?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: ui
- Builds on: 0012, 0017, 0019

## Decision

**A: Needs you first, list behind Back.** Open straight into Needs you when something waits (thread list when nothing does). Back still shows the list. Nothing else changes.

## Context

On a phone the hub opens on the thread list, so answering anything takes a tap into Needs you first, and moving between threads means going back to the list each time. Decision 12 set the desktop layout; the phone layout was never decided. Found in the ux-review round.

## Options

### A: Needs you first, list behind Back (chosen) (recommended)

Open straight into Needs you when something waits (thread list when nothing does). Back still shows the list. Nothing else changes.
- Pro: One tap less for the common case
- Pro: Smallest change
- Con: Moving between agents still goes through the list
- Effort: Small

### B: Bottom bar with four places

A bar at the bottom with Needs you, Orchestrator, Agents and Map, each with its count. Opens on Needs you when something waits. The map strip stays on top as decided.
- Pro: Every place one thumb tap away
- Pro: Counts always visible
- Pro: Feels like a phone app from the home screen
- Con: Takes about 56 px of height
- Con: A second way to navigate next to the strip
- Effort: Medium

### C: Leave the list first

Keep today's behaviour; notification taps already land on the card.
- Pro: No work
- Pro: Notifications cover the urgent case
- Con: Opening the app yourself always costs an extra tap
- Effort: None

## Recommendation

A (toss-up). Most phone visits are to answer something; landing on Needs you fixes that at almost no cost. B is worth it only if you move between agents a lot on the phone.
