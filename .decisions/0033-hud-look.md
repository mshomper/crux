# 0033 How far does the JARVIS look reach beyond the live map?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: ui
- Builds on: 0012, 0017, 0020

## Decision

**A: HUD frame, readable content.** The shell takes the HUD language: sidebar and headers get cyan hairlines and glow edges, cards waiting on you get corner brackets, labels become small mono capitals, decision options get hexagon keys, a short boot sequence on load, a lock-on flash when a notification opens a card. Message and card text stays in the normal sans font at full contrast.

## Context

The live map strip is full HUD (cyan glass, mono labels, corner brackets, scan lines); the rest of the hub is a calm messaging app, so the two halves read like different products. You asked for a futuristic JARVIS look at maximum polish. Readability of long messages and cards must not suffer. Found in the ux-review round.

## Options

### A: HUD frame, readable content (chosen) (recommended)

The shell takes the HUD language: sidebar and headers get cyan hairlines and glow edges, cards waiting on you get corner brackets, labels become small mono capitals, decision options get hexagon keys, a short boot sequence on load, a lock-on flash when a notification opens a card. Message and card text stays in the normal sans font at full contrast.
- Pro: One product from strip to composer
- Pro: Long text stays easy to read
- Pro: Respects reduced motion
- Con: Touches most of style.css
- Con: Needs care so brackets do not clutter long threads
- Effort: Large, in two or three passes

### B: Full HUD everywhere

Everything in the HUD style, including mono text for messages and a glass background over a live grid.
- Pro: Strongest look
- Con: Mono body text is slower to read on a phone
- Con: Glass and grids lower contrast
- Effort: Large

### C: Keep the HUD in the map

Only small touches outside the map (focus rings, link light).
- Pro: Little work
- Pro: Calm chat
- Con: Two visual languages stay side by side
- Effort: Small

## Recommendation

A (lean). It carries the map's look into every frame you touch while keeping what you read in a readable font; the desktop and phone mockups from this round show it.
