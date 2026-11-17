# 0074 How long does the hub keep raw chat and activity?

- Status: open
- Date: 2026-11-16
- Lenses: data model
- Builds on: 0002, 0009
- Settles: shared agent state retention = board entries, decisions, handoffs, summaries and usage totals kept for good; raw chat, permission lines and activity kept live about two weeks, then archived compressed per month and never loaded by the page

## In short

Should the hub keep only recent chat (say the last two weeks) and fold everything older into the board, so the record stays small however long you use it? I recommend that: decisions, requirements, memos and handoffs stay forever, while old chat lines and status noise are trimmed into a compact archive the page never loads.

For you:

- Today every message, permission line and status change is kept and the page reads all of it: Crux is at 11 MB and 19,000 entries after five days
- After this, each project keeps about two weeks of chat; older threads show a one-line summary, and anything settled already lives on the board
- Hard to undo: Old chat lines leave the live record. With B they go to a compressed archive file you can still search; with C they are deleted
- Nothing to set up; the hub trims on its own at start-up

## Context

Decision 2 (2026-11-11) chose an append-only event log: every write is an event and threads and the board are rebuilt from it. It did not set a limit. After five days: crux 11.1 MB, life 2.7 MB, AcuLoad 2.1 MB; the page downloads and rebuilds the whole log, which is a likely part of the slower phone (worker phone-speed is measuring). Matt (2026-11-16): a log of every message isn't tenable; the memory board is what should carry history. The board, decisions, profile and handoffs are small and already hold what later agents need.

## Options

### A: Leave it, load less

Keep the full log, but have the page load only recent messages and fetch older ones when you scroll up.
- Pro: Smallest change; nothing leaves the record
- Con: The file keeps growing forever; start-up and rebuilds slow down over months
- Con: Doesn't answer the design problem
- Effort: Small

### B: Keep two weeks live, archive the rest (recommended)

Board entries, decisions, handoffs, summaries and usage totals stay in the live record for good. Raw chat, permission lines and activity older than about two weeks move to a compressed archive per month that the page never loads. Older threads keep a one-line summary.
- Pro: The live record stays small however long you use the hub
- Pro: Nothing settled is lost; old chat can still be searched if ever needed
- Con: Medium build: rebuilding threads and the board must start from a snapshot plus recent events
- Effort: Medium

### C: Keep two weeks, delete the rest

As B, but old raw chat is deleted instead of archived.
- Pro: Smallest footprint
- Con: Old chat is gone for good; the permission studies and expedition reports that read old lines lose their data
- Effort: Medium

## Recommendation

B (firm). B: the board carries what matters, the live record stays small, and nothing is thrown away by accident.

What would change this: If you never want old chat back, C is simpler on disk.
