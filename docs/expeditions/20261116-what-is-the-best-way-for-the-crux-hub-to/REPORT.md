# How should the Crux hub store and load its event log?

Expedition 20261116-what-is-the-best-way-for-the-crux-hub-to. It informs decision 74 (how long the hub keeps raw chat and activity).

## 1. Answer

**Pick B (keep two weeks live, archive the rest in plain files), and build it in two steps: decision 74's option A (load less) first.** The bench shows the first step does most of the good, and the second step stops the slide over months. Version 0.25.10 merged on main during this expedition and already ships part of step A. It was not benchmarked here.

- **What slows the phone is mainly the page, not the file.** Before 0.25.10, the page downloaded every event uncompressed (12.6 MB for Crux alone), and it did so again after every summary, entry, pick or agent change. Those events came about 238 times a day over the five days measured. 0.25.10 now compresses the feed and sends recent history per thread, but it still re-fetches the whole feed after those changes. Loading less (compression, the last messages per thread, one small update per change) cuts the first open from about 6.4 s to about 0.7 s on the phone (estimate), and each update from a full re-download to about 330 bytes.
- **A alone is not enough for a year.** The server still reads the whole file at every start. The current way stops working altogether after about 234–241 days at this rate (a hard limit in Node on one string's size). Also, the page's own "what's waiting for me" pass grows with the log: 23 ms today, 9.1 s on 91 days of history.
- **B with plain files** keeps the log as text you can read, adds no dependency, and keeps decision 2. At a year: about 313 MB on disk instead of 813 MB, and a server start of about 0.5 s instead of about 3 s.
- **Node's built-in SQLite works on this machine** (Node 24.21, full-text search on). It is the fastest at search (4–22 ms against about 0.5 s for scanning the archives). It also starts fastest on today's five-day log (15 ms), but plain files start faster on longer logs: 156 ms against 276 ms at 91 days, and about 0.5 s against 1.1 s at a year. But it makes one binary file about twice the size of the log, and adopting it as the store replaces decision 2. It is worth adding later as a search index beside the plain files if searching old chat becomes a habit.
- **C (delete old chat)** saves only the archives: about 39 MB of gzip per 77 days of history, so about 175 MB over a year (Lead's arithmetic, on repeated text that compresses well). It breaks "nothing is ever deleted" and the permission studies' history. Not worth it.

What changes from decision 74's own wording: B alone does not make the page fast, and its snapshot does not stay flat by itself. Both need the payload rules in section 5.

## 2. Findings

Bench figures are from `bench-out/results.json`. It covers Crux's log only: 20,235 events, 11.8 MB, 5.4 days, copied read-only. A 91-day synthetic log (the real five days repeated with new ids and shifted times, 343,995 events, 203 MB) stands in for months of use. Phone figures are **estimates from a substitute environment** (this PC): page-side parsing ×4 and a 2 MB/s Tailscale link, both Claude's judgment. `current` figures are a **lower bound**: the real page state also carries every other project and the Conductor.

**What the code does today** (read by the Lead and confirmed by the Advisor)
- The server reads the whole log at start and keeps every event in memory. It appends one line per event from the single hub process, with no fsync, and skips a torn last line (`hub/lib/events.mjs:14-25`).
- The page state carries every event of every project (`hub/lib/hub.mjs:2173`). The server sends it uncompressed (`hub/server.mjs:201-204`). The page fetches it again in full after ten kinds of event (`hub/public/app.js:175`) and on every stream reconnect.
- `tailscale serve` does not compress. It is a plain reverse proxy (notes-4), so compression must happen in Node. No end-to-end check of this has been run.
- These lines describe the hub where this expedition branched (656e28c), which is what the bench's `current` stands for. Since then 0.25.10 (pull request 121) has shipped part of step A on main:
  - replies are now gzipped;
  - each thread sends its newest 8 to 40 events in full and older ones as small stubs, with a Show older button.

  It still keeps every event in memory, still sends every old event (the big kinds as small stubs, the rest in full, minus three telemetry kinds), still re-fetches the whole feed after the ten event kinds, and still has no event ids on the stream. 0.25.10 itself was not benchmarked. The line numbers above have moved on main.

**Bench: the five-day log** (current / load less / plain files / SQLite)

| | current | load less (A) | plain files (B) | node:sqlite (B) |
|---|---|---|---|---|
| Server start | 41 ms | 47 ms | 46 ms | 15 ms |
| First open, PC (server work + parse) | 54 ms | 83 ms | 75 ms | 92 ms |
| Sent to the page | 12.6 MB raw (no gzip before 0.25.10) | 1.19 MB gzip | 1.19 MB gzip | 1.19 MB gzip |
| First open, phone (estimate) | 6.4 s | 0.69 s | 0.68 s | 0.70 s |
| Each refresh or update | full re-fetch: 52 ms PC, 6.4 s phone (est.) | one event, about 330 bytes | same | same |
| On disk | 11.8 MB | 11.8 MB | 11.8 MB (no archive yet) | 22.0 MB |

- Every option reads back all 20,235 events and the same last 50 messages of every thread as today.
- 237.7 refresh-triggering events a day. At 12.6 MB per refresh, that is up to about 3 GB a day for a page left open all day (Lead's arithmetic: 237.7 × 12.6 MB). The size is a lower bound, since it is Crux alone. The count is an upper bound, since events within a quarter second share one re-fetch. This is the hub before 0.25.10, which now gzips the feed.

**Bench: 91 days and a year** (the year is a straight line through the 5-day and 91-day measurements)

| | current | load less (A) | plain files (B) | node:sqlite (B) |
|---|---|---|---|---|
| Server start, 91 days | 741 ms | 803 ms | 156 ms | 276 ms |
| Sent at first open, 91 days | 209 MB raw | 3.36 MB gzip | 3.21 MB gzip | 3.36 MB gzip |
| Server start, year | 3.0 s | 3.2 s | 0.51 s | 1.1 s |
| Sent at first open, year (gzip) | 210 MB (sent raw before 0.25.10: worse) | 10.3 MB | 9.7 MB | 10.3 MB |
| On disk, year | 813 MB | 813 MB | 313 MB | 1.52 GB |

- **Where the current way breaks.** Node's maximum string length is 536,870,888 characters (bench test; the Skeptic found it quoted at kindacode.com). Reading the log as one string fails at about 241 days, and building the page state as one string at about 234 days, for Crux alone. Reading line by line avoids that limit, but memory then becomes the wall, because every event stays in memory (Skeptic, judgment).
- **The page's own work grows with the log.** One pass of the page's "waiting" logic (`all-projects.js` and `questions.js`, run unchanged in Node) takes 23.3 ms on the real state and 9,146 ms on 91 days. That is PC time, before the ×4 for a phone. Paging the data fixes this only if the page computes over the bounded set, or the server works out what's waiting, as it already does for the Conductor (`hub/lib/conductor.mjs:44`).
- **What grows in the payload.** On 91 days, the raw payload is 9.3 MB of summaries (20 per thread), 6.2 MB of board entries, 4.9 MB of messages (50 per thread) and 73 KB of agents. To keep the first open flat, send about 3–5 summaries per thread and load board entries on request.
- **The snapshot (plain files) grows too, more slowly.** The first rule (keep every summary and agent record) gave a 48 MB snapshot on 91 days. The tighter rule (latest summary per agent plus open ones, agents still running or retired in the last two weeks, every board entry) gives 16.8 MB. That is about 177 KB a day against 531 KB a day before.
- **References across the cut.** After rotation, 242 of 11,862 references from kept events point into an archive on the synthetic log: 241 from `question` and `card` fields (68 and 173), and 1 from an approval. On the real log with a 2-day window, the figure is 1. So the snapshot rule must also keep what dismissed questions and routed notices name, or the page must tolerate a miss. 3,594 references on the synthetic log (1,198 on the real copy) dangle in the source log itself, so rotation did not cause them.
- **Search over archived chat** (91-day log, part older than 14 days):

| | "worktree" | "approval" |
|---|---|---|
| In memory (today, load time excluded) | 47.5 ms | 55.0 ms |
| Plain files: unzip and scan the monthly archives | 539 ms | 584 ms |
| SQLite full-text search | 21.9 ms | 4.2 ms |
| SQLite text scan, no index | 130 ms | 147 ms |

  Full-text search matches words that begin with the query (1,121 hits for "approval"), while the scans also match it inside longer words (1,234). The archives here are 38.7 MB of gzip. A year's archives would take about 2–3 seconds to scan on this PC (Lead's arithmetic).

**Research** (sources in section 7)
- Snapshots are a cache-like start point for replaying a log (notes-1, Fowler). Kafka-style compaction keeps the latest value per key: it suits long-lived records, not chat (notes-1, Confluent).
- Appends and renames should not be assumed crash-atomic (notes-1, Dan Luu). On Windows, Node renames with replace-existing and appends with append-only access, but crash atomicity on NTFS is not confirmed (notes-4, libuv source). A process crash loses nothing the OS already holds, but power loss can (judgment, by analogy with SQLite's note that turning sync off is safe against an application crash; notes-1).
- node:sqlite was added in Node 22.5, lost its flag in 22.13 and 23.4, and has been a release candidate since 25.7, backported to 24.15 (notes-2, Node docs; notes-4, Node 24.15 release post). Its API is synchronous only. This machine runs Node 24.21 with SQLite 3.53.4 and full-text search compiled in (bench). Nothing in `hub/package.json` pins a Node version.
- SQLite's WAL mode allows one writer, and it is durable with `synchronous=FULL` (notes-2, sqlite.org). A full-text index is a large fraction of the text it indexes (notes-3, sqlite.org FTS5).
- Chat services load the newest first and fetch older pages with a cursor: Slack's cursor paging, Matrix's `prev_batch` and `since` tokens (notes-3, notes-4). The hub sends no event ids on its stream today, so reconnect-resume is new work.
- Safari clears a site's script storage after 7 days of Safari use without visiting it. A home-screen app like the hub's keeps its own counter (notes-3, secondary source). Either way, a phone cache can only be a cache.
- Code inventory (synthesis, by the Synthesizer): the server reads the in-memory log at 87 places. 41 are fine with a snapshot plus recent events, 44 need a value carried forward (about 12 kinds: agents, board, open questions, settings, downloads, usage baselines, expeditions, Conductor requests and so on), and 2 need the archive (the permission study). The page's own readers (about 30 in `app.js` plus `questions.js` and `all-projects.js`) and about 430 test uses were not counted. Attachments are stored once by content hash and never deleted, so archiving messages leaves them intact.

**On the seven criteria**

| Criterion | current | A load less | B plain files | B node:sqlite store | C delete old |
|---|---|---|---|---|---|
| Read speed: first open and update, PC and phone | poor (6.4 s phone est., full re-fetch) | good now, grows over a year unless the payload rules apply | as A, plus a fast start | as A; fast start, behind plain files on long logs | as B |
| Write safety, several agents | fine: one hub process writes everything | same | same, plus one rotation step | one writer, WAL | as B |
| Crash safety | torn line skipped, no fsync | same | needs write-then-rename and archive-before-trim | transactional journal | as B; deletes are final |
| Size over a year | 813 MB | 813 MB | 313 MB | 1.52 GB | B minus archives |
| Search over old chat | in memory only | same | archive scan, about 0.5 s on 3 months | full-text, 4–22 ms | gone |
| Inspect by hand | plain text | plain text | live is plain text; archives need unzipping | binary; needs a Node one-liner or an installed tool | plain text |
| Fit: no-dependency Node and plain-module page | yes | yes (zlib built in) | yes | built in, but a release candidate; needs Node 24.15+ in the installer | yes |
| Decision 2 (the append-only log is the source) | kept | kept | kept, split in time | **replaced** | kept, but breaks "never delete" |

## 3. The Skeptic's objections, and what was done

- **The snapshot grows with the log (HIGH).** Accepted. The first keep rule kept every summary and agent record, so the snapshot was 48 MB on 91 days. The bench now uses a tighter rule: 16.8 MB, 177 KB a day. It still grows, mostly from board entries and summaries, so B also needs the summary cap below.
- **The page cost rests on assumed phone numbers, and render was never timed (HIGH).** Partly accepted. Phone figures stay estimates. The page's waiting logic was then timed in Node: 23 ms today and 9.1 s on 91 days. So moving that work to the server, or onto the bounded set, is part of A, not optional. Browser drawing time is still unmeasured (proposed next step).
- **Neither A nor B keeps the payload flat (HIGH).** Accepted. Agents were not the cause (73 KB). Summaries and board entries were. The build should send 3–5 summaries per thread and load entries on request. B's gain over A is start-up time and disk, not page speed.
- **The kept-events snapshot breaks references (HIGH).** Measured: 242 of 11,862 references reach into the archive on the synthetic log, and 1 on real data with a 2-day window. 241 of them come from `question` and `card` fields and 1 from an approval. The keep rule must cover them, with a rotate-then-resolve test in the build. The quiet-thread problem was fixed in the bench by keeping each thread's last 50 messages.
- **The inventory understates the cost (MEDIUM).** Accepted. Page readers and tests are uncounted. B is rated medium-to-large below.
- **The string limit is real, but the heap hits first (MEDIUM).** Accepted as framed in section 2.
- **SQLite as the store is dismissed too fast (MEDIUM).** Accepted in part. It is presented as a real option: fastest search, transactional, one file. Its costs are 1.9× the disk, binary, a release-candidate module, and the end of decision 2.
- **C is dismissed on a rule, not a cost (MEDIUM).** Sized: about 39 MB of gzip per 77 days of history, so about 175 MB over a year (Lead's arithmetic).
- **Year figures come from a repeated log (MEDIUM).** Accepted. The real five days repeated compress better than new text will, and they assume the heaviest build week repeats all year. Read the year columns as rough.
- **Smaller points.** No curl check of Tailscale compression has been run. Stream resume is new work. fsync and rename costs are untimed. Decision 74 recommended B "firm" before any measurement, and the bench confirms the pick but not its claim that B alone keeps things small and fast.

## 4. Decisions made on Matt's behalf

1. The benchmark and its results live in the expedition folder, and only the bench code goes onto the branch (`bench/log-storage/`). The repo is public, so the log copy stays private.
2. Measure the current way against plain files and node:sqlite. A load-less option was added at the gate (Advisor), so A and B can be told apart.
3. Phone and Tailscale figures are estimated from PC timings, with a stated slowdown and link speed.
4. A second build round tightened the plain-files keep rule, bounded the payload, checked references across the cut and timed the page's waiting logic, after the Skeptic's objections.
5. The Advisor's gate changes were applied in full: a synthetic 91-day log, a rerun that cannot overwrite the reported numbers, stricter checks, privacy checks.

## 5. Build status and what to run yourself

- **Bench:** `bench/log-storage/run.mjs` on branch `expedition/20261116-what-is-the-best-way-for-the-crux-hub-to` (code only, plus a README). It reads the project's `.crux/events.jsonl` read-only, works on a copy, and takes about a minute on this PC. The frozen test's four command checks passed in the Builder's runs and in the Verifier's rerun, which reproduced the reported sizes and first-open times (`verify/run-1/` and `verify/run-2/VERDICT.md`).
- **Run it yourself** on another project, or later on Crux, to see the numbers move: from the worktree or a checkout, `node bench/log-storage/run.mjs` (see its README).
- **Proposed build, if you pick B in two steps:**
  1. **Step A, finish load less (medium, part shipped in 0.25.10).** Keep the gzip and the per-thread window. Then:
     - replace the ten full re-fetches with small updates;
     - stop sending every old event (stubs included);
     - send 3–5 summaries per thread and only live agents;
     - work out what's waiting on the server;
     - put event ids on the stream so a reconnect resumes.

     Storage is unchanged. Most of the work is in the page.
  2. **Step B, plain-file archive (medium-to-large):** monthly rotation (write the archive, then the new live file, then rename); a snapshot of kept events per the tightened rule, including what open questions and notices cite; an archive reader for scroll-back, search and the permission study; a rotate-then-resolve test proving the board, agents, questions and usage are identical before and after.
  3. **Later, optional (small-to-medium):** a node:sqlite full-text index rebuilt from the plain files, with a scan fallback.
- **Other options' costs:** SQLite as the store is large (new storage layer, migration, supersedes decision 2, a Node 24.15+ check in the installer, plus all of step A). C costs about the same as B, minus the archive reader, plus deletion and a cleanup rule for orphaned attachments.

## 6. Parked items, proposed as next expeditions

- **Measure on the phone.** A small page that times the real first open, parse and draw on the phone over Tailscale, to replace the ×4 and 2 MB/s estimates. Parked because nobody could run the phone during this expedition.
- **Check Tailscale compression end to end.** One curl through `tailscale serve` with gzip requested. Parked: it needs the live phone link.
- **Benchmark 0.25.10.** It merged on main after this expedition branched. Running the bench against its windowed, gzipped feed would show how much of step A is already won. Parked because it landed after the log copy was taken.
- **Fold board entries.** Board entries are the one part of the snapshot that grows forever by design (6.2 MB on 91 days). Folding superseded entries is a board-design question beyond this brief.

## 7. Sources

Opened by a gatherer or the Skeptic:
- Martin Fowler, Event Sourcing: https://martinfowler.com/eaaDev/EventSourcing.html
- Confluent, Kafka log compaction: https://docs.confluent.io/kafka/design/log_compaction.html
- Dan Luu, file consistency: https://danluu.com/file-consistency/
- SQLite atomic commit: https://www.sqlite.org/atomiccommit.html
- SQLite, how to corrupt a database: https://www.sqlite.org/howtocorrupt.html
- SQLite WAL: https://sqlite.org/wal.html
- SQLite FTS5: https://www.sqlite.org/fts5.html
- Node.js zlib: https://nodejs.org/api/zlib.html
- Node.js fs: https://nodejs.org/api/fs.html
- Node.js sqlite: https://nodejs.org/api/sqlite.html
- Node.js 24.15.0 release: https://www.nodejs.org/blog/release/v24.15.0
- Node sqlite build file: https://raw.githubusercontent.com/nodejs/node/main/deps/sqlite/sqlite.gyp
- libuv Windows fs source: https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/fs.c
- Tailscale serve source: https://raw.githubusercontent.com/tailscale/tailscale/main/ipn/ipnlocal/serve.go
- Tailscale serve docs: https://tailscale.com/docs/features/tailscale-serve
- Tailscale connection types: https://tailscale.com/docs/reference/connection-types
- Slack pagination: https://docs.slack.dev/apis/web-api/pagination/
- Matrix client-server API: https://spec.matrix.org/latest/client-server-api/
- V8, the cost of JavaScript in 2019: https://v8.dev/blog/cost-of-javascript-2019
- MJ Tsai on Safari's 7-day storage cap: https://mjtsai.com/blog/?p=28475
- Max string length in Node: https://kindacode.com/article/node-js-the-maximum-size-allowed-for-strings-buffers
- Competitor comparison of node SQLite libraries (claims only, not relied on): https://photostructure.github.io/node-sqlite/documents/library-comparison.html

Hub code read: `hub/lib/events.mjs`, `hub/lib/hub.mjs`, `hub/server.mjs`, `hub/public/app.js`, `hub/public/all-projects.js`, `hub/public/questions.js`, `hub/lib/conductor.mjs`, and the inventory files in `synthesis.md`.

<!-- hub-generated: everything below this line is written by the hub from the event log -->

## Claims check

The Verifier's claims pass ran (verify/VERDICT.md has a claims or corrections section).

## Parked, as proposed next expeditions

1. Measure first open, parse and draw on the phone over Tailscale with a small timing page, replacing the x4 and 2 MB/s estimates. (why parked: Nobody can run the phone during the expedition; phone numbers here are estimates from the PC.). Launch pre-fills a brief from this line.
2. Check end to end with one request through tailscale serve whether responses arrive compressed. (why parked: Needs the live phone link; the source read says the proxy does not compress, but it was not tested.). Launch pre-fills a brief from this line.
3. Fold superseded board entries so the snapshot and the page's board stop growing forever. (why parked: Board entries are kept forever by decision 9; changing that is a board-design question outside this brief.). Launch pre-fills a brief from this line.
4. Benchmark the hub's 0.25.10 feed (gzip plus a per-thread window) against the same log copy, to see how much of step A it already wins. (why parked: 0.25.10 merged on main after this expedition branched and after the log copy was taken; the frozen bench measures the hub at the branch point.). Launch pre-fills a brief from this line.

## Requests that were not allowed

- Bash: cd C:/Users/mshom/Documents/GitHub/crux && node -e " const fs=require('fs');const L=fs.readFileSync('.crux/events.jsonl','utf8').split('\n').filter(Boole… (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)
- Bash: cd C:/Users/mshom/Documents/GitHub/crux/.crux/expeditions/20261116-what-is-the-best-way-for-the-crux-hub-to && time node bench/run.mjs 2>&1 | tail -30 &&… (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)
- Bash: cd /c/Users/mshom/Documents/GitHub/crux/.crux/expeditions/20261116-what-is-the-best-way-for-the-crux-hub-to && node -e "const r=JSON.parse(require('fs').… (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)

## How it ran

Generated from the hub's event log (usage events and expedition events), not estimated. Stop reason: passed. Elapsed: 35 min.

| Role | Agents | Turns | Time at work | Tokens (in / out) | Cost |
|---|---|---|---|---|---|
| Lead (incl. gatherers) | 1 | 14 | 10 min | 9.29M / 145.0k | $4.56 |
| Advisor | 1 | 1 | 4 min | 345.4k / 21.7k | $2.14 |
| Synthesizer | 1 | 1 | 4 min | 1.95M / 21.3k | $1.83 |
| Skeptic | 1 | 1 | 2 min | 1.77M / 18.9k | $0.77 |
| Builder | 1 | 2 | 16 min | 5.44M / 75.5k | $1.95 |
| Verifier | 1 | 3 | 9 min | 5.58M / 55.0k | $3.67 |
| unknown | 1 | 21 | 0 min | 100.6k / 2.8k | $0.12 |
| **Total** | | 43 | 45 min | 24.48M / 340.2k | $15.04 |

Gatherers run inside the Lead, so their time and cost are in the Lead's line and are not split out.

Build-verify loops: 1 (4 passing); 2 (6 passing). Decisions made on the user's behalf: 5. Parked: 7 (3 of them requests that were not allowed).

Spend figures here are the results' logged usage. While a turn runs, the hub's watchdog counts an upper-bound estimate that each result replaces (memo M046), so a limit may trip a little early, never late.
