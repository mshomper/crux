# 0049 Does the Tauri app own the hub, or sit on top of it?

- Status: decided
- Date: 2026-11-12, decided 2026-11-13
- Lenses: architecture
- Builds on: 0004, 0019, 0048
- Settles: desktop app shell = Tauri window that loads the live local server's page and attaches to the server (starting it if down) rather than owning it; quitting the window leaves the server running

## Decision

**A: Sit on top: attach to the hub, start it if it's down.** The app checks the hub at launch and starts it the usual way if it isn't running. Restarts (restart_hub, the menu, the tray) work as today. Quitting the app leaves the hub running, so the phone keeps working.

## Context

Decision 4 chose a Tauri window around the hub page with the Node server as a 'sidecar' (a child process the app owns). The plan (memo M028, researcher tauri-plan) found that a true sidecar fits badly: Tauri sidecars are standalone executables, so the Node hub and the Agent SDK would need packaging into one exe (fragile); the hub restarts itself, which slips out of Tauri's hold on it anyway; and quitting or crashing the window app would take the hub, and the phone's access, down with it. Either way the window loads the live hub at http://crux.localhost:4747, so decision 48's PC trust works unchanged, and the page gets no Tauri native access. The app lives in app/ in the crux repo (hub/ stays dependency-free). Build tools: Microsoft C++ Build Tools and Rust (about 9-12 GB, Matt's call). Amends decision 4.

## Options

### A: Sit on top: attach to the hub, start it if it's down (chosen) (recommended)

The app checks the hub at launch and starts it the usual way if it isn't running. Restarts (restart_hub, the menu, the tray) work as today. Quitting the app leaves the hub running, so the phone keeps working.
- Pro: Nothing about how the hub runs or restarts changes
- Pro: The phone never loses the hub because the window closed or crashed
- Pro: No packaging of Node or the Agent SDK
- Con: Two things to think about (app and hub) instead of one
- Effort: Small to medium

### B: Own it: a true sidecar

As decision 4 said: the app packages and starts the hub as its child, and quitting the app stops the hub.
- Pro: One thing to start and stop
- Con: Packaging the Node hub and the Agent SDK into one exe is fragile
- Con: Self-restarts fight Tauri's hold on the process
- Con: Closing or crashing the app cuts off the phone
- Effort: Medium to large

## Recommendation

A (strong). A keeps everything that works today and only adds a window, a tray and PC notifications on top.
