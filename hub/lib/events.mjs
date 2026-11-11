// Append-only event log, one per project: <project>/.crux/events.jsonl
// Every message, summary, pick, board entry and agent change is an event.
// Threads and board entries are rebuilt from it (decision 0002).
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class EventLog {
  constructor(projectDir) {
    this.dir = join(projectDir, '.crux');
    this.file = join(this.dir, 'events.jsonl');
    this.events = [];
    this.listeners = new Set();
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.events.push(JSON.parse(line)); } catch { /* skip a torn last line */ }
      }
    }
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
}
