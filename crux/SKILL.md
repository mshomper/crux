---
name: crux
description: Surface the decisions hiding inside a task, show options visually, wait for the user's pick, and record it in .decisions/. Use when the user types /crux, asks to think through options before building, or when you are about to make an architecture-level choice on your own (new dependency, data model change, solver or physics model change, a change spanning several modules, or a research or product direction). Not for routine fixes.
argument-hint: "[quick|full] [deep] what's on your mind | challenge <number> | park <number> | drop <number> | clear | all"
---

# Crux

You do the work around a decision. The user makes the call. You never build, edit code, or act on an option until the user has picked one.

Arguments: **$ARGUMENTS**

## 0. Before anything

1. Read every `.decisions/*.md` file in the repo root, if the folder exists. These are past decisions. They are short; read them all.
2. If the repo keeps its own decision log (`DECISIONS.md`, `docs/adr/` and the like), read it too. It is part of the record: respect what it settles, link its entries with `log_refs` rather than restating them, and raise any entry it marks as open or for review when it bears on the current work.
3. Read `~/crux/conventions.md` if it exists (the home folder's `crux` folder). It lists what has been settled across all the user's projects, such as units, precision or file formats.
   Also read `~/crux/profile/core.md` if it exists: how the user wants work done and decisions shown. If `~/crux/profile/packs/_index.md` names a pack for this project, read that pack too. Never read `~/crux/profile/private.md` unless the decision needs it, and never copy anything from the profile into `.decisions/` or any other file in the repo.
4. Note any active decision, in this repo, its own log, or the conventions list, that your new options would contradict. A conflict is shown to the user, never silently overridden.
5. Check parked decisions. Any whose `revisit.date` has passed: set `status` back to `open`, keep the `revisit` note, and tell the user in one line. Any whose `revisit.trigger` matches the work at hand: mention it in one line and ask whether to reopen it. Do not reopen trigger-based ones yourself.
6. If `.decisions/` does not exist, create it on the first record. Then check the repo's `CLAUDE.md` for the decisions line (see section 6). If missing, ask once whether to add it.

## 1. Pick the mode

- First word `quick` → quick mode. First word `full` → full mode. First word `challenge` → challenge mode (section 5). First word `all` → cross-project summary (section 5). First word `park`, `drop` or `clear` → section 4b.
- The word `deep` among the first two words adds depth (section 3, "Deep additions") on top of either mode. `quick deep` means one decision, researched, on a page rather than in chat. `full deep` means every decision is researched. `deep` alone means full deep. Say in one line that deep mode takes longer and uses more.
- No mode word: use **quick** if the question is contained (one module, easy to reverse). Use **full** if it is hard to reverse, touches several modules, or sets direction for later work. Say which you chose in one line.
- When you invoked this yourself mid-task (the user did not type /crux), always use quick mode and keep it to one decision.

## 2. Find the decisions

1. Load the matching lens files from this skill's `lenses/` folder. Load only what applies; several may apply.

   | Lens | Load when the work involves |
   | --- | --- |
   | `architecture.md` | modules, dependencies, file and folder structure, build, performance strategy |
   | `data-model.md` | file formats, data structures, state, persistence, units, import and export |
   | `solver.md` | physics, simulation, numerical methods, GPU compute, calibration, validation |
   | `ui.md` | layout, controls, panels, interaction, visual presentation |
   | `research.md` | research questions, test plans, product direction, priorities, what to build next |

2. Use each lens's checklist to find the decisions hiding in the request, including ones the user did not mention.
3. Rank by: hard to reverse first, then what other decisions depend on, then impact.
4. Quick mode: take the top **one** decision (at most two). Full mode: take the top **three to five**. Show the ranked list in one short message before building pages, so the user can drop or add one. In quick mode skip this step.

## 3. Build each decision

### Quick mode (in chat, no page)

Write, in chat:
- The question, one line.
- Two or three options, each as: letter, name, one sentence, main cost.
- Your recommendation, one sentence of why, and your confidence: strong, lean, or toss-up. For a toss-up, name the condition that decides it.
- If you showed pictures for it (mockups, screenshots, charts), attach them to the message or post them, and name them in the record's `images` list (see "Pictures" below).
- Then stop and wait.

After the pick, still write the record (section 4) with `"mode": "quick"` and no sketches, keeping its `images`.

### Pictures (any mode)

Every decision that was shown with pictures carries them, so its card, page and `.md` show what the call was made from.

- List each picture in the record's `images` field: `{ "from": "...", "caption": "One line on what it shows", "option": "B" }`. `from` is the id `post_visual` returned in the Crux hub, or the path of a PNG, JPEG, GIF or WebP file inside the project folder or one of its worktrees. Files elsewhere (a temp folder, say) are refused: post them with `post_visual` first, or save them inside the project. Leave out `option` for a picture that covers the whole question.
- The build script (or the hub, when it commits the record) copies each one into `.decisions/images/NNNN-name.png`, shrinks PNGs wider than 1600 px, strips text and camera metadata from PNGs and JPEGs (GIF and WebP are copied as they are), and rewrites the entry to `{ "file": "images/NNNN-name.png", ... }`. Never write into `images/` yourself and never edit a `file` entry by hand.
- A picture that is refused (outside the project, not an image, an interlaced PNG wider than 1600 px, over 3 MB after shrinking) gets a `"skipped"` note with the reason, and the build lists it under "Problems to fix". It is not tried again: fix it, then delete the `"skipped"` note. A file not found yet gets a `"missing"` note and is tried again on every build and commit.
- SVG and HTML mockups: take a PNG screenshot and list that.
- **Public repos**: the pictures go into git with the record and become public. Mockups use fake, neutral data (made-up names, projects and numbers); never real people, clients, employer work, private paths or anything confidential. Check a repo's visibility before adding a screenshot of real work.

### Full mode (visual page)

For each decision, write one JSON file `.decisions/NNNN-short-slug.json` (next free number, four digits) using the schema in section 7. Requirements:

- **Two to four options.** Use fewer when fewer real options exist. Never pad with straw men.
- **Every option gets a sketch**: a small inline SVG that makes the difference visible. The lens file says what kind of sketch fits. Sketch rules:
  - `viewBox` around `0 0 320 180`, no fixed width or height attributes.
  - Use `currentColor` for strokes and text, and the CSS variables `var(--accent)`, `var(--muted)`, `var(--good)`, `var(--warn)` for fills. No hard-coded colors, no emoji, no glyph icons.
  - Text inside the SVG at least 11 units tall, three to five labels maximum.
- Pros and cons are specific enough to argue with. Your recommended option gets the same scrutiny as the rest.
- **Criteria**: three to six dimensions that decide this question, each option scored 1 (weak), 2 (fair), or 3 (strong), with a one-line note where a score is not obvious.
- Fill `depends_on` with numbers of earlier decisions this one builds on, and `conflicts` with any active decision it would contradict.
- Mockups and screenshots beyond the sketches go in `images` (see "Pictures" above), each with its option letter. Fake, neutral data in public repos.

Then run the build script from this skill's folder:

```
node <this skill's folder>/scripts/build.mjs .decisions
```

It copies the record's pictures into `.decisions/images/`, then writes `NNNN-slug.html` (the page), `NNNN-slug.md` (the readable record) and `index.html`, plus a `.gitignore` in `.decisions` that keeps the pages out of git. Commit only the `.json` and `.md` records and their pictures in `images/`; never commit or force-add the `.html` pages or `index.html`, which are rebuilt from the records. If the repo you are working in is a worktree (its path contains `.claude/worktrees/`, or `git rev-parse --git-common-dir` points outside it), say so in one line with the full path of `.decisions/`, and note that the records reach the main copy when the branch is merged. Offer to merge when the work is done. Tell the user the page path in one line, plus a one-line summary of each option. Then stop and wait.

### Deep additions (only when `deep` was given)

Before writing the JSON, research. Split it into small parallel subagents, one per option (plus one for the codebase if code is involved), all launched in one message. Give each a short brief: the decision, its one option, and what to return. Keep drafting the rest of the decision while they run. Each returns findings only, not page dumps.

- **Web search is on by default.** Look for papers, documentation, standards, benchmarks and prior implementations that bear on the option. Fetch a source before citing it. Never invent a citation, title or number; if nothing turns up, say so.
- **Code**: read the relevant files and note the paths that matter.

Then add to the JSON (schema in section 7):

- `evidence`: claims that matter to the decision. Each has the claim in your own words, which options it bears on, and its source title and link. A claim with no source is allowed only when marked `"judgment": true`, meaning it is your reasoning, not a finding.
- Per option: `assumptions` (what has to be true for it to work), `risks` (how it goes wrong in practice), and `estimates` (run time, memory, effort or cost, each with a value and the basis for it, so the user can check the reasoning).
- `change_mind`: the result or fact that would flip your recommendation to another option.

Keep each list to the three to five items that matter most. Depth means better-grounded content, not longer lists.

The user replies in chat ("B", "B because ...", or "none, do X instead"), or uses the copy button on the page, which produces a line like `Decision 0007: pick B. Reason: ...`.

## 4. Record the pick

1. Update the JSON: `status` to `decided`, `chosen` to the letter, `reason` to the user's reason in their words (leave empty if they gave none; never ask twice), `decided_on` to today.
   Also fill `settles`: the conventions this pick fixes that other projects might also decide, as short key and value pairs (for example key "length unit", value "millimetres"). Reuse a key from `~/crux/conventions.md` whenever the question is the same, so the roll-up can compare them. Fill it whenever a related project of the user's might decide the same thing, even if this project is the only one using it today: units and coordinate frames, grid or array layout and indexing order, material laws and their constants, numerical method choices, precision, file formats, and build or tooling conventions. Include the specifics another project would need to match (for example a version or constants source, or an indexing formula). Leave it empty only when no other project could plausibly face the same question.
2. If the user brings their own answer, add it as a new option (next letter, `"source": "human"`), with a sketch in full mode, and mark it chosen.
3. If this replaces an older decision, set the older one's `status` to `superseded` and `superseded_by` to the new number.
4. **Deep mode only:** write the `brief` for the chosen option. It is the briefing for whichever session builds it, so write it for a reader with no memory of this conversation: `files` (paths to create or change, with one line each on what changes), `steps` (in order), `done_when` (checks that prove it works), `validation` (tests, or for physics work the comparison against data and the acceptable error), and `avoid` (traps, and anything that would contradict an active decision). Ground it in the code you read and the evidence gathered.
5. Run the build script again. Then move to the next decision, using what was just chosen.
6. When all decisions are made, give a one-paragraph summary of the choices and ask whether to start building. When building a decision that has a `brief`, follow it.

## 4b. Park, drop and clear

The user can also reply to a decision with "park", "drop", "reject" or "edit", in chat or with the page's copy button (for example `Decision 0007: park until 2027-01-15` or `Decision 0007: park when the hosted backend starts`).

- **Park** an open decision (`/crux park 0007 until <date>` or `when <trigger>`): set `status` to `parked` and `revisit` to `{ "date": "YYYY-MM-DD" }` or `{ "trigger": "plain words" }`. Ask for one if neither was given. Parked decisions are not waiting for a call and never count as stale. Section 0 reopens them.
- **Drop** an open decision (`/crux drop 0007`, "we're not doing this"): set `status` to `rejected`, with `reason` from their words. Kept as history; never proposed again.
- **Reject** a found decision: same as drop. Kept so Crux Dig never drafts it again.
- **Clear** (`/crux clear`, optionally followed by numbers): removes drafts nobody has acted on, meaning `found` records and `open` ones without a `chosen` pick. List exactly which files will go, wait for a yes, then delete each one's `.json`, `.html` and `.md`, plus the pictures its `images` list points at, and rebuild. Never delete `decided`, `rejected`, `superseded` or `parked` records, even if asked to clear everything; offer to supersede or drop them instead. Numbers are not reused.

Rebuild after any of these.

## 5. Challenge mode and cross-project summary

`/crux challenge 0007` (or "argue against my pick"): read that decision. Argue the strongest case against the chosen option in a short message: what would have to be true for another option to win, and what evidence would show it. Add the argument to the JSON under `challenge`, rebuild, and ask whether to keep the pick or reopen the decision. Do not reopen it yourself.

`/crux all`: run `node <this skill's folder>/scripts/rollup.mjs`, then read `~/crux/conventions.md` and the script's output. Give a short summary: what is waiting for a call in each project (oldest first), any conflicts across projects, and the path to `~/crux/index.html`. Change nothing.

The build script refreshes the roll-up automatically after every build. If it prints a conflict, tell the user in one line and offer to open a decision that settles it.

## 6. The CLAUDE.md line

The line to offer (once per repo):

```
Decisions: read .decisions/*.md before planning work. Do not contradict an active decision without saying so. Before an architecture-level choice (new dependency, data model, solver or physics model, multi-module change, research or product direction), run /crux in quick mode.
```

## 7. JSON schema

```json
{
  "id": 7,
  "slug": "gpu-solver-port",
  "title": "How should the contact solver move to the GPU?",
  "date": "2026-11-02",
  "mode": "full",
  "lenses": ["solver", "architecture"],
  "status": "open",
  "context": "Two or three sentences: what is being decided and why it matters now.",
  "depends_on": [3],
  "conflicts": [],
  "options": [
    {
      "key": "A",
      "name": "Short name",
      "summary": "One or two sentences.",
      "sketch": "<svg viewBox='0 0 320 180'>...</svg>",
      "pros": ["..."],
      "cons": ["..."],
      "effort": "Rough effort or cost in plain words",
      "source": "claude"
    }
  ],
  "criteria": [
    { "name": "Speed", "scores": { "A": 3, "B": 2 }, "note": "optional" }
  ],
  "recommended": "A",
  "recommendation": "One or two sentences of why.",
  "confidence": "lean",
  "chosen": null,
  "reason": null,
  "decided_on": null,
  "superseded_by": null,
  "challenge": null,
  "settles": [ { "key": "length unit", "value": "millimetres" } ],
  "images": [
    { "from": "C:/repo/.claude/worktrees/mock/mockup-b.png", "caption": "Option B on a phone", "option": "B" },
    { "file": "images/0007-current-layout.png", "caption": "Today's layout" }
  ]
}
```

`images` is optional. An entry with `from` is still to be copied in; the build turns it into a `file` entry, or marks it `"skipped"` with the reason.

Deep mode adds these fields (leave them out otherwise):

```json
{
  "deep": true,
  "evidence": [
    { "claim": "Your words", "options": ["B"], "source": "Title", "url": "https://..." },
    { "claim": "Your reasoning", "options": ["A", "C"], "judgment": true }
  ],
  "change_mind": "If held-back tests show X, A becomes the better pick.",
  "options": [
    {
      "key": "A",
      "assumptions": ["..."],
      "risks": ["..."],
      "estimates": [ { "what": "Run time", "value": "about 2x current", "basis": "the finer band doubles the cell count" } ]
    }
  ],
  "brief": {
    "files": [ { "path": "src/solver/contact.js", "change": "..." } ],
    "steps": ["..."],
    "done_when": ["..."],
    "validation": ["..."],
    "avoid": ["..."]
  }
}
```

Findings from `/crux-dig` also carry `deliberate` (`yes`, `likely`, `unclear`), `holding_up` (`fine` or `strained`), `strain` (one sentence), `ruled_out` (list of `{ "option", "by" }`), `log_refs` (list of `{ "file", "entry" }`) and `open_item` (true or false). Any decision may carry `log_refs`.

`status` is one of `open`, `decided`, `superseded`, `found` (drafted by /crux-dig and waiting for review), `parked` (set aside, with `revisit`), or `rejected` (dropped or rejected; kept as history).

`revisit` (parked only): `{ "date": "2027-01-15" }` or `{ "trigger": "when the hosted backend starts" }`, or both.

## Rules

- Never build, edit, or install anything as part of this skill except files in `.decisions/` and the CLAUDE.md line the user approved.
- Pictures in a public repo's records show fake, neutral data only.
- Never ask the user to justify a pick. Record a reason only when they give one.
- Plain language in questions to the user: no variable names or symbols.
- Keep chat messages short. The page carries the detail.
