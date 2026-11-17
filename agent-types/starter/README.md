# Starter agent types

Sixteen short agent files for the Hub (decision 20), plus seven for the Expedition module (below): each sets a model, an effort level, a tool limit and a few standing instructions. They are plain Claude Code agent files, so they work in Claude Code too.

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

### Expedition types (seven more, used only by the Expedition module)

An expedition is a self-running research-and-build job (decisions 68 to 72). These seven files are its roles. The hub starts them; you do not pick them from the new-agent dialog. A project can override any of them in its own `.claude/agents/` (for example to name the Verifier's test environments). "Runs as" says whether the role is its own hub agent (own thread, usage and permission requests) or a subagent inside the Lead's Agent tool.

| Type | Model · effort | Runs as | Use for |
|---|---|---|---|
| `expedition-lead` | Opus · medium | hub agent | Plans, splits the work, makes in-scope calls, writes the report. Has the Agent tool. |
| `expedition-advisor` | Fable · medium | hub agent | Reviews the plan once at the gate; on call for escalated decisions |
| `expedition-gatherer` | Haiku · low | subagent | Answers one sub-question with notes and links it opened (up to 8 searches, 6 page opens; at most 4 at once, 8 runs per expedition; page-list "reader" runs allowed) |
| `expedition-synthesizer` | Opus · medium | hub agent | Notes into cited findings and a recommendation |
| `expedition-skeptic` | Sonnet · high | hub agent | Tries to break the notes and the synthesis |
| `expedition-builder` | Sonnet · medium | hub agent | Builds the prototype in its own worktree against the frozen test |
| `expedition-verifier` | Opus · high | hub agent | Runs the frozen test for real and checks the report's claims; never the Builder's model |

Install: copy the `.md` files (not this README) into `~/.claude/agents/`; see [INSTALL.md](../../INSTALL.md). A project can override a type by putting a file of the same name in its own `.claude/agents/`.
