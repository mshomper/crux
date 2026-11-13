# 0053 How should the Windows installer be signed?

- Status: open
- Date: 2026-11-13
- Lenses: architecture
- Builds on: 0052
- Settles: Windows code signing = Microsoft Artifact Signing (individual), wired into the Tauri release build

## In short

Pick how the installer gets signed so Windows stops saying 'Unknown publisher'. I recommend A: Microsoft's Artifact Signing at $9.99 a month, if you sign up as an individual in the US or Canada. Confidence: medium.

For you:

- The warning shows your name instead of 'Unknown publisher'; it still appears for a few weeks until Windows trusts the app
- Setup: You sign up for an Azure subscription and an ID check (one evening); an agent wires it into the release build
- Hard to undo: A monthly charge you can cancel any time; unsigned releases keep working

## Context

Release v0.1.0 is unsigned, so Windows shows 'Windows protected your PC' with More info, Run anyway. install-research (memo M030): no certificate removes that warning on day one; every signed app still warns until it builds reputation ('several weeks and hundreds of clean installs', Microsoft). Only a Microsoft Store MSIX avoids it at once. EV certificates stopped skipping the warning in August 2024. A Microsoft Store individual developer account is free since 2025, but Tauri makes EXE/MSI, the Store's EXE route still needs a paid certificate, and the free MSIX route for Tauri is experimental. Prices as found on 2026-11-13.

## Options

### A: Microsoft Artifact Signing (recommended)

Microsoft's cloud signing service, $9.99 a month, no hardware token, plugs into Tauri's sign command. Open to individuals in the USA and Canada only (organizations also EU and UK).
- Pro: Cheapest real signing, about $120 a year
- Pro: No USB token; signs from the build on your PC
- Con: Individuals only in the US or Canada; needs a paid Azure subscription and ID check
- Effort: Small: sign-up, then a sign command in the release build

### B: OV certificate

A standard code-signing certificate from a seller such as Sectigo, about $150-300 a year, key on a USB token or cloud HSM, renewed at most every 460 days.
- Pro: Works from any country
- Con: About twice the price, plus a token to manage
- Effort: Small to medium

### C: Stay unsigned for now

Keep releasing unsigned; the docs tell users to choose More info, Run anyway. Try a free Microsoft Store listing later.
- Pro: Free
- Con: 'Unknown publisher' looks untrustworthy to strangers
- Effort: None

## Recommendation

A (lean). A is the cheapest signing that shows your name, and with no token it fits the build on your PC. Skip EV: it no longer buys anything.

What would change this: If you can't register as a US or Canadian individual, B; if the app stays mostly for you for now, C.
