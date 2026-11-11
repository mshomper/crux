# 0017 Where does the live map of the orchestrator and workers live?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: ui
- Builds on: 0012

## Decision

**D: Always-on strip that zooms to the centre.** A live strip above the conversation is always visible; engaging it zooms the map into the centre of the screen as a full view, and it shrinks back into the strip when you pick a station or close it. On a phone the strip is a slim band that opens to full screen.

Reason: I like the idea of it being visible at all times, and zooming into the center of the screen when engaged. The strip idea is nice for an always on spot that can be seen. It needs to look and behave futuristically, think JARVIS from Ironman.

## Context

The hub gets a live map: the orchestrator role as a particle core whose ring shows context used, workers as stations around it, pulses for messages, red when something needs you. Decision 12 gives the screen to threads and the conversation, with the board on request, so the map needs a place that does not crowd the chat.

## Options

### A: Its own thread

A Map item at the top of the thread list; opening it fills the middle with the map, and tapping a station jumps to that chat.
- Pro: Full size, room for many workers
- Pro: No change to the chat layout
- Con: Out of sight while you chat
- Effort: Medium

### B: Strip above the chat

A short live band over every conversation.
- Pro: Always in view
- Con: Takes height from the chat, most on a phone
- Effort: Medium

### C: Small map on top of the thread list (recommended)

A small map above the threads; tap it for a big version in the middle.
- Pro: Always there, chat keeps its height
- Con: Small, crowds past about six workers
- Effort: Medium

### D: Always-on strip that zooms to the centre (chosen)

A live strip above the conversation is always visible; engaging it zooms the map into the centre of the screen as a full view, and it shrinks back into the strip when you pick a station or close it. On a phone the strip is a slim band that opens to full screen.
- Pro: Always visible, the strip's strength
- Pro: Full size when engaged, the own-view strength
- Pro: Zoom keeps your sense of place
- Con: Strip still takes some height from the chat
- Effort: Medium to large

## Recommendation

C (lean). Always one glance away without shrinking the conversation; the big version on tap covers what A offers.
