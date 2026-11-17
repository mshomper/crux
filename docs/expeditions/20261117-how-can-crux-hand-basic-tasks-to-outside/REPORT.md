# Handing basic tasks to outside models: report

## 1. Answer

Crux can hand basic work to cheap or local models through **one small provider layer that only the hub calls**. Agents never
get a network, a key or an address: they get one question-only tool. The hub makes the call, to the one provider you set up.
A per-project setting decides whether this is allowed. It has three values, **off (the default), local only, or any**, and is
kept in hub settings, never in a repo.

The prototype is on branch `expedition/20261117-how-can-crux-hand-basic-tasks-to-outside`. It has the provider layer
(OpenAI, Google's compatible endpoint, OpenRouter, a local Ollama, plus an image call), month summaries that can run on an
outside model, an `ask_outside_model` tool for agents, provider keys protected like the Account card's, a usage line for
every outside call, and plain failures. It runs end to end against a local mock server: 27 of 27 new tests pass, and the 144
existing tests it touches still pass. It has not yet made a live call to a real provider. That is your step (section 5).

On cost, Claude is not the expensive route for this work. Claude Haiku 5.5 through an API key lists at $0.10 / $0.50 per
million tokens for prompts up to 100k tokens ($0.50 / $2.50 above that; Batch $0.05 / $0.25). Of the hosted models checked, only gpt-5-nano ($0.05 / $0.40) is cheaper, and Gemini
Flash-Lite costs 3 to 5 times as much. **The real gain from offloading is relief for the Claude plan when the hub runs on
plan sign-in**, plus images, which Claude does not make, and privacy, where a local model sends nothing out. A hub already
running on an API key gains only the price gap. Agents run on this PC's Claude Code plan sign-in by default (the project
pack), and the Account card can switch the hub to an API key (decision 78). This expedition did not check which one your
hub uses today. Nobody has quality evidence for any route, Claude included.

## 2. Findings

### Where offloading plugs in (checked against the repo, main at 834fcab, and the branch)
- **Hub-side jobs** (the hub runs them itself, with no agent involved):
  - **Month summaries.** `summariseDue` and `summariseMonth` in `hub/lib/month-summaries.mjs` already take an injected
    `summarise({ system, user })`. On the branch, `Hub.summariseSoon` (`hub/lib/hub.mjs`) picks the summariser per project:
    the outside provider when that project's setting allows it, otherwise the existing Claude route (`Hub.summariser`). The
    summary file and the `usage` event now record the provider and model that really answered, including per thread.
    Before, both hard-coded `SUMMARY_MODEL` (Haiku).
  - **The permission check** (`PermissionCheck`, `sdkCall` and `apiCall` in `hub/lib/permission-check.mjs`) has the same
    one-call shape and could take an outside model mechanically. **It should not.** It is a safety gate, and no route has
    quality evidence. A wrong "allow" costs far more than the tokens saved.
- **A tool agents call.** `cruxTools` in `hub/lib/tools.mjs` builds the agents' in-process MCP server, so a tool handler runs
  inside the hub. On the branch, `ask_outside_model` is listed only when the project's setting is not off when the agent
  starts (`outsideListed`, also used by `cruxToolNames`). It is never given to the Conductor. Its handler checks the setting
  again on every call (`askOutside` in `hub/lib/offload.mjs`).

### Which basic tasks are worth offloading
| Task | Offload? | Why |
|---|---|---|
| Month summaries (decision 74) | Yes, first, but the saving is tiny | Bulk, not urgent and safe to retry. But no month is due until about May 2027 (`OLD_MS` = 183 days, and the hub log starts in November 2026). Each call is capped at about 6k tokens in and 900 characters out, which comes to under $0.001 at Haiku list price (the Skeptic's estimate from the caps). It is a good first wiring, not a real saving |
| Triage and classification | Yes, behind the switch | Short and repetitive. With no quality evidence, check it against what Claude would have said before anything acts on it |
| Short text answers for agents | Yes, labelled | The caller is Claude and treats the answer as untrusted text |
| Images | Only outside | Claude makes no images. Gemini 3.1 Flash Image costs $0.045 to $0.151 per image. OpenAI's per-image price was not found |
| Permission check, decisions, agent work | No | Safety and judgement gates. Replacing Claude for agents is out of scope |

### Routes on the same footing (prices seen 2026-11-17)
| Route | $ per 1M in / out | Privacy defaults | Load off the Claude plan |
|---|---|---|---|
| Claude Haiku via plan sign-in (Agent SDK) | none in dollars; spends plan percent | Consumer plan terms | **None** |
| Claude Haiku 5.5 via API key | 0.10 / 0.50 up to 100k-token prompts, 0.50 / 2.50 above (Batch 0.05 / 0.25) | Not used for training; API prompts not kept by default | Full |
| OpenAI gpt-5-nano / gpt-4o-mini / gpt-5-mini | 0.05 / 0.40; 0.15 / 0.60; 0.25 / 2.00 (no effective date on the page) | Not trained on by default; abuse logs kept up to 30 days | Full |
| Gemini 3.5 Flash-Lite / 3.8 Flash, paid | 0.30 / 2.50; 0.75 / 3.75 until 2026-12-31, then 1.50 / 7.50 | Not trained on; logged "for a limited period" for abuse checks | Full |
| Gemini, free tier | 0 | **Used to improve Google's products; human reviewers may read it** | Full |
| OpenRouter | list price, plus 5.5% (at least $0.80) when buying credits | OpenRouter itself does not log prompts by default; `data_collection: "deny"` and `zdr` can be requested; upstream terms vary | Full |
| Local Ollama on the 16 GB RTX 4070 Ti Super | 0 (power not counted) | Nothing leaves the PC **if the model is a local one** (Ollama cloud models answer through the same local API) | Full |

Row sources:
- Claude: https://platform.claude.com/docs/en/about-claude/pricing and https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- OpenAI: https://developers.openai.com/api/docs/pricing and https://developers.openai.com/api/docs/guides/your-data
- Gemini: https://aistudio.google.com/docs/pricing and https://aistudio.google.com/docs/terms
- OpenRouter: https://openrouter.ai/docs/faq and https://openrouter.ai/docs/features/provider-routing
- Ollama: https://docs.ollama.com/cloud

### What fits locally (16 GB, shared with nnU-Net training)
- Download sizes: qwen3 4b 2.5 GB, 8b 5.2 GB, 14b 9.3 GB; gemma3 4b 3.4 GB, 12b 8.2 GB; phi4 14b 9.1 GB. qwen3 30b
  (19 GB) does not fit. VRAM in use (with context) is higher; those figures are estimates, not measured.
- Ollama keeps a model loaded for 5 minutes by default. `keep_alive: 0` on its own native routes unloads it. The OpenAI-style
  `/v1` route does not list `keep_alive`, so the prototype sends a separate native unload after every job.
- **The main local risk:** a background job (month summaries run on a timer) loading a 5 to 10 GB model while a long
  training run holds the card. No source says Ollama hands VRAM back to another program. The prototype refuses a local call
  when free VRAM is under 12,000 MB (read with `nvidia-smi`; unreadable counts as busy) and leaves the job for later.
- Local image generation would not share the card with training. Flux-class models need about 11 GB according to search
  snippets (pages not opened, and the figures conflict). SDXL is said to run on 8 GB (also snippets only).
  Ollama's official compatibility page lists no image route.

### What the provider layer smooths over
- Token cap: `max_completion_tokens` for OpenAI (`max_tokens` is deprecated there), `max_tokens` elsewhere (unconfirmed for
  Google and OpenRouter: the live check settles it).
- Usage: `prompt_tokens` / `completion_tokens`. OpenRouter also returns `usage.cost`, which is recorded in credits, not
  labelled as dollars.
- Errors: OpenAI `error{code,type,param}`, OpenRouter `error{code,message,metadata}`, Gemini `429 RESOURCE_EXHAUSTED`. The
  layer turns them into a few plain kinds and never passes a body or header on (a provider can echo the key back).
- Rate limits: three header families; `Retry-After` is not always sent. A 429 becomes kind `rate-limit` with the seconds when
  given.

### Keys, the switch, privacy and permissions
- Provider keys are kept in their own file, `provider-keys.json`, in the hub data folder (`~/.crux-hub`). They are protected
  with the same Windows DPAPI per-user protector as the Account card (`defaultProtector` in `hub/lib/account.mjs`), with only
  the last four characters beside each key. They are kept apart from `secrets.json` so new code cannot break the agents'
  Anthropic key.
- The per-project setting (`outsideModels`: off / local / any) sits in hub settings beside decision 44's other project
  values. "local" allows only the Ollama preset on a loopback address and refuses model tags ending in `-cloud` or `:cloud`.
  That rule is a guess: it has not been checked against Ollama's docs. "any" also needs the provider marked as paid terms by
  you (data terms default to "unknown"), and refuses OpenRouter `:free` models.
- Month summaries and the agent tool send chat text out as written. Keep the switch off, or set to local, on the life
  project and on any project holding employer material. The hub does not block it there yet.
- Permissions: agents never call the network for this. The hub does, only to the preset addresses, with the key it holds.
  This is shown by the tool's input shape (question and optional context only) plus reading the code. A test run cannot
  prove a negative.

### Usage and cost
- Every answered outside call logs a `usage` event with `via: 'outside'`, provider, model, tokens, estimated dollars (null
  when the model is not in the dated price table), `estimated`, and milliseconds. No key is ever included.
- The agent tool has a per-project allowance: 30 calls an hour and $0.50 a day by default. Past it, the tool refuses with
  kind `budget`.
- Outside calls do not move the plan meters (decision 36): the meters come only from Claude's own plan usage readings. They
  are also not counted in an expedition's job budget (decision 69), because outside usage events carry no expedition tag.
  Today, an expedition agent's outside spend is held only by the per-project allowance. The usage panel's dollar totals
  still add outside dollars (and OpenRouter credits) to Claude's plan-estimated dollars, with no split. That is a small
  follow-up for the screen work.
- A model missing from the price table logs no dollar figure, so the daily dollar allowance does not see it. Such a model
  is held by the calls-per-hour limit only.

### Failures
- Timeouts (30 s hosted, 120 s Ollama), 429s, missing keys, empty answers, busy GPU, terms refusals and the budget all fail
  with a plain kind. No retry happens inside the layer, and **there is no fallback to Claude**: a failed month waits for the
  next tick, and a refused tool call leaves the calling agent (Claude) to carry on itself, visibly. Rate limits, timeouts, a
  busy GPU and network errors do not count toward the two-failure rule that parks a month until restart.

## 3. Skeptic's objections (and what was done)
- **The first job has almost no volume.** Accepted. The report says the month-summary saving is near zero and the real volume
  is elsewhere (parked as a sizing study).
- **A background local job could take the GPU from a training run.** Accepted: free-VRAM guard (kind `busy`), the native
  unload after every job (also after failures), and the risk stated above. A hub crash between load and unload leaves the
  model loaded for up to 5 minutes.
- **"Local" is not "nothing leaves": Ollama cloud models.** Accepted: wording weakened, and a cloud-tag refusal added (a guess,
  not verified).
- **One "any" value treats a free Gemini key like a paid one, and a key cannot reveal its tier.** Accepted: you state the data
  terms. "any" refuses free or unknown terms and OpenRouter free models.
- **An agent could loop on a paid key.** Accepted: the per-project call and dollar allowance.
- **Wrong prices.** Accepted: own dated price table, unknown means no figure. Found in passing: the existing permission-check
  cost table prices Haiku 5.5 at Sonnet's $2 / $10 (parked).
- **Reasoning models can return empty, billed answers under a small cap.** Partly met: an empty answer is kind `bad-answer`
  and its usage is still logged. Whether gpt-5-nano reasons is unverified; the live check will show it.
- **Image support is untested on any real route.** Accepted: the image call is coded and tested against the mock only. It is
  unconfirmed on every real provider, and OpenAI's per-image price is unknown.
- **"Load off the plan" depends on the account.** Accepted (section 1).
- **The proposed quality check made Claude the reference.** Accepted: the parked check is blind, with answers unlabelled.
- **Raw chat goes out, and the switch is the only gate.** Accepted as a stated rule (section 2), with the hard block parked.
- **Not done:**
  - a live-check mode that runs the real summary prompt on a sample thread;
  - asking Ollama itself which models are remote (the name guess replaces it);
  - a Claude API preset in the layer (Anthropic's API is not OpenAI-shaped; the existing Account-card route covers it);
  - checking that the usage panel shows unknown model names cleanly;
  - "local" accepts this PC's loopback address only, so a second box on Tailscale cannot serve as the local model.

## 4. Decisions made on your behalf
1. Provider keys go in their own protected file, not in `secrets.json` (Advisor).
2. The agent tool is left out when the switch is off at agent start, and its handler checks the switch on every call (Advisor).
3. No fallback to Claude, silent or opt-in. Failures are plain and name the model (Advisor).
4. The per-project setting has three values, off, local and any, with addresses fixed by hub setup; the Conductor never gets
   the tool (Advisor).
5. No retry inside the client. A 429 fails with the retry seconds (Advisor).
6. No Account-card screen in the prototype. The live check is a script (Advisor).
7. The Skeptic's fixes were folded into the build: unload, VRAM guard, cloud tags, data terms, allowance, prices, and transient
   failures not parking a month (Lead).

## 5. Build status, and what to run yourself
- Branch `expedition/20261117-how-can-crux-hand-basic-tasks-to-outside`. New files: `hub/lib/providers.mjs`,
  `hub/lib/offload.mjs`, `hub/tools/offload-live-check.mjs`, `hub/test/offload.test.mjs`. Changed: `settings.mjs`,
  `month-summaries.mjs`, `hub.mjs`, `tools.mjs`, `agent.mjs` (one line). No new npm package and no version bump.
- Commits c0dcf69 and 6f9303e (fixes from verify run 1). Tests: `node --test test/offload.test.mjs` has 27 of 27 passing.
  The 8 touched existing test files have 144 of 144 passing, the same as on main. `hub/package.json` is unchanged. In the
  tests, DPAPI is replaced by a test protector, so the Windows protection path is checked by reading the code only.
- Known small gaps: the image call is not wired to the switch or the usage log, because nothing in the hub calls it yet.
  The usage panel mixes outside dollars into Claude's totals.
- All results are against a local mock of an OpenAI-compatible server. No real provider has been called.
- **Your live check** (one call, about two minutes). From the branch's `hub` folder:
  `node tools/offload-live-check.mjs --provider google --model gemini-3.5-flash-lite`
  (or `--provider openai --model gpt-5-nano`, or `--provider ollama --model gemma3:4b` with no key). It asks for the key without
  showing it, saves it protected for your Windows user, makes one short call and prints one line: provider, model, tokens,
  dollars, milliseconds, and ok or the error kind. Paste that line back. Add `--no-save` to use the key once without saving it.
  Run it from PowerShell or Windows Terminal: it refuses in Git Bash, where the key would show on screen. The answer is
  capped at 60 tokens. If gpt-5-nano reasons first, the line may read "error: bad-answer". That means the reasoning used up
  the cap, not that the key or the route failed.
- Turning it on for a project in the prototype has no screen yet. It is the `outsideModels` value per project and an
  `outsideProvider` entry in the hub's settings file.

## 6. Parked: proposed next expeditions
- A screen on the Account card for outside providers (key, last 4, data terms) and the switch on the project card. Needs your
  yes on screenshots.
- A blind quality check: the same summaries and triage items from Claude Haiku, one hosted cheap model and one local model,
  read with the answers unlabelled.
- Fix the permission check's cost table pricing Haiku 5.5 at Sonnet's rate.
- Size the real saving from your own usage events by agent type, including Claude's Batch API at half price, which would
  need an asynchronous path.
- An opt-in "use Claude if the outside model fails", and a hard block on the life project and employer-material projects.

## 7. Sources (all opened by a gatherer or the Skeptic, seen 2026-11-17)
- https://platform.claude.com/docs/en/about-claude/pricing
- https://platform.claude.com/docs/en/api/rate-limits
- https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training
- https://developers.openai.com/api/docs/pricing
- https://developers.openai.com/api/docs/guides/your-data
- https://developers.openai.com/api/docs/guides/rate-limits
- https://developers.openai.com/api/docs/guides/error-codes
- https://developers.openai.com/api/docs/guides/image-generation (partly read)
- https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create
- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://aistudio.google.com/docs/pricing
- https://aistudio.google.com/docs/openai
- https://aistudio.google.com/docs/rate-limits
- https://aistudio.google.com/docs/terms
- https://aistudio.google.com/docs/imagen
- https://openrouter.ai/docs/faq
- https://openrouter.ai/docs/guides/administration/usage-accounting
- https://openrouter.ai/docs/api-reference/limits
- https://openrouter.ai/docs/features/provider-routing
- https://openrouter.ai/models?max_price=0
- https://docs.ollama.com/api/openai-compatibility
- https://docs.ollama.com/modelfile
- https://docs.ollama.com/faq
- https://docs.ollama.com/cloud
- https://ollama.readthedocs.io/en/faq/
- https://github.com/ollama/ollama/blob/main/docs/api.md
- https://ollama.com/library/qwen3
- https://ollama.com/library/gemma3
- https://ollama.com/library/phi4
- https://eastondev.com/blog/en/posts/ai/20260410-ollama-performance-optimization/ (third-party)

<!-- hub-generated: everything below this line is written by the hub from the event log -->

## Claims check

The Verifier's claims pass ran (verify/VERDICT.md has a claims or corrections section).

## Parked, as proposed next expeditions

1. A screen on the Account card for outside providers (paste a key, see its last 4, set data terms) and the per-project switch on the project card. (why parked: Anything Matt sees needs his yes on screenshots; the prototype sets these from the live-check script and hub settings only.). Launch pre-fills a brief from this line.
2. A blind quality check: the same thread summaries and triage items done by Claude Haiku, one hosted cheap model and one local model, read unlabelled by Matt. (why parked: No opened source has quality evidence for any route; judging it needs Matt's reading and his GPU, which the brief leaves to him.). Launch pre-fills a brief from this line.
3. Fix the existing Haiku mispricing: permission-check listCost prices any model not in its table (Haiku 5.5 included) at Sonnet's $2/$10. (why parked: A bug in existing hub cost logging, outside this prototype's scope.). Launch pre-fills a brief from this line.
4. Size the real saving: read Matt's usage events by agent type and price them per route, and study where the volume is (agent turns, the permission check, bulk triage), including Claude's own Batch API at half price. (why parked: Month summaries have near-zero volume until about May 2027; the brief asks how to offload, not to measure volume, and the Batch API needs an asynchronous path the layer does not have.). Launch pre-fills a brief from this line.
5. An opt-in "use Claude if the outside model fails" per project, and a hard block of outside providers on the life project and employer-material projects. (why parked: Both are product choices for Matt; the prototype refuses plainly and relies on the off-by-default switch.). Launch pre-fills a brief from this line.

## Requests that were not allowed

- Bash: node -e " const fs=require('fs');let s=fs.readFileSync('lib/providers.mjs','utf8');console.log(s.length)" ; ls ../../../.crux/expeditions/20261117-how-ca… (Inline code the hub cannot read in full: only a few exact read-only strings (the temp-dir print, version prints) are al…)
- Bash: cd hub && node --test test/offload.test.mjs 2>&1 | tail -80; echo EXIT=${PIPESTATUS[0]} (Uses a variable the hub cannot check (${PIPESTATUS))
- Bash: cd hub && node --test test/month-summaries.test.mjs test/account.test.mjs test/project-settings.test.mjs test/usage.test.mjs test/mark-done.test.mjs test… (Uses a variable the hub cannot check (${PIPESTATUS))

## How it ran

Generated from the hub's event log (usage events and expedition events), not estimated. Stop reason: passed. Elapsed: 23 min.

| Role | Agents | Turns | Time at work | Tokens (in / out) | Cost |
|---|---|---|---|---|---|
| Lead (incl. gatherers) | 1 | 14 | 6 min | 7.61M / 116.0k | $3.56 |
| Advisor | 1 | 1 | 3 min | 566.4k / 18.4k | $2.33 |
| Synthesizer | 1 | 1 | 2 min | 335.1k / 9.1k | $0.77 |
| Skeptic | 1 | 1 | 4 min | 1.12M / 28.5k | $0.79 |
| Builder | 1 | 2 | 9 min | 7.59M / 76.9k | $2.27 |
| Verifier | 1 | 2 | 8 min | 5.30M / 46.7k | $3.39 |
| unknown | 1 | 9 | 0 min | 198.2k / 1.4k | $0.37 |
| **Total** | | 30 | 32 min | 22.72M / 297.1k | $13.49 |

Gatherers run inside the Lead, so their time and cost are in the Lead's line and are not split out.

Build-verify loops: 1 (8 passing); 2 (10 passing). Decisions made on the user's behalf: 7. Parked: 8 (3 of them requests that were not allowed).

Spend figures here are the results' logged usage. While a turn runs, the hub's watchdog counts an upper-bound estimate that each result replaces (memo M046), so a limit may trip a little early, never late.
