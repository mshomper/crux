# 0039 How do two or three threads stay open at once in the main window?

- Status: open
- Date: 2026-11-12
- Lenses: ui
- Builds on: 0012, 0031, 0033

## Context

The main window shows one conversation at a time (decision 12). On a wide screen most of the width is blank, and Matt wants to pin threads so two or three are open together, for example talking to the orchestrator while watching a worker. The pin-mockups worker drew both layouts on the real hub page with demo content, at 3170 and 1440 wide, with two and three threads open (stills posted in the hub). The phone layout stays one thread at a time in both.

## Options

### A: Split columns (recommended)

Pinning a thread opens it as a full column beside the current one, each with its own header and message box. Up to three columns share the width evenly. A cyan top line marks the column that has the keyboard; a red count in a column header means a card waits there. When more are pinned than fit, the extra one folds to a slim rail on the right and opens with one click.
- Pro: Fills the wide screen: three readable columns of about 965 px at 3170 wide
- Pro: Every column is the same full conversation, so nothing new to learn
- Pro: Less to build than B: one conversation part that can exist several times, then a simple layout
- Con: On a laptop only two columns fit, and one with the board open
- Con: Column headers get tight at laptop width: buttons become icons with hover labels and the task line drops out
- Con: Medium to large change: about a third of the page code assumes one open thread
- Effort: Medium to large (worker's estimate)

### B: Main thread plus watch panes

The main conversation keeps the centre. Pinned threads sit as narrower panes on the right showing the latest messages, the working line, any red card with its buttons, and a one-line reply box. A button in the pane header swaps it into the main spot. On a laptop the panes stack.
- Pro: One conversation clearly stays the main one
- Pro: Panes are compact, so three fit on a laptop by stacking
- Con: On the wide screen most of the main area is still blank, which is the problem to solve
- Con: Two ways of drawing a conversation (full and compact) to build and keep in step
- Con: More to build than A: the same groundwork plus the compact view, the swap and the stacking rules
- Effort: Large: A's groundwork plus more (worker's estimate)

## Recommendation

A (strong). Split columns. It is the one that fills the blank width, each column is the conversation Matt already knows, and B needs everything A needs plus more. With A, the defaults proposed are: the extra pinned thread folds to a slim rail when it does not fit; Needs you can be pinned like any thread; clicking an unpinned thread in the list replaces the column that has the keyboard. Claude's judgment, based on the mock-ups and the worker's reading of the page code.
