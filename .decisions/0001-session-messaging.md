# 0001 How does the hub talk to its agents?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture
- Builds on: 0006

## Decision

**C: Hosted, with a channel later.** Start with hub-hosted agents; add the channel later so terminal sessions can join the same board.

## Context

The hub is a separate small app (decision 6). Agents work as usual, post a summary when they finish a round, then wait for a reply from the orchestrator or from you. The hub has to send replies into agents that are idle and waiting.

## Options

### A: Hub hosts its agents

The hub starts every agent, orchestrators included, through the Claude Agent SDK, so it can send to them and read their output whenever it likes.
- Pro: Full control: send, stream, interrupt, read status
- Pro: No preview features, no hook timing
- Pro: You already know this pattern well
- Con: Sessions started elsewhere (a terminal) are outside it
- Con: The hub must handle permission prompts itself
- Effort: Medium

### B: Agents join through a channel

Agents run wherever you start them, launched with a Crux channel server that carries messages both ways.
- Pro: Any terminal session can join
- Pro: Agents keep their normal interface
- Con: Channels are a research preview
- Con: Every agent must be started with the flag
- Effort: Medium

### C: Hosted, with a channel later (chosen) (recommended)

Start with hub-hosted agents; add the channel later so terminal sessions can join the same board.
- Pro: Ships on stable ground
- Pro: Leaves the door open
- Con: Two routes eventually
- Effort: Medium, then small

## Recommendation

C (lean). Hosting agents in the hub is stable and squarely in your wheelhouse; the message format should not care how an agent connects, so a channel can be added when you want terminal sessions on the board.
