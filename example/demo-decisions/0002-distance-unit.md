# 0002 Distances are stored in miles

- Status: found
- Date: 2026-11-02
- Lenses: data-model
- Deliberate: likely
- Holding up: strained. Decision 0004 saves routes as GPX, which is metric, so every save and load now converts miles back and forth.

## Context

All route code (src/route/*.js) stores distances in miles, with no unit written in saved routes.

## Options

### A: Miles, implicit

What the code does now: every distance is in miles, never stated.
- Pro: Matches the trail guides the first users read
- Con: Saved routes carry no unit

### B: Kilometres inside, miles on screen if asked (recommended)

Store kilometres everywhere and convert only for display.
- Pro: Matches GPX files and most map data
- Pro: Safe to share routes
- Con: Every distance in the code and in saved routes changes

## Recommendation

B (lean). Route files and map data are metric, so miles force a conversion at every edge of the app.
