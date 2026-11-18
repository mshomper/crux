# 0080 Should the hub hand basic tasks to outside model providers?

- Status: decided
- Date: 2026-11-17, decided 2026-11-17
- Lenses: architecture, research and product
- Builds on: 0036, 0044, 0069, 0074, 0078
- Settles: outside model providers = only the hub calls outside or local models, through one provider layer on built-in fetch; per-project setting off (default), local or any; agents get only a short-question tool; keys DPAPI-protected per user outside any project; every call logs model and cost; plain failure, no silent fallback to Claude

## In short

Should the hub keep the expedition's prototype, so a project can send basic jobs (month summaries now, a short-answer tool for agents) to an outside or local model, off by default? I recommend it after a review: Claude stays the brain, and it takes load off your plan, with the live call already working.

For you:

- Each project gets an outside-model setting: off (default), local only, or any provider
- Agents can ask an outside model a short question; only the hub ever talks to the provider
- Every outside call logs which model answered and what it cost, with a cap of 30 calls an hour and $0.50 a day per project
- Setup: Your Google key is already saved, protected for your Windows user, from the live check

## Decision

**A: Keep the prototype, off by default.** Review and merge PR #143 as built: the provider layer, month summaries on an outside model, the ask_outside_model tool, the per-project setting (off, local, any), usage lines and the per-project caps.

Reason: Matt in chat: "Yes, the Hub should provide a way to hand outside tasks to other model providers." The month summary is not a useful first job yet; test image generation and report writing on his Google AI Studio key instead.

## Context

Matt (2026-11-17): Claude stays the general brain of Crux, but basic tasks should go to other providers where it makes sense, mainly to keep usage inside his plan limits. Expedition 20261117 (draft PR #143) built a prototype: one provider layer (OpenAI, Google's compatible endpoint, OpenRouter, local Ollama, plus an image call) on Node's built-in fetch with no new package; month summaries per project on an outside provider; an ask_outside_model tool for agents; provider keys DPAPI-protected in ~/.crux-hub/provider-keys.json, with the page seeing the last 4 only; a usage line for every outside call; plain failures with no fallback to Claude; a free-VRAM guard and an Ollama unload after each job (his RTX 4070 Ti Super has 16 GB, shared with training). Tests: 27 of 27 against a local mock. Matt's live call: google gemini-3.5-flash-lite, 16+7 tokens, $0.000022, 928 ms, ok. Finding: Haiku on an API key is already among the cheapest routes, so offloading pays mainly as plan relief when the hub runs on plan sign-in, for images, and for privacy with a local model. No route has quality evidence yet.

## Options

### A: Keep the prototype, off by default (chosen) (recommended)

Review and merge PR #143 as built: the provider layer, month summaries on an outside model, the ask_outside_model tool, the per-project setting (off, local, any), usage lines and the per-project caps.
- Pro: Takes basic work off the Claude plan where a project allows it
- Pro: Already working live; no new package
- Con: No quality evidence yet for summaries from cheap models
- Con: Another place keys live, and outside data terms to watch per project
- Effort: Small (review and fixes)

### B: Keep the layer, no agent tool yet

Merge only the hub-side part (provider layer and month summaries), and leave the agent tool until a project needs it.
- Pro: Smaller surface: agents can't send anything out
- Con: Little plan relief: month summaries are near zero volume until about May 2027
- Effort: Small

### C: Park it

Keep the report and close the PR; revisit when plan limits bite or images are needed.
- Pro: Nothing new to maintain
- Con: No relief for plan limits
- Effort: None

## Recommendation

A (medium). A: review and merge the prototype with every project off by default, then turn it on per project where basic jobs add up.

What would change this: If cheap-model summaries read badly in a first trial, keep the layer for images and privacy (B) and leave text on Claude.
