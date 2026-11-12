# 0003 How should the planner estimate walking time?

- Status: open
- Date: 2026-11-02
- Lenses: research, architecture
- Builds on: 0001

## Context

Hikers plan their day around the time estimate, not the distance. The planner shows a single figure today (distance divided by 4 km/h), which ignores climbing and is far off on steep routes.

## Options

### A: Naismith's rule

One hour per 5 km, plus one hour per 600 m of climbing.
- Pro: Known to most hikers, easy to explain
- Pro: A few lines of code
- Con: Treats steep descents as free
- Con: Same pace for everyone
- Effort: A day
- Assumes: Most routes are climbs and walks on paths, not scrambles
- Risk: Underestimates long, steep descents
- Estimate, Effort: about a day (basis: one formula plus tests on five known routes)

### B: Tobler's hiking function (recommended)

Walking speed changes with slope along every segment, fastest on a gentle downhill.
- Pro: Handles descents as well as climbs
- Pro: Uses the elevation data the map already has
- Con: Needs elevation along the whole route
- Con: Harder to explain in one line
- Effort: Three to four days
- Assumes: Elevation data is fine enough to give slope every 50 m or so
- Risk: Noisy elevation data makes the slope jump and the time too high
- Estimate, Effort: three to four days (basis: segment the route, smooth elevation, apply the function, test)

### C: Learn from your own tracks

Fit a personal pace from the GPS tracks you have already walked.
- Pro: Fits each hiker
- Pro: Gets better the more you walk
- Con: Nothing to fit for a new user
- Con: Needs track import first
- Effort: Two weeks
- Assumes: Users have a handful of recorded tracks to import
- Risk: Tracks with long breaks skew the pace unless breaks are cut out
- Estimate, Effort: about two weeks (basis: track import, break detection, fitting, and a fallback for new users)

## Evidence

- Naismith's rule allows one hour for every 5 km forward plus one hour for every 600 m of ascent. [A] ([Example source (placeholder)](https://example.com/naismith))
- Tobler's hiking function gives walking speed as a function of slope, with the highest speed on a slight downhill. [B] ([Example source (placeholder)](https://example.com/tobler))
- A personal fit needs enough tracks per user to be steadier than a general rule. [C] (Claude's judgment)

## Recommendation

B (lean). Steep routes are where today's figure goes most wrong, and B fixes that without needing any history. C can come later as a personal adjustment on top of B.

What would change this: If the elevation data turns out too coarse for slope every 50 m, A with a descent correction wins on effort.
