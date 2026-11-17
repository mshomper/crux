# 0075 Should expeditions change their team or let gatherers collect more?

- Status: open
- Date: 2026-11-16
- Lenses: architecture, research and product
- Builds on: 0068, 0070, 0071
- Settles: expedition gatherer allowance = at most 4 gatherers at once and one second round, 8 runs in all, enforced by the hub; round 1 up to 8 searches and 6 page opens with at least 2 opened; round 2 from a page list; reader runs allowed inside the 8

## In short

Should expeditions keep their seven roles and let gatherers read more pages within a clear cap of 8 runs, rather than adding agents or many more gatherers? I recommend that: gatherers are only 2% of a run's cost, but every extra note they write is then read by the expensive roles, so tripling them would roughly double a run's cost.

For you:

- Expeditions look the same; gatherers open and read more pages instead of just skimming search results, so reports cite more sources they actually read
- About $1 more per run (a run was $15); the hub refuses a ninth gatherer run
- Two cheaper variants (cheaper checkers, or the Lead writing the synthesis) are untested; each would be tried on one run first
- Two writers comparing notes was asked about but not tested or costed; it can be a follow-up trial

## Context

Matt (2026-11-16) asked for more flexibility for cheap gatherers and whether the expedition's shape (one Lead, one Advisor, one Synthesizer, one Skeptic, one Builder, one Verifier, Haiku gatherers capped at 4 at once plus one second round) matches how other agent systems are built. Expedition 20261116-how-should-crux-expeditions-structure-th (REPORT.md, draft PR 126) measured the first finished run: $15.04, Lead's own work 28%, Verifier 24%, Advisor 14%, Builder 13%, Synthesizer 12%, Skeptic 5%, gatherers at most 2% (half of that web-search fees). Published systems (Anthropic's research system, open_deep_research, GPT-Researcher) run 3 to 5 parallel workers; more compute saturates; multi-agent setups help parallel work (gathering) and hurt sequential work; self-review without outside feedback lowers accuracy, which supports keeping a separate Skeptic and Verifier. Today's gatherer wording was read as 4 runs in total by one Lead and 4 plus 4 by another. Raising gatherers to 8 at once, 24 searches each, 3 rounds would add about $14 per run, mostly from the Opus and Sonnet roles reading the extra notes. Parallel synthesizers that compare notes were not covered by the report. Evidence is one finished run (n = 1), so the team verdicts are defaults, not proven wins.

## Options

### A: Same team, gatherer rule in numbers, read more pages (recommended)

Keep the seven roles. Gatherers: at most 4 at once and one second round, 8 runs in all, enforced by the hub. Round 1 up to 8 searches and 6 page opens, at least 2 pages actually opened; round 2 works from a list of pages. The Lead may send 'reader' runs with only a page list.
- Pro: Reports rest on pages actually read, not search snippets
- Pro: About +$0.6 to +$1.2 per run (4-8% of a $15 run)
- Pro: Clear numbers end the 4-or-8 misreading
- Con: Gatherer breadth stays about where it is
- Effort: Small

### B: A, plus cheaper checkers

A, and the Advisor runs as an Opus deep-reviewer instead of Fable, and the Verifier at Opus medium instead of high.
- Pro: About $1.6 less per run (estimate), paying for A
- Con: Untested: what the cheaper checks would miss is unknown; try on one run first
- Effort: Small

### C: A, plus the Lead writes the synthesis

A, with six agents: the Lead writes the synthesis itself instead of a separate Synthesizer.
- Pro: About $1.1 less per run (estimate); one thread fewer
- Con: The Lead judges its own plan's findings; untested
- Effort: Small

### D: Many more gatherers

Up to 8 gatherers at once, more searches each, a third round.
- Pro: Widest collection
- Con: About +$14 per run, roughly doubling it, mostly from the expensive roles reading more notes
- Con: Published systems and the evidence show returns flattening past 3-5 workers
- Effort: Small

## Recommendation

A (medium). A: let gatherers read more pages inside a clear cap of 8 runs, keep the team, and try B and two writers comparing notes as one-run trials later.

What would change this: If a trial shows reports missing sources that more gatherers would have found, raise the cap step by step.
