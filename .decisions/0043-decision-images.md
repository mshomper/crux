# 0043 Where do a decision's pictures live, so its card can show them?

- Status: open
- Date: 2026-11-12
- Lenses: data-model, ui
- Builds on: 0023, 0035, 0041

## Context

Mockups and sketches for a decision today live in a worker's thread or temp folder, or on a branch, so the decision card in Needs you doesn't carry them and Matt has to go looking (decision 42 was the latest example). Matt proposed that every decision with pictures gets a card that opens a gallery of them. The card part is plain UI; the real choice is where the pictures are kept and whether they travel with the record into git. Agents would name the pictures when drafting (the ids from post_visual, or file paths), and the hub does the copying. Builds on decision 23 (pasted images kept as files next to the event log), 35 (records land on a rolling docs/decisions pull request) and 41 (only .json and .md go into git).

## Options

### A: Pictures go into git with the record (recommended)

The hub copies each picture into .decisions/images/NNNN-name.png (shrunk to about 1600 px wide) and lists it in the record's .json. The card gets a pictures button that opens them as a gallery; the .md and the page show them too, so they read on GitHub and the phone, and land on the same rolling records pull request.
- Pro: The record is complete: pictures survive branches, worktrees and temp folders being cleaned up
- Pro: Readable on GitHub and the phone through the .md, not only in the hub
- Pro: Later sessions see what was actually shown when the call was made
- Con: Records pull requests grow again, by a few hundred KB per picture
- Con: In a public repo (Crux) the pictures are public, so mockups must keep using fake data (already the practice)
- Effort: Small to medium: a pictures field, a copy-and-shrink step in the hub, a gallery on the card, a line in the page and .md templates

### B: Pictures stay in the hub only

Pictures are kept as hub attachments (.crux/attachments, like pasted images) and the record lists their ids. The card opens the gallery; nothing goes into git.
- Pro: No growth in records pull requests
- Pro: Nothing becomes public by accident
- Con: Only visible in the hub on this machine; GitHub, the .md and a fresh clone show no pictures
- Con: Lost if the hub's folder is cleared or the projects move to another box
- Effort: Small

### C: Hub while open, into git when picked

While a decision is open its pictures live in the hub (as B). When Matt picks, only the pictures of the chosen option, plus any shared ones, are copied into .decisions/images and committed with the record (as A).
- Pro: Keeps the history of what was chosen, with less weight than A
- Pro: Open decisions don't add to pull requests until they're settled
- Con: The pictures of the options not taken are not kept in git
- Con: Two places and a hand-over step: more to build and more to go wrong
- Effort: Medium

## Recommendation

A (moderate). A keeps the record whole: the pictures are what Matt decides from, so they belong with the decision, and they read on GitHub and the phone too. Shrinking them keeps the weight modest. Public repos rely on fake data in mockups, which agents already use.
