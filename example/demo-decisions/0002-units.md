# 0002 Internal length unit is millimetres

- Status: found
- Date: 2026-11-02
- Lenses: data-model

## Context

All geometry code (src/geom/*.js) assumes millimetres with no unit field in saved files.

## Options

### A: Millimetres, implicit (recommended)

What the code does now: every length is millimetres, never stated.
- Pro: Matches implant drawings
- Con: Saved files carry no unit

### B: Explicit unit field

Store the unit in every saved file and convert on load.
- Pro: Safe to share files
- Con: Format change

## Recommendation

A (lean). Consistent across geometry code; only the saved-file format is at risk.
