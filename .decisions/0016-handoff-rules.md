# 0016 What must a handoff carry, and how does the swap happen?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture
- Builds on: 0010, 0013
- Settles: agent handoff = hub writes the facts (workers, last summaries, open cards, waiting decisions); outgoing agent writes judgement under required headings; incoming agent may ask the outgoing one up to three questions before it retires; same rule for workers

## Decision

**C: B, plus a short overlap.** As B, then the new orchestrator reads the handoff and may ask the outgoing one a few questions (say up to three, or ten minutes) before it retires. The questions and answers are saved with the handoff so later holders see them too.

## Context

Decision 10 retires an orchestrator past a context threshold and the new holder starts from the board plus a handoff memo. Today that memo is free text the outgoing agent writes from memory. The goal is that nothing in flight is lost and the next holder can carry on as if nothing changed.

## Options

### A: A better memo

Keep the agent-written memo, but require set headings in it: work in flight, promises to you, open questions, risks, next step.
- Pro: Small change
- Con: The agent can still misremember who is doing what
- Con: Facts the hub already knows get retyped and can be wrong
- Effort: Small

### B: Hub writes the facts, agent writes the judgement

The hub fills in what it knows for certain: each worker and its last summary, open cards, decisions waiting, recent messages from you. The outgoing orchestrator writes only judgement under required headings: why things are the way they are, promises to you, risks, what it would do next, and board tidy-ups. The hub refuses a handoff that skips a heading and asks again. Workers follow the same rule at their own threshold.
- Pro: The facts cannot be wrong
- Pro: The agent spends its words on what only it knows
- Pro: Same shape for orchestrators and workers
- Con: The next holder cannot ask about anything left unclear
- Effort: Medium

### C: B, plus a short overlap (chosen) (recommended)

As B, then the new orchestrator reads the handoff and may ask the outgoing one a few questions (say up to three, or ten minutes) before it retires. The questions and answers are saved with the handoff so later holders see them too.
- Pro: Gaps get filled before the old agent is gone
- Pro: The Q and A becomes part of the memory
- Con: Two agents run briefly, so a little more of your plan
- Con: The outgoing agent is already near its limit, so answers should be short
- Effort: Medium

## Recommendation

C (lean). Splitting facts from judgement makes the handoff reliable; the short overlap is what makes it seamless, and it costs little because the questions are few and the answers short.
