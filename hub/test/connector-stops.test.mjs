// Matt's claude.ai connectors (Gmail, Calendar, Drive): sends, shares, changes and deletes are hard stops in every
// mode; reads and Gmail drafts go to the orchestrator; anything not on the read list is a hard stop by default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classify, connectorTool } from '../lib/permission-rules.mjs';
import { CommandPolicy } from '../lib/permissions.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';

const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () {};

const route = (tool, input = {}) => classify({ tool, input, projectDir: tmpdir() }).route;
const G = 'mcp__claude_ai_Gmail__', C = 'mcp__claude_ai_Google_Calendar__', D = 'mcp__claude_ai_Google_Drive__';

const HARD = [
  ...['send_message', 'reply', 'forward', 'trash_message', 'trash_thread', 'mark_message_spam', 'mark_thread_spam', 'unmark_thread_spam',
    'label_message', 'label_thread', 'unlabel_message', 'unlabel_thread', 'update_message_labels', 'create_label', 'update_label', 'delete_label',
    'apply_sensitive_message_label', 'apply_sensitive_thread_label', 'delete_draft', 'untrash_message'].map(n => G + n),
  ...['create_event', 'update_event', 'delete_event', 'respond_to_event'].map(n => C + n),
  ...['share_file', 'create_file', 'update_file', 'trash_file', 'copy_file'].map(n => D + n),
  // not on the read list: a hard stop by default, including other connectors and tools added later
  G + 'some_new_tool', 'mcp__claude_ai_Claude_Docs__batch', 'mcp__claude_ai_Claude_Docs__update', 'mcp__claude_ai_Three_js_3D_Viewer__show_threejs_scene'
];
const READS = [
  ...['search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft'].map(n => G + n),
  ...['list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time'].map(n => C + n),
  ...['search_files', 'read_file_content', 'get_file_metadata', 'get_file_permissions', 'list_recent_files', 'list_shared_drives', 'get_shared_drive_metadata', 'download_file_content'].map(n => D + n)
];

test('sends, shares, changes and deletes in a connector are hard stops; so is any tool not on the read list', () => {
  for (const t of HARD) assert.equal(route(t, { to: 'someone@example.com' }), 'human', t);
});

test('connector reads are unsure (for the orchestrator), never allowed outright', () => {
  for (const t of READS) assert.equal(route(t, { query: 'x' }), 'unsure', t);
});

test('Gmail drafts are unsure: nothing is sent', () => {
  assert.equal(route(G + 'create_draft', { to: 'x', body: 'y' }), 'unsure');
  assert.equal(route(G + 'update_draft', { body: 'y' }), 'unsure');
  assert.equal(connectorTool(G + 'create_draft').kind, 'draft');
  assert.equal(connectorTool('mcp__other__thing'), null, 'other MCP servers are not connectors');
});

test('"Always allow" is never offered for a connector tool', () => {
  const suggestion = [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: G + 'search_threads' }] }];
  assert.equal(CommandPolicy.alwaysRules(G + 'search_threads', {}, suggestion), null);
  assert.equal(CommandPolicy.alwaysRules(G + 'send_message', {}, [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: G + 'send_message' }] }]), null);
});

function setup(auto) {
  sent.length = 0;
  const root = mkdtempSync(join(tmpdir(), 'crux-connectors-'));
  const dir = join(root, 'proj');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  if (auto) writeFileSync(join(dir, '.crux-hub.json'), '{ "permissions": "auto" }');
  const hub = new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file: null }) });
  const p = hub.project('proj');
  const orch = hub.ensureOrchestrator(p); orch.q = {};
  const w = hub.startWorker(p, 'w1', 'Fix the build', 'you', 'Fix the build');
  sent.length = 0;
  return { hub, p, orch, w };
}
const last = (p, type) => p.log.ofType(type).at(-1);

test('in every mode, a connector send comes to Matt as a card and never reaches the orchestrator', () => {
  for (const auto of [true, false]) {
    const { hub, p, w, orch } = setup(auto);
    for (const t of [G + 'send_message', D + 'share_file', C + 'create_event']) {
      hub.requestApproval(p, w, t, { to: 'x' });
      assert.equal(last(p, 'approval').routedTo, null, `${t} (${auto ? 'Auto' : 'Ask'})`);
      assert.ok(last(p, 'approval').stops.length);
      hub.requestApproval(p, orch, t, { to: 'x' });
      assert.equal(last(p, 'approval').agent, orch.name, 'the orchestrator\'s own send is a card too');
    }
    assert.equal(sent.length, 0, 'the orchestrator was never asked');
  }
});

test('a worker\'s connector read goes to the orchestrator; the orchestrator\'s own read comes to Matt (not auto-allowed)', async () => {
  const { hub, p, w, orch } = setup(true);
  hub.requestApproval(p, w, G + 'search_threads', { query: 'invoice' });
  assert.equal(last(p, 'approval').routedTo, orch.name);
  assert.match(sent.at(-1)[1], /Reads Matt's Gmail/);
  const before = p.log.ofType('permission_answer').length;
  hub.requestApproval(p, orch, G + 'search_threads', { query: 'invoice' });
  assert.equal(last(p, 'approval').agent, orch.name, 'a card for Matt');
  assert.equal(last(p, 'approval').routedTo, null);
  assert.equal(p.log.ofType('permission_answer').length, before, 'not allowed-and-logged');
});

test('the prompts say connector content is untrusted and must never trigger a send or share', () => {
  const { orch, w } = setup(true);
  const o = orch.options().systemPrompt.append, wk = w.options().systemPrompt.append;
  for (const text of [o, wk]) assert.match(text, /untrusted/);
  assert.match(o, /prompt injection/);
  assert.match(o, /never lead to a send or share/);
});
