# 0018 How does your phone reach the hub when you are away from your desk?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture
- Builds on: 0004
- Settles: remote access to local tools = private Tailscale network (tailscale serve gives an https address only your devices can open); nothing exposed on the public internet

## Decision

**A: Private network for your devices.** Install Tailscale on the PC and the phone. The hub gets an https address that only your own signed-in devices can open; nothing is reachable from the open internet. On the phone it is the same hub page, added to the home screen like an app.

## Context

The hub runs on your PC and only answers on that PC (localhost). Away from your desk you cannot see cards or answer them, so agents stall on permission prompts and decisions. Whatever opens it up must keep everyone else out: the hub can run commands on your machine through its agents.

## Options

### A: Private network for your devices (chosen) (recommended)

Install Tailscale on the PC and the phone. The hub gets an https address that only your own signed-in devices can open; nothing is reachable from the open internet. On the phone it is the same hub page, added to the home screen like an app.
- Pro: Nothing exposed to the internet at all
- Pro: Full hub on the phone: cards, threads, board, live map
- Pro: Free for personal use; no domain or server to run
- Pro: Gives the https the phone needs for notifications
- Con: One more app on the PC and the phone
- Con: Works only on devices you have signed in
- Con: The PC has to be on and awake
- Effort: Small: install two apps, one command, plus a short hub change to trust the address

### B: Public address behind a sign-in

A Cloudflare tunnel publishes the hub at a subdomain of a domain you own, with Cloudflare Access asking for a one-time email code before anything loads.
- Pro: Opens from any browser, even one you have never used
- Pro: No app on the phone
- Con: The hub sits on the open internet; safety rests on the sign-in gate
- Con: Needs the domain's DNS moved to Cloudflare
- Con: More to set up and to keep right
- Effort: Medium

### C: No remote page: chat only

Keep the hub on the PC only. Away from your desk, everything comes and goes through a chat app (decision 19 picks which).
- Pro: Nothing on the PC is opened up
- Pro: Works in an app you already check
- Con: Only what fits in a chat message: no board, no live map, no full decision pages
- Con: Every card's contents pass through the chat company's servers
- Effort: Medium (it is all in decision 19)

## Recommendation

A (strong). It gives you the whole hub on the phone without putting anything on the internet, and it is the least to set up. It also provides the secure address that phone notifications (decision 19) need.
