# 0003 How should screw-bone contact be modelled in the pull-out solver?

- Status: open
- Date: 2026-11-02
- Lenses: solver, architecture
- Builds on: 0001

## Context

Pull-out force depends heavily on how thread flanks engage the foam. The current grid-based contact smears the interface over one cell, which may underpredict peak force on fine threads.

## Options

### A: Keep grid contact, refine locally

Leave the contact method alone and add a finer grid band around the screw.
- Pro: Smallest code change
- Pro: Existing calibration largely holds
- Con: Run time grows with band size
- Con: Still smears the interface, just less
- Effort: A few days
- Assumes: Under-prediction comes mainly from grid resolution, not the contact rule itself
- Risk: Band size needed for convergence may make runs too slow to compare many designs
- Estimate, Run time: about 2 to 3 times current (basis: band roughly doubles the active cells near the screw)

### B: Explicit thread surface (recommended)

Represent the thread as a rigid surface and resolve contact against it directly.
- Pro: Captures flank engagement directly
- Pro: Sensitivity to thread pitch becomes visible
- Con: New contact code on the GPU
- Con: Needs recalibration against pull-out tests
- Effort: Two to three weeks
- Assumes: Thread geometry can be imported cleanly as a rigid surface
- Assumes: Foam crush behavior near the flank is captured by the existing material model
- Risk: New GPU contact code may be unstable at large penetrations
- Estimate, Run time: similar to current (basis: contact check is per particle near the surface only)
- Estimate, Effort: two to three weeks (basis: new contact pass plus a recalibration round)

### C: Empirical correction factor

Keep the solver and multiply peak force by a factor fitted from test data per thread family.
- Pro: No solver change
- Pro: Fast to ship
- Con: Hides the physics
- Con: Breaks on thread designs outside the fitted set
- Effort: A day plus test data
- Assumes: Thread designs users test stay close to the fitted set
- Risk: A factor fitted on one foam grade may not transfer to another
- Estimate, Effort: about a day (basis: fit from existing test results)

## Evidence

- Grid-based contact in material point methods spreads the interface across about one cell, which softens sharp features. [A, B] ([Example source (placeholder)](https://example.com/mpm-contact))
- Pull-out strength in foam is sensitive to thread pitch and flank angle. [B, C] ([Example source (placeholder)](https://example.com/pullout-foam))
- A correction factor is unlikely to survive large changes in thread form, since it cannot respond to geometry. [C] (Claude's judgment)

## Recommendation

B (lean). Thread pitch is what users are comparing, and only an explicit surface resolves it. Worth confirming against two or three held-back tests before trusting it.

What would change this: If refining the grid band alone closes most of the gap to held-back tests, A wins on effort.
