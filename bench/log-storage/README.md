# Log-storage benchmark

Measures how the hub could store and load its event log (`.crux/events.jsonl`), on a copy of the real log and on a synthetic 90+ day log made by repeating the copy with shifted timestamps and fresh ids.

Options compared: the current way (whole log in memory, full state JSON at open and at every refresh), "load less" (same storage, page gets the board plus the last 50 messages per thread, gzip, one event per update), plain files (snapshot + 14 days live + monthly gzip archives), and `node:sqlite` (one database, indexes, FTS5 when available).

For each: server start time, first open, cost per update, size on disk, transfer size raw and gzip, events read back, whether the recent messages match the current way, a phone estimate (a stated slowdown factor and link speed, not a phone measurement), a one-year projection, and search over the archived part.

Run (plain Node, no packages, about a minute):

```
node bench/log-storage/run.mjs [projectFolder]
```

- It finds `<project>/.crux/events.jsonl` by walking up from the current folder (or takes the project folder as an argument, or `BENCH_PROJECT`). The log is opened read-only and copied once into `bench-out/`; everything else works on the copy.
- Output goes to `./bench-out/` (set `BENCH_OUT` to change it); results to `bench-out/results.json` (or `BENCH_RESULTS`). Keep `bench-out/` out of git: it holds log data.
- The script re-starts itself with a larger memory limit for the synthetic log.
