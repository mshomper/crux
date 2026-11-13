# 0048 Does the hub PC itself have to pair or log in?

- Status: decided
- Date: 2026-11-12, decided 2026-11-12
- Lenses: architecture
- Builds on: 0047
- Settles: local tool write authentication = the machine the tool runs on is trusted (no login, no pairing); remote devices pair once with a passkey and use it for big changes; a file in the tool folder turns the guard off

## Decision

**A: The PC is trusted; only remote devices pair.** Requests from the PC's own browser need no device cookie and no step-up. The phone pairs once and uses Face ID for big changes. Off switch in the hub folder.

Reason: Matt: "My main PC is where I operate from, I shouldn't have to log in from here." and "There needs to be some reasonableness to device security, since my PC is password protected and at my house."

## Context

Decision 47 B made every device pair with a passkey and use Windows Hello or Face ID for big changes. Its first rollout locked Matt out of his own PC. Matt's call: his main PC is password-protected and at his house, he operates from it, and it shouldn't need a login. A local Claude Code session could reach the repo and the hub anyway, so guarding against local agents isn't worth the friction. Amends decision 47: pairing and Face ID stay for remote devices (the phone over Tailscale). The PC's own browser is trusted. An off switch (a guard-off file in the hub folder, or CRUX_HUB_GUARD=off) turns the whole guard off.

## Options

### A: The PC is trusted; only remote devices pair (chosen) (recommended)

Requests from the PC's own browser need no device cookie and no step-up. The phone pairs once and uses Face ID for big changes. Off switch in the hub folder.
- Pro: No login on the machine Matt works from
- Pro: The phone, which leaves the house, stays protected
- Con: A local script can act as Matt again, as before decision 47; Matt accepts that
- Effort: Small

### B: Keep decision 47 as built

Every device pairs, the PC included.
- Pro: Covers local scripts
- Con: Locked Matt out on rollout; friction on his main machine
- Effort: None

## Recommendation

A (strong). Matt's direct instruction.
