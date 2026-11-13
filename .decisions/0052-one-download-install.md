# 0052 How does a stranger get from download to a running hub?

- Status: open
- Date: 2026-11-13
- Lenses: architecture
- Builds on: 0004, 0049, 0038
- Settles: desktop app distribution = one installer carrying Node, the hub and its packages; app still attaches to the hub and Quit leaves it running; updates via the signed Tauri updater on GitHub Releases

## In short

Pick how the desktop app installs. I recommend A: one installer of about 120-150 MB that carries the hub, Node and Claude Code inside it, so a stranger downloads, clicks through, pastes an API key and is running. Confidence: medium-high on the approach, medium on the size.

For you:

- Strangers skip Node, git and the terminal; a first-run screen asks for the API key and project folders
- Setup: Builds run on your PC as today; updates reach users through the app's own signed updater on GitHub Releases
- Hard to undo: Amends decisions 4 and 49: the app still attaches and Quit still leaves the hub running, but the hub now lives in the app folder. Your own clone keeps working through hubDir

## Context

Today the desktop app (decision 49, release v0.1.0) is only a window on a hub the user installs by hand: Node, clone, npm install, login, start. Matt: 'why would we go through the trouble of making a Tauri wrapper if people had to do 400 steps?' install-research (memo M030) compared four routes. Licence: Anthropic's terms allow shipping Claude Code inside a product if the binary is unmodified, users bring their own key or subscription and usage is never resold; the Agent SDK is all rights reserved, so it goes in the installer, never in the public repo (Claude's reading, not legal advice). A single-exe build (Node SEA, bun) was ruled out: same size, experimental, needs a bundler. winget can be a second channel later.

## Options

### A: Everything in one installer (recommended)

The installer carries node.exe, the hub, crux scripts and its packages including Claude Code, as plain files. The app starts that hub detached, exactly as now. First-run screen for the key and folders. Updates through the Tauri updater.
- Pro: One download, nothing else to install, works offline after install
- Pro: Fewest ways to fail on a stranger's PC
- Con: 120-150 MB download, and each update re-downloads it all
- Con: Anthropic's closed-source parts ship inside our installer (allowed under their terms, as read)
- Effort: Medium: bundling step, first-run screen, updater, an installer hook that stops the hub before an update

### B: Small installer that fetches the rest

A ~10 MB installer; on first run the app downloads Node and the hub's packages, then shows the same key and folder screen.
- Pro: Small download; Anthropic's parts come straight from npm, the cleanest licence position
- Pro: Updates of the hub can be small
- Con: More ways to fail: firewalls, proxies, npm outages, half-finished first runs
- Con: Needs the network on first run
- Effort: Medium to large: a download-and-repair flow with progress and retry

### C: Keep the window only

Leave the app as it is: users set up the hub by hand from the README, then install the app.
- Pro: No work; decision 49 unchanged
- Con: Strangers still face Node, git and a terminal, which is what Matt objected to
- Effort: None

## Recommendation

A (lean). A is the only option that matches 'download, click, paste a key'. The size is the price, and an installer that works offline is easier to support than a first-run download that can break halfway. B stays the fallback if the size or the licence reading becomes a problem.

What would change this: If Anthropic's terms are read more strictly, or 150 MB proves a barrier, go B.
