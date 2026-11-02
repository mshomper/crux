---
name: crux-dig
description: Read an existing codebase and draft records of the decisions already baked into it, for the human to confirm, edit or reject. Use when the user types /crux-dig or asks to document why an existing tool is built the way it is. Writes only to .decisions/.
argument-hint: "[folder or area to scan, optional]"
---

# Crux Dig

Every line of code is a decision someone made without writing it down. Find the important ones, draft them as records, and let the human confirm them. Never treat a finding as decided until the human says so.

Arguments: **$ARGUMENTS** (a folder or area to focus on; empty means the whole repo)

## 1. Survey

1. Read existing `.decisions/*.md` first. Re-running is safe and never duplicates:
   - `found` records nobody has reviewed yet are **refreshed in place**: keep the number and file name, re-check the evidence against the current code, and add any fields this version of the skill expects that are missing (such as `deliberate`, `holding_up`, `ruled_out`, `log_refs`). If the code no longer supports a finding, say so and suggest rejecting it.
   - `decided`, `parked` and `superseded` records are left alone. Mention one only if the code has since moved away from it.
   - `rejected` records are never drafted again.
   - New findings get the next free numbers.
2. Look for a decision log the repo already keeps: files such as `DECISIONS.md`, `docs/DECISIONS.md`, `ADR*`, `docs/adr/`, `docs/decisions/`, or a decisions section in `SPEC*` or `CLAUDE.md`. If one exists, it stays the main record. Read it, link to its entries from your findings instead of restating them (see `log_refs` below), and note every entry it marks as open, pending, or for review.
3. Map the repo: entry points, folders, dependencies, build setup, file formats, and the largest or most-edited files.
4. For a large repo, split the scan into small parallel subagents, one per area (for example: architecture and dependencies, data structures and file formats, solver or physics code, UI). Give each a short brief and ask for findings only, not file dumps. Keep working on the survey while they run.

## 2. What counts as a decision

Keep findings that are hard to reverse or that later work depends on. Use the checklists in the crux skill's `lenses/` folder as the guide. Typical finds:
- Choice of framework, library, or none.
- Where computation runs (main thread, worker, GPU) and why.
- Core data layout, units, precision, and saved-file formats.
- Numerical method, material model, boundary conditions, convergence settings.
- UI layout pattern and state handling.

Skip style choices, naming, and anything trivially reversible. Aim for 5 to 15 findings, ranked by how hard they are to reverse. When refreshing, report what changed: refreshed, new, and suggested for rejection.

## 3. Draft each finding

Write one JSON file per finding in `.decisions/` using the crux skill's schema, with:
- `status`: `found`
- `mode`: `quick`
- `context`: what the code does and where (file paths), and what it seems to be for.
- `options`: option A is what the code does now (`chosen: "A"` is not set yet). Add one or two alternatives a capable engineer would still consider today, so the record shows what was given up. No sketches needed.
- `ruled_out`: alternatives excluded by a hard rule (a guardrail, the spec, a regulation, an owner instruction) go here as one line each, `{ "option": "One 3D volume over the disc", "by": "Guardrail G1" }`, not as option cards.
- `recommended`: `A`, with `recommendation` stating the evidence in the code (file paths).
- Two separate reads, never merged into one confidence label:
  - `deliberate`: `yes` (stated in a comment, spec or log), `likely` (consistent and purposeful but not written down), or `unclear` (may be accidental). This replaces `confidence` for findings.
  - `holding_up`: `fine` or `strained`. Strained means the choice is now causing cost or risk: growth, bugs traced to it, tuning tied to one machine, a planned change it blocks, an open review item. When strained, `strain` says why in one sentence, with evidence.
- `log_refs`: entries in the repo's own decision log that cover this finding, as `{ "file": "docs/DECISIONS.md", "entry": "2026-10-05" }`. If the log already records the decision fully, keep the finding short and let the link carry the detail.
- `open_item`: true when the repo's own log marks this choice as awaiting review. Confirming the finding closes it.

If you are working in a worktree (its path contains `.claude/worktrees/`, or `git rev-parse --git-common-dir` points outside it), tell the human in your summary, with the full path of `.decisions/`, that the findings reach the main copy when the branch is merged, and offer to merge after they review.

Then run the crux skill's build script:

```
node <crux skill folder>/scripts/build.mjs .decisions
```

## 4. Review with the human

Give a short message in this order:
1. Open items from the repo's own log, if any (these need a call first).
2. Strained findings, each with its strain in one line. These are the candidates for new decisions.
3. The rest, as number and title only. Ask them to reply in one message, for example "confirm 3, 5, 6; reject 4; edit 7: it was for licensing reasons". Then:
- Confirmed: `status` to `decided`, `chosen` to `A`, `decided_on` to today, `reason` from their words if given. Fill `settles` as described in the crux skill (section 4), reusing keys from `~/crux/conventions.md`. Findings about units, frames, grid layout, material laws, numerical methods, precision, file formats and tooling almost always settle something.
- Rejected: `status` to `rejected`.
- Edited: apply their correction, then confirm.
- Anything they want to change going forward, including a strained finding they want to act on, becomes a new open decision through /crux with `depends_on` pointing at the finding.
- If the repo keeps its own decision log, offer to add a one-line pointer there to `.decisions/` once findings are confirmed. Never rewrite that log.

Rebuild after applying the replies.

## Rules

- Read code only. Never modify code as part of this skill.
- Mark guesses as guesses. Evidence comes with file paths.
