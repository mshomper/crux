# 0012 What does the main screen look like?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: ui
- Builds on: 0006, 0009

## Decision

**A: Threads, conversation, board on request.** Thread list on the left (orchestrator pinned first, then agents), the conversation in the middle with decision cards inline; the board opens in a side panel when you ask for it or click a card.

## Context

A small app with a messaging feel: you talk with the orchestrator, drop into any agent, see the decisions that need you, and can look at the board. House rules: no sideways scrolling, drawn icons only, no visibility toggles.

## Options

### A: Threads, conversation, board on request (chosen) (recommended)

Thread list on the left (orchestrator pinned first, then agents), the conversation in the middle with decision cards inline; the board opens in a side panel when you ask for it or click a card.
- Pro: Feels like a messaging app first
- Pro: Full width for the conversation
- Pro: Board is one click away, not always taking space
- Con: The board is out of sight until you ask
- Effort: Medium

### B: Three columns

Threads, conversation and the board side by side at all times; at narrow widths the board moves under the conversation.
- Pro: Memory always visible
- Pro: Easy to see what a conversation changed
- Con: Cramped conversation on a laptop
- Con: Busier screen
- Effort: Medium

### C: Board first, threads over it

The board is home; clicking an entry or agent opens its conversation over it.
- Pro: Puts the long-term memory at the centre
- Pro: Close to today's Crux board
- Con: Less like messaging, which is the point
- Con: Conversations feel secondary
- Effort: Medium

## Recommendation

A (lean). You asked for messaging first; decision cards inline bring the calls to you, and the board is one click away without crowding the conversation.
