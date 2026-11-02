# 0001 Where should heavy computation run?

- Status: decided
- Date: 2026-10-20, decided 2026-10-20
- Lenses: architecture

## Decision

**A: WebGPU compute.** Run field evaluation and solver steps in WebGPU compute shaders.

Reason: Speed is the whole point of the browser tools.

## Context

The tools need large field evaluations without freezing the interface.

## Options

### A: WebGPU compute (chosen) (recommended)

Run field evaluation and solver steps in WebGPU compute shaders.
- Pro: Orders of magnitude faster on large grids
- Con: Single precision only
- Effort: Medium

### B: Web worker on CPU

Keep everything in JavaScript on a worker thread.
- Pro: Double precision, simpler debugging
- Con: Too slow for fine grids
- Effort: Low

## Recommendation

A (strong). Grid sizes in use need GPU throughput.
