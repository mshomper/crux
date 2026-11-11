# 0014 Where does what the system knows about you live?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: data-model
- Builds on: 0013
- Settles: personal profile location = private git repo in the home crux folder (alongside the roll-up); never in a public repo; the public Crux repo ships only a blank template

## Decision

**C: A private memory repo.** Turn the home crux folder (where the roll-up and conventions already live) into its own private repo. The profile and cross-project memory live there with full history, and sync through GitHub Desktop. The Crux repo root carries a blank template and a pointer.

## Context

You asked for it at the root of the Crux repo. That repo is public on GitHub, and the material to merge (your Claude.ai export plus the 45 lessons in Claude Code memory) includes confidential employer work, contract terms, people and family details. Whatever is committed to the repo is published on the next push.

## Options

### A: Repo root, public-safe part only

Commit only the working preferences (how to talk to you, UI rules, testing habits) at the repo root. Everything sensitive lives in a private file elsewhere.
- Pro: Literally where you asked
- Pro: Doubles as an example for other Crux users
- Con: Two files to keep in step
- Con: Every edit is a judgement call about what is safe to publish
- Effort: Small

### B: Repo root, kept out of git

A profile folder at the repo root, listed in the ignore file so it is never committed.
- Pro: Exactly where you asked, never pushed
- Con: One slip in the ignore file or in GitHub Desktop publishes it
- Con: No history of changes
- Con: Lives on this machine only
- Effort: Small

### C: A private memory repo (chosen) (recommended)

Turn the home crux folder (where the roll-up and conventions already live) into its own private repo. The profile and cross-project memory live there with full history, and sync through GitHub Desktop. The Crux repo root carries a blank template and a pointer.
- Pro: History of every change, like your other repos
- Pro: Private, and on the same footing as your other private repos
- Pro: Syncs to any machine
- Pro: Natural home for the top two layers in decision 13
- Con: One more repo to keep
- Con: Not literally at the Crux repo root
- Effort: Small

## Recommendation

C (lean). Your memory will hold confidential work, so it should never sit one click from a public push. A private repo keeps it versioned and portable, and the Crux repo still ships a template others can copy.
