# 0023 When you paste a screenshot into a thread, where is the image kept?

- Status: decided
- Date: 2026-11-11, decided 2026-11-11
- Lenses: data-model, ui
- Builds on: 0002, 0012
- Settles: chat image attachments storage = files under the project's .crux/attachments/, referenced by id from message events; never inline in the event log

## Decision

**A: Files next to the project's event log.** Images are saved under the project's .crux/attachments/; the message event points to the file. Agents receive the image itself. Screenshots agents post can share the same store.

## Context

Matt wants to paste or drop screenshots into hub threads, and copy screenshots agents post. The images have to be stored somewhere, and agents must receive them as real images. Builds on decision 2 (append-only event log).

## Options

### A: Files next to the project's event log (chosen) (recommended)

Images are saved under the project's .crux/attachments/; the message event points to the file. Agents receive the image itself. Screenshots agents post can share the same store.
- Pro: Keeps the event log lean
- Pro: Each project is self-contained
- Pro: .crux/ is already kept out of git
- Con: The folder grows; needs an occasional tidy
- Effort: Medium

### B: Inline in the event log

Images are stored as data inside the message events.
- Pro: Simplest
- Con: The append-only log keeps every image forever, growing heavy and slow to replay
- Effort: Small

### C: In the home folder, outside every project

Images go to ~/.crux-hub/attachments/.
- Pro: Confidential screenshots never sit in a project folder
- Con: The project's history depends on files kept elsewhere
- Effort: Medium

## Recommendation

A (lean). Keeps the log lean and the project self-contained, and .crux/ is already out of git.
