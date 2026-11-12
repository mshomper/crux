# 0004 How are planned routes saved and shared?

- Status: decided
- Date: 2026-11-01, decided 2026-11-01
- Lenses: data-model, ui
- Builds on: 0001
- Settles: route file format = GPX 1.1; distance unit = kilometres

## Decision

**B: GPX file.** Save the route as a standard GPX file that watches and other apps read.

Reason: Friends load routes on their watches, so the file has to be GPX.

## Context

Hikers want to save a planned route, send it to friends, and load it on their GPS watch.

## Options

### A: In the page link

Encode the route in the web address.
- Pro: Share by link
- Con: Long links for long routes
- Con: Watches cannot read it
- Assumes: Routes stay under a few hundred points
- Risk: Some chat apps cut long links short

### B: GPX file (chosen) (recommended)

Save the route as a standard GPX file that watches and other apps read.
- Pro: Loads on most GPS watches
- Pro: No size limit, works offline
- Con: One more file to manage
- Assumes: Users are fine sending a file
- Risk: Notes the planner adds (rest stops, water) need GPX extensions that some apps ignore
- Estimate, Effort: two days (basis: save, load and the notes extension)

## Evidence

- GPX is the common exchange format for routes and tracks across GPS devices and hiking apps. [B] (Claude's judgment)

## Recommendation

B (strong). Getting the route onto a watch is the main reason to save it, and only a GPX file does that.

## Build brief

Files:
- `src/routes/save-gpx.js`: new: write the current route as a GPX 1.1 file, notes in an extension
- `src/routes/load-gpx.js`: new: read a GPX route or track, keep unknown parts, apply to the map
- `src/ui/toolbar.js`: add save and load buttons with drawn icons

Steps:
1. Write save, with distances in kilometres and elevation in metres
2. Write load, keeping anything it does not understand
3. Add the toolbar buttons
4. Round-trip test on three real routes and one watch

Done when:
- Saving then loading reproduces the route exactly
- A saved route opens on a GPS watch and in one other hiking app

Validation:
- Round-trip comparison of every point and note on three routes

Avoid:
- Inventing a format of our own
- Adding a settings toggle for this
