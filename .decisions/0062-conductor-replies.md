# 0062 How do orchestrators answer the Conductor?

- Status: decided
- Date: 2026-11-14, decided 2026-11-14
- Lenses: architecture
- Builds on: 0055, 0060
- Settles: Conductor request replies = Conductor requests carry an id and expect a reply; orchestrators answer with a reply tool, reminded once if a turn ends without one; the reply wakes the Conductor with its text; the Conductor can read a project's latest round summaries; replies go only to the Conductor and the human

## In short

Pick how a project's orchestrator answers a request the Conductor sent it. I recommend A: the orchestrator gets a reply tool, a Conductor request is marked as expecting an answer, the hub reminds it once if it forgets, and the reply lands in the Conductor's chat for you. Confidence: medium.

For you:

- Ask the Conductor for status, a tidy-up or a handoff across projects, and the answers come back into its chat; no more digging through each project's thread
- The Conductor can also read a project's latest round summaries when it needs more than the answer
- Replies go only to the Conductor and you, never into another project
- Hard to undo: Small hub change (a reply tool, a reminder, a read tool); easy to remove

## Decision

**A: Reply tool, with a reminder.** Each Conductor request carries an id and is marked 'reply expected'. Orchestrators get reply_to_conductor(id, text). If a turn ends without a reply to an open request, the hub reminds the orchestrator once. The reply wakes the Conductor with its text, and the Conductor shows it to Matt in its chat (or folds several into one answer). The Conductor also gets a read tool for a project's latest round summaries.

## Context

Matt, via the Conductor: orchestrators don't answer the Conductor's requests back to it; they post in their own threads, so he has to dig into each project, which defeats the point of relaying through the Conductor. From the Conductor's side: message_agent is one-way (no reply tool, and nothing tells the orchestrator an answer is expected); the Conductor gets a one-line notice that a project posted a summary but can't read its text (its read tools cover the board, latest handoff, Needs you and agents only). Results so far: a tidy-up sent to six orchestrators produced no report it could see; a handoff meant for it sat as a board memo; a status request was answered in the project's own thread. Decision 60 made the Conductor the single point of contact; this is the missing return path. The project boundary from decision 55 stays: a reply goes to the Conductor and Matt only.

## Options

### A: Reply tool, with a reminder (chosen) (recommended)

Each Conductor request carries an id and is marked 'reply expected'. Orchestrators get reply_to_conductor(id, text). If a turn ends without a reply to an open request, the hub reminds the orchestrator once. The reply wakes the Conductor with its text, and the Conductor shows it to Matt in its chat (or folds several into one answer). The Conductor also gets a read tool for a project's latest round summaries.
- Pro: Answers come back reliably and are clearly answers to a request
- Pro: Works for status, tidy-ups and handoffs alike
- Con: One more tool and prompt line for every orchestrator
- Effort: Small to medium: a tool, a reminder at turn end, the wake with text, a summaries read tool, tests

### B: Forward the next summary

No new tool. After a Conductor request, the orchestrator's next round summary is forwarded to the Conductor in full as the answer.
- Pro: No change to how orchestrators work
- Con: A summary about other work can be taken as the answer; a request answered across two turns is cut short
- Effort: Small

### C: Read access only

Give the Conductor tools to read a project's thread and recent summaries, and let it look for answers itself.
- Pro: Smallest change to orchestrators
- Con: The Conductor has to guess where and when the answer appears; more reading, more cost
- Effort: Small

## Recommendation

A (lean). A gives a real return path: the orchestrator knows an answer is expected, says so plainly, and the Conductor gets it with no guessing. The summaries read tool covers the cases where it needs more context.

What would change this: If orchestrators reliably answer in their summaries anyway, B is enough.
