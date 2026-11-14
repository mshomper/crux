// Card and rules wording names the person from their own profile (R007 item 3), and reads naturally with no profile.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTmp } from './helpers/tmp.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { classify, defaultRules } from '../lib/permission-rules.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () {};

function setup(name) {
  sent.length = 0;
  const root = makeTmp('crux-card-names-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  writeFileSync(join(dir, '.crux-hub.json'), '{ "permissions": "auto" }');
  if (name) {
    mkdirSync(join(root, 'home', 'profile'), { recursive: true });
    writeFileSync(join(root, 'home', 'profile', 'core.md'), `# Working with ${name}: core\n`);
  }
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }) });
  const p = hub.project('proj');
  const orch = hub.ensureOrchestrator(p); orch.q = {};
  const w = hub.startWorker(p, 'w1', 'Fix the build', 'you', 'Fix the build');
  sent.length = 0;
  return { hub, p, orch, w };
}
const last = (p, type) => p.log.ofType(type).at(-1);
// Only the rules part of the orchestrator's prompt: agent types come from the machine's own agent files.
const rulesPart = prompt => prompt.split('PERMISSION RULES')[1].split('AGENT TYPES')[0];
const G = 'mcp__claude_ai_Gmail__';

test('the rules module itself names no one: only the {{who}} placeholder', () => {
  const r = classify({ tool: G + 'send_message', input: {}, projectDir: tmpdir() });
  assert.match(r.reasons[0], /^Acts in \{\{who\}\}'s Gmail/);
  const body = defaultRules(tmpdir()).body;
  assert.doesNotMatch(body, /Matt/);
  assert.match(body, /\{\{Who\}\} may replace them/);
});

test('with a profile: cards, the orchestrator\'s message, its rules and notices use the profile name', async () => {
  const { hub, p, orch, w } = setup('Sam');
  hub.requestApproval(p, w, G + 'send_message', { to: 'x' });
  assert.match(last(p, 'approval').stops.join('\n'), /Acts in Sam's Gmail/);
  hub.requestApproval(p, w, G + 'search_threads', { query: 'x' });
  assert.match(sent.at(-1)[1], /Reads Sam's Gmail/);
  const prompt = orch.options().systemPrompt.append;
  assert.match(prompt, /Sam may replace them/);
  assert.match(prompt, /HARD STOPS, always to Sam:/);
  await new Promise(r => setTimeout(r, 5));
  const hint = p.log.ofType('notice').find(n => /no permission rules entry/.test(n.text));
  assert.match(hint.text, /draft a rules entry for Sam to approve/);
  // send is stubbed here; the real send personalizes the whole message in userMessage.
  const delivered = JSON.stringify(orch.userMessage(sent.at(-1)[1]).message.content);
  assert.match(delivered, /HARD STOPS, always to Sam:/);
  for (const text of [last(p, 'approval').stops.join('\n'), delivered, rulesPart(prompt), hint.text]) assert.doesNotMatch(text, /Matt|\{\{[wW]ho\}\}/);
});

test('with no profile: the wording falls back to "the user", never a hardcoded name or a raw placeholder', async () => {
  const { hub, p, orch, w } = setup(null);
  hub.requestApproval(p, w, G + 'send_message', { to: 'x' });
  assert.match(last(p, 'approval').stops.join('\n'), /Acts in the user's Gmail/);
  const prompt = orch.options().systemPrompt.append;
  assert.match(prompt, /The user may replace them/);
  await new Promise(r => setTimeout(r, 5));
  const hint = p.log.ofType('notice').find(n => /no permission rules entry/.test(n.text));
  assert.match(hint.text, /draft a rules entry for the user to approve/);
  for (const text of [last(p, 'approval').stops.join('\n'), rulesPart(prompt), hint.text]) assert.doesNotMatch(text, /Matt|\{\{[wW]ho\}\}/);
});
