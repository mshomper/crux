// Append-only event log, one per project: <project>/.crux/events.jsonl
// Every message, summary, pick, board entry and agent change is an event.
// Threads and board entries are rebuilt from it (decision 0002).
//
// Decision 74 B: the live file holds the last two to four weeks; older events move to monthly archives and a snapshot
// (lib/archive.mjs). The log is still the source, split in time. `events` is what the hub works from: the snapshot's
// events, then the live file's. Nothing is ever deleted: the archive keeps every event as it was written.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEvents, rotate, isDue, readIndex, archivedPage, readSince, hasJournal } from './archive.mjs';

export class EventLog {
  // repair: false reads only (a test hub on a real folder, or CRUX_HUB_NO_ROTATE=1): nothing is finished, rewritten or deleted.
  constructor(projectDir, { repair = true } = {}) {
    this.dir = join(projectDir, '.crux');
    this.file = join(this.dir, 'events.jsonl');
    this.listeners = new Set();
    this.repair = repair;
    this.loads = 0;
    this.load();
  }

  // Reads the log from disk: finishes a rotation a crash cut short first, then the snapshot and the live file. `loads`
  // counts the reads: whoever keeps a position in `events` (the expedition watchdog) starts over when it changes.
  load() {
    const l = loadEvents(this.dir, { repair: this.repair });
    this.loads++;
    this.events = l.events;
    this.snapshotCount = l.snapshotCount;   // how many of `events` come from the snapshot (older than the live file)
    this.carried = l.carried;               // the unread and traffic counts of what the snapshot left out
  }

  append(type, data) {
    const ev = { id: randomUUID(), ts: new Date().toISOString(), type, ...data };
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file, JSON.stringify(ev) + '\n');
    this.events.push(ev);
    for (const fn of this.listeners) fn(ev);
    return ev;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  ofType(...types) { return this.events.filter(e => types.includes(e.type)); }

  // Moves what is older than about two weeks into the archive, when the live file has grown past about four. Returns
  // what it did, or null. Synchronous: no event is written meanwhile.
  rotateIfDue(now = Date.now()) { return isDue(this.dir, now) ? this.rotateNow({ now }) : null; }
  rotateNow(opts = {}) {
    const unfinished = hasJournal(this.dir);   // an earlier rotation that failed part-way is finished first (rotate does), so read again either way
    const r = rotate(this.dir, opts);
    if (r || unfinished) this.load();
    return r;
  }

  // Conversation events per thread that are in the archive: what "Show older" brings after the live log's. (The snapshot's
  // own conversation events are copies of archived ones and are never shown from memory.)
  archivedOlder() {
    const out = {};
    for (const m of Object.values(readIndex(this.dir).months)) for (const [t, n] of Object.entries(m.display || {})) out[t] = (out[t] || 0) + n;
    return out;
  }
  archivedPage(opts) { return archivedPage(this.dir, opts); }

  // Events from `sinceTs` on, archive included (an expedition's report reads its own span).
  eventsSince(sinceTs) { return readSince(this.dir, sinceTs); }
}
