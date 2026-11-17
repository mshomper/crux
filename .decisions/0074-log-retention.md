# 0074 How long does the hub keep raw chat and activity?

- Status: open
- Date: 2026-11-16
- Lenses: data model
- Builds on: 0002, 0009
- Settles: shared agent state retention = board entries, decisions, handoffs, latest summaries and usage totals kept live for good; raw chat, permission lines and activity kept live about two weeks, then archived as compressed plain-text files per month (read back for scroll-back and search); the page loads a bounded recent window with small updates

## In short

Should the hub keep only the last two weeks of chat live and move older chat into compressed monthly files, built in two steps with the page loading less first? I recommend that: the expedition measured it as the option that stays fast and small for a year without adding anything new or deleting anything.

For you:

- Step 1 (loading less, part already merged in the phone fix): the page gets small updates instead of re-downloading everything, so the phone opens in about 0.7 s instead of 6.4 s (estimate) and stays quick as chat grows
- Step 2: chat older than two weeks moves to one compressed file per month; the hub starts in about half a second after a year instead of 3 s, and uses about 313 MB of disk a year instead of 813 MB
- Old chat stays searchable (about half a second per search over three months); decisions, the board, handoffs and summaries stay live for good
- Hard to undo: Without step 2 the hub stops starting at all after about eight months of Crux at today's pace
- Nothing to set up

## Context

Decision 2 (2026-11-11) chose an append-only event log with no limit. After five days Crux's log was 11.8 MB and 20,235 events. The expedition of 2026-11-16 (report: .crux/expeditions/20261116-what-is-the-best-way-for-the-crux-hub-to/REPORT.md, draft PR 122) benchmarked the current way, loading less, plain-file archives and Node's built-in SQLite, on the real log and a 91-day synthetic one; all six test items passed. Findings: the phone slowdown was mostly the page re-downloading everything (12.6 MB raw, up to about 238 times a day); loading less fixes the open and updates; but the server still reads the whole file at start, and the current way hits a hard Node limit at about 234-241 days. The page's own 'what is waiting' pass grows with the log (23 ms today, 9.1 s at 91 days), so it must move to the server. Deleting old chat saves only about 175 MB a year. Phone figures are estimates from the PC. Matt (2026-11-16): a log of every message isn't tenable; the board should carry history.

## Options

### A: Leave it, load less

Keep the full log; finish loading less: small updates instead of full re-downloads, recent messages and 3-5 summaries per thread, what's waiting worked out on the server, event ids so a reconnect resumes.
- Pro: Phone open about 0.7 s instead of 6.4 s (estimate); each update about 330 bytes
- Pro: Storage unchanged; part already shipped in the phone fix
- Con: Server start still grows (about 3 s at a year) and the log reaches Node's string limit at about 234-241 days
- Con: 813 MB on disk at a year
- Effort: Medium

### B: A first, then archive older chat in plain files (recommended)

Step A as above. Then step B: board entries, decisions, handoffs, latest summaries and usage totals stay live; chat, permission lines and activity older than about two weeks move to one compressed plain-text file per month, read back for scroll-back, search and the permission study. The hub starts from a snapshot plus recent events.
- Pro: At a year: start about 0.5 s instead of 3 s, 313 MB on disk instead of 813 MB
- Pro: No new dependency; the log stays plain text and decision 2 holds (split in time)
- Pro: Nothing deleted; old chat searchable in about half a second over three months
- Con: Medium-to-large build; the snapshot must keep what open questions and notices point to, proven by a test
- Con: Search over old chat is slower than a database
- Effort: Medium-to-large

### D: A first, then Node's built-in database as the store

Step A, then replace the plain log with Node's built-in SQLite file, with full-text search.
- Pro: Searches in 4-22 ms; transactional writes
- Con: One binary file about twice the log's size (1.52 GB at a year); start slower than plain files on long logs
- Con: The module is still a release candidate; replaces decision 2; installer must check Node 24.15 or later
- Effort: Large

### C: Keep two weeks, delete the rest

As B, but old raw chat is deleted instead of archived.
- Pro: Saves the archives: about 175 MB a year
- Con: Old chat is gone for good; the permission studies and expedition reports that read old lines lose their data
- Con: About the same build as B
- Effort: Medium-to-large

## Recommendation

B (firm). B, in two steps: step A fixes the phone now, step B keeps start-up and disk small over a year with no new dependency and nothing deleted. A database index for fast search can be added beside the plain files later if searching old chat becomes a habit.

What would change this: If you expect to search old chat often, D's fast search may be worth its size and the new storage layer.
