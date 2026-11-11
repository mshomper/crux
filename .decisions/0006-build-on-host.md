# 0006 Build a separate hub, or build Crux on top of the Claude desktop app?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture, research

## Decision

**A: Separate Crux hub.** Crux's own app starts the orchestrator and the agents through the Claude Agent SDK, and you chat with them there.

Reason: The point is not to use the Desktop App. I want a small app with a nicer UI / UX that is more messaging-like.

## Context

The goal is a preview: one place to manage several agents through chat, with an orchestrator that reads their summaries, answers their questions and sends them back. The Claude desktop app's Code tab already lets one session start other sessions, receive a note when each ends a turn, and message them back. This decides how much of the plumbing you build at all.

## Options

### A: Separate Crux hub (chosen)

Crux's own app starts the orchestrator and the agents through the Claude Agent SDK, and you chat with them there.
- Pro: Full control over the interface and the message flow
- Pro: Not tied to any one host app
- Con: You rebuild session management, permissions and transcripts
- Con: Sessions you start in a terminal or the desktop app are outside it
- Con: Weeks before you can test whether the workflow is worth it
- Effort: Large

### B: Crux layer on the desktop app (recommended)

The orchestrator is an ordinary desktop session that starts and messages agent sessions, which the app already supports. Crux adds the summary format, the authority rules and decision cards, through the skill and optionally a side panel.
- Pro: The messaging plumbing exists today
- Pro: You keep the app's chat, permissions and phone access
- Pro: Testable in days: mostly skill text and a summary format
- Con: Tied to the desktop app and what it exposes
- Con: Terminal sessions are not part of it
- Con: Custom interface limited to what a panel mod can do
- Effort: Small

### C: Crux protocol, any host

Crux defines its own messages (summary, question, reply, decision) over files and a channel server, so desktop sessions, terminal sessions and a hub interface can all join.
- Pro: Portable across hosts
- Pro: Survives changes to any one app
- Con: The most design work before anything runs
- Con: Leans on channels, still a research preview
- Effort: Medium to large

## Recommendation

B (lean). The point is to find out whether one place to manage agents is worth it; building on the app that already does the plumbing answers that in days, and the summary format and authority rules carry over to a separate hub later.
