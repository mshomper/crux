# 0054 Does the installer carry Claude Code, or fetch it?

- Status: decided
- Date: 2026-11-13, decided 2026-11-13
- Lenses: architecture
- Builds on: 0052, 0001
- Settles: Claude Code in the desktop installer = not bundled; first run downloads the exact matching version from Anthropic's npm package with a checksum check; an installed copy is the offline fallback

## In short

Pick where the app gets the Claude Code program the hub's agents run on. I recommend B: a small installer (about 40 MB) that downloads the exact matching Claude Code from Anthropic on first run (about 150 MB, once per hub update), and uses an installed copy only when offline. Confidence: medium.

For you:

- Strangers download about 40 MB instead of about 160 MB; the first-run screen shows a download bar
- Setup: First run needs the internet once; nothing for you to set up
- Hard to undo: Amends decision 52 for Claude Code only; switching back to bundling later is a build change, not a redesign

## Decision

**B: Download the matching one on first run.** About 40 MB installer. The setup screen fetches the exact Claude Code version the hub's SDK expects from Anthropic's npm package (about 150 MB), checks its checksum, and keeps it. Uses an installed copy only as an offline fallback.

## Context

Matt asked why Claude Code has to be bundled. The Agent SDK the hub is built on (decision 1) is a remote control for the Claude Code program (claude.exe, 330 MB), which does the file edits, commands and permissions. tauri-app checked the SDK: it can use an installed Claude Code (pathToClaudeCodeExecutable); nothing refuses a version mismatch, but each Claude Code is tested only with about the last 30 SDK releases, and installed copies update themselves while the hub's SDK stays fixed, so features the hub relies on (permission callbacks, board tools, live model changes, usage) can fail quietly after a few weeks. The program is an optional npm part, so the hub installs without it. This PC has no standalone Claude Code (Matt's lives inside the Claude desktop app, at a path that changes with each update). Guess: 50-70% of developers but only 10-30% of non-programmers already have one. Every option still ships the SDK's own JavaScript (about 5 MB) under Anthropic's terms (memo M030).

## Options

### A: Carry it in the installer

As decision 52 A planned: Claude Code inside the installer. About 160 MB download, about 470 MB installed. Versions always match, nothing to download.
- Pro: Works offline from the first minute; fewest ways to fail
- Con: Four times the download, and every app update re-downloads it
- Con: We redistribute Anthropic's program (allowed under their terms, as read)
- Effort: As planned

### B: Download the matching one on first run (chosen) (recommended)

About 40 MB installer. The setup screen fetches the exact Claude Code version the hub's SDK expects from Anthropic's npm package (about 150 MB), checks its checksum, and keeps it. Uses an installed copy only as an offline fallback.
- Pro: Small download; versions always match
- Pro: Cleanest licence position: the user's PC fetches the program from Anthropic
- Con: Needs the internet once, and again (about 150 MB) when the hub's SDK version moves
- Con: More ways to fail on first run: proxies, antivirus, an npm outage
- Effort: Medium: a download with progress, retry and checksum on the setup screen

### C: Use an installed one, or ask for one command

About 40 MB installer. Uses Claude Code if the user has it; otherwise asks them to run Anthropic's one-line PowerShell installer.
- Pro: Smallest work; cleanest licence position
- Con: A terminal step for most non-programmers
- Con: Installed copies drift out of step with the hub and can break features quietly
- Effort: Small

## Recommendation

B (lean). B keeps the download small and the versions matched without a terminal step, and the program comes straight from Anthropic. A stays the fallback if first-run downloads prove fragile.

What would change this: If early users hit failed first-run downloads, go A; if the app is mainly for developers who already run Claude Code, C.
