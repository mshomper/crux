# How should Crux expeditions structure their agent team, and how much more should cheap gatherers collect?

Expedition 20261116-how-should-crux-expeditions-structure-th. In-house figures come from **one finished hub-run expedition** (20261116-what-is-the-best-way-for-the-crux-hub-to, "the finished run", $15.04) and from this run, still going when measured. The hand-run reference in the spec has only estimated figures. No figure here generalises far from n = 1.

## 1. Answer

**Keep the seven roles, keep today's gatherer allowance, and spend it on opening pages rather than on more searches.** The gatherers are not the cost. They were 2.1% of the finished run. What more collecting really costs is the Opus and Sonnet roles that then read the extra notes. So don't raise the allowance. State it in numbers the hub enforces, and change what a gatherer is told to do.

**Team.** Nothing measured argues for changing a role, but that is a default, not a proven win (one run; no other shape was ever run).

| Role | Verdict | Model, effort | Runs as | Woken | Share of the finished run | Reason |
|---|---|---|---|---|---|---|
| Lead | keep | Opus medium | hub agent | whole run | 28.2% (own work) | Largest share, paid on its long context; extra work folded into it costs Opus rates |
| Advisor | keep, one wake | Fable medium (deep-reviewer if Fable is amber) | hub agent | once at the gate, then escalations only | 14.2% finished; 46% of this run while unfinished | Its test changes can only be made before the freeze; it is also the dearest per turn ($2.14 and $3.31) |
| Gatherer | keep, change the brief | Haiku low | subagent of the Lead | rounds 1 and 2 | at most 2.1% | Cheap; see the gatherer rule below |
| Synthesizer | keep (trial a Lead-written synthesis, option C) | Opus medium | hub agent | once after gathering | 12.2% | Gives the Skeptic a fixed target; merging into the Lead is untested |
| Skeptic | keep | Sonnet high | hub agent | once after the synthesis | 5.1% | In both runs its objections changed the answer (finished run: 4 HIGH, all acted on, a second build round) |
| Builder | keep | Sonnet medium | hub agent, own worktree | as soon as the approach is fixed | 12.9% | Nothing argues otherwise |
| Verifier | keep (trial Opus medium, option B) | Opus high | hub agent | each loop, then the claims check | 24.4% | 12 corrections in the finished run (1 HIGH); no evidence on what medium effort would miss |

**Gatherers: the rule, in numbers.**
- **At most 4 at once, one second round of up to 4, so at most 8 runs per expedition.** The hub should refuse a 9th run. Today's wording ("at most 4 at once, and one second round of the same size... Hard limit 4") was read as 4 runs in total by the finished run's Lead and as 4 + 4 by this one.
- **Round 1:** up to 8 searches and up to 6 page opens, with at least 2 pages actually opened.
- **Round 2:** a list of pages to open, up to 4 searches and up to 6 opens.
- **Reader runs.** The Lead may send a gatherer with only a list of pages, inside the 8, instead of writing notes from its own judgment. It cannot search or fetch itself.
- **No third round, and no context cap.** Neither run needed one. The largest gatherer call seen was 57k tokens, well under any cap worth setting.

**What it costs.** Against what the finished run actually ran (4 runs), this rule allows 4 more:
- Gatherers: measured +$0.10. This run ran 8 gatherers for $0.43; the finished run ran 4 for $0.32. The topics differ.
- Reading the extra notes: +$0.15 to +$0.46 (Lead's arithmetic, below).
- One or two more Lead turns at the measured $0.33 a turn (incl. its gatherers; $0.30 for its own work): +$0.33 to +$0.65.
- **Total: about +$0.6 to +$1.2 per expedition, 4–8% of a $15 run, or about 1–2% of the hub's $63 example envelope (7% at $9 per percent, a figure not yet confirmed).**
- Raising gatherers to 8 at once with 24 searches each and 3 rounds would add about $14 by the analyzer's what-if, about a whole run's cost either way (90–100%, depending on how many searches a run is taken to use).

**Choices for Matt, written as Crux options:**
- **A. Same team, the rule in numbers, pages over searches (recommended).** Daily use: expeditions look the same on the map, reports cite more opened sources and fewer "seen in search results only", and a run costs about $1 more.
- **B. A, plus cheaper checkers:** the Advisor runs as deep-reviewer (Opus high) and the Verifier at Opus medium. Daily use: about $1.6 less per run (estimate), which pays for A. What it would miss is unknown, so try it on one run first.
- **C. A, plus the Lead writes the synthesis:** six agents instead of seven. Daily use: one thread fewer and about $1.1 less per run (estimate from $0.33 a Lead turn). The Lead then judges its own plan's findings. Untested.

## 2. Findings

**Measured in Crux (finished run, n = 1; analyzer `bench-out/results.json`, matching the hub's "How it ran" table to the cent)**

| Role | $ | Share | Turns |
|---|---|---|---|
| Lead, incl. gatherers | 4.56 | 30.3% | 14 |
| of which the Lead's own work | 4.24 | 28.2% | - |
| of which gatherers (4 runs) | at most 0.32 | at most 2.1% | - |
| Advisor (Fable) | 2.14 | 14.2% | 1 |
| Synthesizer (Opus) | 1.83 | 12.2% | 1 |
| Skeptic (Sonnet) | 0.77 | 5.1% | 1 |
| Builder (Sonnet) | 1.95 | 12.9% | 2 |
| Verifier (Opus) | 3.67 | 24.4% | 3 |
| Permission check (the hub's "unknown" row) | 0.12 | 0.8% | 21 |
| **Total** | **15.04** | | |

- **Gatherer dollars** are the Haiku entries in the Lead's usage: an upper bound that also holds the Lead's own small Haiku calls. By model the finished run spent Opus $9.73, Sonnet $2.81, Fable $2.14 and Haiku $0.37.
- **A web search costs $0.01; opening a page costs almost nothing.** The logged Haiku cost of each gatherer frame is its tokens at Haiku prices plus exactly $0.01 per search (Skeptic's arithmetic on this run's frames). In this run, token spend was about $0.02 per run whether a run did 0 or 8 searches; in the finished run it was about $0.04 a run. The finished run's Haiku frames bill 16 searches, $0.16, which is about half of its $0.32 gatherer spend. Whether Matt's plan login bills that fee is not known.
- **Gatherers did not use their search allowance.** In the finished run they ran 54–80 s each, and the two notes that state a count used 5 and 4 of 8 searches. This run's round 1 used 6, 7, 8 and 3 searches. Only one gatherer (notes-3) hit 8, and it opened no pages at all. A search cap alone can leave pages unopened.
- **The finished run's "cap ran out" was a misreading.** It ran 3 + 1 gatherers and then had the Lead write a note from its own judgment, which said "No outside source is claimed". Its envelope said 3 gatherers, so the written rule allowed 3 + 3.
- **Gathering is off the critical path.** Gatherer runs took 25–80 s; the finished run lasted 35 min, with the Builder at work for 16 of them.
- **What each role produced, counted by hand (finished run, plus the hand run's outline):**
  - Advisor: 8 changes, reported applied in full. In the hand run it added 7 of 18 test items.
  - Skeptic: 4 HIGH objections (all acted on), 5 MEDIUM and 5 LOW; it caused a second build round. In the hand run Matt's spec calls it the most valuable role.
  - Verifier: 0 failed items and 12 report corrections (1 HIGH, 2 MEDIUM, 9 LOW). In the hand run: 1 defect and 8 overstatements.
  - These counts don't rank the roles by value per dollar: the units differ, and the Skeptic's $0.77 does not include the rework it caused.

**This run's two gathering rounds (one expedition; two things changed at once)**

| Sub-question | Round 1 (stop after 8 searches) | Round 2 (page list, up to 4 searches and 6 opens) |
|---|---|---|
| 1. Published designs | notes-1: 6 searches, 2 pages opened | notes-5: 0 searches, 3 pages; notes-8 adds the two config files |
| 2. Cheap models, search budgets | notes-2: 7 searches, 2 pages | notes-6: 1 search, 3 pages |
| 3. Critic and team size | notes-3: 8 searches, 0 pages | notes-7: 1 search, 3 distinct pages (6 fetches) |
| 4. Cost mechanics | notes-4: 3 searches, 4 pages | notes-8: 0 searches, 5 distinct pages (6 fetches) |
| Total, cost, time (four runs' durations summed) | 24 searches reported (25 billed), 10 fetches; $0.33, 201 s | 2 searches, 18 fetches; $0.09, 145 s |

- Round 2 closed most of the gaps round 1 listed (Lead's reading): it read the primary papers behind round-1 snippets and confirmed the open_deep_research and GPT-Researcher defaults.
- Its lower cost is the search fee (25 searches billed against 2), not cheaper reading, and its links came from round 1's searches. So the fair price of "primary pages opened" is both rounds together: $0.43 for 28 fetches.
- Two of round 2's pages repeat round 1's: the Anthropic post and the open_deep_research config.
- The trial cannot say whether the page list or the tighter cap did the work.
- Some "opened" figures were read through the fetch tool's summary by a small model, not by the gatherer itself.

**From the web (sources in section 7; "via summary" means read through the fetch tool's summarizing model)**
- **Published systems run 3 to 5 parallel workers.** Anthropic's research system spins up 3–5 subagents in parallel, and 2–4 subagents with 10–15 tool calls each for comparisons (opened). open_deep_research defaults to 5 concurrent researchers, 6 iterations and 10 tool calls per step. GPT-Researcher uses 3 subtopics, 3 iterations and concurrency 4 (opened via summary).
- **Token use matters within a system; call counts don't compare across models.** Anthropic: token usage alone explains 80% of BrowseComp variance in its system (opened). BrowseComp-Plus: gpt-oss-20B makes about 24 search calls for 34.6% and gpt-5 about 22 for 70.1%. Within one model, a better retriever gives higher accuracy with fewer calls (opened via summary). Reading what is found matters more than searching more (judgment).
- **More compute saturates.** Web-action agents: 43.2% at N = 10 and 43.0% at N = 20 for about twice the tokens (opened; not research tasks).
- **Multi-agent setups help parallel work and hurt sequential work.** One paper reports +80.8% on a parallel finance task and −39% to −70% on a sequential planning task (opened via summary). It gives error amplification of 17.2x (independent) and 4.4x (centralised), but in the paper's model error amplification did not significantly predict performance (p = 0.658). Its roughly 45% single-agent threshold is in the paper's text (rechecked by the Verifier). Gathering is the parallel part of an expedition; the rest of the pipeline is sequential (judgment).
- **Verification matters but cures nothing.** MAST, from 1,642 traces: task verification is about 23.5% of failures and inter-agent misalignment about 32%. A verifier is "not a silver bullet", and one task-objective check gave +15.6% (opened via summary; the category totals are the summarizer's sums).
- **Self-review without outside feedback lowers accuracy** (GPT-4 on GSM8K: 95.5 to 89.0 after two rounds; opened). Models favour their own text (GPT-4 recognises its own summaries 73.5% of the time; opened). This evidence is indirect for an Opus synthesis reviewed by a Sonnet Skeptic: both are Claude, and the studies are of reasoning and summarization tasks.
- **Prices** (opened):
  - Per million tokens: Haiku 5.5 $0.10 in / $0.50 out, 5x above 100k-token prompts; Sonnet 5.5 $2 / $10; Opus 5.5 $4 / $20; Fable 5.2 $8 / $40.
  - Web search $10 per 1,000; web fetch costs only its tokens.
  - Subagents return only their final message and run up to 20 at once by default.
- **No Haiku score on any web-research benchmark was found** (notes-2, notes-6).

**How the cost of option A was worked out (Lead's arithmetic)**
- Gatherers: +$0.10 measured (this run's 8 runs, $0.43, against the finished run's 4, $0.32).
- Reading: 4 more notes of about 8.4 KB each, about 2.1k tokens. With 30% more tokens for current models' tokenizer (notes-4), that is about 2.7k tokens per note.
  - Read once each by the Lead, Synthesizer and Verifier (Opus, $4 per million) and the Skeptic (Sonnet, $2) at $14 per million combined: about $0.04 a note, so $0.15.
  - Up to three times that if the Lead re-reads them across turns: $0.46.
- Lead: one or two more turns at the measured $0.33 a turn ($0.30 without its gatherers): $0.33–0.65.
- Total about +$0.6 to +$1.2. The analyzer's what-if prices only the gatherers and one read of the notes. The rows are in `bench-out/results.json`, with their assumptions; that file is not on the branch.

## 3. The Skeptic's objections, and what was done

- **H1. "Three rounds, 12 runs" had no evidence, and "the cap ran out" was a misreading.** Accepted. The recommendation keeps today's 4 + 4 = 8 and makes the hub enforce it; a third round is parked as something to test.
- **H2. Round 2 was cheap because of the search fee, not directed opening.** Accepted. Section 2 now says a search costs $0.01 and an open costs almost nothing in Haiku. The price of opened pages is both rounds together.
- **H3. The value-per-dollar ranking contradicts itself, and n = 1 cannot carry the verdicts.** Accepted. Counts are given by severity, the "most per dollar" ranking is dropped, and the team verdicts say "no evidence to change".
- **H4. The cheaper shapes were dropped for weak reasons; S3 vanished, and S2 was costed against itself.** Accepted. Cheaper checkers are option B and a Lead-written synthesis is option C. S2 was re-estimated from $0.33 a Lead turn (about $1.1 saved, not $0.4–0.8). A Lead-plus-gatherers-only shape was not costed: none of the evidence bears on it, and the Skeptic and Verifier changed the outcome in both runs.
- **M1. The cost of collecting more leaves out the Lead's turns, the Verifier's claim load, the tokenizer and re-reads.** Accepted, except the Verifier's claim load, which was not modelled and stays open. The cost range in section 1 includes the Lead's turns, the tokenizer and re-reads.
- **M2. Envelope shares flatter the cost.** Accepted. Costs are quoted mainly against the $15.04 run; the share of the unconfirmed $63 envelope is given only beside it.
- **M3. The 100k context cap is unjustified.** Accepted; dropped.
- **M4. Several "opened" sources were read through a summarizing model.** Accepted. Those findings say "via summary" and carry the p = 0.658 caveat. The Verifier reopened the four pages the answer leans on (also through the fetch tool), and every figure matched.
- **M5. The self-review evidence is stretched, and "a different model" doesn't escape same-family bias.** Accepted. The Skeptic is kept on its record in the two runs; the outside evidence is called indirect, and the different-model argument is dropped.
- **M6. The round comparison borrows round 1's discovery.** Accepted. The rounds are priced together, repeated pages are marked, and notes-3 is cited as a search cap leaving pages unopened.
- **M7. The Advisor's cost was understated.** Accepted. The table shows 14.2% (finished) and 46% (this run while unfinished). That the Fable meter is separate from the plan's overall spend is not established and is not claimed.
- **LOW (Lead token counts mix models; the 4.5-searches basis rests on 2 notes; page-count mismatch; "no new type" for a reader is untested; rounding).** Noted:
  - Dollar splits use cost by model.
  - Round 1's opened-page counts in decision 3 ("0, 2, 4, 6") are wrong; the notes show 2, 2, 0 and 4.
  - The reader is proposed as a brief that overrides the gatherer file's search and gaps rules, still to be tried.

## 4. Decisions made on Matt's behalf

1. Gatherers started in parallel with the Advisor's gate review, to fit the 2-hour envelope.
2. The build is an analyzer of Crux's own expedition logs. Role and limit changes stay proposals for a Crux decision.
3. Round 2 gave each gatherer a page list, at most 4 searches and at most 6 opens, as a trial against round 1.
4. (Advisor) The plan was approved with changes; the analyzer stays small.
5. (Advisor) Gatherer dollars come from the Haiku entries in the Lead's usage, as an upper bound.
6. (Advisor) Round-2 notes state their own search and page counts, and the report says the trial changed two things at once.
7. (Advisor) The test ties each role's cost to the hub's table to the cent, and the what-if includes the reading cost.
8. (Advisor) Only the analyzer and the report go on the branch. Hub quirks are proposals.
9. The recommendation keeps 4 + 4 = 8 runs, hub-enforced, and drops the third round and the 100k cap.
10. Team verdicts read "no evidence to change". The cheaper checkers and a Lead-written synthesis are offered as one-run trials.
11. Added cost is quoted against a measured run's cost, including the Lead's turns.

(DECISIONS.md numbers the last three lines 4–6 again, because the Advisor's lines were written by hand between them.)

## 5. Build status and what to run yourself

- **Analyzer:** `bench/expedition-team/analyze.mjs` on branch `expedition/20261116-how-should-crux-expeditions-structure-th`, plain Node with no packages, plus a README.
  - It reads a project's `.crux/events.jsonl` read-only, plus the expedition folders. It reports cost per role (to the cent of the hub's own table), gatherer runs and dollars split out of the Lead, notes statistics, and the what-if table.
  - It reads the live log only; usage moves to the archive after about a month.
- **Frozen test:** items 5–7 (the analyzer runs; its results tie to the hub's table and rerun exactly; the branch holds only the analyzer, with no log data) passed in the Builder's runs and in the Verifier's run in `verify/run-1/`. Items 1–4 are judged on this report; see `verify/VERDICT.md`.
- **Run it yourself** after the next few expeditions, to see whether these shares hold beyond n = 1: from the worktree or a checkout, `node bench/expedition-team/analyze.mjs <project folder>`.
- **Hub quirks found** (proposed fixes, not built):
  - The cost table's "unknown" row is the permission check.
  - "Time at work" has no end, so it grows if an agent is woken after the finish.
  - A gatherer's logged tokens are its last call, not its spend, and its searches and pages are never logged.
  - The gatherer count is not enforced.

## 6. Parked items, proposed as next expeditions

- **Hub fixes:** label the permission-check row, bound time at work, log each gatherer's searches, pages and own spend and split gatherers out of the Lead's row, and refuse a gatherer past the limit. These are code changes for a Crux decision.
- **Trial the cheaper shapes:** one run with the Advisor as deep-reviewer and the Verifier at Opus medium, one with the Lead writing the synthesis, each compared with a present-team run by the analyzer.
- **Separate the page list from the cap:** test whether a page list alone gets primary pages opened, and whether a third round is ever needed.

## 7. Sources

Opened by a gatherer (some through the fetch tool's summary, as marked in the notes):
- Anthropic, How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- open_deep_research configuration: https://raw.githubusercontent.com/langchain-ai/open_deep_research/main/src/open_deep_research/configuration.py
- GPT-Researcher defaults: https://raw.githubusercontent.com/assafelovic/gpt-researcher/master/gpt_researcher/config/variables/default.py
- BrowseComp-Plus project page: https://texttron.github.io/BrowseComp-Plus
- BrowseComp-Plus paper: https://arxiv.org/html/2508.06600
- BrowseComp: https://arxiv.org/html/2504.12516
- Per-step sampling in web agents: https://arxiv.org/html/2602.12276
- Claude Haiku 4.5 announcement: https://www.anthropic.com/news/claude-haiku-4-5
- Why Do Multi-Agent LLM Systems Fail? (MAST): https://arxiv.org/html/2503.13657
- Towards a Science of Scaling Agent Systems: https://arxiv.org/html/2512.08296
- Large Language Models Cannot Self-Correct Reasoning Yet: https://arxiv.org/html/2310.01798v2
- LLM Evaluators Recognize and Favor Their Own Generations: https://arxiv.org/html/2404.13076
- LLM Critics Help Catch LLM Bugs: https://arxiv.org/html/2407.00215
- Anthropic pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Claude Code costs: https://code.claude.com/docs/en/costs
- Agent SDK subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- Web search tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Web fetch tool: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool

Seen in search results only, not relied on: OpenAI deep research, Gemini Deep Research docs, STORM, GPT-Researcher docs, AgentCoder, Cognition's "Don't Build Multi-Agents", and the notes-3 snippets (see notes-1, notes-3).

In-house: `bench-out/results.json`, the finished expedition's folder (REPORT.md, skeptic.md, DECISIONS.md, verify/), `hub/lib/expedition.mjs`, `hub/lib/agent.mjs`, `agent-types/starter/expedition-*.md`, and the spec's Appendix A.

<!-- hub-generated: everything below this line is written by the hub from the event log -->

## Claims check

The Verifier's claims pass ran (verify/VERDICT.md has a claims or corrections section).

## Parked, as proposed next expeditions

1. Hub fixes from this expedition: label the "unknown" row as the permission check, bound time at work to the expedition's start and stop, log each gatherer's searches, pages opened and own Haiku spend at its end and split gatherers out of the Lead's row, and have the hub refuse a gatherer past the stated limit. (why parked: Hub code changes are outside a research brief and go through Crux for Matt's pick; the branch carries only the analyzer.). Launch pre-fills a brief from this line.
2. Trial the two cheaper team shapes on real expeditions: one run with the Advisor as deep-reviewer and the Verifier at Opus medium, one run with the Lead writing the synthesis, each compared with the analyzer against a present-team run. (why parked: No run has tested either shape; only a real run can show what they miss, and choosing the team is Matt's call.). Launch pre-fills a brief from this line.
3. Test whether a page list alone (no tighter cap) gets gatherers to open primary pages, and whether a third round is ever needed, by running one expedition whose second-round gaps name pages nobody has a link for yet. (why parked: This run changed the page list and the cap at once, and the gatherer slots were used up, so the two could not be separated here.). Launch pre-fills a brief from this line.

## Requests that were not allowed

- Bash: cd /c/Users/mshom/Documents/GitHub/crux/.crux && ls expeditions expeditions/2026*how-should* expeditions/2026*best-way* && wc -c events.jsonl && node -e… (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)
- Bash: cd C:/Users/mshom/Documents/GitHub/crux/.crux/expeditions/20261116-how-should-crux-expeditions-structure-th/bench-out && node -e " const r=JSON.parse(req… (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)
- Bash: cd C:/Users/mshom/Documents/GitHub/crux/.crux/expeditions/20261116-how-should-crux-expeditions-structure-th && ls -la . ; for f in notes-*.md; do echo "=… (Not sure what this does (for); Uses a variable whose value is only known at run time ($f))
- Bash: cd /c/Users/mshom/Documents/GitHub/crux && diff <(tr -d '\r' < .claude/worktrees/exp-20261116-how-should-crux-expeditions-structure-th/bench/expedition-t… (Command substitution the hub cannot read; Not sure what this does (-d))
- Bash: cd /c/Users/mshom/Documents/GitHub/crux/.crux/expeditions/20261116-how-should-crux-expeditions-structure-th/bench-out && node -e "const r=require('./resu… (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)

## How it ran

Generated from the hub's event log (usage events and expedition events), not estimated. Stop reason: passed. Elapsed: 28 min.

| Role | Agents | Turns | Time at work | Tokens (in / out) | Cost |
|---|---|---|---|---|---|
| Lead (incl. gatherers) | 1 | 16 | 9 min | 9.52M / 153.4k | $4.74 |
| Advisor | 1 | 1 | 5 min | 1.26M / 29.6k | $3.31 |
| Synthesizer | 1 | 1 | 8 min | 2.66M / 49.6k | $2.95 |
| Skeptic | 1 | 1 | 6 min | 1.80M / 45.4k | $1.31 |
| Builder | 1 | 2 | 4 min | 2.53M / 35.8k | $1.13 |
| Verifier | 1 | 3 | 10 min | 8.06M / 69.5k | $4.49 |
| unknown | 1 | 13 | 0 min | 60.9k / 2.3k | $0.08 |
| **Total** | | 37 | 41 min | 25.88M / 385.6k | $18.00 |

Gatherers run inside the Lead, so their time and cost are in the Lead's line and are not split out.

Build-verify loops: 1 (3 passing); 2 (7 passing). Decisions made on the user's behalf: 6. Parked: 8 (5 of them requests that were not allowed).

Spend figures here are the results' logged usage. While a turn runs, the hub's watchdog counts an upper-bound estimate that each result replaces (memo M046), so a limit may trip a little early, never late.
