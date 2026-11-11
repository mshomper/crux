# 0031 What does each status colour mean across the hub?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: ui
- Builds on: 0012, 0017, 0020

## Decision

**A: Red is your call, everywhere.** Red only for things waiting on you (badges, card frames, map stations, the phone strip). Amber only for warnings (handoff threshold, 'runs code' tags, amber marks). Green for done or resting, cyan-blue for working. Unread becomes a small white dot.

## Context

Today 'needs you' is amber in the sidebar and project badge but red on the live map, unread messages are also amber, and blue means both 'working' and 'open decision' and is the colour of every main button. Decision 20 kept the model hues clear of red, amber, green and blue, so those four need one fixed meaning each. Found in the ux-review round.

## Options

### A: Red is your call, everywhere (chosen) (recommended)

Red only for things waiting on you (badges, card frames, map stations, the phone strip). Amber only for warnings (handoff threshold, 'runs code' tags, amber marks). Green for done or resting, cyan-blue for working. Unread becomes a small white dot.
- Pro: One glance anywhere tells you whether you are needed
- Pro: Matches the map, which already uses red
- Pro: Amber warnings stop competing with your queue
- Con: A lot of red when many things wait; mitigated by red counts rather than whole red stations
- Effort: Small: colour tokens in style.css and map.css, a few class names in app.js

### B: Amber is your call, everywhere

Keep the sidebar's amber for 'needs you' and change the map's red stations to amber; red is kept for errors only.
- Pro: Calmer screen
- Pro: Red stays rare, so an error stands out
- Con: Amber also means warning, so 'needs you' and 'careful' blur together
- Con: Changes the map you already approved
- Effort: Small

### C: Leave as is

Sidebar amber, map red, unread amber.
- Pro: No work
- Con: The same state shows in two colours depending on where you look
- Effort: None

## Recommendation

A (lean). Red already carries 'act here' on the map and in phone notifications; using it for exactly that everywhere, and amber only for warnings, makes the queue readable at a glance.
