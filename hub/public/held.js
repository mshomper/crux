// A thread's older conversation the page fetched ("Show older") or had from the stream stays across a fresh state: the hub
// sends each thread's newest events, and a refresh must not take away what you were reading. Pure, so a test runs it.
import { DISPLAY, threadOf } from './feed-rules.js';

// before: the projects the page held; after: the projects just read; held: project name -> (event id -> event), kept
// by the caller. Puts back the held events that are not in the new window, per thread, only where they join up with it
// (some held event of the thread is in the new window too). A page that was away long enough for the window to move
// past what it held would otherwise show a gap that "Show older" could never fill: that thread's held events are dropped.
export function keepHeld(before, after, held) {
  for (const p of before) {
    const m = held.get(p.name) || new Map();
    for (const e of p.events) if (DISPLAY.has(e.type)) m.set(e.id, e);
    held.set(p.name, m);
  }
  for (const p of after) {
    const m = held.get(p.name), have = new Set(p.events.map(e => e.id)), threads = new Map(p.agents.map(a => [a.name, a.thread]));
    p.older ||= {};
    if (!m) continue;
    const byThread = new Map();
    for (const e of m.values()) { const t = threadOf(e, threads); if (!byThread.has(t)) byThread.set(t, []); byThread.get(t).push(e); }
    const extra = [];
    for (const [t, list] of byThread) {
      const joins = list.some(e => have.has(e.id));
      const out = list.filter(e => !have.has(e.id));
      if (!joins) { for (const e of out) m.delete(e.id); continue; }
      for (const e of out) { extra.push(e); if (p.older[t]) p.older[t]--; }
    }
    if (extra.length) p.events = [...p.events, ...extra].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }
}
