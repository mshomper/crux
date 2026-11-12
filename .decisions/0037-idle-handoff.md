# 0037 When should the orchestrator hand off besides the 60% threshold?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture
- Builds on: 0010, 0013, 0016
- Settles: orchestrator idle handoff = hand off automatically after 1 hour idle when above 25% context, published from a rolling handoff draft without waking the old agent; in addition to the 60% threshold and on the human's word

## Decision

**B: Automatically after a long idle stretch.** If the orchestrator has been idle for 3 hours and is above 25% context, it writes the handoff and retires; the next message goes to a fresh orchestrator. Matt can still say hand off any time. The 60% threshold stays.

Reason: B, with the idle window at 3 hours and the floor at 25%; then, once a rolling handoff draft makes handing off cheap, the idle window drops to 1 hour (as the prompt cache expires)

## Context

After a long idle stretch the prompt cache has expired, so the next message makes a long-running orchestrator re-read its whole context (hundreds of thousands of tokens), which is slow and costly. A fresh orchestrator starts from the board index and a handoff instead. Amends decision 10, which hands off only at the 60% context threshold.

## Options

### A: When Matt says so

Matt says hand off, at the end of the day or any time.
- Pro: Full control
- Con: Matt has to remember
- Effort: Small

### B: Automatically after a long idle stretch (chosen) (recommended)

If the orchestrator has been idle for 3 hours and is above 25% context, it writes the handoff and retires; the next message goes to a fresh orchestrator. Matt can still say hand off any time. The 60% threshold stays.
- Pro: Avoids the costly cold re-read after nights and long breaks
- Pro: No action needed from Matt
- Con: May hand off during a long break
- Effort: Small to medium

### C: 60% threshold only

No change.
- Pro: Nothing to build
- Con: Expensive re-read every morning
- Effort: None

## Recommendation

B (lean). Handles the overnight case without Matt thinking about it; the floor keeps it from churning on light days.
