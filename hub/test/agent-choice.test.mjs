// Decision 20: agent types, per-agent model and effort, and changing them. Agents are stubbed; type files
// live in a temp folder that stands in for the home folder, never the real ~/.claude/agents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { AgentTypes, parseAgentFile, parseFrontmatter, modelId, modelLabel } from '../lib/agent-types.mjs';
import { cruxToolNames, settingsChanges } from '../lib/tools.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () { this.closed = (this.closed || 0) + 1; this.q = null; };

function setup({ homeTypes = {}, projectTypes = {}, defaults = {} } = {}) {
  const root = makeTmp('crux-hub-types-');
  const home = join(root, 'home'), dir = join(root, 'proj');
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(dir, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(dir, '.crux'), { recursive: true });
  for (const [f, s] of Object.entries(homeTypes)) writeFileSync(join(home, '.claude', 'agents', f), s);
  for (const [f, s] of Object.entries(projectTypes)) writeFileSync(join(dir, '.claude', 'agents', f), s);
  const make = () => new Hub({ projects: [dir], memory: new Memory(join(root, 'crux')), agentHome: home, defaults });
  const hub = make();
  return { hub, p: hub.project('proj'), root, home, dir, make };
}

const REVIEWER = `---
name: reviewer
description: Reviews a change for bugs before Matt click-tests it
model: sonnet
effort: medium
tools: Read, Grep, Glob, Bash
color: purple
---
Read the whole change before judging it.
Report findings in plain words.
`;

test('agent files: frontmatter, short model names, tools and unknown fields', () => {
  const t = parseAgentFile(REVIEWER, 'reviewer.md');
  assert.equal(t.name, 'reviewer');
  assert.equal(t.model, 'claude-sonnet-5-5');
  assert.equal(t.effort, 'medium');
  assert.deepEqual(t.tools, ['Read', 'Grep', 'Glob', 'Bash']);
  assert.match(t.prompt, /^Read the whole change/);
  assert.ok(!('color' in t), 'unknown fields are ignored');

  const folded = parseFrontmatter(`---\r\nname: "quick-fix"\r\ndescription: >\r\n  Small, scoped fixes:\r\n  one file or two.\r\ntools:\r\n  - Read\r\n  - Edit\r\nmodel: inherit # use the default\r\n---\r\nBody`);
  assert.equal(folded.data.name, 'quick-fix');
  assert.equal(folded.data.description, 'Small, scoped fixes: one file or two.');
  assert.deepEqual(folded.data.tools, ['Read', 'Edit']);
  assert.equal(folded.body, 'Body');
  const qf = parseAgentFile(`---\nname: quick-fix\nmodel: inherit\neffort: turbo\ntools: [Read, "Edit"]\n---\n`, 'x.md');
  assert.equal(qf.model, null, 'inherit means the default model');
  assert.equal(qf.effort, null, 'an effort level that does not exist is dropped');
  assert.deepEqual(qf.tools, ['Read', 'Edit']);
  assert.equal(parseAgentFile('No frontmatter at all', 'researcher.md').name, 'researcher', 'name falls back to the file name');

  assert.equal(modelId('fable'), 'claude-fable-5-2');
  assert.equal(modelId('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(modelLabel('claude-haiku-5-5'), 'Haiku 5.5');
  assert.equal(modelLabel('claude-opus-4-8'), 'Opus 4.8');
  assert.equal(modelLabel('claude-sonnet-5-5[1m]'), 'Sonnet 5.5');
});

test('a project type wins over a home type with the same name', () => {
  const { home, dir } = setup({
    homeTypes: { 'reviewer.md': REVIEWER, 'researcher.md': '---\nname: researcher\nmodel: opus\neffort: high\n---\nDig.' },
    projectTypes: { 'my-reviewer.md': '---\nname: Reviewer\nmodel: haiku\n---\nProject rules.' }
  });
  const types = new AgentTypes({ home, projectDir: dir });
  assert.deepEqual(types.list().map(t => [t.name, t.source]), [['researcher', 'home'], ['Reviewer', 'project']]);
  assert.equal(types.get('reviewer').model, 'claude-haiku-5-5');
  assert.equal(new AgentTypes({ home }).get('reviewer').model, 'claude-sonnet-5-5', 'other projects still get the home type');
});

test('start_worker with a type: model, effort, tools and instructions come from the type; picks override', () => {
  const { hub, p } = setup({ homeTypes: { 'reviewer.md': REVIEWER } });
  const w = hub.startWorker(p, 'rev', 'Review the branch', 'orchestrator-1', 'Review', { type: 'reviewer' });
  assert.deepEqual([w.type, w.model, w.effort], ['reviewer', 'claude-sonnet-5-5', 'medium']);
  const created = p.log.ofType('agent_created').at(-1);
  assert.deepEqual([created.agentType, created.model, created.effort], ['reviewer', 'claude-sonnet-5-5', 'medium']);
  const brief = p.log.ofType('message').at(-1);
  assert.deepEqual([brief.agentType, brief.model, brief.effort], ['reviewer', 'claude-sonnet-5-5', 'medium'], 'the brief shows what it runs as');

  const o = w.options();
  assert.equal(o.model, 'claude-sonnet-5-5');
  assert.equal(o.effort, 'medium');
  assert.deepEqual(o.tools, ['Read', 'Grep', 'Glob', 'Bash'], 'type tools limit the built-in tools');
  assert.ok(o.allowedTools.includes('mcp__crux__post_summary') && !o.allowedTools.includes('Bash'), 'type tools never skip permission cards');
  assert.match(o.systemPrompt.append, /AGENT TYPE: reviewer[\s\S]*Read the whole change before judging it/);

  const w2 = hub.startWorker(p, 'rev2', 'Review it harder', 'orchestrator-1', '', { type: 'reviewer', model: 'opus', effort: 'max' });
  assert.deepEqual([w2.model, w2.effort], ['claude-opus-5-5', 'max']);
  assert.throws(() => hub.startWorker(p, 'x', 'task', 'orchestrator-1', '', { type: 'nobody' }), /No agent type "nobody". Types: reviewer/);
  assert.throws(() => hub.startWorker(p, 'y', 'task', 'orchestrator-1', '', { effort: 'turbo' }), /Effort must be/);
  assert.ok(!p.agents.has('x') && !p.agents.has('y'), 'a bad pick creates nothing');
});

test('defaults per role apply when nothing is picked; an untyped default agent passes no model', () => {
  const { hub, p } = setup({ defaults: { worker: { model: 'haiku', effort: 'low' } } });
  const w = hub.startWorker(p, 'w', 'task');
  assert.deepEqual([w.model, w.effort], ['claude-haiku-5-5', 'low']);
  const o = hub.ensureOrchestrator(p);
  assert.deepEqual([o.model, o.effort], [null, null]);
  const opts = o.options();
  assert.ok(!('model' in opts) && !('effort' in opts) && !('tools' in opts), 'Claude Code picks its own default');
  assert.match(opts.systemPrompt.append, /AGENT TYPES[\s\S]*none yet/);
});

test('the orchestrator prompt lists the types', () => {
  const { hub, p } = setup({ homeTypes: { 'reviewer.md': REVIEWER } });
  const append = hub.ensureOrchestrator(p).options().systemPrompt.append;
  assert.match(append, /- reviewer \(claude-sonnet-5-5, effort medium\): Reviews a change for bugs/);
  assert.match(append, /tricky work, or work that touches shared systems/);
});

test('settings changes are logged and restored after a restart', async () => {
  const { hub, p, make } = setup({ homeTypes: { 'reviewer.md': REVIEWER } });
  hub.startWorker(p, 'w', 'task', 'you', '', { model: 'opus', effort: 'high' });
  p.log.append('agent_session', { agent: 'w', sessionId: 's1', model: 'claude-opus-5-5' });
  const r = await hub.setAgentSettings(p, 'w', { model: 'sonnet', effort: 'low' });
  assert.equal(r.changed, true);
  await hub.setAgentSettings(p, 'w', { type: 'reviewer', effort: 'xhigh' });

  const again = make().project('proj').agents.get('w');
  assert.deepEqual([again.type, again.model, again.effort, again.sessionId, again.modelSeen], ['reviewer', 'claude-sonnet-5-5', 'xhigh', 's1', 'claude-opus-5-5']);
  assert.equal((await hub.setAgentSettings(p, 'w', { effort: 'xhigh' })).changed, false, 'no change, no event');
  await hub.setAgentSettings(p, 'w', { model: null, effort: null });
  const cleared = make().project('proj').agents.get('w');
  assert.deepEqual([cleared.model, cleared.effort], [null, null], 'back to the default');
});

test('a live agent switches model and effort at once; a type change waits for it to go idle', async () => {
  const { hub, p } = setup({ homeTypes: { 'reviewer.md': REVIEWER } });
  const w = hub.startWorker(p, 'w', 'task');
  const calls = [];
  w.q = { setModel: async m => calls.push(['model', m]), applyFlagSettings: async s => calls.push(['flags', s]) };
  w.state = 'working';
  const r = await hub.setAgentSettings(p, 'w', { model: 'haiku', effort: 'high' });
  assert.equal(r.when, 'now');
  assert.deepEqual(calls, [['model', 'claude-haiku-5-5'], ['flags', { effortLevel: 'high' }]]);

  const r2 = await hub.setAgentSettings(p, 'w', { type: 'reviewer' });
  assert.match(r2.when, /once it finishes/);
  assert.equal(w.restartWhenIdle, true);
  assert.deepEqual([w.model, w.effort], ['claude-sonnet-5-5', 'medium'], 'a new type brings its own model and effort');
  w.state = 'idle';
  hub.onIdle(p, w);
  assert.equal(w.closed, 1, 'restarted when it went idle');
  assert.equal(w.restartWhenIdle, false);

  // A live switch that fails falls back to a restart; resting agents are restarted at once.
  w.q = { setModel: async () => { throw new Error('not supported'); }, applyFlagSettings: async () => {} };
  w.state = 'idle';
  const r3 = await hub.setAgentSettings(p, 'w', { model: 'fable' });
  assert.equal(r3.when, 'from its next message');
  assert.equal(w.closed, 2);
  assert.ok(p.log.ofType('notice').some(n => /You set w to reviewer · Fable 5\.2 · effort medium/.test(n.text)));
  await assert.rejects(hub.setAgentSettings(p, 'w', { effort: 'turbo' }), /Effort must be/);
});

test('the start-up event records the model Claude Code reports, and survives a restart', async () => {
  const { hub, p, make } = setup({ homeTypes: { 'reviewer.md': REVIEWER } });
  const w = hub.startWorker(p, 'rev', 'task', 'you', '', { type: 'reviewer' });
  async function* fake() { yield { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-sonnet-5-5' }; }
  await w.loop(fake());
  const ev = p.log.events.at(-1);
  assert.equal(ev.type, 'agent_session', 'the event keeps its own type');
  assert.deepEqual([ev.model, ev.agentType, ev.effort], ['claude-sonnet-5-5', 'reviewer', 'medium']);
  assert.equal(make().project('proj').agents.get('rev').modelSeen, 'claude-sonnet-5-5');
});

test('set_agent_settings: the orchestrator makes the same change as the chip, logged in both threads', async () => {
  const { hub, p } = setup({ homeTypes: { 'reviewer.md': REVIEWER } });
  const o = hub.ensureOrchestrator(p);
  const w = hub.startWorker(p, 'w', 'task');
  assert.ok(cruxToolNames(o).includes('mcp__crux__set_agent_settings'), 'in the orchestrator\'s tool list');
  assert.ok(!cruxToolNames(w).includes('mcp__crux__set_agent_settings'), 'not a worker\'s');
  assert.match(o.options().systemPrompt.append, /set_agent_settings\(name, model\?, effort\?,\s+type\?\)/, 'and in its prompt');

  const calls = [];
  w.q = { setModel: async m => calls.push(['model', m]), applyFlagSettings: async s => calls.push(['flags', s]) };
  w.state = 'working';
  const r = await hub.setAgentSettings(p, 'w', settingsChanges({ model: 'sonnet', effort: 'high' }), o.name);
  assert.equal(r.when, 'now');
  assert.deepEqual(calls, [['model', 'claude-sonnet-5-5'], ['flags', { effortLevel: 'high' }]], 'a live switch, as from the chip');
  const ev = p.log.ofType('agent_settings').at(-1);
  assert.deepEqual([ev.by, ev.model, ev.effort], ['orchestrator-1', 'claude-sonnet-5-5', 'high']);
  const lines = p.log.ofType('notice').filter(n => /orchestrator-1 set w to Sonnet 5\.5 · effort high; it applies now/.test(n.text));
  assert.deepEqual(lines.map(n => n.thread).sort(), ['orchestrator', 'w'], 'logged in the worker\'s thread and the orchestrator\'s');

  await hub.setAgentSettings(p, 'w', settingsChanges({ type: 'reviewer' }), o.name);
  assert.equal(w.restartWhenIdle, true, 'a type waits until it is free');
  await hub.setAgentSettings(p, 'w', settingsChanges({ type: 'none', model: 'default', effort: 'default' }), o.name);
  assert.deepEqual([w.type, w.model, w.effort], [null, null, null], '"default" and "none" reset');

  // Changing itself by its thread name; your own chip changes are logged once, in the agent's thread.
  await hub.setAgentSettings(p, 'orchestrator', { effort: 'max' }, o.name);
  assert.equal(o.effort, 'max');
  const before = p.log.ofType('notice').length;
  await hub.setAgentSettings(p, 'w', { effort: 'low' });
  assert.equal(p.log.ofType('notice').length, before + 1);
  await assert.rejects(hub.setAgentSettings(p, 'nobody', { effort: 'low' }, o.name), /No agent called nobody/);
});

test('set_agent_settings arguments: only what is given changes; default and none reset', () => {
  assert.deepEqual(settingsChanges({}), {});
  assert.deepEqual(settingsChanges({ model: ' haiku ' }), { model: 'haiku' });
  assert.deepEqual(settingsChanges({ model: 'Default', effort: 'default', type: 'none' }), { model: null, effort: null, type: null });
  assert.deepEqual(settingsChanges({ effort: 'xhigh', type: 'reviewer' }), { effort: 'xhigh', type: 'reviewer' });
});

test('a live switch that never answers gives up, and the change applies at the next start', async () => {
  const { hub, p } = setup();
  const w = hub.startWorker(p, 'w', 'task');
  w.q = { setModel: () => new Promise(() => { }), applyFlagSettings: async () => { } };
  assert.equal(await w.applyLive({ model: 'claude-haiku-5-5' }, 20), false);
});

test('a successor keeps its predecessor\'s type, model and effort', () => {
  const { hub, p } = setup({ homeTypes: { 'reviewer.md': REVIEWER } });
  const w = hub.startWorker(p, 'rev', 'task', 'you', '', { type: 'reviewer', effort: 'high' });
  w.sessionId = 's';
  hub.retire(p, w);
  hub.startSuccessor(p, w);
  const succ = [...p.agents.values()].find(a => a.predecessor === 'rev');
  assert.deepEqual([succ.type, succ.model, succ.effort], ['reviewer', 'claude-sonnet-5-5', 'high']);
  clearTimeout(w.overlapTimer);
});
