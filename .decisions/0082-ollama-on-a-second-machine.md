# 0082 May the hub call a local model running on your second PC over Tailscale?

- Status: decided
- Date: 2026-11-17, decided 2026-11-18
- Lenses: architecture
- Builds on: 0018, 0080, 0081
- Settles: local model address = the hub's Ollama route may use this PC or the human's own machines on the private Tailscale network (100.x or *.ts.net), counted as local; no other address

## In short

Should the hub be allowed to send jobs to Ollama on your second PC over your private Tailscale network, and treat it like a model on this PC? I recommend it: it's your own machine on a private network, so small text jobs stay free and in your hands while your main GPU stays free for training.

For you:

- The Whole hub panel gets an address box for Ollama: this PC (as now) or one of your own machines on Tailscale
- Projects set to Local can use the second PC, the same as a model on this PC; nothing goes to a cloud provider
- The hub's check for free GPU memory only works on this PC, so it is skipped for the second box (nothing trains there)
- Setup: On the second PC: install Ollama, pull one model, and let it answer on its Tailscale address (about five steps; the worker writes them out)

## Decision

**A: Allow your Tailscale machines, count as local.** The Ollama address may be this PC or an address on your Tailscale network (a 100.x address or a name ending .ts.net); nothing else. Jobs sent there count as Local. The free-memory guard and model unload run only for this PC.

## Context

Matt (2026-11-17) wants local text jobs on his second PC: Ryzen 5 5600T, 32 GB RAM, AMD RX 9070 with 16 GB. Recent Ollama supports RDNA4 Radeon cards on Windows (newer cards may need the latest driver or the slower Vulkan mode; check at setup). 16 GB runs open models of about 12-20B parameters (gpt-oss-20b, Gemma, Qwen-class) for labels, rewording, transcript tidying and plain drafts. Today (decision 80) the Ollama preset accepts only this PC's loopback address, and the Local mode is defined as models on this PC; the expedition report noted a second box on Tailscale as not supported. The hub already reaches Matt's phone over Tailscale (decision 18, M002). Matt also set (R015) that outside providers are for cheap grunt work only, with local Ollama the free route. The main PC's RTX 4070 Ti Super (16 GB) is shared with training, so moving local jobs off it helps.

## Options

### A: Allow your Tailscale machines, count as local (chosen) (recommended)

The Ollama address may be this PC or an address on your Tailscale network (a 100.x address or a name ending .ts.net); nothing else. Jobs sent there count as Local. The free-memory guard and model unload run only for this PC.
- Pro: Free small text jobs without using the main GPU
- Pro: Stays on your own machines and private network
- Pro: Small change: the address check and one panel box
- Con: Local now means 'my machines', not 'this PC'
- Con: The second PC must be on and awake, or jobs fail plainly
- Effort: Small (one implementer, then a reviewer)

### B: Allow it, but count as an outside provider

Same address rule, but the second PC counts like a cloud provider, so only projects set to Any can use it.
- Pro: Local keeps meaning this PC only
- Con: Projects kept on Local for privacy (life, employer work) can't use your own second PC
- Effort: Small

### C: Keep this PC only

No change; run Ollama on the main PC when needed.
- Pro: Nothing new
- Con: Local jobs compete with training for the main GPU
- Effort: None

## Recommendation

A (medium). A: allow Ollama on your own Tailscale machines and treat it as local, so the second PC takes small text jobs for free.

What would change this: If the RX 9070 won't run Ollama well at setup, park this and keep this PC only.
