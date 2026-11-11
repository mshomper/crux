# 0008 What does an agent post when it finishes a round of work?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: data-model
- Builds on: 0002, 0007

## Decision

**C: Structured summary event.** The same sections posted as a structured event (questions, decisions with entry numbers, files changed), which the hub renders as a message with cards.

## Context

Agents work as usual, then post a summary to their thread. The orchestrator acts on it, the hub renders it, and it becomes part of the board's history.

## Options

### A: Free text

The agent's normal closing message.
- Pro: Nothing to add
- Con: Questions and decisions get buried
- Effort: None

### B: Fixed sections in text

Done, changed, questions, decisions needed, blocked on, next step.
- Pro: Easy to scan
- Pro: Plain text
- Con: The hub must parse text to render cards
- Effort: Small

### C: Structured summary event (chosen) (recommended)

The same sections posted as a structured event (questions, decisions with entry numbers, files changed), which the hub renders as a message with cards.
- Pro: Questions and decisions render as real cards with buttons
- Pro: Fits the event log
- Pro: Easy to search later
- Con: Agents need a tool or schema to post it
- Effort: Small to medium

## Recommendation

C (lean). With your own interface and an event log, a structured summary is what turns questions and decisions into cards you can act on.
