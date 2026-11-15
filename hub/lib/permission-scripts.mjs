// Which scripts a worker's command runs, and whether the permission check has seen them in full (plan v3 B2).
// Pulled out of permission-check.mjs. The rule it serves: a script the hub cannot resolve to a file and read in full
// (or that is not "committed and unchanged from main", with everything it loads) makes the request "unread", and an
// unread request is never allowed by the check (permission-check.mjs applyRules).
//
// parseCommand() reads the command text only (no files): which interpreters and runners it starts, and with what.
// scriptsFor() then looks at the files. Anything it cannot work out is unread: an unknown shape fails safe.
import { execFile } from 'node:child_process';
import { existsSync, statSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, basename, resolve, join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

export const SCRIPT_LIMIT = 16 * 1024;               // plan B2: attach a script in full up to about 16 KB
export const SCRIPTS_TOTAL = 48 * 1024;              // and no more than this much script text in one call
export const MAX_SCRIPTS = 8;
const MAX_NEST = 4;                                  // a command inside a command inside a package script ...
const MAX_FILES = 60, MAX_FILE_BYTES = 1024 * 1024;  // following imports of a committed script

const SCRIPT_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|sh|bash|ps1|psm1|bat|cmd|rb|pl|php)$/i;
const DYN = '\u0001';                                // stands in for $(...) and `...` in the command text

// ---------- reading the command ----------
// $(...) and `...` are pulled out (they run commands of their own) and left as a marker in the text.
function pullSubs(cmd) {
  let out = '', i = 0, sq = false, dq = false;
  const subs = [];
  while (i < cmd.length) {
    const c = cmd[i];
    if (!sq && c === '"' && cmd[i - 1] !== '\\') dq = !dq;
    else if (!dq && c === "'") sq = !sq;
    if (!sq && c === '$' && cmd[i + 1] === '(') {
      let depth = 1, j = i + 2;
      while (j < cmd.length && depth) { if (cmd[j] === '(') depth++; else if (cmd[j] === ')') depth--; j++; }
      subs.push(cmd.slice(i + 2, depth ? j : j - 1));
      out += DYN; i = j; continue;
    }
    if (!sq && c === '`') {
      const j = cmd.indexOf('`', i + 1);
      if (j > 0) { subs.push(cmd.slice(i + 1, j)); out += DYN; i = j + 1; continue; }
    }
    out += c; i++;
  }
  return { text: out, subs };
}
const words = seg => (seg.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) || []).map(w => w.replace(/^["']|["']$/g, ''));
// Split at ; | & newlines and brackets (not inside quotes): each part is one command.
function segments(cmd) {
  const out = []; let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) { if (c === q && cmd[i - 1] !== '\\') q = null; cur += c; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ('\n;|&(){}'.includes(c)) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}
const dynamic = x => x.includes(DYN) || /\$[\w{(]|%\w+%|^~/.test(x);
const bareSpec = s => !/^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:|file:)/.test(s);   // a package name: dependency code, not a file here
const SHELLS = /^(bash|sh|zsh|dash|ksh|ash)$/;
const NODEISH = /^(node|nodejs|tsx|ts-node|ts-node-esm)$/;
const PYTHONISH = /^(python[\d.]*|py|pypy[\d.]*)$/;
const NODE_VALUE = new Set(['--input-type', '-C', '--conditions', '--title', '--env-file', '--stack-trace-limit', '--test-name-pattern', '--test-reporter', '--test-concurrency', '--test-timeout']);
const PM_BUILTIN = new Set(['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'list', 'ls', 'info', 'why', 'init', 'link', 'unlink', 'audit', 'outdated', 'config', 'cache', 'store', 'publish', 'pack', 'version', 'help', 'import', 'prune', 'rebuild', 'dedupe', 'fetch', 'patch', 'licenses', 'create', 'set', 'get', 'workspace', 'workspaces', 'env', 'login', 'logout', 'whoami', 'view', 'search', 'ci', 'cit', 'ddp', 'doctor', 'explain', 'diff', 'pkg']);

// What a command starts. files: { path, mode } with mode 'file' (as written), 'node' (a node entry: may omit the
// extension), 'module' (python -m), 'direct' (a path used as the command word). inline: code written in the command.
// nested: command text to read in turn (bash -c "...", $(...)). runners: npm-style script names. unread: why not.
export function parseCommand(cmd) {
  const out = { files: [], inline: [], nested: [], runners: [], unread: [] };
  const { text, subs } = pullSubs(String(cmd || ''));
  out.nested.push(...subs.map(s => ({ cmd: s, at: '' })));
  // "cd hub && npm test": the folder a later part of the command runs in. Each file, runner and nested command is
  // tagged with it (`at`, relative to where the whole command runs), so it is looked for where it really is.
  let at = '';
  const tagNew = () => {
    for (const x of [...out.files, ...out.runners]) if (x.at === undefined) x.at = at;
    out.nested = out.nested.map(n => (typeof n === 'string' ? { cmd: n, at } : n));
  };
  for (const seg of segments(text)) {
    tagNew();
    let w = words(seg);
    for (;;) {   // VAR=x in front, and wrappers: timeout 5 node x.mjs, env X=1 node x.mjs, sudo ..., . ./x.sh (sourced)
      if (!w.length) break;
      if (/^[A-Za-z_]\w*=/.test(w[0])) { w.shift(); continue; }
      if (/^(timeout|time|nohup|env|call|start|sudo|exec|command|nice|builtin)$/i.test(w[0]) && w.length > 1) { w.shift(); while (w.length && (/^(-\S+|\d+(\.\d+)?[smhd]?)$/.test(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]))) w.shift(); continue; }
      break;
    }
    if (!w.length) continue;
    const word0 = w[0], rest = w.slice(1);
    const head = basename(word0.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();
    if (/^(cd|chdir|pushd|set-location|sl)$/.test(head)) {
      const arg = rest.find(x => !/^\/d$/i.test(x) && !/^-(path|literalpath|l|p)$/i.test(x));
      // a folder it cannot work out, or a cd inside a group or after ||, whose reach cannot be told from the text
      if (!arg || arg === '-' || dynamic(arg) || /[(){}]/.test(text) || text.includes('||')) out.unread.push({ head: 'cd', why: 'moves to a folder the hub cannot work out' });
      else at = isAbsolute(arg) ? arg : join(at || '.', arg);
      continue;
    }
    if (word0 === '.' || head === 'source') {   // ". ./x.sh", "source x.sh"
      if (rest[0] && !dynamic(rest[0])) out.files.push({ path: rest[0], mode: 'file' }); else if (rest[0]) out.unread.push({ head: 'source', why: 'its path is built at run time' });
      continue;
    }
    if (head === 'xargs') {   // xargs [flags] cmd args: the rest is a command
      let i = 0;
      while (i < rest.length && rest[i].startsWith('-')) i += /^-[INPdELsa]$/.test(rest[i]) ? 2 : 1;
      if (i < rest.length) out.nested.push(rest.slice(i).join(' ')); continue;
    }
    if (/^(start-process|saps)$/.test(head)) {
      let file = null, args = [], i = 0;
      for (; i < rest.length; i++) {
        const lx = rest[i].toLowerCase();
        if (lx === '-filepath') file = rest[++i];
        else if (lx === '-argumentlist') { args = rest.slice(i + 1); break; }
        else if (/^-(windowstyle|workingdirectory|redirectstandard\w+|verb|credential)$/.test(lx)) i++;
        else if (!rest[i].startsWith('-')) { if (file === null) file = rest[i]; else args.push(rest[i]); }
      }
      if (file) out.nested.push([file, ...args].join(' ').replace(/,/g, ' ')); else out.unread.push({ head, why: 'what it starts is not clear' });
      continue;
    }
    const interp = NODEISH.test(head) || PYTHONISH.test(head) || SHELLS.test(head) || /^(pwsh|powershell|cmd|ruby|perl|php|deno|bun|bunx|npx|pnpx|npm|pnpm|yarn|uv|poetry|pipx|cargo|go|dotnet|make|gmake|nmake|just|task)$/.test(head);
    if (interp) {
      if (rest.some(dynamic) || dynamic(word0)) { out.unread.push({ head, why: 'its arguments are built at run time' }); continue; }
      starts(head, rest, out, cmd);
    } else if (SCRIPT_EXT.test(word0)) out.files.push({ path: word0, mode: 'file' });   // the command word is itself a script: ./run.sh, x.ps1, build.bat
    else if (/[\\/]/.test(word0)) out.files.push({ path: word0, mode: 'direct' });      // ./tool, .\tool: a program in the project, if it is one
  }
  tagNew();
  return out;
}

function starts(head, rest, out, cmd) {
  const unread = why => out.unread.push({ head, why });
  const stdin = () => (/<<-?\s*['"]?\w+/.test(cmd) ? out.inline.push({ code: cmd, heredoc: true }) : unread('reads its code from standard input'));
  const file = (path, mode = 'file') => out.files.push({ path, mode });
  if (NODEISH.test(head)) {
    let test = false;
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (/^(-e|-p|-pe|--eval|--print)$/.test(x)) { out.inline.push({ code: rest[i + 1] ?? '' }); return; }   // what follows is the code's own arguments
      const ev = /^--(?:eval|print)=([\s\S]*)$/.exec(x);
      if (ev) { out.inline.push({ code: ev[1] }); return; }
      if (/^(-r|--require|--import|--loader|--experimental-loader)$/.test(x)) { const v = rest[++i]; if (v === undefined) unread('a preload with no name'); else if (!bareSpec(v)) file(v); continue; }
      const pl = /^--(?:import|require|loader|experimental-loader)=([\s\S]*)$/.exec(x);
      if (pl) { if (!bareSpec(pl[1])) file(pl[1]); continue; }
      if (x === '--test') { test = true; continue; }
      if (x === '-') return stdin();
      if (NODE_VALUE.has(x)) { i++; continue; }
      if (x === '--') { const next = rest.slice(i + 1); if (next[0]) file(next[0], 'node'); else unread('no script named'); return; }
      if (x.startsWith('-')) continue;
      if (test) { for (const f of rest.slice(i)) if (!f.startsWith('-')) file(f, 'node'); return; }
      return file(x, 'node');   // the first positional is the script; the rest are its own arguments, even "-c" or "-p"
    }
    return test ? unread('runs every test file it finds') : stdin();
  }
  if (PYTHONISH.test(head)) {
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (x === '-c') { out.inline.push({ code: rest[i + 1] ?? '', python: true }); return; }
      if (x === '-m') { if (rest[i + 1]) file(rest[i + 1], 'module'); else unread('no module named'); return; }
      if (/^-m./.test(x)) return file(x.slice(2), 'module');
      if (x === '-') return stdin();
      if (/^-[WXQ]$/.test(x)) { i++; continue; }
      if (x.startsWith('-')) continue;
      return file(x);
    }
    return stdin();
  }
  if (SHELLS.test(head)) {
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (/^-[A-Za-z]*c$/.test(x)) { if (rest[i + 1] === undefined) unread('no command given'); else out.nested.push(rest[i + 1]); return; }
      if (x === '-s') return stdin();
      if (/^[-+]o$|^--(rcfile|init-file)$/.test(x)) { i++; continue; }
      if (x.startsWith('-') || x.startsWith('+')) continue;
      return file(x);
    }
    return stdin();
  }
  if (/^(pwsh|powershell)$/.test(head)) {
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i], lx = x.toLowerCase();
      if (/^-(f|file)$/.test(lx)) { if (rest[i + 1] === undefined) unread('no file named'); else file(rest[i + 1]); return; }
      if (/^-(c|command|cm|com\w*)$/.test(lx)) { out.nested.push(rest.slice(i + 1).join(' ')); return; }
      if (/^-(e|ec|enc\w*)$/.test(lx)) return unread('runs an encoded command');
      if (/^-(ep|executionpolicy|windowstyle|w|wd|workingdirectory|inputformat|if|outputformat|of|version|psconsolefile|configurationname|settingsfile)$/.test(lx)) { i++; continue; }
      if (x.startsWith('-')) continue;
      if (SCRIPT_EXT.test(x)) return file(x);
      out.nested.push(rest.slice(i).join(' ')); return;
    }
    return stdin();
  }
  if (head === 'cmd') {
    const k = rest.findIndex(x => /^\/{1,2}[ck]$/i.test(x));
    return k < 0 ? unread('opens a command prompt') : void out.nested.push(rest.slice(k + 1).join(' '));
  }
  if (/^(ruby|perl|php)$/.test(head)) {
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (x === '-e' || (head === 'php' && x === '-r')) { out.inline.push({ code: rest[i + 1] ?? '' }); return; }
      if (x === '-') return stdin();
      if (x.startsWith('-')) continue;
      return file(x);
    }
    return stdin();
  }
  if (head === 'deno') {
    const sub = rest.find(x => !x.startsWith('-')), after = rest.slice(rest.indexOf(sub) + 1).filter(x => !x.startsWith('-'));
    if (sub === 'run') { const t = after[0]; if (!t) return unread('no script named'); return /^(https?|npm|jsr|data):/i.test(t) ? unread('runs code from the internet') : file(t, 'node'); }
    if (sub === 'task') return unread('runs a task from deno.json');
    if (sub === 'eval') { out.inline.push({ code: after[0] ?? '' }); return; }
    if (sub === 'test' || sub === 'bench') { const fs = after.filter(f => SCRIPT_EXT.test(f)); return fs.length ? fs.forEach(f => file(f, 'node')) : unread('runs every test file it finds'); }
    if (sub === 'repl') return unread('opens a prompt');
    return;
  }
  if (/^(bunx|npx|pnpx)$/.test(head)) return unread('downloads and runs a package');
  if (/^(bun|npm|pnpm|yarn)$/.test(head)) {
    const dd = rest.indexOf('--'), args = dd < 0 ? rest : rest.slice(0, dd);
    if (args.some(x => /^(--prefix|-C|--workspace|-w|--workspaces|-ws|--cwd|--dir|-F|--filter|--include-workspace-root)(=|$)/.test(x))) return unread('runs a package script in another folder');
    const pos = args.filter(x => !x.startsWith('-'));
    const sub = pos[0];
    if (!sub) return;
    if (head === 'bun' && (SCRIPT_EXT.test(sub) || /[\\/]/.test(sub))) return file(sub, 'node');
    if (['exec', 'dlx', 'x'].includes(sub)) return unread('downloads and runs a package');
    let name = null;
    if (['run', 'run-script', 'rum', 'urn'].includes(sub)) name = pos[1];
    else if (head === 'npm') name = { test: 'test', t: 'test', tst: 'test', start: 'start', stop: 'stop', restart: 'restart' }[sub] || null;
    else if (!PM_BUILTIN.has(sub)) name = sub;   // pnpm and yarn run a package script by its bare name
    if (head === 'bun' && sub === 'test' && !pos[1]) return unread('runs every test file it finds');
    if (name && head === 'bun' && (SCRIPT_EXT.test(name) || /[\\/]/.test(name))) return file(name, 'node');
    if (name) out.runners.push({ tool: head, name, hooks: head === 'npm' });
    return;
  }
  if (/^(uv|poetry|pipx|hatch|pdm)$/.test(head)) {
    const i = rest.indexOf('run');
    if (i < 0) return;
    if (head === 'pipx') return unread('downloads and runs a package');
    const tail = rest.slice(i + 1);
    let j = 0;
    while (j < tail.length && /^(--no-sync|--frozen|--locked|--offline|--quiet|-q|--no-project)$/.test(tail[j])) j++;
    if (j >= tail.length) return unread('no command named');
    if (tail[j].startsWith('-')) return unread('an option the hub does not read');
    out.nested.push(tail.slice(j).join(' '));
    return;
  }
  if (/^(cargo|dotnet)$/.test(head)) { if (rest.some(x => /^(run|test|bench|build|check|clippy|doc|watch)$/.test(x))) unread('builds and runs project code the hub does not read'); return; }
  if (head === 'go') { if (rest.some(x => /^(run|test|generate)$/.test(x))) unread('builds and runs project code the hub does not read'); return; }
  if (/^(make|gmake|nmake|just|task)$/.test(head)) return unread('runs commands from a build file the hub does not read');
}

// The script paths as written, for the tests and the simple cases.
export function scriptPaths(cmd) {
  return [...new Set(parseCommand(cmd).files.map(f => f.path))];
}

// ---------- text that loads something unseen ----------
// Reasons text loads, runs or evals something the check cannot see (empty: nothing found).
export function loadsUnseen(text, { python = false, dir = '', skipRuns = false } = {}) {
  const t = String(text || ''), why = [];
  const add = s => { if (!why.includes(s)) why.push(s); };
  if (/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"](?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:|file:|#)/.test(t) || /^\s*import\s*['"](?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:|file:|#)/m.test(t)) add('imports another file');
  if (/\b(?:require|import)\s*\(\s*['"`](?:\.{1,2}[\\/]?|[\\/]|[A-Za-z]:|file:|#)/.test(t)) add('requires another file');
  if (/\b(?:require|import)\s*\(\s*[^'"`)\s]/.test(t)) add('loads a file named at run time');
  if (/\b(?:eval|execScript)\s*\(|\bnew\s+Function\b|\bFunction\s*\(/.test(t) && !python) add('evals text');
  if (python) {
    if (/\b(?:exec|eval|__import__|compile)\s*\(|\brunpy\b|\bimportlib\b/.test(t)) add('runs text or loads a file named at run time');
    for (const m of t.matchAll(/^\s*(?:from\s+(\.+\w*|\w+)\s+import|import\s+(\w+))/gm)) {
      const mod = m[1] || m[2];
      if (/^\./.test(mod)) add('imports a sibling module');
      else if (dir && (existsSync(join(dir, `${mod}.py`)) || existsSync(join(dir, mod, '__init__.py')))) add(`imports ${mod}.py, next to it`);
    }
  }
  if (/^\s*(?:source|\.)\s+[^\s=]/m.test(t) || /^\s*\.\s+["'$]/m.test(t)) add('sources another script');
  if (/\b(?:iex|Invoke-Expression)\b/i.test(t)) add('evals text');
  if (/\bImport-Module\s+\S/i.test(t) || /\bInvoke-Command\b[^\n]*-FilePath/i.test(t)) add('loads another script or module');
  if (/(?:^|[;\s])&\s*\$\w/.test(t)) add('runs a command named in a variable');
  if (!skipRuns && /\b(?:node|nodejs|python[\d.]*|py|bash|sh|pwsh|powershell|ruby|perl)\s+(?:-\S+\s+)*["']?[\w.\\/:~$-]+\.(?:mjs|cjs|js|py|sh|ps1|rb|pl)\b/i.test(t)) add('runs another script');
  return why;
}

// ---------- git (never blocks the hub; never lets the repo's own config run anything) ----------
// Literal pathspecs, so a file name is a name and never a pattern ("[restart].mjs" matches only that file). No
// optional locks. fsmonitor off, so a repo's own config cannot make `git status` run a program. Always resolves.
export function defaultGit(args, cwd) {
  const flags = ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'diff.external='];
  return new Promise(done => {
    execFile('git', [...flags, ...args], { cwd, encoding: 'utf8', timeout: 8000, windowsHide: true, maxBuffer: 1 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } },
      (err, stdout) => done(err ? { code: typeof err.code === 'number' ? err.code : -1, out: String(stdout || '') } : { code: 0, out: String(stdout || '') }));
  });
}
const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const within = (p, root) => norm(p) === norm(root) || norm(p).startsWith(norm(root) + '/');

// One file: inside the project (or one of its worktrees), tracked by git, not ignored, not changed in the working tree
// or index, not a link, and the same as at the merge-base with main (a worker's own committed edit is not main's).
// Anything git cannot confirm is false. cache: a Map shared by one request, so each file and ref is asked about once.
export async function isCommittedFile(file, { projectDir, git = defaultGit, mainRefs = ['origin/main', 'main'], cache = new Map() } = {}) {
  try {
    const key = `f:${norm(file)}`;
    if (cache.has(key)) return cache.get(key);
    const ok = await (async () => {
      if (!projectDir || !within(realpathSync(file), realpathSync(projectDir))) return false;
      if (lstatSync(file).isSymbolicLink()) return false;
      const dir = dirname(file), name = basename(file);
      if ((await git(['ls-files', '--error-unmatch', '--', name], dir)).code !== 0) return false;
      const st = await git(['status', '--porcelain', '--ignored', '--', name], dir);
      if (st.code !== 0 || st.out.trim()) return false;
      let sha = cache.get(`b:${norm(dir)}`);
      if (sha === undefined) {
        sha = '';
        for (const ref of mainRefs) { const b = await git(['merge-base', 'HEAD', ref], dir); if (b.code === 0 && b.out.trim()) { sha = b.out.trim(); break; } }
        cache.set(`b:${norm(dir)}`, sha);
      }
      if (!sha) return false;
      return (await git(['diff', '--quiet', '--no-ext-diff', '--no-textconv', sha, '--', name], dir)).code === 0;
    })();
    cache.set(key, ok);
    return ok;
  } catch { return false; }
}

// What a JS or Python file loads by relative path, and whether anything it loads cannot be followed statically.
export function importsOf(text, file) {
  const t = String(text || ''), dir = dirname(file), python = /\.py$/i.test(file);
  const specs = new Set();
  let unresolvable = false;
  if (python) {
    for (const m of t.matchAll(/^[ \t]*from\s+(\.+)([\w.]*)\s+import\s+([\w, *]+)/gm)) {   // from .x import y  /  from . import y
      const up = m[1].length - 1, base = up ? join(dir, ...Array(up).fill('..')) : dir;
      if (m[2]) specs.add(join(base, ...m[2].split('.')));
      else for (const n of m[3].split(',').map(s => s.trim()).filter(Boolean)) specs.add(join(base, n));
    }
    for (const m of t.matchAll(/^[ \t]*(?:from\s+(\w+)\s+import|import\s+(\w+))/gm)) { const mod = m[1] || m[2]; if (existsSync(join(dir, `${mod}.py`)) || existsSync(join(dir, mod, '__init__.py'))) specs.add(join(dir, mod)); }
    if (/\b(?:exec|eval|__import__|compile)\s*\(|\brunpy\b|\bimportlib\b/.test(t)) unresolvable = true;
    return { specs: [...specs], unresolvable };
  }
  const grab = re => { for (const m of t.matchAll(re)) specs.add(m[1]); };
  grab(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g);
  grab(/^\s*import\s*['"]([^'"]+)['"]/gm);
  grab(/\b(?:require|import)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g);
  if (/\b(?:require|import)\s*\(\s*(?!['"`][^'"`$]*['"`]\s*\))/.test(t) || /\b(?:eval|execScript)\s*\(|\bnew\s+Function\b|\bFunction\s*\(/.test(t)) unresolvable = true;
  const files = [];
  for (const s of specs) {
    if (/^(node:|data:|https?:)/.test(s) || bareSpec(s) && !s.startsWith('#')) continue;   // a built-in or a dependency
    if (s.startsWith('#') || /^file:/.test(s) && /[?#]/.test(s)) { unresolvable = true; continue; }
    files.push(s.replace(/^file:\/*/, '').replace(/^([A-Za-z]:)/, '$1'));
  }
  return { specs: files.map(s => (isAbsolute(s) ? s : resolve(dir, s))), unresolvable };
}
const JS_CANDIDATES = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '/index.js', '/index.mjs', '/index.cjs'];
const PY_CANDIDATES = ['.py', '/__init__.py', ''];
function resolveImport(abs, python) {
  for (const ext of python ? PY_CANDIDATES : JS_CANDIDATES) {
    const f = abs + ext;
    try { if (statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

// "Committed and unchanged from main", for a script and everything it loads by relative import or require, followed
// all the way down. A dynamic import, a computed require or an import that cannot be found makes it false: such a
// script is attached instead, and the unread rule applies to it.
export async function isProjectScript(file, opts = {}) {
  const cache = opts.cache || new Map(), seen = new Set(), todo = [file];
  while (todo.length) {
    const f = todo.pop(), k = norm(f);
    if (seen.has(k)) continue;
    seen.add(k);
    if (seen.size > MAX_FILES) return false;
    if (!(await isCommittedFile(f, { ...opts, cache }))) return false;
    if (!/\.(mjs|cjs|js|jsx|ts|tsx|py)$/i.test(f)) continue;   // other kinds are not followed
    let text;
    try { if (statSync(f).size > MAX_FILE_BYTES) return false; text = readFileSync(f, 'utf8'); } catch { return false; }
    const { specs, unresolvable } = importsOf(text, f);
    if (unresolvable) return false;
    for (const s of specs) {
      const r = resolveImport(s, /\.py$/i.test(f));
      if (!r) return false;
      if (!/\.json$/i.test(r)) todo.push(r);
    }
  }
  return true;
}

function expandGlob(path) {
  if (!/[*?]/.test(path)) return [path];
  const dir = dirname(path), pat = basename(path);
  if (/[*?]/.test(dir)) return [];   // only a pattern in the last part
  const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]') + '$', 'i');
  try { return readdirSync(dir).filter(f => re.test(f)).sort().map(f => join(dir, f)).slice(0, 200); } catch { return []; }
}

const PY_MODULES_OK = new Set(['venv', 'json.tool', 'ensurepip']);   // standard modules that run nothing of the project's
// Where the files a command names are, as the items to look at: { path } or { path, kind: 'unknown' | 'missing', note }.
function itemsFor(files, base, projectDir) {
  const items = [];
  const add = f => items.push({ path: f });
  const base0 = base;
  for (const { path: r, mode, at } of files) {
    const base = at ? resolve(base0, at) : base0;   // after a cd in the command, where it really runs
    if (/[$`\u0001]|^~|%\w+%/.test(r)) { items.push({ path: r, kind: 'unknown', note: 'its path is built from a variable or a command' }); continue; }
    const abs = isAbsolute(r) ? r : resolve(base, r);
    if (mode === 'module') {
      const local =[resolve(base, `${r.replace(/\./g, '/')}.py`), resolve(base, r.replace(/\./g, '/'), '__main__.py')].filter(f => existsSync(f));
      if (local.length) local.forEach(add);
      else if (!PY_MODULES_OK.has(r)) items.push({ path: `python -m ${r}`, kind: 'unknown', note: 'it runs a module the hub cannot read here' });
      continue;
    }
    if (mode === 'direct') {
      let real; try { real = realpathSync(abs); } catch { continue; }   // not there: a program on the PATH, not a script of the project's
      const mine = (projectDir && within(real, realpathSync(projectDir))) || within(real, realpathSync(tmpdir()));
      if (mine && !/[\\/]node_modules[\\/]/i.test(real) && statSync(real).isFile()) add(abs);
      continue;
    }
    if (mode === 'node' && !SCRIPT_EXT.test(abs) && !/[*?]/.test(abs)) {   // node tools/evil: the file, then .js .cjs .mjs, then a folder's index
      const found = JS_CANDIDATES.map(e => abs + e).filter(f => { try { return statSync(f).isFile(); } catch { return false; } });
      if (found.length) found.forEach(add);
      else {
        let dir = false; try { dir = statSync(abs).isDirectory(); } catch { /* not there */ }
        items.push({ path: abs, kind: dir ? 'unreadable' : 'missing', note: dir ? 'a folder, not one script' : 'no such file' });
      }
      continue;
    }
    const files2 = expandGlob(abs);
    if (!files2.length) items.push({ path: abs, kind: 'missing', note: /[*?]/.test(abs) ? 'no file matches this pattern' : 'the file does not exist' });
    for (const f of files2) add(f);
  }
  return items;
}

function findPackageJson(from, projectDir) {
  let d = resolve(from);
  for (let i = 0; i < 40; i++) {
    if (projectDir && !within(d, projectDir)) return null;
    const f = join(d, 'package.json');
    if (existsSync(f)) return f;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

// What the check is told about each script the command runs. Each entry:
//   { path, kind: 'committed' }                              project script, committed (and everything it loads): nothing attached
//   { path, kind: 'attached', text, bytes, cutOff, loads }    the text (up to SCRIPT_LIMIT) and what could not be seen
//   { path, kind: 'missing' | 'unreadable' | 'unknown', note } never allowed
// `unread` is true when any script is not fully seen: the answer may not be allow (enforced in applyRules).
// Reads every shell string, $(...) and package script the command starts, down to MAX_NEST levels.
export async function scriptsFor(cmd, { cwd, projectDir, git = defaultGit, mainRefs } = {}) {
  const base = cwd || projectDir || process.cwd();
  const cache = new Map(), opts = { projectDir, git, mainRefs, cache };
  const out = [], inlineLoads = [], seenPaths = new Set();
  let attachedBytes = 0;
  const queue = [{ cmd: String(cmd || ''), cwd: base, depth: 0 }], seenCmds = new Set();
  const items = [];
  while (queue.length) {
    const q = queue.shift();
    const key = `${norm(q.cwd)}\u0000${q.cmd}`;
    if (seenCmds.has(key)) continue;
    seenCmds.add(key);
    if (q.depth > MAX_NEST) { out.push({ path: '(a command)', kind: 'unknown', note: 'commands inside commands go too deep to read' }); continue; }
    const p = parseCommand(q.cmd);
    for (const u of p.unread) out.push({ path: `(${u.head})`, kind: 'unknown', note: u.why });
    for (const it of itemsFor(p.files, q.cwd, projectDir)) items.push(it);
    for (const i of p.inline) for (const r of loadsUnseen(i.code, { python: !!i.python, skipRuns: !!i.heredoc })) if (!inlineLoads.includes(r)) inlineLoads.push(r);
    for (const n of p.nested) queue.push({ cmd: n.cmd, cwd: n.at ? resolve(q.cwd, n.at) : q.cwd, depth: q.depth + 1 });
    for (const r of p.runners) {   // npm run x: the package's own script text is the command
      const pkg = findPackageJson(r.at ? resolve(q.cwd, r.at) : q.cwd, projectDir);
      if (!pkg) { out.push({ path: `(${r.tool} ${r.name})`, kind: 'unknown', note: 'no package.json here to read the script from' }); continue; }
      let scripts;
      try { if (statSync(pkg).size > 256 * 1024) throw new Error('big'); scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts; } catch { out.push({ path: pkg, kind: 'unreadable', note: 'package.json could not be read' }); continue; }
      const names = [r.hooks ? `pre${r.name}` : null, r.name, r.hooks ? `post${r.name}` : null].filter(Boolean);
      if (typeof scripts?.[r.name] !== 'string') { out.push({ path: `(${r.tool} ${r.name})`, kind: 'unknown', note: 'package.json has no such script' }); continue; }
      items.push({ path: pkg });
      for (const n of names) if (typeof scripts?.[n] === 'string') queue.push({ cmd: scripts[n], cwd: dirname(pkg), depth: q.depth + 1 });
    }
  }
  // Text run as a command (iex, eval) is never a file the hub could read, wherever it sits in the command.
  if (/\b(?:iex|Invoke-Expression)\b|(?:^|[;&|(\s])eval\s/i.test(String(cmd || '')) && !inlineLoads.includes('evals text')) inlineLoads.push('evals text');
  const unique = new Map();   // the same file named twice is one script
  for (const it of items) unique.set(it.kind ? `${it.kind}\u0000${it.path}` : norm(it.path), it);
  items.length = 0; items.push(...unique.values());
  if (items.length > MAX_SCRIPTS) {   // more than can be told about: the rest are not seen, so it cannot be allowed
    out.push({ path: `${items.length - MAX_SCRIPTS} more scripts`, kind: 'unreadable', note: `more than ${MAX_SCRIPTS} scripts run, the rest are not listed` });
    items.length = MAX_SCRIPTS;
  }
  for (const it of items) {
    if (it.kind) { out.push(it); continue; }
    const pk = norm(it.path);
    if (seenPaths.has(pk)) continue;
    seenPaths.add(pk);
    let st;
    try { st = statSync(it.path); } catch { out.push({ path: it.path, kind: 'missing', note: 'the file does not exist' }); continue; }
    if (!st.isFile()) { out.push({ path: it.path, kind: 'unreadable', note: 'not a file' }); continue; }
    if (await isProjectScript(it.path, opts)) { out.push({ path: it.path, kind: 'committed' }); continue; }
    let buf;
    try { buf = readFileSync(it.path); } catch { out.push({ path: it.path, kind: 'unreadable', note: 'could not be read' }); continue; }
    if (buf.subarray(0, 4096).includes(0)) { out.push({ path: it.path, kind: 'unreadable', note: 'binary, not text' }); continue; }
    const room = Math.max(0, Math.min(SCRIPT_LIMIT, SCRIPTS_TOTAL - attachedBytes));
    const cutOff = buf.length > room;
    const text = buf.subarray(0, room).toString('utf8');
    attachedBytes += Buffer.byteLength(text);
    const py = /\.py$/i.test(it.path);
    // package.json is data: the commands in it are read in turn (above), so they are not "loaded" from here.
    const data = /^package\.json$/i.test(basename(it.path));
    out.push({ path: it.path, kind: 'attached', text, bytes: buf.length, cutOff, loads: data ? [] : loadsUnseen(cutOff ? buf.toString('utf8') : text, { python: py, dir: dirname(it.path) }) });
  }
  const unread = out.some(s => s.kind !== 'committed' && (s.kind !== 'attached' || s.cutOff || s.loads.length)) || inlineLoads.length > 0;
  return { scripts: out, inlineLoads, unread };
}
