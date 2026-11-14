# 0060 How does the Conductor cut down what reaches you?

- Status: decided
- Date: 2026-11-14, decided 2026-11-14
- Lenses: research and product, ui
- Builds on: 0021, 0031, 0042, 0055, 0058, 0059
- Settles: cross-project agent authority = a Conductor above the project orchestrators is the human's live single point of contact: it shows waiting cards with a recommendation so the human answers in place, and greets the human with one digest after time away; it reads every project and routes requests to orchestrators, answers nothing itself, never edits, merges or pushes, and never carries details from one project into another; merges, pushes, installs, deletes and decisions always go to the human

## In short

Pick how the Conductor takes work off you. I recommend A: while you're around, it's a live single point of contact you can talk to and answer cards through; when you've been away, it greets you with one digest, a recommendation per item, answered with one tap. Confidence: medium.

For you:

- While you're active, the Conductor answers you right away; you can ask anything, give orders it routes, and answer any waiting card from its chat; your tap or reply counts as your own answer in that project
- When you've been away from the PC and the phone, it holds what comes in and greets you with one digest, grouped by project, each item with a recommendation; one phone notice per digest, while permission requests that need you right away keep their own notice
- B adds no authority the orchestrators lack: the Conductor would only clear items your earlier answers already settle, plus contained permission requests an orchestrator let time out
- Hard to undo: Widens decision 55 (it can show and take your answers, not just point to projects); going back is a settings change

## Decision

**A: Live contact, digest when you've been away.** While you're active, the Conductor is a live chat: it answers at once, routes your orders, and shows any waiting card in its chat with its recommendation so you answer there. When you've been away, it holds what arrives and greets you with one digest (grouped by project, recommendation per item, the real cards inside, 'take all recommendations'). One phone notice per digest while away.

## Context

Matt, after using the Conductor (decision 55 A): it 'is supposed to be the hive mind that supercharges my ability to manage projects at once, not just send me to individual repos... It needs to reduce what's coming into me, not increase it.' Then, on the first draft: a digest suits time away from the desk or phone, but otherwise the Conductor must stay a communicative single point of contact; and what would it answer that the orchestrators can't already? Honest answer: nothing beyond their authority. What reaches Matt today is (1) questions orchestrators chose to put to him (product calls and confirmations), (2) contained permission requests an orchestrator was unsure of or let time out, (3) decisions, (4) push, PR and merge OKs. (3) and (4) are his in every option. B's extra is narrow: (1) where his own earlier answer, in any project, or the board already settles it (cross-project memory the orchestrators don't have), and (2) within the same rules an orchestrator uses. Away is judged by the PC and phone activity the hub already tracks (decision 58). An answer counts as Matt's because it is his own tap or reply on the real card; a push, PR or merge OK in the Conductor's own words never counts. Mockups by conductor-mock, fake projects.

## Options

### A: Live contact, digest when you've been away (chosen) (recommended)

While you're active, the Conductor is a live chat: it answers at once, routes your orders, and shows any waiting card in its chat with its recommendation so you answer there. When you've been away, it holds what arrives and greets you with one digest (grouped by project, recommendation per item, the real cards inside, 'take all recommendations'). One phone notice per digest while away.

![A: the digest after time away, four items with recommendations, answered in place \(phone\)](images/0060-a-one-digest-four-items-with.png)

*A: the digest after time away, four items with recommendations, answered in place \(phone\)*

- Pro: One place to talk to and answer everything, live or after a break
- Pro: No new authority for the Conductor
- Con: Every item still needs your tap, though with a recommendation ready
- Effort: Medium: away detection from existing presence, digest timing, cards shown in the Conductor chat, notice batching

### B: A, plus it clears what you've already answered

As A, and the Conductor clears two narrow kinds itself, each listed with its reason and Undo: questions your own earlier answer or the board already settles (in any project), and contained permission requests an orchestrator let time out, judged by the same rules the orchestrator uses. Nothing beyond the orchestrators' authority.

![B: three real calls, plus 'I handled these' with reasons and Undo \(phone\)](images/0060-b-three-real-calls-plus-i-handled-these.png)

*B: three real calls, plus 'I handled these' with reasons and Undo \(phone\)*

![B on the desktop](images/0060-b-on-the-desktop.png)

*B on the desktop*

- Pro: Stops the same question reaching you twice across projects
- Con: Small extra saving for a new answering path that needs its own review
- Con: A wrong match runs before you see it (undo after the fact)
- Effort: Medium to large: A plus matching against past answers, undo and tests

### C: Today's relay, batched

One message listing the waiting items with links to answer each in its project; the cards stay in the Waiting drawer.

![C: today's relay batched into one message \(phone\)](images/0060-c-todays-relay-batched-into-one-message.png)

*C: today's relay batched into one message \(phone\)*

- Pro: Smallest change
- Con: No shorter than today; still sends you to each project
- Effort: Small

## Recommendation

A (lean). A gives you what you described: one live point of contact while you work, and a short digest when you come back, with every card answerable in place. B's extra saving is small, since the Conductor can't do more than the orchestrators; add it later if repeat questions keep reaching you.

What would change this: If the same questions keep reaching you from different projects, add B.
