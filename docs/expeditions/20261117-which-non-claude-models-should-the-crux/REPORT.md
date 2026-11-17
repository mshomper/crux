# Which non-Claude models should the Crux hub call?

Expedition 20261117, research only. Prices checked 2026-11-17. No images were generated and no model was called
during this expedition. "Judgment" marks a claim with no opened source. "Snippet" marks a figure seen only in a search
result, not on an opened page.

## Answer

**Image route: local Qwen-Image in ComfyUI on Matt's GPU (provisional until a 3-prompt trial).** It is the only
image option with Apache 2.0 weights, no cost per picture and nothing leaving the PC, so it can serve every project,
employer ones included. It is picked on privacy and cost, not proven quality: the only text-rendering evidence is
Qwen's own model card. It is for raster mockups and illustrations. Icons and diagrams stay Claude-drawn SVG, which
already fits the drawn-SVG icon rule and needs nothing new.
Runner-up: Google Nano Banana 2.1, at $0.0336 an image ($0.0168 batch), for personal projects only.

**Text route: local gpt-oss:20b in Ollama (provisional until a sample test against Haiku).** It costs nothing per
run, keeps bulk jobs off the plan meter (usage is Matt's binding constraint), sends nothing off the PC, and its
weights are Apache 2.0. Runner-up: stay on Claude Haiku 5.5. The cheapest hosted option saves 3 to 6 cents per run (worked
example below), and Haiku batch needs its own API key and a batch tool.

What would change the picks: the trial showing poor text in Qwen-Image pictures, a GPU under 16 GB, or a sample test
where gpt-oss:20b summaries clearly lose to Haiku. Any of these points to the runner-up.

**Decision card brief**
- Lead: Should the hub's agents get two local model tools, Qwen-Image through ComfyUI for pictures and gpt-oss:20b
  through Ollama for bulk text, both on your PC? I recommend it: nothing leaves the machine, there is no per-use bill,
  and they keep bulk jobs off your plan meter.
- What changes for you:
  - Agents can ask for a mockup picture or a bulk summary, and the result lands in the thread. Icons and diagrams are still drawn by Claude.
  - (setup) You install ComfyUI and Ollama yourself and download well over 34 GB of models (about 20 GB image model from a search result, not confirmed; 14 GB text model, plus the image text encoder), in roughly 11 steps. Both programs must be running when an agent uses them.
  - (setup) Before you rely on them, run one picture trial and one summary trial on your PC, 3 prompts each.
  - (undo) Nothing is hard to undo: close or uninstall the two programs and the tools report "not running".

## Findings

**Image options** (prices checked 2026-11-17)

| Option | Cost per image, 1024px | Quality for mockups / icons / diagrams | Setup | Licence (commercial use) | Privacy (what leaves the machine) |
|---|---|---|---|---|---|
| Baseline: Claude draws SVG / HTML (status quo) | $0 extra (judgment) | Vector icons and diagrams, matches the drawn-SVG rule; no photo-like mockups (judgment) | None | Matt's own output | Nothing new |
| OpenAI gpt-image-2 (cheap: gpt-image-1-mini) | Guide's "Historical output costs" table: $0.053 medium, $0.211 high; mini $0.011 medium ([guide](https://developers.openai.com/api/docs/guides/image-generation)). Pricing page gives token rates only: $30 / $8 per 1M image output tokens ([pricing](https://developers.openai.com/api/docs/pricing)) | No opened source (judgment) | API key, about 3 steps (judgment) | Output ownership unconfirmed (terms pages returned 403) | Prompt and image go to OpenAI. Not trained on by default; logs kept up to 30 days ([your-data](https://developers.openai.com/api/docs/guides/your-data)) |
| Google Nano Banana 2.1 (runner-up) | $0.0336 at 1K; batch $0.0168 ([pricing](https://aistudio.google.com/docs/pricing)) | No opened source (judgment) | API key with billing on, about 3 steps (judgment) | "Google won't claim ownership"; for professional or business use ([terms](https://aistudio.google.com/docs/terms)) | Prompt and image go to Google. Paid tier not used to improve products, logged "for a limited period"; free tier trained on and human-reviewed ([terms](https://aistudio.google.com/docs/terms)) |
| Black Forest Labs FLUX.2 [pro] | $0.03 first megapixel ([pricing](https://bfl.ai/pricing)) | No opened source (judgment) | API key, about 3 steps (judgment) | No ownership claim; outputs may not train other models ([ToS](https://bfl.ai/legal/terms-of-service)) | Prompt and image go to BFL, which trains on them unless you opt out by email ([ToS](https://bfl.ai/legal/terms-of-service)) |
| xAI grok-imagine-image | $0.02, size not stated ([models](https://docs.x.ai/docs/models)) | No opened source (judgment) | API key, about 3 steps (judgment) | Not gathered (terms page returned 403) | Prompt and image go to xAI. Kept 30 days, not trained on ([FAQ](https://docs.x.ai/docs/faq/security)) |
| **Local: Qwen-Image (fp8) in ComfyUI (pick)** | $0 marginal, electricity only (judgment) | Card claims "significant advances in complex text rendering" (vendor's claim; [card](https://huggingface.co/Qwen/Qwen-Image)); no independent source | About 8 hand steps (below); 11 with Ollama. VRAM: 24 GB fits; 16 GB only with offload and slower; 12 GB doubtful (assumption: Matt's GPU model is unknown). Time per image: snippet only, about 71 s on a 24 GB card after a 94 s first run | Weights Apache 2.0 ([card](https://huggingface.co/Qwen/Qwen-Image)); outputs: no restriction on the card (judgment: Apache 2.0 sets no output limit). Text-encoder and repacked fp8 file licences unchecked | Nothing |
| Local: FLUX.1 schnell in ComfyUI | $0 marginal (judgment) | Fast, 1-4 steps; no text-rendering claim ([card](https://huggingface.co/black-forest-labs/FLUX.1-schnell)) | About 8 hand steps. VRAM: 16-24 GB (assumption). Time: unknown | Apache 2.0; outputs usable commercially per card ([card](https://huggingface.co/black-forest-labs/FLUX.1-schnell)) | Nothing |

The Verifier noticed that the OpenAI image guide also lists newer GPT-Image-2.5 and 2.6 models and says gpt-image-1
was shut down on 2026-10-23. Their prices were not gathered.

Ruled out: FLUX.2 [dev]. Its outputs may be used commercially, but the weights are "Non-Commercial Purposes" only
([licence](https://huggingface.co/black-forest-labs/FLUX.2-dev/blob/main/LICENSE.md)). SDXL base: the card says it
"cannot render legible text" ([card](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0)).

Local image setup, from ComfyUI's Windows page ([install](https://docs.comfy.org/installation/comfyui_portable_windows))
and the Qwen-Image example ([example](https://comfyanonymous.github.io/ComfyUI_examples/qwen_image/)):
1. Download the portable NVIDIA .7z.
2. Install 7-Zip if it is not already there.
3. Extract the archive.
4. Download the diffusion model.
5. Download the Qwen2.5-VL 7B fp8 text encoder.
6. Download the VAE.
7. Place the three files in their model folders.
8. Run run_nvidia_gpu.bat.

Ollama adds three more: install it, pull gpt-oss:20b, and keep it running. That makes about 11 steps in all
(judgment), about at the setup budget of around 10 steps (one phone screen). Download sizes: Qwen-Image fp8 is about 20 GB (snippet), the
encoder size was not gathered, and gpt-oss:20b is 14 GB ([library](https://ollama.com/library/gpt-oss)). Installing
is a step only Matt can take, because installs are a hard stop for agents.

**Text options** (per million tokens, checked 2026-11-17)

| Option | Cost $ in / $ out; batch | Quality vs Haiku | Setup | Licence (commercial use) | Privacy (what leaves the machine) |
|---|---|---|---|---|---|
| Baseline: Claude Haiku 5.5 (prompts up to 100K), runner-up | $0.10 / $0.50; batch $0.05 / $0.25 ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)) | Baseline | Plan login as today (uses the plan meter); batch needs a separate API key and a batch tool (Skeptic, from repo: setup.mjs holds one sk-ant key) | Terms not gathered (unchanged from today's use) | Same as today, no new service. Retention not gathered (unchanged from today's use) |
| OpenAI gpt-5-nano | $0.05 / $0.40; batch $0.025 / $0.20 ([pricing](https://developers.openai.com/api/docs/pricing)) | No opened benchmark (judgment: fine for labels, riskier for long summaries) | API key, about 3 steps (judgment) | Output terms unconfirmed (403) | Prompt goes to OpenAI. Not trained on by default; logs kept up to 30 days ([your-data](https://developers.openai.com/api/docs/guides/your-data)) |
| Google Gemini 2.5 Flash-Lite | $0.10 / $0.40; batch $0.05 / $0.20 ([pricing](https://aistudio.google.com/docs/pricing)) | No opened benchmark (judgment: below Haiku, about level with gpt-5-nano; fine for labels, weaker on long summaries) | API key with billing on, about 3 steps (judgment) | No ownership claim ([terms](https://aistudio.google.com/docs/terms)) | Prompt goes to Google. Paid tier not used to improve products; free tier trained on ([terms](https://aistudio.google.com/docs/terms)) |
| Groq openai/gpt-oss-20b (open-weight host) | $0.075 / $0.30; batch not gathered ([models](https://console.groq.com/docs/models)) | No source (judgment: same model as the local pick, so likely below Haiku on long summaries, adequate for triage and labels) | API key, about 3 steps (judgment) | Weights Apache 2.0 ([library](https://ollama.com/library/gpt-oss)) | Prompt goes to Groq. Retention and training terms not gathered (the gatherer allowance ran out; Groq's data page was not opened), so treat them as unknown and send nothing private |
| DeepSeek deepseek-flash | $0.15 / $0.60 off-peak; $0.30 / $1.20 peak ([pricing](https://api-docs.deepseek.com/quick_start/pricing)) | No source (judgment: likely near Haiku on summaries) | API key (judgment) | Not gathered | Stored in China and may be trained on, per the consumer policy; API coverage not confirmed ([privacy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html)) |
| xAI grok-build-0.1 (cheapest Grok listed) | $1.00 / $2.00 ([models](https://docs.x.ai/docs/models)) | No source (judgment: likely at or above Haiku, at 10 times the price for input and 4 times for output) | API key (judgment) | Not gathered | Kept 30 days, not trained on ([FAQ](https://docs.x.ai/docs/faq/security)) |
| **Local: Ollama gpt-oss:20b (pick)** | $0 marginal (judgment) | No source (judgment: likely below Haiku on long summaries, adequate for triage and labels) | About 3 hand steps (judgment). VRAM: runs "with as little as 16GB memory"; 24 GB comfortable (assumption about Matt's card) | "Permissive Apache 2.0 license"; outputs usable commercially (page: "ideal for ... commercial deployment") ([library](https://ollama.com/library/gpt-oss)) | Nothing |
| Local: Ollama qwen3:8b | $0 marginal (judgment) | No source (judgment: a small model, below Haiku and below gpt-oss:20b; triage and labels only) | Same as above; 5.2 GB download ([library](https://ollama.com/library/qwen3)) | apache-2.0 ([card](https://huggingface.co/Qwen/Qwen3-8B)) | Nothing |

Mistral was dropped because its pricing page listed no small model.

**Worked example: one bulk job with 1M tokens in and 100k out** (a month-summary run)

| Option | Standard | Batch |
|---|---|---|
| Claude Haiku 5.5 | $0.150 | $0.075 |
| OpenAI gpt-5-nano | $0.090 | $0.045 |
| Google Gemini 2.5 Flash-Lite | $0.140 | $0.070 |
| Groq gpt-oss-20b | $0.105 | not gathered |
| DeepSeek deepseek-flash, off-peak | $0.210 | not gathered |
| xAI grok-build-0.1 | $1.200 | not gathered |
| Local gpt-oss:20b | $0 (judgment) | n/a |

Even at 100 times this volume a month, the cheapest hosted option saves only about $3 to $6 against Haiku (judgment
from the table). Hosted savings are not the argument. Keeping work off the plan meter and keeping private material on
the PC are. The Anthropic page says Claude 4.7 and later produce about 30% more tokens than earlier Claude tokenizers.
That is relative to older Claude models, not other vendors, so cross-vendor token counts may differ (judgment).

**Wiring as a hub tool** (Lead's read of the repo at 36061c4)
- Hub tools are `tool(...)` entries in hub/lib/tools.mjs, served by `createSdkMcpServer` (tools.mjs:2, :283) inside
  the hub's own Node process. A `make_image` or `bulk_text` tool is one more entry, and its handler calls the service
  with Node's built-in `fetch`, as setup.mjs:45-51 already does for Anthropic. No new npm package is needed.
- The local routes call 127.0.0.1 only. ComfyUI: POST the workflow to `/prompt`, read `/history/{prompt_id}`, then
  fetch the picture from `/view?filename&subfolder&type`
  ([api examples](https://docs.comfy.org/development/comfyui-server/api-examples)). Ollama: an OpenAI-shaped
  `POST http://localhost:11434/v1/chat/completions`, with a placeholder key it ignores
  ([docs](https://docs.ollama.com/api/openai-compatibility)). The tool ships the workflow file, writes pictures under
  the project's `.crux/attachments/` (decision 23), and replies "start ComfyUI" or "start Ollama" when the program is
  down (judgment).
- Keys: today the `Secrets` class (hub/lib/setup.mjs:18-40) keeps one Anthropic key in `~/.crux-hub/secrets.json`.
  `KEY_SHAPE` accepts only sk-ant keys, and the 0600 file mode does nothing on Windows (Skeptic). Decision 78 moves
  keys to Windows' protected storage, which is not built yet. A hosted key would be one more named entry there. The
  local picks need no key at all.
- Permission rules: an MCP tool call is not a shell command or a WebFetch, so agents still reach no host themselves.
  The network rules (permission-rules.mjs:86, :737) stay as they are. But permission-rules.mjs:748 allows every
  `mcp__crux__*` tool silently at every level. So any guard must sit in the tool's own code. A hosted tool would need
  a per-project switch (off by default, set in the project card, decision 44) checked in its handler, a fixed host,
  and no agent-supplied URL, file path or input image. That switch is what keeps employer and private material away
  from a new service. Only the local tools would be offered in employer projects. The only new outbound traffic would
  come from the hub process: to 127.0.0.1 for the picks, or to one named host such as generativelanguage.googleapis.com
  for a hosted runner-up.

## Skeptic's objections

How each was handled (SKEPTIC.md has the full list):
1. **HIGH: "Stay on Haiku batch" is not setup-free.** It needs a separate API key and a batch tool, and batches can
   take up to 24 hours (snippet), too slow for quick triage. Folded in: the text pick moved to local gpt-oss:20b, and
   Haiku became the runner-up (DECISIONS.md, Lead's decision 4; item 3 below).
2. **HIGH: the image and text picks used different tests.** Text rejected a few cents of saving; images accepted about 8
   hand steps to save about $0.03 a picture. Folded in: both picks now rest on the same grounds (privacy, employer projects, plan meter),
   are labelled provisional, and the image quality basis is stated plainly as the vendor's claim (DECISIONS.md, Lead's decision 5; item 4 below).
3. **HIGH: a missing baseline, Claude drawing SVG/HTML.** Added as the first image row. Icons and diagrams stay with
   Claude, and Qwen-Image is scoped to raster mockups.
4. MEDIUM: Qwen-Image VRAM and speed. A snippet (not opened) gives a file of about 20 GB, roughly 86% of a 24 GB
   card, and 71 s per image after the first run. Shown as a snippet.
5. MEDIUM: installs are Matt's hard stop and the download is large. Stated in the setup lines and the card.
6. MEDIUM: permission-rules.mjs:748 allows every crux tool silently. The guard now sits in the handler (wiring section).
7. MEDIUM: the licences of the Qwen text encoder and the repacked fp8 files were not checked. NVIDIA's hosted page
   names its own licence for its endpoint (notes-2). Left as an open check before use.
8. MEDIUM: GPU contention. Qwen-Image (about 20 GB) and gpt-oss:20b (14 GB) cannot share a 24 GB card, nor sit beside
   Matt's CUDA jobs. Judgment: run one at a time, and have the tools wait or refuse while the GPU is busy.
9. LOW: the tokenizer note compares Claude models, not vendors (corrected above). The Gemini 2.5 Flash-Lite lifecycle
   was not read. Terms quotes from summarising fetches are unverified word for word.

## Decisions made on Matt's behalf

1. Widened the search to xAI Grok, Mistral and DeepSeek, at Matt's mid-run request (re-logged as decision 3 after an overwrite).
2. Kept the three round-1 gatherers as run, filled the gaps with three reader runs, and raised the hosted-text cap to five.
3. Changed the text pick to local gpt-oss:20b, with Haiku as runner-up, after the Skeptic's objection.
4. Kept local Qwen-Image as a provisional image pick, scoped to raster mockups; icons and diagrams stay Claude SVG.
5. Advisor decisions at the gate: Haiku batch was allowed as a text route; no images generated; VRAM given by tier as
   an assumption; candidate caps; the test amended (see DECISIONS.md).

## Build status

**Success test: 11 of 12 items pass. Item 4 is PARTIAL** because Groq, the required open-weight host, has no
retention or training terms. A reader run for Groq's data page was refused: all 8 gatherer runs were used.

No build, because the brief says research only. Nothing was installed and no key was used. To try the picks yourself:
1. Install ComfyUI portable and the three Qwen-Image files (steps above), then run three prompts in its page: a
   dark-theme settings panel mockup, a simple line icon, and a labelled block diagram.
2. Install Ollama, run `ollama pull gpt-oss:20b`, and compare its summary of one month of a personal project's chat
   with Haiku's.
3. If both look good enough, the decision card follows, then a build brief for the two hub tools.

## Parked items (proposed next expeditions)

1. A trial run: the 3-prompt image trial on Qwen-Image vs Nano Banana 2.1, and a gpt-oss:20b vs Haiku summary test. Matt runs these on his PC.
2. Recraft, an SVG-native icon service: official prices, terms and retention. Only snippets were found.
3. Building the ComfyUI and Ollama hub tools, and the Windows protected-storage key store from decision 78. This
   follows a Crux decision; the brief said no build.

## Sources

Pages a gatherer opened (directly or through a summarising fetch), as recorded in notes-1 to notes-9:
- https://platform.claude.com/docs/en/about-claude/pricing (notes-3, notes-6)
- https://developers.openai.com/api/docs/pricing (notes-3, notes-9)
- https://developers.openai.com/api/docs/guides/image-generation (notes-1)
- https://developers.openai.com/api/docs/guides/your-data (notes-6)
- https://aistudio.google.com/docs/pricing (notes-1, notes-3)
- https://aistudio.google.com/docs/terms (notes-9)
- https://bfl.ai/pricing (notes-1)
- https://bfl.ai/legal/terms-of-service (notes-7)
- https://docs.x.ai/docs/models (notes-5)
- https://docs.x.ai/docs/faq/security (notes-6)
- https://console.groq.com/docs/models (notes-6)
- https://api-docs.deepseek.com/quick_start/pricing (notes-5)
- https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html (notes-5)
- https://huggingface.co/Qwen/Qwen-Image (notes-2)
- https://huggingface.co/black-forest-labs/FLUX.1-schnell (notes-2)
- https://huggingface.co/black-forest-labs/FLUX.2-dev/blob/main/LICENSE.md (notes-9)
- https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0 (notes-2)
- https://huggingface.co/Qwen/Qwen3-8B (notes-9)
- https://ollama.com/library/gpt-oss (notes-8)
- https://ollama.com/library/qwen3 (notes-8)
- https://docs.ollama.com/api/openai-compatibility (notes-8)
- https://docs.comfy.org/installation/comfyui_portable_windows (notes-2)
- https://docs.comfy.org/development/comfyui-server/api-examples (notes-8)
- https://comfyanonymous.github.io/ComfyUI_examples/qwen_image/ (notes-8)

Repo files the Lead read: hub/lib/tools.mjs, hub/lib/setup.mjs, hub/lib/permission-rules.mjs, board item D0078.

<!-- hub-generated: everything below this line is written by the hub from the event log -->

## Claims check

The Verifier's claims pass ran (verify/VERDICT.md has a claims or corrections section).

## Parked, as proposed next expeditions

1. A follow-up to run the 3-prompt image trial (UI mockup, icon, labelled diagram) on local Qwen-Image vs Google Nano Banana 2.1, plus a text sample test of gpt-oss:20b vs Claude Haiku 5.5 on real month summaries. (why parked: The brief is research only, with no keys and no installs, and the GPU runs are Matt's to do on his PC.). Launch pre-fills a brief from this line.
2. Check Recraft (SVG-native icon generation): official prices, terms and retention. (why parked: Only search snippets were found, the gatherer allowance ran out, and an SVG-native hosted tool could beat raster models for icons.). Launch pre-fills a brief from this line.
3. Build the hub model tools (ComfyUI and Ollama local tools; any hosted tool with a per-project gate in its handler) and the Windows protected-storage key store from decision 78. (why parked: The brief says no build. These belong to a Crux decision and a build brief after Matt picks.). Launch pre-fills a brief from this line.

## How it ran

Generated from the hub's event log (usage events and expedition events), not estimated. Stop reason: no-progress. Elapsed: 19 min.

| Role | Agents | Turns | Time at work | Tokens (in / out) | Cost |
|---|---|---|---|---|---|
| Lead (incl. gatherers) | 1 | 12 | 7 min | 6.49M / 144.4k | $3.50 |
| Advisor | 1 | 1 | 2 min | 234.8k / 9.0k | $1.22 |
| Synthesizer | 1 | 1 | 4 min | 606.1k / 26.3k | $1.40 |
| Skeptic | 1 | 1 | 2 min | 728.3k / 15.2k | $0.59 |
| Verifier | 1 | 3 | 6 min | 3.18M / 44.4k | $2.45 |
| unknown | 1 | 6 | 0 min | 32.9k / 1.2k | $0.05 |
| **Total** | | 24 | 20 min | 11.27M / 240.6k | $9.21 |

Gatherers run inside the Lead, so their time and cost are in the Lead's line and are not split out.

Build-verify loops: 1 (10 passing); 2 (11 passing); 3 (11 passing, no progress); 4 (11 passing, no progress). Decisions made on the user's behalf: 5. Parked: 3.

Spend figures here are the results' logged usage. While a turn runs, the hub's watchdog counts an upper-bound estimate that each result replaces (memo M046), so a limit may trip a little early, never late.
