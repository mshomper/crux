# Lens: data model

## Decisions that hide here
- The shape of the core data: flat arrays, nested objects, a grid or voxel field, a mesh, a point cloud, an implicit function.
- Units and coordinate frames, and where conversion happens. Name the unit in every field.
- Precision: 32-bit versus 64-bit, and where precision is lost (GPU buffers, file export).
- What is stored versus recomputed on demand.
- File formats in and out: STL, 3MF, OBJ, CSV, JSON, a custom binary, and what metadata travels with them.
- Versioning: how old saved files load after the format changes.
- Who owns each piece of state, and how changes propagate to views.
- Size limits: the largest realistic model, and what happens past it.

## Red flags to raise even if not asked
- Units implied rather than stated.
- A saved format with no version field.
- The same value stored in two places that can drift.

## Sketch style
Small table or record sketch: the fields as rows with type and unit, or a diagram of how the arrays or grid are laid out. For format choices, a sketch of the file's structure. Keep field names readable at small size.

## Default criteria
Memory use, speed of access, ease of export, robustness to format changes, clarity for future readers.
