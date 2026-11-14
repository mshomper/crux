# 0064 How do we cut the notices that reach you?

- Status: open
- Date: 2026-11-14
- Lenses: architecture, ui
- Builds on: 0019, 0021, 0034, 0045, 0058, 0060

## In short

Pick how to cut your notices. I recommend A: fix the permission checker so harmless commands stop reaching you, send one notice per choice instead of two or three, let your yes on a merge cover the merge itself, and quiet the restart and digest notices. On today's numbers that removes about half. Confidence: medium.

For you:

- Today you got about 102 notices (plus digests): 49 permission cards, 32 questions, 12 decisions, 8 restart notices, 1 pairing alert
- A would have removed roughly 50 of them: 25 harmless commands the checker misread, about 12 doubled choices, 9 merges asked again right after your yes, and the restart notices after merges you approved
- Real hard stops (push to main, force push, deletes outside, installs, secrets) still reach you every time
- Setup: The checker part is security work: built and reviewed on Opus at the highest effort, as before
- Hard to undo: Each fix is a separate rule that can be turned back; nothing is deleted

## Context

Matt: 'I'm still getting far too many notifications. The decision cards, the orchestrator follow-ups, your nudges. It's not tenable.' notice-audit replayed every project's event log for 2026-11-14 through the hub's own card rules (memo M038; the notice log and Conductor log sit under ~/.crux-hub and weren't read, so digests and Conductor re-posts aren't counted and card totals are an upper bound). About 102 notices: permission 49 (all allowed, none denied), questions 32, decisions 12, restart pushes 8, pairing 1. Causes ranked: (c) contained commands the checker misread, 25: feature-branch pushes read as pushes to main because the check starts in the main folder, merging main into a feature branch, a risky word anywhere in an opaque command (a commit message, a here-string), inline scripts with 'http', local test-hub curls, a GitHub release curl, pip --version, read-only git in other repos, temp cleanup, a read-only listing read as secrets, a 1-minute timeout. (a) one choice as several cards, 12: a worker's question plus its orchestrator's re-ask in looser words, a question plus a decision card on the same choice, a decision re-sent across a restart. (b) a merge asked again right after Matt's yes, 9 (every crux merge was question + merge card + restart notice = 3). Restart notices, 8. (f) statements in the questions field, 4. Summaries that ask nothing already send none. Return digests have no minimum gap. Conductor chat itself never pushes.

## Options

### A: Fix the causes (recommended)

1) Permission checker: check a command from the agent's own worktree (not the main folder), a merge needs Matt only when main receives it, scan for risky words with quoted text and here-strings removed, plus the dozen one-line rule fixes from the audit and a 5-minute permission timeout. 2) One notice per choice: a re-ask with mostly the same words, or a decision card on the same choice, is hidden behind the first card; the sent list survives restarts. 3) Your yes on 'May I merge #N?' pre-approves exactly that merge for 30 minutes. 4) No restart notice right after a merge you approved; other restarts follow the normal PC-or-phone routing. 5) A question line without a question mark isn't a card. 6) A 30-minute floor for return digests, and the Conductor stays silent about cards already in Needs you while you're present.
- Pro: Removes about half of today's notices without loosening any real hard stop
- Pro: Each fix targets a counted cause
- Con: Biggest build; the checker part needs a careful review
- Effort: Medium to large: two workers in parallel (checker on Opus xhigh with its reviewer; cards and digests on Opus high)

### B: Card fixes only

Parts 2 to 6 of A, leaving the permission checker as it is.
- Pro: Smaller build, no security changes
- Con: The largest single cause (25 harmless commands) keeps reaching you
- Effort: Medium

### C: A, plus a quiet mode

As A, and a quiet switch: while it's on, only hard-stop permission requests notify at once; everything else waits for the next digest, even while you're at the PC.
- Pro: The biggest cut, under your control
- Con: Questions and decisions wait up to 30 minutes while it's on
- Effort: A plus a small switch

## Recommendation

A (lean). A removes the counted causes at the source, so notices drop without hiding anything you need. The quiet switch in C is easy to add later if A isn't enough.

What would change this: If notices still feel heavy after A, add C's quiet switch; if you'd rather not touch the checker now, take B.
