# 0081 How do you add keys for several outside providers, and choose a model for each kind of job?

- Status: decided
- Date: 2026-11-17, decided 2026-11-18
- Lenses: architecture, UI
- Builds on: 0044, 0078, 0080
- Settles: outside model routing = the hub picks provider and model per job type (short question, long draft, picture), set by the human in hub settings; agents never choose; keys entered in hub settings, DPAPI-protected per user, page sees the last four only

## In short

Should the hub's settings panel take a key for each outside provider, and let you pick which provider and model answers each kind of job (short questions, long drafts, pictures)? I recommend it: you set it once, agents still just ask for a draft or a picture, and the hub picks the model.

For you:

- The Whole hub panel gets a key box per provider (Google, OpenAI, OpenRouter; Ollama needs none), like the Claude key box on the Account card
- Under it, one line per job type: short questions, long drafts, pictures, each with its provider and model
- Agents never choose a provider, model or address; the per-project switch and the spending caps stay as they are
- Setup: Later, at your PC: paste your OpenRouter key into its box once

## Decision

**A: Key per provider, model per job type.** Key boxes for each provider in the Whole hub panel (saved protected, page sees the last four only), plus a provider and model chosen for each job type: short questions, long drafts, pictures. The live-check script stays as a test tool.

## Context

Matt (2026-11-17), after the first live picture test (Google, nano-banana 2.1, about $0.045): he wants a way to enter more than one provider's key, and picked per-job routing (option B in chat) to build in from the start. He has just opened an OpenRouter account. Today (decision 80, PR #145 merged): one provider and model answer for the whole hub, and a key can be saved only by running the live-check script in PowerShell, so the hub panel shows Google as the provider even before anything is saved. Typing a key into the page has precedent: the Account card already takes the Anthropic API key (decision 78), kept with the same Windows per-user protection. OpenRouter alone reaches hundreds of models (Mistral, DeepSeek, Grok, Llama, Qwen and others), so direct boxes for those providers can wait; each one that speaks the same request format needs only its address and prices. Pictures through OpenRouter are untested; only Google is tested live.

## Options

### A: Key per provider, model per job type (chosen) (recommended)

Key boxes for each provider in the Whole hub panel (saved protected, page sees the last four only), plus a provider and model chosen for each job type: short questions, long drafts, pictures. The live-check script stays as a test tool.
- Pro: Cheapest suitable model for each job, set once
- Pro: No PowerShell step to add a key
- Pro: Agents' tools and the caps don't change
- Con: A few more settings on the panel
- Con: Keys now typed into the page, so the save path needs a careful review
- Effort: Medium (one implementer, then a deep review of the key handling)

### B: Key per provider, still one provider at a time

Key boxes for each provider in the panel, but one provider and model still answer every job; you switch by hand.
- Pro: Smaller change
- Con: Switching to OpenRouter for text would drop Google for pictures
- Con: Per-job choice would have to be added later anyway
- Effort: Small

### C: Per-job choice, keys still by script

Add the per-job provider and model lines, but keys keep being saved only with the PowerShell live-check script.
- Pro: Keys never pass through the page
- Con: A PowerShell step for every new key, and not from the phone
- Effort: Small to medium

## Recommendation

A (high). A: key boxes per provider and a provider and model per job type, with the panel showing plainly when a key or a choice isn't saved yet.

What would change this: If keys in the page feel like too much exposure, take C and keep adding keys with the script.
