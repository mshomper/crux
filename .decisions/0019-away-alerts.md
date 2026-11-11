# 0019 How does the hub get your attention, and take quick answers, when you are away?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: architecture, ui
- Builds on: 0018
- Settles: phone notifications from local tools = web push from the tool itself to its home-screen app; card contents never pass through a third-party chat service

## Decision

**A: Notifications from the hub itself.** The hub page, added to the phone's home screen, sends its own notifications. Tapping one opens that card in the hub. Nothing passes through a chat company. On iPhone the page has to be added to the home screen first.

## Context

Reaching the hub is half of it; the other half is knowing when it needs you. A card waiting for an Allow, a decision ready to pick, or a question from an agent should reach you within a minute, and simple answers (Allow, Deny, "all", "4A") should take one tap or a short reply. Some projects hold confidential work, so where card contents travel matters.

## Options

### A: Notifications from the hub itself (chosen) (recommended)

The hub page, added to the phone's home screen, sends its own notifications. Tapping one opens that card in the hub. Nothing passes through a chat company. On iPhone the page has to be added to the home screen first.
- Pro: Card contents stay between your PC and your phone
- Pro: Tapping lands on the real card with all its context
- Pro: No accounts or bots to run
- Con: Needs decision 18 A (or B) for the secure address
- Con: Answers happen in the hub page, not as a chat reply
- Effort: Medium

### B: Slack

A Slack app posts each card to a private channel with Allow, Deny and Take buttons; a reply like "4A" in the thread picks. Slack's socket mode means the hub needs no public address.
- Pro: Buttons and threads suit cards well
- Pro: Works without decision 18
- Pro: You may already have Slack open all day
- Con: Card contents (commands, file names, questions) are stored on Slack's servers
- Con: A Slack app to create and keep
- Con: Confidential projects would have to be kept off it
- Effort: Medium

### C: Telegram

A Telegram bot sends cards with tap buttons and takes short replies. The bot polls, so no public address either.
- Pro: The quickest bot to set up
- Pro: Good buttons, works on any phone
- Con: Contents stored by Telegram
- Con: One more chat app if you do not use it already
- Con: Confidential projects kept off it
- Effort: Small to medium

### D: WhatsApp

Cards arrive as WhatsApp messages with reply buttons, through Meta's business messaging platform.
- Pro: The app you probably check most
- Con: Needs a Meta business account and a separate phone number
- Con: Replies need a public address for Meta to call
- Con: Message rules and possible per-message charges
- Con: Contents pass through Meta
- Effort: Large

## Recommendation

A (lean). With decision 18 A in place, the hub's own notifications reach you without any card leaving your devices, which matters for confidential projects. Slack can be added later as an extra channel for projects that are safe to post, if one-tap replies in chat turn out to matter.
