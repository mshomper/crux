# 0072 When part of the test can only run on Matt's machine, how do those results get into the report?

- Status: open
- Date: 2026-11-16
- Lenses: research and product
- Builds on: 0068

## In short

Should the expedition finish as usual and, when you paste back the results from your machine, a short follow-up job update the report and its pull request? I recommend that: the expedition never waits on you, and the report still ends up with the real-hardware numbers.

For you:

- The report lists what to run yourself (often one small local page) with a results block to copy
- Paste the block into the thread or use 'Paste results' on the finished card; a few minutes later the PR carries the real result
- The follow-up has its own small budget, separate from the expedition's

## Context

Spec section 12, question 3 (memo M044). The reference run's GPU test needed Matt's RTX card: within one float step of the CPU, with 85% of the pipeline time on the CPU side, found only on real hardware. Scoping and the advisor checkpoint (2026-11-16) agree on B, built after phase 5.

## Options

### A: Report only

The report lists what to run; what you do with the result is up to you.
- Pro: Nothing to build
- Con: The report stays wrong on exactly the items it couldn't run
- Effort: None

### B: Short follow-up job after you paste (recommended)

One small verifier job reads your pasted results and the report, updates the build status and how-it-ran sections, and pushes to the same draft PR.
- Pro: The expedition never waits; the report ends up right
- Con: One more small piece to build, after phase 5
- Effort: Small

### C: Keep the expedition open until you paste

The Lead stays alive and the run waits for your results.
- Pro: One run, start to finish
- Con: Breaks the time and budget envelope; holds a Lead for hours or days
- Effort: Small

## Recommendation

B (firm). B: the report gets the real numbers without holding the expedition open.

What would change this: If you rarely paste results back, A is enough.
