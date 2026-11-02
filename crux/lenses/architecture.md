# Lens: architecture

## Decisions that hide here
- Where the new code lives: inside an existing module, a new module, or a shared library other tools also use.
- What it depends on: a new third-party library versus writing it, and what that library pulls in.
- How modules talk: direct calls, events, a shared state object, or message passing to a worker.
- What runs where: main thread, web worker, GPU, or ahead of time in a build step.
- What is shared across tools in the suite versus copied per tool.
- How it is loaded: single self-contained file, bundled, or loaded on demand.
- What happens on failure: missing GPU support, out of memory, a bad input file.
- How it will be tested or checked, and by whom.

## Red flags to raise even if not asked
- A change that couples two tools that are deployed separately.
- A dependency that is unmaintained, very large, or needs a build step the project does not have.
- Two sources of truth for the same setting or state.

## Sketch style
Box-and-arrow module diagram: three to five boxes, arrows for calls or data flow, the new or changed part filled with `var(--accent)`. One sketch per option, same box positions across options so the difference stands out.

## Default criteria
Effort to build, ease of reversing, performance, effect on other tools, ease of maintenance.
