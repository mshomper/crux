# Lens: solver and physics

## Decisions that hide here
- Method family: finite element, material point, finite difference, homogenization, analytical or empirical estimate. What each can and cannot capture for this question.
- Material model: linear elastic, elastoplastic, crushable foam, anisotropic or directional, damage or failure criterion. Where the parameters come from.
- Boundary conditions and loading: displacement or force control, rate, contact, friction, symmetry.
- Resolution and convergence: mesh or particle density, time step, how convergence is shown.
- Precision and determinism on the GPU: single precision limits, atomic operations, run-to-run repeatability.
- Calibration: which physical tests the model is tuned against, and which are held back for checking.
- Validation: what comparison counts as "good enough", and the error that would make the result unusable.
- Output: which quantities are reported, and whether they are screening-level or quantitative.

## Red flags to raise even if not asked
- Calibrating and validating against the same data.
- A result reported with more precision than the model supports.
- A change in method that silently changes results users have already compared against.
- Single-precision accumulation in long runs or large sums.

## Sketch style
Schematic of the setup: the part, the loading arrow, the boundary conditions, and the quantity measured. Or a qualitative curve (for example force against displacement) showing how each option's behavior differs. Label axes; no invented numbers on axes.

## Default criteria
Physical fidelity, run time, calibration effort, robustness (does it blow up), credibility to a reviewer.

## Caution
Your recommendation here is a starting point. Say plainly where the literature or test data is needed to settle it, rather than sounding certain.
