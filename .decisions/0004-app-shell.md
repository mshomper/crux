# 0004 What is the hub built as?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture, ui
- Builds on: 0006
- Settles: desktop app shell = no-dependency Node server and plain-module page, wrapped in Tauri

## Decision

**B: Tauri around the same page.** The Node server as a sidecar, wrapped in a small native window with tray icon and notifications.

## Context

A small app with a nicer, messaging-style interface. Crux today is no-dependency Node scripts and static pages, and two of your projects settled on no bundler for front-end builds.

## Options

### A: Local Node server, browser tab

A no-dependency Node server hosting the agents and the board, serving a plain-module web page with live updates.
- Pro: Fastest to build; fits the no-bundler convention
- Pro: Reuses Crux templates and scripts
- Con: Feels like a web page, not an app
- Con: Only browser notifications
- Effort: Small

### B: Tauri around the same page (chosen) (recommended)

The Node server as a sidecar, wrapped in a small native window with tray icon and notifications.
- Pro: A real small app: tray, notifications, starts at login
- Pro: Small installer
- Con: Rust toolchain and packaging
- Con: Sidecar process to manage
- Effort: Medium

### C: Electron

A native window with Node built in.
- Pro: All JavaScript
- Pro: Tray and notifications
- Con: Heavy for a small app
- Con: Packaging and updates
- Effort: Medium

## Recommendation

B (lean). Build it as a local server and page first (that is all of A), then wrap it in Tauri for the small-app feel; nothing in A is thrown away.
