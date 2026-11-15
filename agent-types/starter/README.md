# Starter agent types

Sixteen short agent files for the Hub (decision 20): each sets a model, an effort level, a tool limit and a few standing instructions. They are plain Claude Code agent files, so they work in Claude Code too.

| Type | Model · effort | Use for |
|---|---|---|
| `implementer` | Sonnet · medium | Standard feature work and bug fixes from a clear brief. The sensible default worker. |
| `quick-fix` | Sonnet · low | Boilerplate, config, renames |
| `solver` | Opus · high | GPU kernels, solver physics, geometry math, meshing, concurrency |
| `test-writer` | Sonnet · low | Unit tests for existing code |
| `reviewer` | Sonnet · medium | Reviewing a change before you click-test it |
| `deep-reviewer` | Opus · high | Reviewing high-risk changes |
| `advisor` | Fable · high | One checkpoint review, then retired |
| `researcher` | Sonnet · medium | Comparing options and checking claims, with sources |
| `gatherer` | Haiku · low | Collecting sources for one sub-question |
| `synthesizer` | Opus · high | Combining research notes into a conclusion |
| `doc-editor` | Sonnet · low | Copy edits and formatting |
| `doc-reviewer` | Sonnet · high | Checking docs against code and facts |
| `clerk` | Haiku · low | Inventories, file moves, changelogs |
| `task-organizer` | Sonnet · low | Turning notes into tasks |
| `calendar-reader` | Haiku · low | Reading the schedule (needs calendar connectors on) |
| `calendar-planner` | Sonnet · medium | Week plans as proposals only (needs calendar connectors on) |

Install: copy the `.md` files (not this README) into `~/.claude/agents/`; see [INSTALL.md](../../INSTALL.md). A project can override a type by putting a file of the same name in its own `.claude/agents/`.
