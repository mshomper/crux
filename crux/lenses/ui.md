# Lens: UI

## House rules (every option must follow these; never offer an option that breaks them)
- No horizontal scrolling anywhere. Layouts fit their pane.
- No emoji or symbol-glyph icons. Every icon is a drawn icon.
- Avoid adding visibility toggles, especially many small ones hidden behind menus. Prefer contextual controls and showing things on request.

## Decisions that hide here
- Where the control lives: always-visible panel, contextual to a selection, or on request.
- Layout of the main view versus side panels, and what gets the space at narrow widths.
- How the user learns the current state at a glance.
- Defaults: what the tool does before the user touches anything.
- Feedback for long operations: progress, cancel, partial results.
- How an expert moves fast (shortcuts, direct manipulation) without cluttering it for a new user.
- What happens with an empty state, an error, or a huge input.

## Red flags to raise even if not asked
- A new option that duplicates an existing control somewhere else.
- A setting that only makes sense for one tool but lives in a shared panel.

## Sketch style
Low-fidelity mockup of the actual screen region: gray blocks for unchanged areas, the changed region drawn in `var(--accent)`, short real labels from the tool. Same frame and proportions across options.

## Default criteria
Clarity at a glance, speed for an expert, discoverability, clutter, effort to build.
