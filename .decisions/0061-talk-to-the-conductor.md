# 0061 How do you talk to the Conductor by voice?

- Status: decided
- Date: 2026-11-14, decided 2026-11-14
- Lenses: architecture, research and product
- Builds on: 0018, 0019, 0048, 0055, 0060
- Settles: voice conversation with agents = tap to talk; local Python helper on 127.0.0.1 with Parakeet TDT 0.6B v3 (onnx-asr) for listening and Phonon 31M (voice Imogen) for speaking; transcript sent at once as the human's message; the agent writes a 1-3 sentence spoken summary; mic closed while the voice plays; audio never stored

## In short

Pick how voice works with the Conductor. I recommend A: tap the mic, talk, tap again; your words go in at once as your message, and Imogen reads the Conductor's short spoken summary back; everything runs on your PC in one small helper. Confidence: medium.

For you:

- Tap to talk on the phone or PC; your words appear as your message with a mic mark (fix it after if misheard); a tap anywhere stops the voice
- The Conductor starts each reply with a 1 to 3 sentence spoken summary; the full reply stays on screen; about 3 to 9 seconds from when you stop talking, most of it the Conductor thinking
- Nothing leaves your PC; audio is never stored; the voice switch is off until you turn it on
- Setup: One-time install of a small Python helper (speech recognition plus the Phonon voice, about 1 GB of models), one step for you; strangers get it as an optional download
- Hard to undo: Adds a helper process next to the hub (a new dependency); switching voice off stops it, and removing it is deleting one folder

## Decision

**A: Tap to talk, all local.** Tap the mic, talk, tap again. The clip goes to the hub and on to a local Python helper (Parakeet speech recognition plus Phonon) on 127.0.0.1. Your words go into the Conductor chat at once as your message with a mic mark. The Conductor writes a 1-3 sentence spoken summary at the top of its reply while voice is on; Imogen reads it sentence by sentence. The mic is closed while she speaks; a tap stops her.

## Context

Matt wants to talk to the Conductor, not just hear it. Speaking is picked: Phonon 31M, voice Imogen, local on the CPU, about 55-150 ms to first audio (memo M036). voice-research (memo M037, with sources) looked at the listening half. Best practical local speech recognition: Parakeet TDT 0.6B v3 through onnx-asr (about 6.2% word errors against 7.6-7.8% for Whisper turbo; about 36x real time on a desktop CPU, so it leaves the GPU free for CUDA work; MIT code, CC-BY-4.0 model needing a credit line; no hint list for project names, so the hub snaps near-misses to known names). faster-whisper turbo on the GPU is the alternative with a hint list, at the cost of about 1 GB of CUDA libraries. iPhone: the mic works over Tailscale https; the home-screen app asks for it each launch; an open WebKit bug (326286) makes playback crackle or drop to the earpiece while the mic is open, so the mic must close while the voice plays, which tap-to-talk does naturally. The browser's own speech recognition sends audio to Apple, Google or Microsoft and isn't available in the iPhone home-screen app. The hub has no WebSocket server; one upload per clip is enough. A 10-command bake-off on Matt's PC and iPhone (Parakeet against Whisper on project names and numbers, plus the mic closing and reopening on iOS) comes before the build.

## Options

### A: Tap to talk, all local (chosen) (recommended)

Tap the mic, talk, tap again. The clip goes to the hub and on to a local Python helper (Parakeet speech recognition plus Phonon) on 127.0.0.1. Your words go into the Conductor chat at once as your message with a mic mark. The Conductor writes a 1-3 sentence spoken summary at the top of its reply while voice is on; Imogen reads it sentence by sentence. The mic is closed while she speaks; a tap stops her.
- Pro: Private and free; works around the iPhone mic bug by design
- Pro: One helper for listening and speaking; GPU left free
- Con: A tap at the start and end of each thing you say
- Con: Project names can be misheard (snapped to known names, fixable after)
- Effort: Medium to large: the helper, an upload route, the summary line, the mic and voice controls on the page

### B: Hands-free, all local

As A, but the mic listens and notices when you stop talking (voice detection), so no taps. It still closes while Imogen speaks, so you can't talk over her on the phone speaker.
- Pro: Feels more like a conversation
- Con: Picks up background talk; can cut you off mid-thought
- Con: Can't interrupt by voice on the iPhone speaker (the bug), so it still needs a tap to stop her
- Effort: A plus voice detection and tuning; best as a later switch on A

### C: Browser speech recognition

Use the browser's built-in speech recognition for listening and keep Phonon for speaking.
- Pro: No speech model to install
- Con: Audio goes to Apple, Google or Microsoft
- Con: Not available in the iPhone home-screen app at all
- Effort: Small, but saves little since speaking needs the helper anyway

## Recommendation

A (lean). A keeps everything on your PC, gives you one place to talk and listen, and fits how the iPhone mic behaves today. Hands-free can come later as a switch once A feels right.

What would change this: If the bake-off shows Parakeet mishears project names too often, use faster-whisper on the GPU with a name list; if taps feel clumsy in use, add B's hands-free switch.
