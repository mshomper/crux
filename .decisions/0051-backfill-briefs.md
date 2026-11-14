# 0051 Should older decisions get a written brief too?

- Status: decided
- Date: 2026-11-13, decided 2026-11-13
- Lenses: data-model
- Builds on: 0050, 0040, 0041

## In short

Pick whether an agent goes back and writes the short brief (answer first, what it means for you) into decisions made before the brief existed. I recommend B: only decisions still open or parked, since those are the ones you will read again. Confidence: lean.

For you:

- Older decisions you reopen will start with a plain answer instead of the background
- Setup: Nothing to set up: one records-only pull request, which I merge and report in one line
- Hard to undo: Easy to undo: briefs are two text fields; the original wording of every decision stays untouched

## Decision

**B: Only the ones still open or parked.** An agent writes lead and for_you into every record whose status is open or parked, plus any decided record that a new decision is about to supersede. Settled ones keep the fallback.

## Context

Decision 50 B added two fields to every record, lead and for_you, and the hub's brief opens on them. Records 0001 to 0049 were written before that, so their brief is laid out from their other fields and opens on the recommendation with a note that no brief was written. The reviewer of PR #57 and the builder both listed a backfill as a possible follow-up. The Crux rule that nothing decided is ever rewritten still holds: a backfill only adds the two new fields and never changes the options, the pick or the reason. This record also serves as Matt's first live test of the brief on hub 0.17.1.

## Options

### A: Leave them as they are

No backfill. Older decisions keep the fallback layout built from their fields. Every new decision gets a brief from now on.
- Pro: No work, no records pull request
- Pro: Most of the old decisions are settled and rarely reopened
- Con: When an old decision comes back (a challenge or a superseding call), you read the agent-written background again
- Effort: None

### B: Only the ones still open or parked (chosen) (recommended)

An agent writes lead and for_you into every record whose status is open or parked, plus any decided record that a new decision is about to supersede. Settled ones keep the fallback.
- Pro: Covers the decisions you are likely to read again
- Pro: Small: a handful of records, one records-only pull request
- Con: A settled decision that comes back later still needs its brief written then
- Effort: Small: one agent, under an hour, records only

### C: All of them

An agent writes lead and for_you into every record from 0001 to 0049, settled ones included.
- Pro: Every card in the hub opens the same way
- Pro: The whole decision history becomes readable on GitHub and the phone
- Con: Most of the effort goes on decisions nobody will reopen
- Con: Writing a brief after the fact means guessing what mattered to you at the time
- Effort: Medium: about 49 records, one longer records-only pull request

## Recommendation

B (lean). The brief pays off when you read a decision again, and that is almost always an open or parked one. B covers those for a small records-only change; C spends most of its effort on history.

What would change this: If you often browse the settled history on your phone, C is worth it; if you hardly reopen anything, A.
