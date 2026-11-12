# 0040 Who merges pull requests that hold only decision records or documentation?

- Status: decided
- Date: 2026-11-12, decided 2026-11-12
- Lenses: research
- Builds on: 0007, 0022, 0035
- Settles: records and documentation merges = the orchestrator may merge pull requests that change only decision records and documentation (Markdown and its pictures), reporting each in one line; set per repo by the human; all other merges stay with the human (see agent git push authority)

## Decision

**C: The orchestrator merges records-only and documentation-only pull requests.** When a pull request changes nothing but decision records and documentation, the orchestrator merges it without asking and tells Matt in one line. Every other merge stays Matt's. Each person sets this per repo; it is Matt's rule for this repo and most of his others.

Reason: Having to say merge each time is what bothers me. In general, documentation-only PRs and merges are fine with me. In most of my repos, I'm fine with the orchestrator merging records-only / documentation without my approval.

## Context

Picks made in the hub land on a standing docs/decisions branch with one rolling pull request (decision 35), and every merge has needed Matt's word (decisions 7 and 22). On 2026-11-12 that meant three separate 'merge' replies for records-only pull requests. Matt said that having to say merge each time is the part that bothers him, and that records-only and documentation-only merges are fine without his approval in most of his repos.

## Options

### A: Keep as is

One rolling records pull request; Matt says merge each time.
- Pro: No change to the rule that every merge is Matt's
- Con: A merge reply for every pick, with nothing in it for Matt to review
- Effort: None

### B: Records ride with the build

The record goes into the pull request of the work that builds it.
- Pro: Fewer pull requests
- Con: Picks that lead to no code have no home
- Con: The record reaches main later than the pick
- Effort: A change to how the hub lands picks

### C: The orchestrator merges records-only and documentation-only pull requests (chosen) (recommended)

When a pull request changes nothing but decision records and documentation, the orchestrator merges it without asking and tells Matt in one line. Every other merge stays Matt's. Each person sets this per repo; it is Matt's rule for this repo and most of his others.
- Pro: Removes the merge reply that carries no real review
- Pro: Code merges, pushes to main, force pushes and deletions stay with Matt
- Pro: Still one line in the thread for each merge, so nothing happens unseen
- Con: Documentation in a public repo can still leak something private, so the orchestrator must check what the pull request contains before merging
- Con: Needs a clear line for what counts as documentation
- Effort: A rule for the orchestrator now; a per-repo setting in the hub later if wanted

## Recommendation

C (strong). Matt's own rule. The line used: a pull request counts as records-only or documentation-only when every changed file is under .decisions/ or is a Markdown document (README, INSTALL, guides, notes) or a picture those documents show. Anything that runs or is published as a product (code, scripts, settings, package files, the public web page in site/) is not documentation for this rule. Before merging, the orchestrator checks the file list, checks it merges cleanly, and in a public repo checks nothing private is in it; when in doubt it asks.
