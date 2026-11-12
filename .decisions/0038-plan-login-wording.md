# 0038 How should the public page present running the Hub on a Claude plan login?

- Status: decided
- Date: 2026-11-12, decided 2026-11-12
- Lenses: research
- Builds on: 0001, 0036

## Decision

**B: API key is the documented way.** The page and README tell strangers to run the Hub with their own Anthropic API key. Plan login stays in the code as Matt's personal setup and is not advertised. The API-key switch already exists.

## Context

The Hub runs its agents on the user's own Claude Code login and plan limits by default. Anthropic's Agent SDK documentation says third-party developers may not offer claude.ai login or plan limits in their products unless previously approved, and should use API keys instead (reported by the docs-audit worker from the SDK overview page; not yet re-checked by a second reader). The public page at crux.notarobot-eng.com will market the Hub to strangers, so how setup is worded matters before it is written.

## Options

### A: Ask Anthropic for approval

Write to Anthropic and ask for approval to offer plan login in the Hub. The page waits, or launches with option B's wording until an answer comes.
- Pro: The only route that makes plan login a fully supported, advertised way to run the Hub
- Pro: A clear answer either way
- Con: No known timeline or guarantee of an answer
- Con: Holds the Hub part of the page, or needs B's wording in the meantime anyway
- Effort: One email from Matt; unknown wait

### B: API key is the documented way (chosen) (recommended)

The page and README tell strangers to run the Hub with their own Anthropic API key. Plan login stays in the code as Matt's personal setup and is not advertised. The API-key switch already exists.
- Pro: Matches Anthropic's stated rule as written
- Pro: No waiting: the page can go ahead now
- Pro: Needs only wording, plus making the API key the easy path in setup
- Con: API use is paid per token, so the Hub is less attractive to people who already pay for a plan
- Con: The plan usage meters mean little to API-key users
- Con: The default in the code (plan login) and the documented way would differ unless the default is flipped later
- Effort: Wording only now; a small follow-up if the default should flip

### C: A personal tool you run yourself

The page describes the Hub as open-source software each person runs on their own machine with their own Claude Code login, the same as running Claude Code. Setup shows plan login first and the API key as the alternative.
- Pro: Most attractive to plan subscribers
- Pro: Describes how the Hub actually works today
- Con: Rests on Matt's reading that an open-source tool run locally is not 'offering' plan login; Anthropic may read it differently
- Con: Marketing it publicly makes that reading riskier
- Con: If Anthropic objects, the page and setup need rewriting
- Effort: Wording only

## Recommendation

B (lean). Document the API key as the way to run the Hub now, and send the approval request in parallel if plan login matters for marketing. It is the only wording that is safe today and it does not block the page. This is Claude's judgment, not legal advice.
