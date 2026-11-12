# 0041 Which decision record files go into git?

- Status: open
- Date: 2026-11-12
- Lenses: architecture, data-model
- Builds on: 0035, 0040

## Context

Each record is saved three ways: the .json is the source (about 70 lines), the .md is the readable copy that GitHub and phones show nicely (about 40 lines), and the .html page is about 290 lines, plus an index.html that every build rewrites. Another of Matt's projects found the pages made up about 75% of a 61-file records pull request, and GitHub's merge timed out on it twice. GitHub also shows .html only as raw code. And every page carries links to all the other decisions, so adding one record rewrites every page in the folder: drafting this one changed 34 pages for one new line in each. The build script recreates every page from the .json, so nothing would be lost. That project now keeps the pages local, with Matt's OK, and its orchestrator suggested the same for Crux. Builds on decision 35 (records land on a rolling docs/decisions pull request) and decision 40 (the orchestrator merges records-only pull requests).

## Options

### A: Commit .json and .md; build the pages locally (recommended)

A .gitignore inside .decisions ignores *.html, so the pages and index.html stay on disk but out of git. The build script writes that .gitignore whenever it creates a .decisions folder, the hub's records worktree does the same, and the hub rebuilds a project's pages after a pull when a .json is newer than its page.
- Pro: Records pull requests shrink to about a quarter
- Pro: No more conflicts between two branches that both add records: today each new record rewrites every page and index.html
- Pro: GitHub and phones show the .md, which is what reads well there anyway
- Pro: Nothing is lost: every page is rebuilt from its .json
- Con: After a pull, the pages are missing or stale until something runs the build, so the hub and the roll-up need to rebuild before they link to a page
- Con: Someone who clones the public repo has to run the build to see the pages (the example folder keeps its own pages)
- Con: A one-time cleanup in each repo: untrack the existing pages, which stay on disk
- Effort: Small: a .gitignore, a rebuild-if-stale step in the hub and roll-up, and doc updates

### B: Keep all three, marked as generated

Keep committing the pages, but mark them as generated in .gitattributes so GitHub folds them away in pull request views.
- Pro: Pages are always there after a pull, with no rebuild step
- Pro: Small change
- Con: The pages still make up most of every records pull request, and it is not clear this stops the merge timeouts
- Con: Every new record still rewrites every page, so two branches that add records conflict on all of them
- Effort: Tiny

### C: Commit only the .json

Treat both the .md and the .html as generated and keep them local.
- Pro: The smallest records pull requests
- Con: Records are no longer readable on GitHub or a phone
- Con: Reviewing a records pull request means reading raw JSON
- Effort: Small

## Recommendation

A (strong). A keeps what reads well on GitHub and drops what only bloats pull requests and causes conflicts. Its one real cost, pages missing after a pull, is solved by having the hub and the roll-up rebuild stale pages before linking to them. If picked, the build script and the docs/decisions setup write the .gitignore by default, so every repo gets it.
