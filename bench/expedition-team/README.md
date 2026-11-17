# Expedition team analyzer

Plain Node, no packages. Measures what each role and the cheap gatherers cost in the hub's own expeditions, and estimates what larger gatherer settings would add.

    node analyze.mjs [project folder]

- Reads `<project>/.crux/events.jsonl` (read once, never written) and `<project>/.crux/expeditions/*/` (notes files, REPORT.md).
- Without a folder it walks up from the current folder or this file to find a `.crux/events.jsonl`; the worktree has none, so pass the project folder.
- Writes numbers only (ids, counts, dollars; no message text) to `bench-out/results.json` in the current folder, or to the file in env `ANALYZE_RESULTS`.
- Per expedition: role rows as in the report's "How it ran" table, gatherer runs and dollars (the Haiku share of the Lead's usage frames), notes statistics, and report sources found in notes.
- `whatIf` rows scale the measured cost per gatherer search; the assumptions are written into the output.
