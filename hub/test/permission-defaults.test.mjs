// A project in Auto with no permission rules entry (f13ld.lab): unclear requests still go to its orchestrator, under the
// hub's built-in default rules, and the orchestrator is asked once to draft an entry for Matt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { DEFAULT_RULES_ID } from '../lib/permission-rules.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () {};

function setup({ auto = true, entry = false } = {}) {
  sent.length = 0;
  const root = mkdtempSync(join(tmpdir(), 'crux-defaults-'));
  const dir = join(root, 'lab');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  if (auto) writeFileSync(join(dir, '.crux-hub.json'), '{ "permissions": "auto" }');
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }) });
  const p = hub.project('lab');
  if (entry) p.board.addEntry({ kind: 'requirement', title: 'Agent permission rules (lab)', summary: 's', body: 'LAB RULES', from: 'you' });
  const orch = hub.ensureOrchestrator(p);
  orch.q = {};   // running
  const w = hub.startWorker(p, 'tidy', 'Tidy the lab', 'you', 'Tidy the lab');
  sent.length = 0;
  return { hub, p, orch, w, dir };
}
const last = (p, type) => p.log.ofType(type).at(-1);

test('Auto with no rules entry: unclear requests go to the orchestrator under the built-in defaults', () => {
  const { hub, p, orch, w, dir } = setup();
  hub.requestApproval(p, w, 'Bash', { command: 'mytool --sync' });
  const ap = last(p, 'approval');
  assert.equal(ap.routedTo, orch.name, 'routed, not a card for Matt');
  assert.equal(ap.rules, DEFAULT_RULES_ID);
  const msg = sent.at(-1)[1];
  assert.match(msg, /no permission rules entry, so you are working from the hub's built-in defaults/);
  const prompt = orch.options().systemPrompt.append;
  assert.match(prompt, /built-in defaults/);
  assert.ok(prompt.includes(dir), 'the defaults name this project\'s own folder');
  assert.match(prompt, /HARD STOPS, always to the user:/, 'no profile here, so no name');
  assert.match(prompt, /draft a rules entry/);
});

test('a real rules entry wins over the defaults', () => {
  const { hub, p, orch, w } = setup({ entry: true });
  hub.requestApproval(p, w, 'Bash', { command: 'mytool --sync' });
  assert.equal(last(p, 'approval').rules, 'R001');
  assert.ok(orch.options().systemPrompt.append.includes('LAB RULES'));
  assert.doesNotMatch(orch.options().systemPrompt.append, /built-in defaults/);
});

test('Ask mode with no rules entry: as before, the card comes to Matt', () => {
  const { hub, p, w } = setup({ auto: false });
  hub.requestApproval(p, w, 'Bash', { command: 'mytool --sync' });
  assert.equal(last(p, 'approval').routedTo, null);
  assert.equal(sent.length, 0);
});

test('switching to Auto with no rules entry posts one notice asking the orchestrator to draft one', async () => {
  const { hub, p } = setup({ auto: false });
  const hints = () => p.log.ofType('notice').filter(n => n.thread === 'orchestrator' && /no permission rules entry/.test(n.text));
  await new Promise(r => setTimeout(r, 5));
  assert.equal(hints().length, 0, 'not in Ask mode');
  hub.setPermissionMode(p, 'auto');
  assert.equal(hints().length, 1);
  assert.match(hints()[0].text, /draft a rules entry/);
  hub.setPermissionMode(p, 'standard');
  hub.setPermissionMode(p, 'auto');
  assert.equal(hints().length, 1, 'only once');
});

test('a project already in Auto at start-up gets the hint once; one with an entry never does', async () => {
  const a = setup();
  await new Promise(r => setTimeout(r, 5));
  assert.equal(a.p.log.ofType('rules_hint').length, 1);
  const b = setup({ entry: true });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(b.p.log.ofType('rules_hint').length, 0);
});
