// Decisions 44 B and 45 B: the Trusted level, per-project handoff numbers with the hub defaults behind them, settings
// saving, and the settings card's pure parts. Paths are only compared, never touched, except throwaway temp folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classify, mergeNeedsOwner, MERGE_RULE, defaultRules } from '../lib/permission-rules.mjs';
import { HubSettings, projectKey, SETTING_DEFAULTS } from '../lib/settings.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { levelChip, projectCard, hubPanel, projectChanges, hubChanges, readNumber, MERGE_LINE, LEVELS, ALWAYS, NUMBERS } from '../public/project-settings.js';

Agent.prototype.send = function () { this.state = 'working'; };
Agent.prototype.close = function () {};

const HOME = 'C:\\Users\\someone';
const TEMP = 'C:\\Users\\someone\\AppData\\Local\\Temp';
const PROJ = 'C:\\Users\\someone\\Documents\\GitHub\\garden-planner';
const at = (level, tool, input) => classify({ tool, input, projectDir: PROJ, tmp: TEMP, home: HOME, level });
const bash = (level, command) => at(level, 'Bash', { command }).route;

const roots = [];
const scratch = name => { const r = mkdtempSync(join(tmpdir(), `crux-psettings-${name}-`)); roots.push(r); return r; };
test.after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

// ---------- the Trusted level (decision 45) ----------
test('Trusted allows installing packages into the project; Auto still sends them to you', () => {
  const installs = [
    'npm install lodash', 'npm i -D vitest', 'npm ci', 'npm uninstall left-pad', 'pnpm add zod', 'yarn add react', 'yarn', 'bun add hono',
    'npm install --prefix hub web-push', 'cd hub && npm install',
    '.venv/Scripts/pip install requests', '.venv/bin/pip3 install -r requirements.txt', '.venv/Scripts/python -m pip install numpy',
    'python -m venv .venv', 'pip install --target ./vendor requests', 'uv add httpx', 'uv sync', 'poetry add pandas',
    'cargo add serde', 'go get example.com/mod', 'npm view react version', 'npm outdated'
  ];
  for (const c of installs) {
    const r = at('trusted', 'Bash', { command: c });
    assert.equal(r.route, 'allow', `${c}: ${r.reasons.join('; ')} ${r.unsure.join('; ')}`);
  }
  for (const c of ['npm install lodash', 'pnpm add zod', 'yarn add react', '.venv/Scripts/pip install requests', 'uv add httpx', 'cargo add serde']) {
    assert.equal(bash('auto', c), 'human', `Auto: ${c}`);
  }
  // The project's own dependency files may change too.
  assert.equal(at('trusted', 'Edit', { file_path: join(PROJ, 'package.json') }).route, 'allow');
  assert.equal(at('trusted', 'Write', { file_path: join(PROJ, 'requirements.txt') }).route, 'allow');
  assert.equal(at('auto', 'Edit', { file_path: join(PROJ, 'package.json') }).route, 'human');
});

test('Trusted allows reading and downloading from any website into the project; Auto does not', () => {
  assert.equal(at('trusted', 'WebFetch', { url: 'https://example.org/docs', prompt: 'x' }).route, 'allow');
  assert.equal(at('auto', 'WebFetch', { url: 'https://example.org/docs', prompt: 'x' }).route, 'unsure');
  const reads = [
    'curl -sL https://example.org/data.json', 'curl -sL https://example.org/data.json -o data/data.json', 'curl -LO https://example.org/a.zip',
    'wget https://example.org/a.zip', 'wget -O assets/logo.svg https://example.org/logo.svg',
    `curl -L https://example.org/x.tgz -o "${TEMP}\\crux-dl\\x.tgz"`, 'git clone https://gitlab.com/someone/lib.git vendor/lib'
  ];
  for (const c of reads) {
    const r = at('trusted', 'Bash', { command: c });
    assert.equal(r.route, 'allow', `${c}: ${r.reasons.join('; ')} ${r.unsure.join('; ')}`);
  }
  assert.equal(at('trusted', 'PowerShell', { command: 'Invoke-WebRequest https://example.org/a.csv -OutFile data\\a.csv' }).route, 'allow');
  for (const c of ['curl -sL https://example.org/data.json', 'wget https://example.org/a.zip', 'git clone https://gitlab.com/someone/lib.git vendor/lib']) {
    assert.equal(bash('auto', c), 'human', `Auto: ${c}`);
  }
});

test('Trusted keeps every fixed stop: global installs, force push, history, branches, main, outside, secrets, the live hub, connectors', () => {
  const stops = [
    'npm install -g typescript', 'npm i --global pnpm', 'npm install --location=global x', 'yarn global add serve', 'pnpm add -g x',
    'pip install requests', 'pip install --user black', '.venv/Scripts/pip install --prefix C:/Tools x',
    'winget install Git.Git', 'choco install nodejs', 'scoop install jq', 'npx create-vite app', 'npm exec cowsay', 'npm publish',
    'cargo install ripgrep', 'go install example.com/tool@latest', 'uv tool install ruff', 'npm install --prefix C:/elsewhere x',
    'git push --force', 'git push origin +feat/x', 'git push origin main', 'git branch -D feat/old', 'git push origin --delete feat/old',
    'git filter-branch --all', 'git reset --hard origin/main',
    'echo x > C:/Users/someone/.claude/settings.json', 'echo x > C:/Users/someone/crux/core.md', 'rm -rf C:/Users/someone/Documents/other',
    'cat ~/.ssh/id_rsa', 'cat .env',
    'curl -X POST -d @notes.txt https://example.org/upload', 'curl -F file=@a.zip https://example.org', 'curl -H "Authorization: Bearer abc" https://api.example.org',
    'curl -u me:pw https://example.org', 'curl https://example.org/x -o C:/Users/someone/Desktop/x', 'wget -P C:/Users/someone/Downloads https://example.org/a',
    'ssh someone@example.org', 'scp a.txt someone@example.org:/tmp',
    'node hub/tools/stop-test-hub.mjs 4747', 'curl -s -X POST -H "origin: http://localhost:4747" -d \'{}\' localhost:4747/api/settings',
    'node server.mjs', 'gh pr merge 12 --squash', 'git merge feat/x'
  ];
  for (const c of stops) {
    const r = at('trusted', 'Bash', { command: c });
    assert.equal(r.route, 'human', `${c}: got ${r.route} ${r.unsure.join('; ')}`);
  }
  assert.equal(at('trusted', 'mcp__claude_ai_Gmail__send_message', { to: 'x' }).route, 'human', 'outward connector actions');
  assert.equal(at('trusted', 'mcp__claude_ai_Google_Drive__delete_file', {}).route, 'human');
  assert.equal(at('trusted', 'Write', { file_path: 'C:\\Users\\someone\\.claude\\settings.json' }).route, 'human');
  assert.equal(at('trusted', 'PowerShell', { command: 'Install-Module PSReadLine' }).route, 'human');
  assert.equal(at('trusted', 'PowerShell', { command: 'Invoke-WebRequest https://example.org -Method Post -Body x' }).route, 'human');
});

test('the merge rule: every merge needs the owner\'s yes, at every level (one named spot)', () => {
  for (const level of ['standard', 'auto', 'trusted']) {
    assert.equal(mergeNeedsOwner({ level }), true, level);
    assert.equal(bash(level, 'gh pr merge 31'), 'human', level);
    assert.equal(bash(level, 'git merge origin/main'), 'human', level);
  }
  assert.equal(MERGE_RULE, MERGE_LINE, 'the card shows the rule in the same words');
  assert.match(MERGE_LINE, /^Merges: the orchestrator merges after a review, once you say yes\.$/);
  assert.equal(bash('trusted', 'git merge-base HEAD origin/main'), 'allow', 'reading is not merging');
});

test('a repo cannot trust itself: .crux-hub.json "trusted" is Auto; only the hub page sets Trusted', async () => {
  const root = scratch('level');
  const dir = join(root, 'garden-planner');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  writeFileSync(join(dir, '.crux-hub.json'), '{ "permissions": "trusted" }');
  const file = join(root, 'data', 'settings.json');
  const mk = () => new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file }) });
  let hub = mk(), p = hub.project('garden-planner');
  assert.equal(hub.permissionMode(p), 'auto', 'the repo file asked for trusted and got Auto');
  const w = hub.startWorker(p, 'deps', 'Add a package', 'you', 'Add a package');
  hub.requestApproval(p, w, 'Bash', { command: 'npm install lodash' });
  assert.equal(p.log.ofType('approval').at(-1).routedTo, null, 'in Auto an install is a hard stop: it comes to you');
  assert.ok(p.log.ofType('approval').at(-1).stops.some(s => /Installs/.test(s)));

  hub.setPermissionMode(p, 'trusted');
  assert.equal(hub.permissionMode(p), 'trusted');
  assert.ok(p.log.ofType('notice').some(n => n.thread === 'orchestrator' && /Trusted/.test(n.text) && /Merges still need your yes/.test(n.text)));
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects[projectKey(dir)].permissionMode, 'trusted', 'saved by project folder');
  hub = mk(); p = hub.project('garden-planner');
  assert.equal(hub.permissionMode(p), 'trusted', 'survives a restart');
  const w2 = hub.startWorker(p, 'deps2', 'Add a package', 'you', 'Add a package');
  assert.equal((await hub.requestApproval(p, w2, 'Bash', { command: 'npm install lodash' })).behavior, 'allow', 'Trusted: runs on its own');
  hub.requestApproval(p, w2, 'Bash', { command: 'npm install -g typescript' });
  assert.equal(p.log.ofType('approval').at(-1).routedTo, null, 'a global install still comes to you');
  assert.equal(hub.state()[0].permissionMode, 'trusted', 'the page sees it');
  assert.match(hub.rulesFor(p).body, /TRUSTED/, 'the built-in rules tell the orchestrator what Trusted adds');
  assert.doesNotMatch(defaultRules(dir).body, /TRUSTED/, 'and Auto\'s do not');
});

// ---------- handoff numbers per project (decision 44 B) ----------
test('handoff numbers: each project reads its own, falling back to the hub defaults', () => {
  const s = new HubSettings({ file: null, initial: { retireAt: 55 } });
  assert.equal(SETTING_DEFAULTS.retireAt, 60);
  assert.equal(s.get('retireAt'), 55, 'the --retire-at flag is the starting default');
  assert.equal(s.projectNumber('C:/a', 'retireAt'), 55, 'no value of its own: the hub default');
  s.setProject('C:/a', { retireAt: 40, idleHandoffMin: 120 });
  assert.equal(s.projectNumber('C:/a', 'retireAt'), 40);
  assert.equal(s.projectNumber('C:/a', 'idleHandoffMin'), 120);
  assert.equal(s.projectNumber('C:/a', 'idleFloorPct'), 25, 'the one it left empty');
  assert.equal(s.projectNumber('C:/b', 'idleHandoffMin'), 60, 'another project');
  s.set({ idleFloorPct: 30 });
  assert.equal(s.projectNumber('C:/a', 'idleFloorPct'), 30, 'a new hub default reaches projects that use it');
  s.setProject('C:/a', { retireAt: null });
  assert.equal(s.projectNumber('C:/a', 'retireAt'), 55, 'cleared: back to the hub default');
  s.setProject('C:/a', { idleHandoffMin: 5000, idleFloorPct: -1, retireAt: 'x' });
  assert.equal(s.projectNumber('C:/a', 'idleHandoffMin'), 120, 'out of range is ignored');
  assert.equal(s.projectNumber('C:/a', 'retireAt'), 55);
});

test('the hub hands off per project: its own context mark and idle window, else the hub\'s', () => {
  const root = scratch('numbers');
  const ago = min => new Date(Date.now() - min * 60000).toISOString();
  const mkProj = (name, idleMin, pct) => {
    const dir = join(root, name);
    mkdirSync(join(dir, '.crux'), { recursive: true });
    const evs = [
      { id: `${name}-1`, ts: ago(300), type: 'agent_created', agent: 'orchestrator-1', role: 'orchestrator', generation: 1, thread: 'orchestrator' },
      { id: `${name}-2`, ts: ago(300), type: 'agent_session', agent: 'orchestrator-1', sessionId: 's1' },
      { id: `${name}-3`, ts: ago(idleMin), type: 'agent_busy', agent: 'orchestrator-1', busy: false, contextPct: pct }
    ];
    writeFileSync(join(dir, '.crux', 'events.jsonl'), evs.map(e => JSON.stringify(e)).join('\n') + '\n');
    return dir;
  };
  const quick = mkProj('quick', 40, 30), slow = mkProj('slow', 90, 30), never = mkProj('never', 600, 80);
  const settings = new HubSettings({ file: null });
  const hub = new Hub({ projects: [quick, slow, never], memory: new Memory(join(root, 'home')), settings });
  hub.run = () => '';
  settings.setProject(quick, { idleHandoffMin: 30 });    // hands off after 30 minutes here
  settings.setProject(never, { idleHandoffMin: 0 });     // never for being idle here
  assert.deepEqual(hub.handoffNumbers(hub.project('quick')), { idleHandoffMin: 30, idleFloorPct: 25, retireAt: 60 });
  assert.deepEqual(hub.ownHandoffNumbers(hub.project('quick')), { idleHandoffMin: 30, idleFloorPct: null, retireAt: null });
  assert.deepEqual(hub.idleCheck().sort(), ['quick', 'slow'], 'quick by its own 30 minutes, slow by the hub\'s 60; never is off');
  for (const p of hub.projects.values()) for (const a of p.agents.values()) clearTimeout(a.retireTimer);

  settings.setProject(slow, { retireAt: 25 });
  assert.equal(hub.retireAtFor(hub.project('slow')), 25);
  assert.equal(hub.retireAtFor(hub.project('never')), 60, 'the hub default');
  const st = hub.state();
  assert.equal(st.find(p => p.name === 'slow').retireAt, 25, 'the page gets each project\'s mark');
  assert.equal(st.find(p => p.name === 'never').ownHandoff.idleHandoffMin, 0);
});

test('setHandoffNumbers saves, notes the change in the orchestrator thread, and survives a restart', () => {
  const root = scratch('save');
  const dir = join(root, 'recipe-box');
  mkdirSync(join(dir, '.crux'), { recursive: true });
  const file = join(root, 'data', 'settings.json');
  const mk = () => new Hub({ projects: [dir], memory: new Memory(join(root, 'home')), settings: new HubSettings({ file, initial: { retireAt: 60 } }) });
  let hub = mk(), p = hub.project('recipe-box');
  hub.setHandoffNumbers(p, { retireAt: 50, idleHandoffMin: '', idleFloorPct: 20 });
  const saved = JSON.parse(readFileSync(file, 'utf8')).projects[projectKey(dir)];
  assert.equal(saved.retireAt, 50);
  assert.equal(saved.idleFloorPct, 20);
  assert.ok(!('idleHandoffMin' in saved), 'empty means the hub default: nothing saved');
  const n = p.log.ofType('notice').at(-1);
  assert.equal(n.thread, 'orchestrator');
  assert.match(n.text, /hands off at 50% of its context, or after 60 minutes idle \(hub default\) when above 20%/);
  const count = p.log.ofType('project_settings').length;
  hub.setHandoffNumbers(p, { retireAt: 50 });
  assert.equal(p.log.ofType('project_settings').length, count, 'no change, no note');
  hub.settings.set({ retireAt: 70, permissionTimeoutSec: 90 });
  hub = mk(); p = hub.project('recipe-box');
  assert.equal(hub.retireAtFor(p), 50, 'its own mark survives a restart');
  assert.equal(hub.retireAt, 70, 'a saved hub default beats the start flag');
  assert.equal(hub.settings.get('permissionTimeoutSec'), 90);
});

// ---------- the settings card (page) ----------
test('the level chip says the level and opens the card; connectors show as a mark', () => {
  const chip = levelChip({ name: 'garden-planner', permissionMode: 'trusted', connectors: true });
  assert.match(chip, /class="lvchip trusted"/);
  assert.match(chip, /data-settings-open/);
  assert.match(chip, />Trusted</);
  assert.match(chip, /i-plug/);
  assert.match(chip, /title="[^"]*Click for this project&#39;s settings/);
  assert.match(levelChip({ permissionMode: 'standard' }), />Ask</);
  assert.match(levelChip({ permissionMode: 'auto' }), />Auto</);
  assert.doesNotMatch(levelChip({ permissionMode: 'auto' }), /i-plug/);
});

test('the card: Trusted lists the merge rule in plain words, the fixed stops fold, numbers show the hub default', () => {
  const p = { name: 'garden-planner', permissionMode: 'trusted', connectors: false, ownHandoff: { retireAt: null, idleHandoffMin: 120, idleFloorPct: null } };
  const hub = { retireAt: 60, idleHandoffMin: 60, idleFloorPct: 25 };
  const d = { level: 'trusted', connectors: false, nums: { retireAt: '', idleHandoffMin: '120', idleFloorPct: '' }, errors: {}, alwaysOpen: false };
  const html = projectCard(p, hub, d);
  assert.ok(html.includes(MERGE_LINE), 'the merge line under Trusted');
  assert.ok(LEVELS.trusted.you.includes(MERGE_LINE));
  assert.match(html, /<details class="ps-always" >/, 'the always-to-you list is folded until asked');
  assert.match(projectCard(p, hub, { ...d, alwaysOpen: true }), /<details class="ps-always" open>/);
  for (const t of ALWAYS) assert.ok(html.includes(t), t);
  assert.match(html, /Empty: uses the hub default, 60% context/);
  assert.match(html, /Hub default 60 minutes\./);
  assert.match(html, /data-ps-reset="idleHandoffMin"/);
  assert.match(html, /placeholder="25"/);
  assert.match(html, /data-ps-close[^>]*title="Close without changing anything"/, 'an exit that does nothing');
  assert.doesNotMatch(html, /type="range"|type="number"/, 'no sliders or spinners');
  assert.doesNotMatch(html, /&#x|[\u{1F300}-\u{1FAFF}]/u, 'drawn icons only');
  assert.equal((html.match(/role="radio" aria-checked="true" tabindex="0" data-ps-level/g) || []).length, 1, 'one level chosen');
  const hp = hubPanel({ route: true, nums: { permissionTimeoutSec: '120', retireAt: '60', idleHandoffMin: '60', idleFloorPct: '25' }, errors: {} });
  assert.match(hp, /Whole hub/);
  assert.match(hp, /data-ps-close/);
  for (const f of NUMBERS) assert.match(hp, new RegExp(`data-ps-num="${f.k}"`));
  assert.match(hp, /data-ps-num="permissionTimeoutSec"/);
});

test('Done sends only what changed; bad numbers are caught before anything is saved', () => {
  const p = { name: 'g', permissionMode: 'auto', connectors: false, ownHandoff: { retireAt: null, idleHandoffMin: 120, idleFloorPct: null } };
  const same = { level: 'auto', connectors: false, nums: { retireAt: '', idleHandoffMin: '120', idleFloorPct: '' } };
  assert.deepEqual(projectChanges(p, same).body, {});
  const r = projectChanges(p, { level: 'trusted', connectors: true, nums: { retireAt: '50', idleHandoffMin: '', idleFloorPct: '' } });
  assert.deepEqual(r.body, { permissionMode: 'trusted', connectors: true, handoff: { retireAt: 50, idleHandoffMin: null } });
  assert.deepEqual(projectChanges(p, { ...same, nums: { retireAt: '99', idleHandoffMin: 'x', idleFloorPct: '' } }).errors, { retireAt: 'Between 10 and 95', idleHandoffMin: 'Whole numbers only' });
  const s = { routePermissions: true, permissionTimeoutSec: 120, retireAt: 60, idleHandoffMin: 60, idleFloorPct: 25 };
  assert.deepEqual(hubChanges(s, { route: false, nums: { permissionTimeoutSec: '90', retireAt: '60', idleHandoffMin: '60', idleFloorPct: '25' } }).body, { permissionTimeoutSec: 90, routePermissions: false });
  assert.deepEqual(hubChanges(s, { route: true, nums: { permissionTimeoutSec: '', retireAt: '60', idleHandoffMin: '60', idleFloorPct: '25' } }).errors, { permissionTimeoutSec: 'Needs a number' });
  assert.deepEqual(readNumber(' 0 ', NUMBERS.find(f => f.k === 'idleHandoffMin')), { value: 0 }, '0 = never is allowed');
});
