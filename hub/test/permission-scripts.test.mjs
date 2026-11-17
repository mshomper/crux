// The script reader behind decision 67's Auto gate (kept by decision 73): which scripts a command runs, and whether each is
// committed and unchanged from main. Moved here from permission-check.test.mjs and permission-check-review.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeTmp } from './helpers/tmp.mjs';
import { scriptPaths, scriptsFor, loadsUnseen, isProjectScript, isCommittedFile, importsOf, defaultGit } from '../lib/permission-scripts.mjs';

// ---------- part 1: scripts ----------
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
function repo() {
  const root = makeTmp('crux-check-repo-');
  const dir = join(root, 'proj');
  mkdirSync(join(dir, 'tools'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'a@b.c'); git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'commit.gpgsign', 'false');
  return { root, dir };
}
const commit = (dir, msg = 'c') => { git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', msg); };

test('git: a file name is a name, never a pattern; ignored and untracked files are never committed code', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'tools', 'r.mjs'), 'console.log("r")');
  writeFileSync(join(dir, '.gitignore'), '*].mjs\nignored.mjs\n');
  commit(dir);
  assert.equal(await isCommittedFile(join(dir, 'tools', 'r.mjs'), { projectDir: dir }), true, 'a tracked, clean file is committed');
  // the reviewer's case: "[restart].mjs" is a pattern that matches r.mjs, and the .gitignore hides the file from status
  writeFileSync(join(dir, 'tools', '[restart].mjs'), 'console.log("evil")');
  assert.equal(await isCommittedFile(join(dir, 'tools', '[restart].mjs'), { projectDir: dir }), false, 'a file called [restart].mjs is not r.mjs');
  assert.equal(await isProjectScript(join(dir, 'tools', '[restart].mjs'), { projectDir: dir }), false);
  const r = await scriptsFor('node tools/[restart].mjs', { cwd: dir, projectDir: dir });
  assert.equal(r.unread, false, 'it is a file, found, and not trusted');
  assert.equal(r.scripts[0].kind, 'uncommitted');
  assert.equal(r.scripts[0].text, undefined, 'no script text is kept: the check is not sent it (decision 73)');
  // ignored (and so also untracked): never committed
  writeFileSync(join(dir, 'tools', 'ignored.mjs'), 'console.log("x")');
  assert.equal(await isCommittedFile(join(dir, 'tools', 'ignored.mjs'), { projectDir: dir }), false);
  // untracked, not ignored
  writeFileSync(join(dir, 'tools', 'new.mjs'), 'console.log("x")');
  assert.equal(await isCommittedFile(join(dir, 'tools', 'new.mjs'), { projectDir: dir }), false);
  // a tracked file changed in the tree
  writeFileSync(join(dir, 'tools', 'r.mjs'), 'console.log("changed")');
  assert.equal(await isCommittedFile(join(dir, 'tools', 'r.mjs'), { projectDir: dir }), false);
  // a name that git would take for an option
  writeFileSync(join(dir, 'tools', '--force.mjs'), 'x');
  assert.equal(await isCommittedFile(join(dir, 'tools', '--force.mjs'), { projectDir: dir }), false);
});

test('git: committed and unchanged from the merge-base with main; a branch edit is not main\'s', async () => {
  const { dir } = repo();
  writeFileSync(join(dir, 'tools', 'a.mjs'), 'console.log(1)');
  writeFileSync(join(dir, 'tools', 'b.mjs'), 'console.log(2)');
  commit(dir);
  git(dir, 'checkout', '-q', '-b', 'feat/x');
  writeFileSync(join(dir, 'tools', 'b.mjs'), 'console.log("worker edit")');
  commit(dir, 'edit b');
  assert.equal(await isCommittedFile(join(dir, 'tools', 'a.mjs'), { projectDir: dir }), true);
  assert.equal(await isCommittedFile(join(dir, 'tools', 'b.mjs'), { projectDir: dir }), false, 'committed on the branch, but changed from main');
});

test('git: the repo\'s own config cannot make the hub run a program (fsmonitor), and the hub asks git without locks', async () => {
  const { root, dir } = repo();
  writeFileSync(join(dir, 'tools', 'r.mjs'), 'console.log("r")');
  commit(dir);
  const marker = join(root, 'RAN');
  writeFileSync(join(root, 'fsm.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.stdout.write('\\0');`);
  git(dir, 'config', 'core.fsmonitor', `node ${join(root, 'fsm.js').replace(/\\/g, '/')}`);
  git(dir, 'status', '--porcelain');   // the control: a plain git status does run it
  const hookWorks = existsSync(marker);
  rmSync(marker, { force: true });
  assert.equal(await isCommittedFile(join(dir, 'tools', 'r.mjs'), { projectDir: dir }), true);
  assert.equal(existsSync(marker), false, `the hub's git calls did not run the configured program (the control ${hookWorks ? 'did' : 'could not'} run it)`);
  // it is asynchronous: the call returns a promise and the process runs beside the hub's own thread
  const p = defaultGit(['--version'], dir);
  assert.ok(typeof p.then === 'function');
  assert.equal((await p).code, 0);
});

// A fake git for the transitive cases: names tracked, names dirty.
const fakeGit = ({ tracked = [], dirty = [] } = {}) => async (args) => {
  const name = args.at(-1);
  if (args[0] === 'ls-files') return { code: tracked.includes(name) ? 0 : 1, out: '' };
  if (args[0] === 'status') return { code: 0, out: dirty.includes(name) ? ` M ${name}\n` : '' };
  if (args[0] === 'merge-base') return { code: 0, out: 'abc\n' };
  if (args[0] === 'diff') return { code: dirty.includes(name) ? 1 : 0, out: '' };
  return { code: 1, out: '' };
};
function tree(files) {
  const root = makeTmp('crux-check-tree-');
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 'tools'), { recursive: true });
  for (const [f, text] of Object.entries(files)) { mkdirSync(join(proj, f, '..'), { recursive: true }); writeFileSync(join(proj, f), text); }
  return proj;
}

test('committed means the entry script and everything it loads, down the chain', async () => {
  const proj = tree({
    'tools/entry.mjs': "import { a } from './a.mjs';\nconsole.log(a)",
    'tools/a.mjs': "import b from './b.mjs';\nexport const a = b;",
    'tools/b.mjs': 'export default 1;',
    'tools/lone.mjs': 'console.log(1)'
  });
  const all = ['entry.mjs', 'a.mjs', 'b.mjs', 'lone.mjs'];
  const run = (opts) => scriptsFor('node tools/entry.mjs', { cwd: proj, projectDir: proj, git: fakeGit(opts) });
  const ok = await run({ tracked: all });
  assert.deepEqual(ok.scripts.map(s => s.kind), ['committed'], 'every file down the chain is committed and clean');
  assert.equal(ok.unread, false);
  // the reviewer's case: a committed entry that imports a changed file
  const dirtyDep = await run({ tracked: all, dirty: ['b.mjs'] });
  assert.equal(dirtyDep.scripts[0].kind, 'uncommitted', 'two imports down, one file is changed: not committed, so the gate sends it to the check');
  const untrackedDep = await run({ tracked: ['entry.mjs', 'a.mjs'] });
  assert.equal(untrackedDep.scripts[0].kind, 'uncommitted');
  assert.equal(await isProjectScript(join(proj, 'tools', 'lone.mjs'), { projectDir: proj, git: fakeGit({ tracked: all }) }), true, 'no imports: just the file');
});

test('committed: an import that cannot be followed statically makes the script not committed', async () => {
  for (const [name, text] of [
    ['dyn', 'const n = process.argv[2];\nawait import(n);'],
    ['req', "const x = require(process.env.X);"],
    ['tpl', 'await import(`./x-${process.argv[2]}.mjs`);'],
    ['evalx', 'eval(process.argv[2]);'],
    ['gone', "import './not-there.mjs';"],
    ['alias', "import x from '#internal/x';"]
  ]) {
    const proj = tree({ [`tools/${name}.mjs`]: text });
    const r = await scriptsFor(`node tools/${name}.mjs`, { cwd: proj, projectDir: proj, git: fakeGit({ tracked: [`${name}.mjs`] }) });
    assert.equal(r.scripts[0].kind, 'uncommitted', `${name}: tracked and clean, but not followable, so not committed`);
  }
  // built-ins and packages are not files here
  const proj = tree({ 'tools/ok.mjs': "import fs from 'node:fs';\nimport z from 'zod';\nconsole.log(fs, z)" });
  assert.equal((await scriptsFor('node tools/ok.mjs', { cwd: proj, projectDir: proj, git: fakeGit({ tracked: ['ok.mjs'] }) })).scripts[0].kind, 'committed');
  assert.deepEqual(importsOf("import a from './a.mjs'; const b = require('../b.cjs'); await import('./c.mjs'); export * from './d.mjs';", join(proj, 'tools', 'x.mjs')).specs.map(s => s.replace(/\\/g, '/').split('/').pop()), ['a.mjs', 'd.mjs', 'b.cjs', 'c.mjs']);
});

test('committed: python follows its sibling modules too', async () => {
  const proj = tree({ 'tools/run.py': 'import helper\nhelper.go()', 'tools/helper.py': 'def go(): pass', 'tools/solo.py': 'print(1)' });
  const ok = await scriptsFor('python tools/run.py', { cwd: proj, projectDir: proj, git: fakeGit({ tracked: ['run.py', 'helper.py'] }) });
  assert.equal(ok.scripts[0].kind, 'committed');
  const bad = await scriptsFor('python tools/run.py', { cwd: proj, projectDir: proj, git: fakeGit({ tracked: ['run.py', 'helper.py'], dirty: ['helper.py'] }) });
  assert.equal(bad.scripts[0].kind, 'uncommitted');
});

test('package scripts: npm run reads the package.json text; its commands are read in turn, so a changed file behind it is seen', async () => {
  const proj = tree({ 'package.json': JSON.stringify({ scripts: { go: 'node tools/x.mjs', pretest: 'node tools/pre.mjs', test: 'node --test tools/x.mjs' } }), 'tools/x.mjs': 'console.log(1)', 'tools/pre.mjs': 'console.log(0)' });
  const g = fakeGit({ tracked: ['package.json', 'x.mjs', 'pre.mjs'] });
  const ok = await scriptsFor('npm run go', { cwd: proj, projectDir: proj, git: g });
  assert.deepEqual(ok.scripts.map(s => s.kind), ['committed', 'committed'], 'package.json and the script it runs');
  assert.equal(ok.unread, false);
  const edited = await scriptsFor('npm run go', { cwd: proj, projectDir: proj, git: fakeGit({ tracked: ['package.json', 'x.mjs'], dirty: ['x.mjs'] }) });
  assert.ok(edited.scripts.some(s => /x\.mjs$/.test(s.path) && s.kind === 'uncommitted'), 'the changed file behind a committed package script is not committed');
  const hooks = await scriptsFor('npm test', { cwd: proj, projectDir: proj, git: g });
  assert.equal(hooks.scripts.filter(s => /pre\.mjs$/.test(s.path)).length, 1, 'npm test also runs pretest');
  assert.equal((await scriptsFor('npm run nope', { cwd: proj, projectDir: proj, git: g })).unread, true);
  assert.equal((await scriptsFor('npm run go', { cwd: join(proj, 'tools'), projectDir: proj, git: g })).scripts[0].kind, 'committed', 'found from a subfolder');
});

test('a cd in the command: later parts are looked for where they really run', async () => {
  const proj = tree({ 'sub/package.json': JSON.stringify({ scripts: { test: 'node run.mjs' } }), 'sub/run.mjs': 'console.log(1)', 'tools/x.mjs': 'console.log(2)', 'x.mjs': 'console.log("the one in the root")' });
  const g = fakeGit({ tracked: ['package.json', 'run.mjs', 'x.mjs'] });
  const run = c => scriptsFor(c, { cwd: proj, projectDir: proj, git: g });
  const a = await run('cd sub && npm test');
  assert.deepEqual(a.scripts.map(s => s.kind), ['committed', 'committed'], 'the package.json and run.mjs in sub');
  assert.equal(a.unread, false);
  const b = await run('cd tools && node x.mjs');
  assert.ok(b.scripts[0].path.replace(/\\/g, '/').endsWith('tools/x.mjs'), 'x.mjs in tools, not the one in the root');
  assert.equal((await run('cd tools; cd .. && node x.mjs')).scripts[0].path.replace(/\\/g, '/').endsWith('proj/x.mjs'), true, 'back up again');
  // not worked out from the text: unread
  for (const c of ['cd $X && node x.mjs', '(cd tools; node x.mjs); node x.mjs', 'cd tools || node x.mjs', 'cd - && node x.mjs', 'cd', 'Set-Location $env:Z; node x.mjs'])
    assert.equal((await run(c)).unread, true, c);
});


test('which scripts a command runs', () => {
  assert.deepEqual(scriptPaths('node hub/server.mjs --port 4800'), ['hub/server.mjs']);
  assert.deepEqual(scriptPaths('cd x && node --import ./pre.mjs app.mjs; python3 tools/a.py'), ['./pre.mjs', 'app.mjs', 'tools/a.py']);
  assert.deepEqual(scriptPaths('node --test test/*.test.mjs'), ['test/*.test.mjs']);
  assert.deepEqual(scriptPaths('pwsh -File .\\run.ps1 -NoProfile', { shell: 'powershell' }), ['.\\run.ps1']);
  assert.deepEqual(scriptPaths('& "C:\\tools\\go.ps1"', { shell: 'powershell' }), ['C:\\tools\\go.ps1']);
  assert.deepEqual(scriptPaths('FOO=1 timeout 5 bash ./x.sh'), ['./x.sh']);
  assert.deepEqual(scriptPaths('./build.sh && git status'), ['./build.sh']);
  assert.deepEqual(scriptPaths('node -e "require(\'./x.js\')"'), [], 'inline code is read in the command itself');
  assert.deepEqual(scriptPaths('cat a.mjs; git add b.mjs; grep x c.py'), [], 'reading a script is not running it');
});

test('what a script loads that the check cannot see', () => {
  assert.deepEqual(loadsUnseen("import { a } from './lib.mjs';\nconsole.log(a)"), ['imports another file']);
  assert.deepEqual(loadsUnseen("import {\n a,\n b\n} from '../x.mjs'"), ['imports another file']);
  assert.deepEqual(loadsUnseen("const x = require('./y.js')"), ['requires another file']);
  assert.ok(loadsUnseen('await import(name)').includes('loads a file named at run time'));
  assert.ok(loadsUnseen('eval(code)').includes('evals text'));
  assert.deepEqual(loadsUnseen("import fs from 'node:fs'; import { x } from 'some-pkg'; fs.readFileSync('a')"), [], 'built-ins and packages are not other files');
  assert.ok(loadsUnseen('. ./lib.ps1\nGet-Date').includes('sources another script'));
  assert.ok(loadsUnseen('iex $s').includes('evals text'));
  assert.ok(loadsUnseen('node other.mjs').includes('runs another script'));
  assert.deepEqual(loadsUnseen('print(1)', { python: true }), []);
  assert.ok(loadsUnseen('exec(open("a").read())', { python: true }).length);
});

// A fake git: tracked files, what is changed in the tree, and what differs from main.
const fakeGitB = ({ tracked = [], dirty = [], changedFromMain = [], noMain = false } = {}) => (args, cwd) => {
  const name = args.at(-1);
  if (args[0] === 'ls-files') return { code: tracked.includes(name) ? 0 : 1, out: '' };
  if (args[0] === 'status') return { code: 0, out: dirty.includes(name) ? ` M ${name}\n` : '' };
  if (args[0] === 'merge-base') return noMain ? { code: 128, out: '' } : { code: 0, out: 'abc123\n' };
  if (args[0] === 'diff') return { code: changedFromMain.includes(name) ? 1 : 0, out: '' };
  return { code: 1, out: '' };
};

function scriptDir() {
  const root = makeTmp('crux-check-scripts-');
  const proj = join(root, 'proj'), outside = join(root, 'elsewhere');
  mkdirSync(join(proj, 'tools'), { recursive: true }); mkdirSync(outside, { recursive: true });
  writeFileSync(join(proj, 'tools', 'tracked.mjs'), 'console.log(1)');
  writeFileSync(join(proj, 'tools', 'edited.mjs'), 'console.log(2)');
  writeFileSync(join(proj, 'tools', 'worker.mjs'), 'console.log(3)');
  writeFileSync(join(proj, 'tools', 'loader.mjs'), "import { x } from './lib.mjs';\nconsole.log(x)");
  writeFileSync(join(outside, 'tracked.mjs'), 'console.log(4)');
  return { root, proj, outside };
}

test('scripts: a committed, unchanged project script is "committed"; any other file is "uncommitted" and nothing of it is kept', async () => {
  const { proj, outside } = scriptDir();
  const git = fakeGitB({ tracked: ['tracked.mjs', 'edited.mjs', 'loader.mjs'], dirty: ['edited.mjs'] });
  const r = await scriptsFor('node tools/tracked.mjs && node tools/edited.mjs && node tools/worker.mjs', { cwd: proj, projectDir: proj, git });
  const by = n => r.scripts.find(s => s.path.endsWith(n));
  assert.equal(by('tracked.mjs').kind, 'committed');
  assert.equal(by('edited.mjs').kind, 'uncommitted', 'changed in the tree');
  assert.equal(by('worker.mjs').kind, 'uncommitted', 'not tracked');
  assert.equal(r.unread, false, 'every script was found as a file');
  // the path, the kind and, for an uncommitted one, the failed files of its chain: no text, size or budget kept here (the check's
  // request reads the text itself, permission-check.mjs scriptTexts)
  for (const s of r.scripts) assert.deepEqual(Object.keys(s).sort(), s.kind === 'committed' ? ['kind', 'path'] : ['doubts', 'files', 'kind', 'path'], 'no text, size or budget kept');
  assert.deepEqual(by('edited.mjs').files.map(f => f.path), [by('edited.mjs').path], 'the changed file itself is the failed one');
  assert.equal(by('edited.mjs').files[0].changed, true);
  // changed from main by a commit on the worker's branch: not main's script
  assert.equal(await isProjectScript(join(proj, 'tools', 'tracked.mjs'), { projectDir: proj, git: fakeGitB({ tracked: ['tracked.mjs'], changedFromMain: ['tracked.mjs'] }) }), false);
  assert.equal(await isProjectScript(join(proj, 'tools', 'tracked.mjs'), { projectDir: proj, git: fakeGitB({ tracked: ['tracked.mjs'], noMain: true }) }), false, 'no main to compare with: not trusted');
  assert.equal(await isProjectScript(join(outside, 'tracked.mjs'), { projectDir: proj, git: fakeGitB({ tracked: ['tracked.mjs'] }) }), false, 'outside the project is not project code');
});

test('scripts: loading other files, missing, built from a variable, too many: not fully resolved', async () => {
  const { proj } = scriptDir();
  const git = fakeGitB({ tracked: [] });
  const loads = await scriptsFor('node tools/loader.mjs', { cwd: proj, projectDir: proj, git });
  assert.equal(loads.scripts[0].kind, 'uncommitted', 'a script that imports a file: not committed, so the gate sends it to the check');
  for (const [cmd, why] of [['node tools/nope.mjs', /does not exist/], ['node $f.mjs', /built at run time/], ['node tools/*.nomatch.mjs', /no file matches/]]) {
    const r = await scriptsFor(cmd, { cwd: proj, projectDir: proj, git });
    assert.equal(r.unread, true, cmd);
    assert.match(r.scripts[0].note, why, cmd);
  }
  const same = await scriptsFor(Array.from({ length: 12 }, () => 'node tools/worker.mjs').join(' && '), { cwd: proj, projectDir: proj, git });
  assert.equal(same.unread, false, 'the same file twice is one script');
  for (let i = 0; i < 6; i++) writeFileSync(join(proj, 'tools', `extra${i}.mjs`), 'console.log(0)');
  const many = await scriptsFor('node --test tools/*.mjs', { cwd: proj, projectDir: proj, git });   // 10 files
  assert.equal(many.unread, true, 'more scripts than can be listed: the rest are not seen');
  assert.ok(many.scripts.some(s => /more scripts/.test(s.path)));
  const inline = await scriptsFor(`node -e "import('./x.mjs')"`, { cwd: proj, projectDir: proj, git });
  assert.equal(inline.unread, true, 'inline code that loads a file');
  assert.equal((await scriptsFor('git status', { cwd: proj, projectDir: proj, git })).scripts.length, 0);
  assert.equal((await scriptsFor('git status', { cwd: proj, projectDir: proj, git })).unread, false);
});

// HIGH 1 (review of #91): every way of starting a script the hub cannot resolve to a file and read in full is unread.
test('unread: an interpreter or runner whose script cannot be read in full, however it is written', async () => {
  const root = makeTmp('crux-check-unread-');
  const proj = join(root, 'proj');
  mkdirSync(join(proj, 'tools'), { recursive: true });
  writeFileSync(join(proj, 'evil.mjs'), 'console.log("evil")');
  writeFileSync(join(proj, 'tools', 'evil.js'), 'console.log("evil")');   // node tools/evil finds this one
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ scripts: { build: 'node evil.mjs', lint: 'echo ok' } }));
  const git = fakeGitB({ tracked: [] });   // nothing is committed
  const isUnread = async cmd => (await scriptsFor(cmd, { cwd: proj, projectDir: proj, git }));
  // the reviewer's list (with a script that is not there to be read): each of these must come out unread
  for (const cmd of [
    'node ghost.mjs -c fast', 'node ./ghost.mjs -p', 'bash -c "node ghost.mjs"', 'cat ghost.mjs | node', 'node tools/ghost', 'python -m ghost', 'npm run ghost',
    'node --test', 'node $(echo evil.mjs)',
    // and the same idea in other shapes
    'sh -c "node ghost.mjs"', 'bash -lc "node ghost.mjs"', 'pwsh -File ghost.ps1', 'pwsh -Command "node ghost.mjs"', 'powershell -NoProfile -c "node ghost.mjs"',
    'cmd /c node ghost.mjs', 'npx evil', 'npm exec evil', 'deno run ghost.ts', 'node -', 'python -', 'python3 ghost.py', 'node `echo evil.mjs`', 'echo $(node ghost.mjs)',
    'pnpm run nothing-here', 'yarn nothing-here', 'uv run python ghost.py', 'make', 'cargo run', 'bash', 'node', 'pwsh -EncodedCommand AAAA', 'Start-Process node -ArgumentList ghost.mjs',
    'xargs node ghost.mjs', 'npm run build --prefix other', 'node --import ./ghost-loader.mjs evil.mjs', 'node -e "require(\'child_process\').execSync(\'node evil.mjs\')"',
    'iex $payload', 'eval "$x"', 'node evil.mjs $(date)', 'python evil.py `x`'
  ]) {
    const r = await isUnread(cmd);
    assert.equal(r.unread, true, `${cmd} must be unread: ${JSON.stringify(r.scripts.map(s => [s.path, s.kind, s.note]))} ${r.inlineLoads}`);
  }
  // an arrow after the script is its argument, not the interpreter's own flag
  const a = await isUnread('node evil.mjs -c fast');
  assert.deepEqual(a.scripts.map(s => s.path.endsWith('evil.mjs') && s.kind), ['uncommitted'], 'the script is found, not skipped');
  // the ones that resolve to a file are not unread: the file is found and, being uncommitted, goes to the check
  for (const cmd of ['node evil.mjs', 'node ./evil.mjs -p', 'bash -c "node evil.mjs"', 'node tools/evil', 'npm run build', 'node --test evil.mjs']) {
    const r = await isUnread(cmd);
    assert.equal(r.unread, false, `${cmd} resolves to a file: ${JSON.stringify(r.scripts.map(s => [s.path, s.kind, s.note]))}`);
    assert.ok(r.scripts.some(s => s.kind === 'uncommitted' && /evil\.(mjs|js)$/.test(s.path)), cmd);
  }
  assert.equal((await isUnread('git status && npm run lint')).unread, false, 'a package script that runs no file: package.json is the only file');
  assert.equal((await isUnread('git status')).unread, false);
  assert.equal((await isUnread('node -e "console.log(1)"')).unread, false, 'inline code that loads nothing');
  assert.equal((await isUnread('python3 -c "print(1)"')).unread, false);
  assert.equal((await isUnread('node - <<\'EOF\'\nconsole.log(1)\nEOF')).unread, false, 'a heredoc is code in the command itself');
});

