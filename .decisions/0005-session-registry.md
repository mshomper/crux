# 0005 How does the app know which sessions are live and what they are working on?

- Status: rejected
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture, data-model
- Builds on: 0001

## Context

Only matters for agents the hub did not start itself (terminal sessions joining later through a channel). If the hub hosts its agents (decision 1), it already knows which are live, and this can be dropped or parked until a channel is added.

## Options

### A: Sessions register with a hook (recommended)

A SessionStart hook writes session id, folder and transcript path to ~/crux/sessions/; a SessionEnd hook removes it.
- Pro: Exact: the session says it exists
- Pro: Cheap, documented hook events
- Pro: Gives the session id the inbox needs
- Con: A crash leaves a stale entry, so the app must check it is still alive
- Con: The hook must be installed in your user settings
- Effort: Small

### B: Read Claude Code's own session files

Scan ~/.claude/projects for transcripts and treat recently changed ones as live.
- Pro: No setup
- Pro: Includes past sessions too
- Con: Internal format, not a published interface
- Con: "Live" is a guess from file age
- Effort: Small

### C: Sessions tag the decisions they touch

The skill writes the session id into a record when it creates or edits it.
- Pro: Links a decision straight to the session that owns it
- Pro: No hooks needed
- Con: Only knows sessions that touched Crux
- Con: Says nothing about whether the session is still open
- Effort: Small

## Recommendation

A (lean). It is the only option that actually knows a session is open, and it hands the inbox the session id it needs; tagging records (C) can be added on top for the decision link.
