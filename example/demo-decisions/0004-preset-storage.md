# 0004 Where should study presets be saved?

- Status: decided
- Date: 2026-11-01, decided 2026-11-01
- Lenses: data-model, ui
- Builds on: 0001

## Decision

**B: Downloadable preset file.** Save a small JSON file the user can load back in.

Reason: Files match how I already hand off studies.

## Context

Users want to save and share a full study setup.

## Options

### A: In the page link

Encode the preset in the URL.
- Pro: Share by link
- Con: Long links for large setups
- Assumes: Setups stay under a few kilobytes
- Risk: Some chat apps truncate long links

### B: Downloadable preset file (chosen) (recommended)

Save a small JSON file the user can load back in.
- Pro: No size limit
- Pro: Works offline
- Con: One more file to manage
- Assumes: Users are fine dragging a file in
- Risk: Old files breaking after format changes
- Estimate, Effort: two days (basis: save, load and a version field)

## Evidence

- Imported meshes make setups far larger than a link can hold. [A, B] (Claude's judgment)

## Recommendation

B (strong). Setups with imported geometry outgrow links quickly.

## Build brief

Files:
- `src/presets/save.js`: new: write the current study to a versioned JSON file
- `src/presets/load.js`: new: read a preset, migrate older versions, apply to the study
- `src/ui/toolbar.js`: add save and load buttons with drawn icons

Steps:
1. Define the preset format with a version field and units stated on every length
2. Write save, then load with a migration hook
3. Add the toolbar buttons
4. Round-trip test on three existing studies

Done when:
- Saving then loading reproduces the study exactly
- A file from an older version loads with a clear message if anything changed

Validation:
- Round-trip comparison of every setting on three studies

Avoid:
- Storing geometry in the preset; reference the file instead
- Adding a settings toggle for this
