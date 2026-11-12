# Installing and using Crux

Crux is two skill folders, `crux` and `crux-dig`, placed where Claude Code looks for skills: `~/.claude/skills/` (on Windows, `C:\Users\<you>\.claude\skills\`). Both are needed: `crux-dig` uses `crux`'s page builder.

This page covers the skill. To run the Hub, see [hub/README.md](hub/README.md).

**You need:** Claude Code, and Node 20 or newer (the page builder runs on Node). Check with `node --version`; if it is missing or older, install it from https://nodejs.org.

---

## 1. Get the repo

Either:
- `git clone https://github.com/mshomper/crux.git` in a terminal, in the folder where you keep your projects; or
- in GitHub Desktop: File, then Clone repository, and pick `mshomper/crux`.

The steps below assume the clone is at `Documents\GitHub\crux` (Windows) or `~/crux-repo` (Mac/Linux); change the path if yours differs.

## 2. Put the skills where Claude Code finds them

### Option A: link to the clone (recommended)

Claude Code's skills folder points at the clone, so pulling an update updates the installed skill. Nothing to copy again.

**Windows.** Open PowerShell (no admin needed) and run:

```powershell
$repo   = "$env:USERPROFILE\Documents\GitHub\crux"
$skills = "$env:USERPROFILE\.claude\skills"
New-Item -ItemType Directory -Force -Path $skills | Out-Null
New-Item -ItemType Junction -Path "$skills\crux" -Target "$repo\crux"; New-Item -ItemType Junction -Path "$skills\crux-dig" -Target "$repo\crux-dig"
```

A junction is a folder shortcut that programs treat as the real folder. Deleting the junction later does not delete the repo.

**Mac and Linux (untested).** In a terminal:

```bash
mkdir -p ~/.claude/skills
ln -s ~/crux-repo/crux ~/.claude/skills/crux
ln -s ~/crux-repo/crux-dig ~/.claude/skills/crux-dig
```

**Updating:** pull the repo (`git pull`, or Pull in GitHub Desktop). Done.

### Option B: plain copy

1. Download this repo from GitHub (Code, then Download ZIP) and unzip it.
2. Create a `skills` folder inside `~/.claude/` if there isn't one.
3. Copy the `crux` and `crux-dig` folders into `skills`.

**Updating:** replace both folders with the new versions.

## 3. Check it works

1. Start a new Claude Code session in any repo. (If a session was already open, starting a new one is the sure way; typing `/reload-plugins` in it may also work, but this is untested.)
2. Type `/crux`: it should appear in the command list, along with `/crux-dig`.
3. Try `/crux quick` with a small question. When you pick, Claude writes the record and builds `.decisions/index.html` in that repo.
4. The first time, Claude offers to add one line to the repo's `CLAUDE.md`. Say yes so future sessions read the records before planning.

To see the pages before installing, open [example/demo-decisions/index.html](example/demo-decisions/index.html): a made-up hiking-trail planner, with placeholder sources.

---

## How it works

AI coding tools make dozens of decisions for you while you aren't looking: the data model, the method, where state lives, what the screen looks like. Crux stops at the handful that matter, shows you the options as pictures, waits for your pick, and keeps a record that every later session reads before planning.

```mermaid
flowchart TD
    A[You ask for a change] --> B[Crux reads past decisions, the repo's own<br>decision log and cross-project conventions]
    B --> C{How big is the choice?}
    C -->|Contained| D[Quick: 2-3 options in chat]
    C -->|Hard to reverse| E[Full: a visual page per decision]
    D --> F[You pick, park or drop it]
    E --> F
    F --> G[Record saved to .decisions/]
    G --> H[Claude builds]
    G -.->|next session| B
```

- **Quick** for contained questions: two or three options in chat, a recommendation, you reply with a letter.
- **Full** for choices that are hard to reverse: three to five ranked decisions, each on its own page with a sketch per option, specific pros and cons, scored criteria, and a recommendation with a confidence level.
- **Deep**, added to either, researches each option in parallel (web and code), cites sources, and lists assumptions, risks and estimates with their basis. After you pick, it writes a **build brief** for the session that builds it.
- **Crux Dig** reads an existing codebase and drafts the decisions already baked into it. Each finding gets two separate reads: whether it was **deliberate**, and whether it is **holding up** or now **strained**. Strained findings are the candidates for your next real decisions.

<p align="center"><img src="assets/decision-page.png" alt="A Crux decision page from the demo: three ways to estimate walking time on a hiking route, each with a sketch, pros and cons, and a recommended badge on one" width="900"></p>

## Commands

| You type | What happens |
| --- | --- |
| `/crux quick presets in the URL or a file` | Two or three options in chat, you reply with a letter |
| `/crux full plan offline maps` | Three to five ranked decisions, one visual page each |
| `/crux deep plan offline maps` | Full, plus research, sources, risks, estimates and a build brief |
| `/crux quick deep presets in the URL or a file` | One researched decision on a page |
| `/crux challenge 0003` | Claude argues against your pick; you keep it or reopen it |
| `/crux park 0007 until 2027-01-15` or `when the hosted backend starts` | Set a decision aside; it comes back on the date or when the trigger comes up |
| `/crux drop 0007` | Not doing this; kept as history so it is never proposed again |
| `/crux clear` | Lists unreviewed drafts, and deletes them only after you say yes |
| `/crux all` | Summary of what is waiting in every project, plus conflicts |
| `/crux-dig` or `/crux-dig src/routes` | Drafts decisions already in the code; re-running refreshes them in place |

Crux also steps in on its own, in quick mode, when Claude is about to make an architecture-level choice: a new dependency, a data model change, a solver or physics change, a change across several modules, or a research or product direction.

On any decision page you can also pick, park, drop, confirm, reject or edit, then press "Copy for Claude" and paste the line into your session.

## Decision lifecycle

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Found: Crux Dig
    [*] --> Open: /crux
    Found --> Decided: confirm
    Found --> Rejected: reject
    Open --> Decided: pick
    Open --> Parked: park
    Parked --> Open: date passes or trigger comes up
    Open --> Rejected: drop
    Decided --> Superseded: a newer decision replaces it
```

Nothing that was decided, parked or rejected is ever deleted. It is superseded or kept as history, so the record of why things are the way they are stays intact. Only unreviewed drafts can be cleared.

## The board

Each repo gets `.decisions/index.html`, an offline page in the same style as the decision pages:

- **Where things stand**: a status bar and one tile per decision, coloured by state, each opening its page.
- **By area**: one row per lens, so you can see where strain clusters.
- **Board**: lanes for open items from the repo's own log, strained, needs your call, needs review, parked, decided and history. Empty lanes are hidden, and each lane shows its first five cards (three for decided and history) with "Show more" at the bottom, so the page stays short however many decisions pile up.
- **What builds on what**: a map of the links between decisions, foundations on the left.

<p align="center"><img src="assets/board.png" alt="The demo board: a status bar and tiles, decisions by area, lanes for strained, needs your call, parked and decided, and a map of which decisions build on which" width="900"></p>

A decided page keeps the pick, the reason and, in deep mode, the build brief:

<p align="center"><img src="assets/build-brief.png" alt="A decided demo page: GPX file chosen for saving routes, a conflict note with another decision, the recommendation, the pick and the start of the build brief" width="760"></p>

## Across all your projects

Every time a decision changes, Crux refreshes one page covering every repo you have pulled down, plus a short conventions list that Claude reads before planning. It is written to `~/crux/index.html` and `~/crux/conventions.md`. Bookmark the page.

<p align="center"><img src="assets/all-projects.png" alt="The all-projects page for two demo projects: a conflict on distance unit (miles in one, kilometres in the other), next up, and the lanes across both" width="760"></p>

- **Projects collapse** to one summary row each, with a coloured bar of their states; click to see their tiles. Projects with open items or strained decisions start expanded, and your choices are remembered.
- **Next up** lists the five things most worth your attention across every project: open items first, then the oldest calls.
- **Waiting for a call** across all projects, oldest first, with anything over two weeks flagged and parked decisions that are due back.
- **Conflicts**: when two projects settle the same question differently (kilometres in one, miles in another), it shows at the top.
- **Conventions** each project has settled, so a new tool doesn't quietly contradict an old one.

By default it scans `~/Documents/GitHub`. To scan other folders, or skip some, create `~/crux/config.json`:

```json
{
  "roots": ["C:\\Users\\<you>\\Documents\\GitHub", "D:\\Other\\Repos"],
  "ignore": ["old-experiments", "C:\\Users\\<you>\\Documents\\GitHub\\archive"]
}
```

`ignore` takes folder names (skipped wherever they appear) or full paths. Setting `CRUX_HOME` to another folder moves the page, the conventions list and this config file there.

## What lands in each repo

```
.decisions/
  index.html                  the board
  0004-route-files.json       the source Claude edits
  0004-route-files.html       the visual page
  0004-route-files.md         short readable record that later sessions read
```

Pages open in any browser, offline. Commit the folder so the records travel with the code.

## How the parts fit

```mermaid
flowchart LR
    subgraph Skills
        S1[crux/SKILL.md<br>engine]
        S2[crux-dig/SKILL.md<br>codebase pass]
        L[lenses/<br>5 checklists]
    end
    subgraph Repo[Each repo]
        J[.decisions/*.json<br>source records]
        P[.html pages<br>+ index board]
        M[.md records<br>read by later sessions]
        LOG[Existing decision log<br>DECISIONS.md, ADRs]
    end
    subgraph Home[Your home folder]
        R[crux/index.html<br>all projects]
        C[crux/conventions.md]
    end
    S1 -- writes --> J
    S2 -- writes --> J
    L -.-> S1
    L -.-> S2
    J -- build.mjs --> P
    J -- build.mjs --> M
    J -- rollup.mjs --> R
    J -- rollup.mjs --> C
    LOG -. linked, never rewritten .-> S1
    M -. read before planning .-> S1
    C -. read before planning .-> S1
```

| Part | What it does |
| --- | --- |
| `crux/SKILL.md` | The engine: modes, picking, parking, dropping, clearing, challenge and the cross-project summary |
| `crux-dig/SKILL.md` | The codebase pass: drafts findings with the deliberate and holding-up reads, links the repo's own decision log, refreshes in place on re-run |
| `crux/lenses/` | Short checklists Crux loads when relevant: architecture, data model, solver and physics, UI, research and product |
| `crux/template/` | Page, board and all-projects templates, plus the shared style. House UI rules are built in: no sideways scrolling, drawn icons only, no toggles |
| `crux/scripts/build.mjs` | Turns each repo's JSON records into pages, readable Markdown and the board, then refreshes the roll-up. No dependencies |
| `crux/scripts/rollup.mjs` | Scans your project folders, writes the all-projects page and conventions list, and flags conflicts, stale decisions and parked ones that are due |
| `hub/` | Crux Hub, the chat app for running several agents; see [hub/README.md](hub/README.md) |
| `profile-template/` | A blank template for the private profile the Hub's agents can load; see [profile-template/README.md](profile-template/README.md) |
| `example/demo-decisions/` | Demo records and pages for a made-up hiking-trail planner |

The JSON records are the single source; everything else is regenerated from them. Claude writes the content, and the templates handle layout, so pages stay consistent and cost few tokens.

## Design rules

- Nothing is built, edited or installed until you pick.
- Pages never scroll sideways and use drawn icons only.
- No toggles: everything is shown, ordered by what needs you first.
- Claims without a source are labelled as Claude's judgment.
- A repo's existing decision log stays the main record; Crux links to it and never rewrites it.
- Small on purpose: a few hundred lines of instructions, a few templates, and two scripts with no dependencies. (The Hub is separate and has three npm dependencies.)

## Removing it

Delete `crux` and `crux-dig` from `~/.claude/skills/`. Your `.decisions` folders stay in each repo untouched.
