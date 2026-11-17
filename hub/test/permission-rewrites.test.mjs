// An agent changing an existing file of the project with a command-line script is refused at once (M042: plain mistakes, not
// disguise): no card, no orchestrator, no check call. Shapes in both directions, including the real cases of 2026-11-17.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { hashOf, refreshExpeditionFiles } from '../lib/starter-refresh.mjs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { inlineRewrite, REWRITE_REASON } from '../lib/permission-rewrites.mjs';
import { classify } from '../lib/permission-rules.mjs';
import { Agent } from '../lib/agent.mjs';
import { Hub } from '../lib/hub.mjs';
import { Memory } from '../lib/memory.mjs';
import { HubSettings } from '../lib/settings.mjs';
import { CHECK_MODEL, PermissionCheck } from '../lib/permission-check.mjs';

const root = makeTmp('crux-rewrites-');
const proj = join(root, 'proj').replace(/\\/g, '/');
const tmp = join(root, 'tmp').replace(/\\/g, '/');
const home = join(root, 'home').replace(/\\/g, '/');
const wt = `${proj}/.claude/worktrees/strip-layout`;
const put = (p, text = 'x\n') => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, text); };
for (const f of ['lib/feed.mjs', 'README.md', 'notes.txt', '.claude/worktrees/strip-layout/hub/test/strip-zones.test.mjs', '.claude/worktrees/strip-layout/hub/lib/hub.mjs']) put(`${proj}/${f}`);
put(`${tmp}/ps-scripts/compare2.mjs`); put(`${tmp}/log.txt`);
const TRACKED = new Set(['README.md', 'feed.mjs', 'strip-zones.test.mjs', 'hub.mjs']);
const isTracked = p => TRACKED.has(p.split('/').pop());
const run = (command, { tool = 'Bash', cwd = proj } = {}) => inlineRewrite({ tool, command, cwd, projectDir: proj, tmp, home, isTracked });
const denies = (command, opts) => assert.equal(run(command, opts), REWRITE_REASON, `should refuse: ${command}`);
const leaves = (command, opts) => assert.equal(run(command, opts), null, `should leave alone: ${command}`);

test('sed -i and perl -pi on an existing project file are refused; reading sed, a new file, a temp file and an unknown path are not', () => {
  denies('sed -i "s/a/b/" lib/feed.mjs && grep -n entryId lib/feed.mjs');
  denies("sed -i 's/a/b/' lib/feed.mjs README.md");
  denies('sed -i.bak -e "s/a/b/" lib/feed.mjs');
  denies('sed -ni "s/a/b/p" lib/feed.mjs');
  denies('sed --in-place "s/a/b/" lib/feed.mjs');
  denies('perl -pi -e "s/a/b/" lib/feed.mjs');
  denies('perl -pi.bak -e "s/a/b/" lib/feed.mjs');
  denies('cd hub/test && sed -i "s/a/b/" strip-zones.test.mjs', { cwd: wt });          // the cd carries to the file
  denies('nohup sed -i "s/a/b/" lib/feed.mjs');
  leaves('sed -n 1,5p lib/feed.mjs');
  leaves('sed "s/a/b/" lib/feed.mjs');                                                  // prints, changes nothing
  leaves('sed -i "s/a/b/" lib/not-there.mjs');                                          // a file that does not exist
  leaves(`sed -i "s/a/b/" ${tmp}/log.txt`);                                             // the agent's temp folder
  leaves('sed -i "s/a/b/" "$TEMP/log.txt"');
  leaves('sed -i "s/a/b/" $F');                                                         // a path the hub cannot read
  leaves('cd "$X" && sed -i "s/a/b/" lib/feed.mjs');                                    // a folder it cannot work out
  leaves('perl -ne "print if /a/" lib/feed.mjs');
  leaves('git -C . log --oneline | sed -n 1,3p');
});

test('inline node and python scripts that write an existing project file are refused; read-only ones and temp writes are not', () => {
  denies(`node -e "const fs=require('fs');let s=fs.readFileSync('lib/feed.mjs','utf8');fs.writeFileSync('lib/feed.mjs', s.replace('a','b'))"`);
  denies(`node -e "require('fs').appendFileSync('README.md', 'more')"`);
  denies(`node -e "const f='lib/feed.mjs'; const fs=require('fs'); fs.writeFileSync(f, fs.readFileSync(f,'utf8')+'x')"`);   // the path from a variable it can read
  denies(`python3 -c "p='lib/feed.mjs'; s=open(p).read(); open(p,'w').write(s)"`);
  denies(`python -c "open('README.md', 'a').write('x')"`);
  denies(`python3 -c "from pathlib import Path; Path('lib/feed.mjs').write_text('x')"`);
  // the real case (2026-11-17, strip-layout): a test file rewritten with an inline node heredoc
  denies(`node - <<'EOF'\nconst fs=require('fs');let s=fs.readFileSync('test/strip-zones.test.mjs','utf8');\nconst a=s.indexOf("test('no station");\ns=s.slice(0,a)+"test('new', () => {});";\nfs.writeFileSync('test/strip-zones.test.mjs', s);\nEOF\nnode --test test/strip-zones.test.mjs`, { cwd: `${wt}/hub` });
  denies(`cd ${wt}/hub && node - <<'EOF'\nrequire('fs').writeFileSync('lib/hub.mjs', 'x');\nEOF`);
  denies(`python3 - <<'PY'\nimport re\np='lib/feed.mjs'\ns=open(p).read()\nopen(p,'w').write(re.sub('a','b',s))\nPY`);
  leaves(`node -e "const fs=require('fs');const L=fs.readFileSync('.crux/events.jsonl','utf8').split('\\n');console.log(L.length)"`);   // the read-only event-log script
  leaves(`node - <<'EOF'\nconst fs=require('fs');const L=fs.readFileSync('.crux/events.jsonl','utf8').split('\\n').filter(Boolean).map(JSON.parse);\nconsole.log(L.filter(e=>e.type==='check_shadow').length);\nEOF`);
  leaves(`python3 -c "import json;print(len(open('lib/feed.mjs').read()))"`);
  leaves(`node -e "require('fs').writeFileSync('lib/brand-new.mjs','x')"`);                          // a new file
  leaves(`node -e "require('fs').writeFileSync('${tmp}/out.json','x')"`);                           // temp
  leaves(`cd "$TEMP/ps-scripts" && node - <<'EOF'\nconst fs=require('fs');let s=fs.readFileSync('compare2.mjs','utf8');fs.writeFileSync('compare2.mjs', s.replace('a','b'));\nEOF`);   // its own temp scripts
  leaves(`node -e "require('fs').writeFileSync(process.argv[1], 'x')" lib/feed.mjs`);                // a path built at run time
  leaves(`node -e "const fs=require('fs');fs.writeFileSync(require('path').join(__dirname,'a'),'x')"`);
  leaves(`python3 -c "open('log.txt','x')"`);                                                       // exclusive create: a new file
  leaves(`echo "node -e \\"writeFileSync('lib/feed.mjs')\\""`);                                     // text, not code that runs
});

test('PowerShell Set-Content, Add-Content, Out-File and WriteAllText onto an existing project file are refused', () => {
  const ps = c => run(c, { tool: 'PowerShell' });
  assert.equal(ps(`Set-Content -Path lib/feed.mjs -Value "x"`), REWRITE_REASON);
  assert.equal(ps(`Set-Content lib/feed.mjs "x"`), REWRITE_REASON);
  assert.equal(ps(`$s = Get-Content lib/feed.mjs; $s -replace 'a','b' | Set-Content lib/feed.mjs`), REWRITE_REASON);
  assert.equal(ps(`Add-Content -LiteralPath README.md -Value "more"`), REWRITE_REASON);
  assert.equal(ps(`"text" | Out-File -FilePath lib/feed.mjs -Encoding utf8`), REWRITE_REASON);
  assert.equal(ps(`Out-File -Encoding utf8 lib/feed.mjs`), REWRITE_REASON);
  assert.equal(ps(`$f = '${proj}/lib/feed.mjs'; [IO.File]::WriteAllText($f, 'x')`), null, 'a variable inside .NET is left alone');
  assert.equal(ps(`[System.IO.File]::WriteAllText('${proj}/lib/feed.mjs', 'x')`), REWRITE_REASON);
  assert.equal(ps(`$f = 'lib/feed.mjs'; Set-Content $f 'x'`), REWRITE_REASON, 'a variable it can read');
  assert.equal(ps(`Set-Content -Path lib/brand-new.mjs -Value "x"`), null, 'a new file');
  assert.equal(ps(`Set-Content -Path "$env:TEMP/x.txt" -Value "x"`), null, 'temp');
  assert.equal(ps(`Set-Content -Path ${tmp}/log.txt -Value "x"`), null);
  assert.equal(ps(`Set-Content -Path $x -Value "x"`), null, 'a path it cannot read');
  assert.equal(ps(`Get-Content lib/feed.mjs | Select-String a`), null);
  assert.equal(ps(`Get-Content lib/feed.mjs | Out-String`), null);
});

test('a > or >> redirect onto an existing TRACKED file is refused; temp, logs, /dev/null, new and untracked files are not', () => {
  denies('echo "x" > README.md');
  denies('echo "x" >> README.md');
  denies('cat a.txt >lib/feed.mjs');
  denies('node x.mjs 1>README.md');
  denies('cat >> README.md <<EOF\nmore\nEOF');
  leaves('echo "x" > notes.txt');                                                       // exists, but not tracked
  leaves('echo "x" > lib/brand-new.mjs');
  leaves('node x.mjs > "$TEMP/hub.log" 2>&1');
  leaves(`node x.mjs > ${tmp}/log.txt 2>&1`);
  leaves('node x.mjs > /dev/null 2>&1');
  leaves('node x.mjs 2>&1 | tee /dev/null');
  leaves('git log --oneline > "$TEMP/log.txt"');
  leaves('node -e "console.log(1 > 0)"');                                               // a > inside quoted code
  leaves('echo a >README.md.new');
});

test('git\'s own commands, committed project scripts and ordinary file work are not touched', () => {
  for (const c of ['git status', 'git diff -- lib/feed.mjs', 'git checkout -- lib/feed.mjs', 'git add -A && git commit -m "sed -i is not run here"', 'node tools/worktree-setup.mjs link ..', 'node --test test/x.test.mjs', 'npm test', 'cp lib/feed.mjs "$TEMP/feed.bak"', 'mv notes.txt old-notes.txt', 'rm -f notes.txt', 'ls -la | head', 'grep -rn "sed -i" lib/']) leaves(c);
  leaves('', {});
  assert.equal(inlineRewrite({ tool: 'Edit', command: 'sed -i x lib/feed.mjs', projectDir: proj, cwd: proj, tmp, home, isTracked }), null, 'only Bash and PowerShell');
});

test('the real tracked check: a file git tracks is refused, one it does not is not', () => {
  const d = makeTmp('crux-rewrites-git-').replace(/\\/g, '/');
  writeFileSync(`${d}/tracked.txt`, 'a'); writeFileSync(`${d}/loose.txt`, 'b');
  const git = (...a) => execFileSync('git', a, { cwd: d, stdio: 'ignore', windowsHide: true });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'T'); git('config', 'commit.gpgsign', 'false');
  git('add', 'tracked.txt'); git('commit', '-q', '-m', 'c');
  const r = c => inlineRewrite({ tool: 'Bash', command: c, cwd: d, projectDir: d, tmp, home });
  assert.equal(r('echo x > tracked.txt'), REWRITE_REASON);
  assert.equal(r('echo x > loose.txt'), null);
});

test('classify: a rewrite is reported on a request that was not a hard stop; a hard stop stays a hard stop with no rewrite', () => {
  const base = { tool: 'Bash', projectDir: proj, cwd: proj, tmp, home, agent: 'w', level: 'auto' };
  const c = classify({ ...base, input: { command: 'sed -i "s/a/b/" lib/feed.mjs' } });
  assert.equal(c.rewrite, REWRITE_REASON); assert.notEqual(c.route, 'human', 'a deny, never a hard stop');
  const stop = classify({ ...base, input: { command: 'sed -i "s/a/b/" lib/feed.mjs && git push --force origin main' } });
  assert.equal(stop.route, 'human'); assert.equal(stop.rewrite, undefined, 'the hard stop goes to Matt as before');
  assert.equal(classify({ ...base, input: { command: 'sed -n 1,3p lib/feed.mjs' } }).rewrite, undefined);
});

// ---- the hub: a deny with no card, no orchestrator and no check call ----
const sent = [];
Agent.prototype.send = function (t) { sent.push([this.name, t]); this.state = 'working'; };
Agent.prototype.close = function () { this.q = null; };
test('the hub refuses it at once: a deny with the reason, no card, no waiting entry, the check is not asked', async () => {
  const r2 = makeTmp('crux-rewrites-hub-');
  const dir = join(r2, 'proj');
  mkdirSync(join(dir, 'lib'), { recursive: true }); writeFileSync(join(dir, 'lib', 'feed.mjs'), 'x');
  const calls = [];
  const call = async arg => { calls.push(arg); return { text: JSON.stringify({ answer: 'allow', reason: 'ok' }), via: 'sdk', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, modelUsage: { [CHECK_MODEL]: { inputTokens: 1, outputTokens: 1, costUSD: 0 } }, costUSD: 0 }; };
  const hub = new Hub({ projects: [dir], memory: new Memory(join(r2, 'home')), settings: new HubSettings({ file: null }), checker: new PermissionCheck({ call, timeoutMs: 5000 }) });
  const p = hub.project('proj');
  p.board.addEntry({ kind: 'requirement', title: 'Orchestrator permission rules (test)', summary: 'rules', body: 'The orchestrator may ALLOW project work.', from: 'you' });
  const orch = hub.ensureOrchestrator(p); orch.q = {};
  const w = hub.startWorker(p, 'builder', 'Build it', 'you', 'Build it'); w.q = {};
  hub.setPermissionMode(p, 'auto');
  sent.length = 0;
  const before = p.log.ofType('approval').length;
  // The test project sits in the real temp folder, which the rule leaves alone: the hub's temp folder is moved for this request.
  const saved = [process.env.TEMP, process.env.TMP, process.env.TMPDIR];
  mkdirSync(join(r2, 'scratch'));
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = join(r2, 'scratch');
  let res;
  try { res = await hub.requestApproval(p, w, 'Bash', { command: 'sed -i "s/a/b/" lib/feed.mjs', description: 'edit' }); }
  finally { [process.env.TEMP, process.env.TMP, process.env.TMPDIR] = saved; if (saved[2] === undefined) delete process.env.TMPDIR; }
  assert.equal(res.behavior, 'deny');
  assert.match(res.message, /Use the Edit or Write tool to change files, not a command-line script/);
  assert.equal(p.log.ofType('approval').length, before, 'no card');
  assert.equal(calls.length, 0, 'the check was not asked');
  assert.equal(sent.filter(([n]) => n === orch.name).length, 0, 'the orchestrator was not asked');
  const ans = p.log.ofType('permission_answer').at(-1);
  assert.equal(ans.answer, 'deny'); assert.equal(ans.by, 'hub');
});

// ---- the standing line in every starter agent file, and the installed copies following it ----
const STARTER = join(import.meta.dirname, '..', '..', 'agent-types', 'starter');
const LINE = 'Change files with the Edit and Write tools, never with sed -i, inline node/python/PowerShell rewrites or shell redirects onto existing files.';
test('every starter agent file carries the standing line once, and has the hash of its earlier text listed so installed copies refresh', () => {
  const files = readdirSync(STARTER).filter(f => /\.md$/.test(f) && f !== 'README.md');
  assert.ok(files.length >= 23);
  const prev = JSON.parse(readFileSync(join(STARTER, 'previous-hashes.json'), 'utf8'));
  for (const f of files) {
    const text = readFileSync(join(STARTER, f), 'utf8').replace(/\r/g, '');
    assert.equal(text.split(LINE).length - 1, 1, `${f}: the line, once`);
    assert.ok(text.endsWith(LINE + '\n'), `${f}: it is the last line`);
    assert.ok(Array.isArray(prev[f]) && prev[f].length >= 1 && prev[f].every(h => /^[0-9a-f]{16}$/.test(h)), `${f}: earlier hashes listed`);
    assert.ok(!prev[f].includes(hashOf(text)), `${f}: the current text is not its own history`);
  }
});

test('start-up refresh now covers every starter agent file: an unedited older implementer.md is replaced, an edited one is kept', () => {
  const base = makeTmp('crux-refresh-all-');
  const starter = join(base, 'starter'), agents = join(base, 'agents');
  mkdirSync(starter); mkdirSync(agents);
  writeFileSync(join(starter, 'implementer.md'), 'NEW implementer\n'); writeFileSync(join(starter, 'reviewer.md'), 'NEW reviewer\n'); writeFileSync(join(starter, 'README.md'), 'readme\n');
  writeFileSync(join(starter, 'previous-hashes.json'), JSON.stringify({ 'implementer.md': [hashOf('OLD implementer\n')], 'reviewer.md': [hashOf('OLD reviewer\n')] }));
  writeFileSync(join(agents, 'implementer.md'), 'OLD implementer\r\n');
  writeFileSync(join(agents, 'reviewer.md'), 'OLD reviewer\nwith my own line\n');
  writeFileSync(join(agents, 'README.md'), 'not an agent\n');
  const lines = [];
  const r = refreshExpeditionFiles([agents], { starter, log: l => lines.push(l) });
  assert.equal(readFileSync(join(agents, 'implementer.md'), 'utf8'), 'NEW implementer\n');
  assert.equal(readFileSync(join(agents, 'reviewer.md'), 'utf8'), 'OLD reviewer\nwith my own line\n');
  assert.equal(readFileSync(join(agents, 'README.md'), 'utf8'), 'not an agent\n');
  assert.equal(r.refreshed.length, 1); assert.equal(r.kept.length, 1);
});
