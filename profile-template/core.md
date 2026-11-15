# Working with <your name>: core

> Every agent loads this. Keep it to one or two pages. Project detail goes in packs; private detail goes in private.md.

## Who you're working for
- Your role and expertise, and how deep explanations should go.

## How a round of work goes
1. What to read first.
2. When to propose and when to just do it.
3. What "ready" means: how you review and approve.

## Talking to you
- Length, tone, where questions go, and words to avoid.

## Testing and compute
- What agents may run, and what you run yourself.

## Git
- Who branches, commits, pushes and opens PRs, and what needs your OK.

## Code architecture
- Module style and structure across your projects.

## UI rules
- Rules every interface you build must follow.

## Orchestration
- When to split work across agents, and when to keep it in one session.

### Model and effort routing (a sensible default; edit to taste)
Roles: the orchestrator runs on a strong model at medium effort; the default worker is a mid-size model at medium (the `implementer` type, see `agent-types/starter/`). A larger model only for named hard-reasoning work, at high. The most expensive model only as an `advisor`: one answer at a checkpoint, then retired. The smallest model for clerical types. A precise brief beats more effort.
- Boilerplate, config, renames: `quick-fix`. UI, features from a clear spec, a bug with a reproducing test, a one-module refactor: `implementer`.
- A bug with only a symptom: `clerk` gathers logs, then `implementer` at high. A cross-module refactor: the orchestrator plans the cut lines, then one `implementer` per module.
- GPU, solver physics, geometry math, concurrency, hard algorithms: `solver`. Performance work needs a trace first. Security-sensitive code: `implementer` at high, then `deep-reviewer`.
- Tests: `test-writer`. Review: `reviewer`; a high-risk diff: `deep-reviewer`, then the advisor. Commit text, changelogs, inventories, file moves: `clerk`.
- Docs: `doc-editor` to edit, `doc-reviewer` to check against code or facts. Research: `gatherer` per sub-question, then `researcher` to compare and `synthesizer` to conclude from notes, never raw pages.
- Advisor checkpoints: a plan over 5 tasks or touching 2+ modules; a draft decision card on architecture; stuck at the top of the ladder; before merging high-risk code; when asked. One call per checkpoint, one project's material only. If the most expensive model's weekly plan meter is amber or red, use `deep-reviewer` instead.

Escalation ladder: `clerk` → `quick-fix` → `implementer` → `implementer` at high → `solver` (larger model, high) → `solver` at xhigh → advisor diagnosis → stop and tell the user.
Raise when: tests fail twice at a setting, low confidence or blocked, a reviewer rejects, the same file flip-flops three times, the work is harder than its type, or the user says so.
1. Change model before going past high.
2. Two attempts per step, then go up.
3. Automatic raises stop at the larger model's xhigh plus one advisor review; then tell the user, with the trail.
4. `max` is never automatic; only the user picks it, for one task.
5. Fix the brief before raising effort.
Give a one-line reason with every raise (the Hub logs it), and lower a setting again once the hard task is done.

## Boundaries
- What must never cross between projects or reach public places (rules only; specifics go in private.md).
