# 0001 Where should the trail map be drawn?

- Status: decided
- Date: 2026-10-20, decided 2026-10-20
- Lenses: architecture

## Decision

**A: Vector tiles in the browser.** Download map data as vector tiles and draw them on the device.

Reason: Smooth zoom matters most when reading contours on a small screen.

## Context

Alex's trail planner shows a route on a topographic map. Panning and zooming must stay smooth on a phone, out on the trail.

## Options

### A: Vector tiles in the browser (chosen) (recommended)

Download map data as vector tiles and draw them on the device.
- Pro: Smooth zoom at any level
- Pro: Small downloads, easy to keep offline later
- Con: More work on older phones
- Effort: Medium

### B: Ready-made image tiles

Fetch pre-drawn map pictures from a tile server.
- Pro: Simplest to build
- Pro: Light on the phone
- Con: Blurry between zoom levels
- Con: Large downloads for offline use
- Effort: Low

## Recommendation

A (strong). Offline use is likely to come up, and vector tiles keep it small.
