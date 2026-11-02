---
name: crux-dig
description: Read an existing codebase and draft records of the decisions already baked into it, for the human to confirm, edit or reject. Use when the user types /crux-dig or asks to document why an existing tool is built the way it is. Writes only to .decisions/.
argument-hint: "[folder or area to scan, optional]"
---

# Crux Dig

Every line of code is a decision someone made without writing it down. Find the important ones, draft them as records, and let the human confirm them. Never treat a finding as decided until the human says so.

Arguments: **$ARGUMENTS** (a folder or area to focus on; empty means the whole repo)

## 1. Survey

1. Read existing `.decisions/*.md` so nothing is drafted twice.
2. Map the repo: entry points, folders, dependencies, build setup, file formats, and the largest or most-edited files.
3. For a large repo, split the scan into small parallel subagents, one per area (for example: architecture and dependencies, data structures and file formats, solver or physics code, UI). Give each a short brief and ask for findings only, not file dumps. Keep working on the survey while they run.

## 2. What counts as a decision

Keep findings that are hard to reverse or that later work depends on. Use the checklists in the crux skill's `lenses/` folder as the guide. Typical finds:
- Choice of framework, library, or none.
- Where computation runs (main thread, worker, GPU) and why.
- Core data layout, units, precision, and saved-file formats.
- Numerical method, material model, boundary conditions, convergence settings.
- UI layout pattern and state handling.

Skip style choices, naming, and anything trivially reversible. Aim for 5 to 15 findings, ranked by how hard they are to reverse.

## 3. Draft each finding

Write one JSON file per finding in `.decisions/` using the crux skill's schema, with:
- `status`: `found`
- `mode`: `quick`
- `context`: what the code does and where (file paths), and what it seems to be for.
- `options`: option A is what the code does now (`chosen: "A"` is not set yet). Add one or two real alternatives it rules out, so the record shows what was given up. No sketches needed.
- `recommended`: `A`, with `recommendation` stating the evidence in the code. If the code suggests the choice was accidental or is causing problems, say so plainly and set `confidence` to `toss-up`.

Then run the crux skill's build script:

```
node <crux skill folder>/scripts/build.mjs .decisions
```

## 4. Review with the human

Give a short numbered list: number, title, one line on what was found. Ask them to reply in one message, for example "confirm 3, 5, 6; reject 4; edit 7: it was for licensing reasons". Then:
- Confirmed: `status` to `decided`, `chosen` to `A`, `decided_on` to today, `reason` from their words if given. Fill `settles` as described in the crux skill (section 4), reusing keys from `~/crux/conventions.md`.
- Rejected: `status` to `rejected`.
- Edited: apply their correction, then confirm.
- Anything they want to change going forward becomes a new open decision through /crux.

Rebuild after applying the replies.

## Rules

- Read code only. Never modify code as part of this skill.
- Mark guesses as guesses. Evidence comes with file paths.
