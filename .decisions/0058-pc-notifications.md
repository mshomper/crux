# 0058 When something needs you, does the PC or the phone get the notice?

- Status: open
- Date: 2026-11-13
- Lenses: ui, architecture
- Builds on: 0019, 0049, 0052
- Settles: notice routing between PC and phone = the PC gets the notice while it's in use; the phone when the PC has been idle 5+ minutes, or when a card is still waiting 3 minutes after a PC notice

## In short

Pick how notices are split between the desktop app and your phone. I recommend A: if you're at the PC, the PC shows it; if you've been away from the PC for 5 minutes, or a card is still waiting 3 minutes after the PC notice, the phone gets it too. Confidence: medium.

For you:

- Windows notices from the Crux Hub app for the same cards the phone gets today (permissions that are yours, decisions to pick, agent questions); clicking one opens that exact card
- The notice shows only the kind, a short title and the project, never card contents
- Setup: Arrives as desktop app 0.3.0 through the tray's update item; nothing to set up
- Hard to undo: Adds one small library from the Tauri team (Windows notices that report a click); removing it later means clicks only bring the window forward

## Context

The desktop app (decisions 49, 52) shows no notices on the PC yet. tauri-app's plan: the hub decides when to notify, as it does for the phone's web push (decision 19), and gains a PC target. The app keeps a PC-only connection to the hub open and shows a Windows notice per card, with the same few words as the phone push (C001). The app reports how long since the PC last had keyboard or mouse input, so the hub can choose where to send. Clicks that open the exact card need the Tauri team's Windows notification library (tauri-winrt-notification) directly; their notification plugin can't report clicks on Windows. No new hub packages. This widens decision 19 from the phone only to the phone and PC.

## Options

### A: PC first, phone as backup (recommended)

At the PC: the notice goes to the PC only. PC idle 5+ minutes, locked or asleep: phone only. A card still waiting 3 minutes after a PC notice also goes to the phone.
- Pro: No double buzz while you're at the desk
- Pro: Covers locking the PC and walking away
- Con: An occasional second notice on the phone if you leave a card sitting
- Effort: Medium

### B: Strictly one or the other

PC active: PC only. PC idle: phone only. Never both.
- Pro: Never told twice
- Con: Walk away just after a PC notice and the phone stays quiet for up to 5 minutes
- Effort: Medium

### C: Both, always

Every notice goes to the PC and the phone.
- Pro: Simplest; nothing missed
- Con: Your phone buzzes for everything while you sit at the PC
- Effort: Small to medium

## Recommendation

A (lean). A keeps the phone quiet while you work at the desk, but still reaches you if you walk away with a card waiting.

What would change this: If the second notice after 3 minutes annoys you, go B; if you miss notices, go C.
