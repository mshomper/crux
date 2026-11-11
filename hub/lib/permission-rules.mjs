// The board's permission rules (R004, under decisions 21, 22 and 34), read by the hub itself. Three outcomes:
// - 'human': a hard stop. Never left to the orchestrator's judgment: merging, pushing to main or master,
//   force-pushing, deleting branches, history rewrites, installs and dependency changes, writes or deletes outside
//   the project folder or a temp folder, network access, the hub on port 4747, and secrets.
// - 'unsure': the hub cannot read it with confidence (an unknown program, a script that runs other programs,
//   variables, substitutions). In auto mode these go to the orchestrator; one that also mentions a hard-stop word
//   goes to the human instead.
// - 'allow': contained work the hub could read in full: everything stays inside the project folder (which holds the
//   agents' worktrees, .claude/worktrees/...) or the system temp folder, plus feature-branch pushes and PRs.
//   classify({ tool, input, projectDir }) -> { route: 'allow' | 'unsure' | 'human', reasons: [hard stops], unsure: [why] }
import { resolve, isAbsolute, join, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { readFileSync, existsSync, statSync } from 'node:fs';

const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const under = (p, root) => { const a = norm(p), r = norm(root); return a === r || a.startsWith(r + '/'); };

const SAFE = new Set(['ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'where', 'file', 'stat', 'tree',
  'grep', 'rg', 'egrep', 'fgrep', 'sort', 'uniq', 'cut', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'true',
  'false', 'du', 'df', 'diff', 'cmp', 'mkdir', 'touch', 'cp', 'mv', 'sed', 'awk', 'test', '[', 'sleep', 'tee', 'jq', 'column', 'nl',
  'seq', 'sha256sum', 'md5sum', 'xxd', 'od', 'cd', 'pushd', 'popd', 'ps', 'tasklist', 'netstat', 'type',
  // PowerShell cmdlets and aliases that read, or write only where the path checks allow
  'get-childitem', 'gci', 'get-content', 'gc', 'get-item', 'gi', 'get-itemproperty', 'gp', 'get-location', 'gl', 'test-path',
  'select-string', 'sls', 'measure-object', 'measure', 'select-object', 'select', 'where-object', '?', 'foreach-object', '%',
  'sort-object', 'format-table', 'ft', 'format-list', 'fl', 'format-wide', 'out-string', 'out-null', 'write-output', 'write-host',
  'split-path', 'join-path', 'resolve-path', 'rvpa', 'new-item', 'ni', 'md', 'copy-item', 'cpi', 'copy', 'move-item', 'mi', 'move',
  'rename-item', 'rni', 'ren', 'set-content', 'add-content', 'ac', 'out-file', 'set-location', 'sl', 'push-location', 'pop-location',
  'compare-object', 'group-object', 'convertto-json', 'convertfrom-json', 'start-sleep', 'get-filehash', 'get-date', 'get-command',
  'gcm', 'get-process', 'gps', 'get-nettcpconnection', 'get-member', 'gm', 'tee-object', 'clear-content', 'expand-archive', 'compress-archive']);
const NETWORK = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'ncat',
  'telnet', 'ftp', 'ping', 'nslookup', 'test-netconnection', 'tnc', 'start-bitstransfer']);
const DELETE = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri', 'unlink', 'shred', 'rimraf']);
const KILL = new Set(['kill', 'pkill', 'killall', 'taskkill', 'stop-process', 'spps']);
const INSTALL = new Set(['npx', 'pnpx', 'bunx', 'pip', 'pip3', 'pipx', 'conda', 'winget', 'choco', 'scoop', 'apt', 'apt-get', 'brew', 'gem',
  'install-module', 'install-package', 'install-script', 'update-module']);
const INDIRECT = new Set(['sudo', 'runas', 'su', 'doas', 'bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh', 'wsl', 'start', 'start-process',
  'saps', 'invoke-expression', 'iex', 'invoke-command', 'icm', 'invoke-item', 'ii', 'eval', 'exec', 'source', '.', 'xargs', 'env',
  'printenv', 'set', 'get-credential', 'get-secret']);
const NPM_INSTALL = new Set(['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'uninstall', 'remove', 'rm', 'un', 'r', 'link', 'ln',
  'unlink', 'dedupe', 'prune', 'audit', 'dlx', 'exec', 'x', 'create', 'init']);
const NPM_NET = new Set(['publish', 'unpublish', 'deprecate', 'login', 'logout', 'adduser', 'token', 'owner', 'access', 'view', 'info', 'outdated', 'search']);
const NPM_OK = new Set(['test', 't', 'tst', 'run', 'run-script', 'ls', 'list', '-v', '--version', 'explain', 'why', 'root', 'prefix', 'bin', 'start']);
const GIT_LOCAL = new Set(['status', 'diff', 'log', 'show', 'add', 'commit', 'switch', 'checkout', 'restore', 'mv', 'stash', 'tag',
  'cherry-pick', 'revert', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'reflog', 'init', 'worktree', 'merge-base',
  'show-ref', 'for-each-ref', 'rev-list', 'cat-file', 'check-ignore', 'branch', 'config', 'reset', 'rm', 'remote', 'clean']);
const GIT_HISTORY = new Set(['rebase', 'filter-branch', 'filter-repo', 'replace', 'update-ref', 'gc', 'prune']);
const GIT_NETWORK = new Set(['pull', 'fetch', 'clone', 'ls-remote', 'submodule']);
const DEP_FILES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[\w.-]*\.txt|pyproject\.toml|pipfile(\.lock)?|cargo\.(toml|lock)|go\.(mod|sum)|gemfile(\.lock)?)$/i;
const SECRET = /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|\.git-credentials|\.pypirc|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|credentials(\.json)?|secrets?(\.\w+)?|vapid\.json|[\w-]*token\.json)$|(^|\/)(\.ssh|\.aws|\.gnupg|\.crux-hub)(\/|$)|\.(pem|key|pfx|p12)$|(^|\/)env:/i;
const KNOWN_TOOLS = new Set(['Task', 'Agent', 'TodoWrite', 'TaskStop', 'KillShell', 'KillBash', 'BashOutput', 'ToolSearch', 'Skill',
  'EnterPlanMode', 'ExitPlanMode', 'WebSearch', 'LS']);
const OK_VARS = /^\$(_|psitem|null|true|false|\?|lastexitcode)(?![\w:])/i;
const TEMP_VARS = /\$\{?(env:temp|env:tmp|tmpdir|temp|tmp)\}?(?![\w:])|%(temp|tmp)%/gi;

export function classify({ tool, input = {}, projectDir, tmp = tmpdir(), home = homedir() }) {
  const c = new Check(projectDir, tmp, home);
  const cmd = String(input.command || '');
  if (/^(Bash|PowerShell)$/.test(tool)) c.command(cmd, tool === 'PowerShell');
  else c.tool(tool, input);
  // Something the hub could not read that also names a hard-stop action is not left to judgment.
  const word = c.opaque && !c.reasons.length && RISKY_WORDS.exec(cmd);
  if (word) c.stop(`Runs something the hub cannot read in full that mentions "${word[0]}"`);
  if (c.reasons.length) return { route: 'human', reasons: [...new Set(c.reasons)], unsure: [...new Set(c.doubts)] };
  if (c.doubts.length) return { route: 'unsure', reasons: [], unsure: [...new Set(c.doubts)] };
  return { route: 'allow', reasons: [], unsure: [] };
}

const RISKY_WORDS = /\b(push|merge|rebase|filter-branch|reset\s+--hard|branch\s+-[dD]|install|uninstall|publish|curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|ssh|scp|stop-process|taskkill|kill|credential|secret|password|token)\b|4747|\.env\b|\.ssh\b|\.crux-hub/i;

class Check {
  constructor(projectDir, tmp, home) {
    Object.assign(this, { projectDir: resolve(projectDir), tmp, home, reasons: [], doubts: [] });
  }
  stop(why) { this.reasons.push(why); }
  // known: the hub read the step and only cannot tell if it is safe here (a rebase); otherwise the text is opaque.
  unsure(why, known = false) { this.doubts.push(why); if (!known) this.opaque = true; }

  // A path is fine inside the project folder or the system temp folder (where throwaway test projects go).
  where(p, cwd) {
    let s = String(p).replace(TEMP_VARS, this.tmp.replace(/\\/g, '/'));
    if (/^~(?=[\\/]|$)/.test(s)) s = this.home + s.slice(1);
    if (/^\/dev\/null$|^nul$/i.test(s)) return 'null';
    if (/^\/tmp(\/|$)/.test(s)) return 'tmp';
    const m = /^\/([a-z])(\/.*)?$/i.exec(s);           // Git Bash: /c/Users/... is C:/Users/...
    if (m) s = `${m[1]}:${m[2] || '/'}`;
    else if (/^[\\/](?![\\/])/.test(s) && process.platform === 'win32') return 'outside'; // /usr/bin on Windows: not a project path
    if (/^[\\/]{2}/.test(s)) return 'outside';         // network share
    const abs = isAbsolute(s) ? resolve(s) : resolve(cwd, s);
    if (under(abs, this.projectDir)) return 'inside';
    if (under(abs, this.tmp)) return 'tmp';
    return 'outside';
  }
  path(p, cwd, { write = false } = {}) {
    const w = this.where(p, cwd);
    if (w === 'outside') this.stop(`Touches a path outside the project folder: ${p}`);
    const n = norm(p);
    if (SECRET.test(n)) this.stop(`Touches secrets or credentials: ${p}`);
    if (write && w === 'inside') {
      const rel = norm(resolve(cwd, String(p))).slice(norm(this.projectDir).length + 1);
      if (DEP_FILES.test(rel)) this.stop(`Changes dependencies (${basename(rel)})`);
      if (/^\.git(\/|$)/.test(rel)) this.stop('Writes inside .git (history)');
      if (/^\.crux(\/|$)/.test(rel)) this.stop("Writes the hub's own log (.crux)");
      if (/(^|\/)\.claude\/settings/.test(rel)) this.stop("Changes Claude Code's permission settings");
    }
    return w;
  }

  tool(tool, input) {
    const cwd = this.projectDir;
    if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].includes(tool)) {
      for (const k of ['file_path', 'path', 'notebook_path']) if (input[k]) this.path(input[k], cwd);
      if (input.pattern && /^([a-z]:|[\\/~])/i.test(input.pattern) && tool === 'Glob') this.path(input.pattern.replace(/[*?[{].*$/, '') || '/', cwd);
      return;
    }
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
      const f = input.file_path || input.notebook_path;
      if (!f) return this.unsure('No file named');
      return void this.path(f, cwd, { write: true });
    }
    // Reading docs is allowed (R004) but the hub cannot tell a docs page from any other address.
    if (tool === 'WebFetch') return this.unsure(`Reads a web page (${String(input.url || '').slice(0, 80)})`);
    if (tool.startsWith('mcp__crux__') || KNOWN_TOOLS.has(tool)) return;
    this.unsure(`A tool the hub does not know (${tool})`);
  }

  command(cmd, ps) {
    if (!cmd.trim()) return this.unsure('An empty command');
    if (/4747/.test(cmd)) this.stop('Touches the hub on port 4747');
    // A commit message passed through a quoted heredoc is plain text: $(cat <<'EOF' ... EOF)
    let s = cmd.replace(/\$\(\s*cat\s+<<-?\s*'(\w+)'[^\n]*\n[\s\S]*?\n\s*\1\s*\n?\s*\)/g, "'TEXT'");
    // PowerShell here-strings: literal when single-quoted
    s = s.replace(/@'\r?\n[\s\S]*?\r?\n'@/g, "'TEXT'");
    if (/@"\r?\n[\s\S]*?\$[\w({][\s\S]*?\r?\n"@/.test(s)) this.unsure('A here-string with variables the hub cannot read');
    s = s.replace(/@"\r?\n[\s\S]*?\r?\n"@/g, "'TEXT'");
    // Other heredocs: a script fed to node or python is checked as a script; anything else is data.
    s = s.replace(/^([^\n]*?)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n([\s\S]*?)\n\s*\3\s*(?=\n|$)/gm, (all, before, q, tag, after, body) => {
      if (!q && /\$\(|`/.test(body)) this.unsure('A heredoc with commands inside');
      if (/\b(node|python3?|py)\s+-(\s|$)/.test(before)) this.script(body);
      return `${before}${after}`;
    });
    if (/`/.test(s.replace(/'[^']*'/g, ''))) this.unsure(ps ? 'Backtick escapes the hub cannot read' : 'Command substitution (backticks)');
    if (/\$\(|<\(|>\(/.test(s.replace(/'[^']*'/g, ''))) this.unsure('Command substitution the hub cannot read');
    let cwd = this.projectDir;
    for (const part of splitParts(s, ps)) cwd = this.part(part, cwd, ps);
  }

  // One simple command. Returns the working folder for the next one (only cd changes it).
  part(raw, cwd, ps) {
    let words = tokens(raw);
    if (!words.length) return cwd;
    // redirections: > file, >> file, 2> file, < file (2>&1 needs no check)
    const keep = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w.op) { keep.push(w); continue; }
      if (/&\d$/.test(w.text)) continue;
      const target = words[++i];
      if (!target) { this.unsure('A redirection with no file'); continue; }
      this.word(target, cwd);
      if (!/^\$null$/i.test(target.text)) this.path(target.text, cwd, { write: !w.text.startsWith('<') });
    }
    words = keep;
    // Every word: variables, addresses, paths and secrets.
    this.urlsHere = [];
    for (const w of words) this.word(w, cwd);
    while (words.length && /^\w+=/.test(words[0].text) && !words[0].quoted) words = words.slice(1); // VAR=value cmd
    while (words.length && /^(if|then|else|elif|fi|do|done|while|until|!|time)$/.test(words[0].text)) words = words.slice(1);
    if (!words.length) return cwd;
    const head = words[0].text.toLowerCase().replace(/\.exe$/, '');
    const args = words.slice(1).map(w => w.text);
    // An address in the words is a network call, except a push to a named remote or a PR's own text (R002).
    const allowsAddress = (head === 'gh' && args[0] === 'pr' && args[1] === 'create');
    if (this.urlsHere.length && !allowsAddress) this.stop(`Reaches the network (${this.urlsHere[0].slice(0, 80)})`);
    if (['cd', 'pushd', 'set-location', 'sl', 'push-location', 'chdir'].includes(head)) {
      const to = args.find(a => !a.startsWith('-'));
      return to ? resolve(cwd, to.replace(/^~(?=[\\/]|$)/, this.home)) : this.home;
    }
    this.run(head, args, words, cwd);
    return cwd;
  }

  run(head, args, words, cwd) {
    if (/^\$(_|psitem)\b/i.test(head) || /^-(and|or|not|eq|ne|gt|lt|ge|le|like|match)$/i.test(head)) return; // a PowerShell filter expression
    if (NETWORK.has(head)) return this.stop(`Reaches the network (${head})`);
    if (KILL.has(head)) return this.stop(`Stops a process (${head}); the hub cannot tell it is not the hub on port 4747`);
    if (INSTALL.has(head)) return this.stop(`Installs software (${head})`);
    if (/^(env|printenv|set|get-credential|get-secret)$/.test(head)) return this.stop(`Reads environment variables or credentials (${head})`);
    if (INDIRECT.has(head)) return this.unsure(`Runs commands the hub cannot read (${head})`);
    // R004: deleting inside the project folder or a temp folder is contained; anywhere else is a hard stop.
    if (DELETE.has(head)) {
      const targets = args.filter(a => !a.startsWith('-'));
      if (!targets.length) return this.unsure(`${head} with nothing named`);
      if (targets.some(t => this.where(t, cwd) === 'outside')) this.stop(`Deletes files outside the project or a temp folder (${head} ${targets.join(' ')})`);
      else if (targets.some(t => ['.', './', '*'].includes(t) || this.where(t, cwd) === 'inside' && norm(resolve(cwd, t)) === norm(this.projectDir))) this.stop(`Deletes the whole project folder (${head} ${targets.join(' ')})`);
      return;
    }
    if (head === 'find') {
      if (args.some(a => /^-(exec|execdir|ok|okdir)$/.test(a))) this.unsure('find runs other commands (-exec)');
      return;
    }
    if (SAFE.has(head)) return;
    if (head === 'git') return this.git(args, cwd);
    if (head === 'gh') return this.gh(args);
    if (head === 'node') return this.node(args);
    if (/^(python3?|py)$/.test(head)) return this.python(args);
    if (/^(npm|pnpm|yarn|bun)$/.test(head)) return this.npm(args, cwd);
    if (head === 'cargo' || head === 'go' || head === 'dotnet') {
      if (/^(install|add|get)$/.test(args[0] || '')) return this.stop(`Installs software (${head} ${args[0]})`);
      if (!/^(build|test|run|vet|fmt|check|clippy)$/.test(args[0] || '')) this.unsure(`Not sure what this does (${head} ${args[0] || ''})`.trim());
      return;
    }
    this.unsure(`Not sure what this does (${words[0].text})`);
  }

  word(w, cwd) {
    const t = w.text;
    if (w.vars) {
      const rest = t.replace(TEMP_VARS, '').replace(/\$(_|psitem|null|true|false|\?|lastexitcode)(?![\w:])/gi, '');
      if (/\$env:/i.test(rest)) this.stop(`Reads an environment variable (${t})`);
      else if (/[$%]\{?\w*(key|token|secret|passw|auth|cred)/i.test(rest)) this.stop(`Reads what looks like a secret (${t})`);
      else if (/\$[\w{]|%\w+%/.test(rest)) this.unsure(`Uses a variable the hub cannot check (${t})`);
    }
    if (/^[a-z][\w+.-]*:\/\//i.test(t) || /\b(https?|ftp|wss?):\/\//i.test(t) || /^[\w.-]+@[\w.-]+:/.test(t)) { this.urlsHere?.push(t); return; }
    const v = /^--?[\w-]+=(.+)$/.exec(t)?.[1] ?? (t.startsWith('-') ? null : t);
    if (v == null) return;
    if (SECRET.test(norm(v))) this.stop(`Touches secrets or credentials: ${v}`);
    if (/[\\/]|^~|^\.\.?$|^[a-z]:/i.test(v) && !/^[\w.-]+:[^\\/]/.test(v)) {
      if (this.where(v, cwd) === 'outside') this.stop(`Touches a path outside the project folder: ${v}`);
    }
  }

  git(args, cwd) {
    let a = args;
    while (a.length) {
      if (a[0] === '-C') { cwd = resolve(cwd, a[1] || '.'); a = a.slice(2); continue; }  // its path was checked with the other words
      if (a[0] === '--no-pager' || a[0] === '-P') { a = a.slice(1); continue; }
      if (/^--(git-dir|work-tree)=/.test(a[0])) { a = a.slice(1); continue; }
      if (a[0].startsWith('-')) return this.unsure(`git with options the hub cannot check (${a[0]})`);
      break;
    }
    const [sub, ...rest] = a;
    const flag = (...fs) => rest.some(x => fs.includes(x));
    if (!sub) return;
    if (sub === 'push') return this.push(rest, cwd);
    if (sub === 'merge') return this.stop('Merges branches (git merge)');
    if (sub === 'rebase') return this.unsure('Rebases (fine for a branch only this agent has; not for a shared one)', true);
    if (GIT_HISTORY.has(sub)) return this.stop(`Rewrites history (git ${sub})`);
    if (GIT_NETWORK.has(sub)) return this.stop(`Reaches the network (git ${sub})`);
    if (!GIT_LOCAL.has(sub)) return this.unsure(`Not sure what this does (git ${sub})`);
    if (sub === 'commit' && flag('--amend', '--fixup', '--squash')) this.unsure('Rewrites the last commit (fine unless it was pushed)', true);
    if (sub === 'commit' && flag('--no-verify', '-n')) this.unsure('Skips the commit hooks (--no-verify)', true);
    if (sub === 'branch' && flag('-d', '-D', '--delete')) this.stop('Deletes a branch');
    if (sub === 'branch' && flag('-f', '--force', '-M', '-C')) this.stop('Moves or overwrites a branch (history)');
    if ((sub === 'checkout' && flag('-B')) || (sub === 'switch' && flag('-C', '--force-create'))) this.stop('Resets an existing branch (history)');
    if (sub === 'tag' && flag('-d', '--delete', '-f', '--force')) this.unsure('Deletes or moves a tag', true);
    if (sub === 'reflog' && /^(expire|delete)$/.test(rest[0] || '')) this.stop('Rewrites history (reflog)');
    if (sub === 'remote' && rest.length && !(rest.length === 1 && rest[0] === '-v') && rest[0] !== 'get-url') this.stop(`Changes or contacts remotes (git remote ${rest[0]})`);
    if (sub === 'config' && !flag('--get', '--list', '-l', '--get-all', '--show-origin')) this.unsure('Changes git settings', true);
    if (sub === 'reset') {
      // Unstaging is fine: "git reset", "git reset -- file", "git reset HEAD file". reset --hard is a hard stop;
      // moving a branch back (git reset HEAD~1) is fine on an unpushed branch, which the hub cannot tell.
      const r = rest[0] === 'HEAD' ? rest.slice(1) : rest;
      if (r.some(x => /^--(hard|merge|keep)$/.test(x))) this.stop('Throws work away (git reset --hard)');
      else if (r.some(x => /^--(soft|mixed)$/.test(x)) || (r.length && r[0] !== '--' && /^(HEAD[~^]|[0-9a-f]{6,}$|origin\/|@)/i.test(r[0]))) this.unsure('Moves the branch back (git reset)', true);
    }
  }

  // R004: pushing a feature branch is allowed. Pushing to main or master, force in any form (--force,
  // --force-with-lease, a +refspec) and deleting remote branches are hard stops, as is any shape the hub cannot read
  // (wildcards, URLs, tags). With no branch named, or HEAD, the hub reads the current branch from the repo.
  push(rest, cwd = this.projectDir) {
    const ok = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose', '--porcelain', '-n', '--dry-run', '--progress']);
    const pos = [];
    for (const x of rest) {
      if (/^(-f|--force|--force-with-lease(=.*)?|--force-if-includes)$/.test(x) || /^-[a-z]*f/i.test(x) && !x.startsWith('--')) this.stop(`Force-pushes (${x})`);
      else if (/^(-d|--delete)$/.test(x)) this.stop('Deletes a remote branch (push --delete)');
      else if (/^--(mirror|all|tags|prune|follow-tags|no-verify)$/.test(x)) this.stop(`Pushes more than one branch, or skips checks (${x})`);
      else if (x.startsWith('-')) { if (!ok.has(x)) this.stop(`git push with an option the hub cannot check (${x})`); }
      else pos.push(x);
    }
    const [remote, ...named] = pos;
    if (remote && !/^[\w.-]+$/.test(remote)) this.stop(`Pushes to an address the hub cannot check (${remote})`);
    const here = () => currentBranch(cwd);
    const specs = named.length ? named : [here() || '?'];
    for (let spec of specs) {
      if (spec.startsWith('+')) { this.stop(`Force-pushes (${spec})`); continue; }
      let [src, dst = src] = spec.includes(':') ? spec.split(':') : [spec];
      if (spec.includes(':') && !src) { this.stop(`Deletes a remote branch (${spec})`); continue; }
      if (/^(head|@)$/i.test(src)) { src = here() || '?'; if (/^(head|@)$/i.test(dst)) dst = src; }
      const d = dst.replace(/^refs\/heads\//, '');
      if (d === '?' || src === '?') this.stop('git push where the hub cannot tell which branch it pushes');
      else if (/^(main|master)$/i.test(d)) this.stop(`Pushes to ${d}`);
      else if (/[*]|^refs\/(?!heads\/)/.test(spec) || !/^[\w./-]+$/.test(d)) this.stop(`git push of a ref the hub cannot check (${spec})`);
    }
  }

  gh(args) {
    const [a, b] = args;
    if (a === 'pr' && /^(create|list|view|status|diff|checks)$/.test(b || '')) return;
    if (a === 'pr' && b === 'merge') return this.stop('Merges a pull request (gh pr merge)');
    if (a === 'auth' || a === 'secret' || a === 'api') return this.stop(`Touches GitHub credentials or calls its API directly (gh ${a})`);
    this.unsure(`Not sure what this does (gh ${[a, b].filter(Boolean).join(' ')})`);
  }

  node(args) {
    const i = args.findIndex(x => /^(-e|-p|--eval|--print)$/.test(x));
    if (i >= 0) return this.script(args[i + 1] || '');
    const file = args.find(x => !x.startsWith('-'));
    if (file && basename(file) === 'server.mjs') this.hubPort(args);
  }

  python(args) {
    if (args[0] === '-c') return this.script(args[1] || '');
    if (args[0] === '-m') {
      if (/^(pip|ensurepip)$/.test(args[1] || '')) return this.stop('Installs software (pip)');
      if (!/^(unittest|pytest|py_compile|compileall)$/.test(args[1] || '')) return this.unsure(`Not sure what this does (python -m ${args[1] || ''})`);
    }
  }

  npm(args, cwd) {
    const a = args.filter((x, i) => !/^--?(prefix|C|workspace|w)$/.test(x) && !/^--?(prefix|C|workspace|w)$/.test(args[i - 1] || ''));
    const sub = a[0] || '';
    if (NPM_INSTALL.has(sub)) return this.stop(`Installs or changes packages (npm ${sub})`);
    if (NPM_NET.has(sub)) return this.stop(`Reaches the npm registry (npm ${sub})`);
    if (sub === 'config') return /^(get|list|ls)$/.test(a[1] || '') ? undefined : this.stop('Changes npm settings');
    if (!NPM_OK.has(sub)) return this.unsure(`Not sure what this does (npm ${sub})`);
    // "npm start" in a folder whose start script is the hub would start it on port 4747 unless a port is given.
    if (sub === 'start' || (sub === 'run' && a[1] === 'start')) {
      const pre = args.indexOf('--prefix');
      let start = '';
      try { start = JSON.parse(readFileSync(join(pre >= 0 ? resolve(cwd, args[pre + 1]) : cwd, 'package.json'), 'utf8')).scripts?.start || ''; } catch { }
      if (/server\.mjs/.test(start)) this.hubPort(a);
    }
  }

  hubPort(args) {
    const i = args.indexOf('--port');
    const port = i >= 0 ? Number(args[i + 1]) : NaN;
    if (!Number.isFinite(port) || port === 4747) this.stop('Starts a hub without a port other than 4747');
  }

  // An inline script (node -e, python -c, a heredoc into node -) is judged by what it reaches for.
  script(code) {
    if (/\b(fetch|https?|net|dgram|tls|http2|XMLHttpRequest|WebSocket|urllib|requests|socket)\b/.test(code)) this.stop('An inline script that could reach the network');
    if (/\b(child_process|execSync|execFileSync|spawn|spawnSync|exec\(|execFile|subprocess|os\.system|os\.popen)\b/.test(code)) this.unsure('An inline script that runs other programs');
    if (/\b(rmSync|unlinkSync|rmdirSync|rm\(|unlink\(|rmdir\(|os\.remove|os\.unlink|shutil\.rmtree)\b/.test(code)) this.unsure('An inline script that deletes files');
    if (/process\.env|os\.environ|homedir\(\)|expanduser/.test(code)) this.stop('An inline script that reads environment variables or the home folder');
    for (const m of code.matchAll(/['"`]((?:[a-z]:)?[\\/][^'"`\n]*|\.\.[\\/][^'"`\n]*)['"`]/gi)) {
      if (this.where(m[1], this.projectDir) === 'outside') this.stop(`An inline script that touches a path outside the project folder: ${m[1]}`);
    }
  }
}

// Split at ; && || | & newlines and PowerShell { } ( ) blocks, never inside quotes.
export function splitParts(s, ps = false) {
  const out = []; let cur = '', q = null;
  const prev = i => s[i - 1] ?? ' ';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q && (q === "'" || prev(i) !== '\\')) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\\' && !ps && s[i + 1] === '\n') { i++; continue; } // line continuation
    const brace = (c === '{' && /[\s|(;]/.test(prev(i))) || (c === '}' && /[\s|);]|^$/.test(s[i + 1] ?? '')) || c === '(' && /[\s|;=]/.test(prev(i)) || c === ')';
    if (c === '\n' || c === '\r' || c === ';' || c === '|' || c === '&' || brace) {
      if (c === '&' && /[<>]/.test(prev(i))) { cur += c; continue; } // 2>&1
      out.push(cur); cur = '';
      if ((c === '|' || c === '&') && s[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map(x => x.trim()).filter(Boolean);
}

// Words with quotes removed. quoted: any quotes; vars: a $ or %VAR% outside single quotes (it would expand).
export function tokens(part) {
  const out = []; let cur = null;
  const push = () => { if (cur) out.push(cur); cur = null; };
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (/\s/.test(c)) { push(); continue; }
    if (c === '>' || c === '<') {   // a redirection is its own word, even when written hard against a file name
      let op = c;
      if (cur && !cur.quoted && /^\d$/.test(cur.text)) { op = cur.text + c; cur = null; } else push();
      if (part[i + 1] === c) op += part[++i];
      if (part[i + 1] === '&' && /\d/.test(part[i + 2] || '')) { op += part.slice(i + 1, i + 3); i += 2; }
      out.push({ text: op, quoted: false, vars: false, op: true });
      continue;
    }
    cur ||= { text: '', quoted: false, vars: false };
    if (c === "'" || c === '"') {
      const j = part.indexOf(c, i + 1);
      const end = j < 0 ? part.length : j;
      const inner = part.slice(i + 1, end);
      if (c === '"' && /\$|%\w+%/.test(inner)) cur.vars = true;
      cur.text += inner; cur.quoted = true; i = end; continue;
    }
    if (c === '$' || (c === '%' && /^%\w+%/.test(part.slice(i)))) cur.vars = true;
    cur.text += c;
  }
  push();
  return out;
}

// The branch checked out in the repo holding `dir` (worktrees too), read from .git/HEAD; null if it can't tell.
export function currentBranch(dir) {
  let d = resolve(dir);
  for (let i = 0; i < 40; i++) {
    const g = join(d, '.git');
    if (existsSync(g)) {
      try {
        let gitDir = g;
        if (statSync(g).isFile()) gitDir = resolve(d, /gitdir:\s*(.+)/.exec(readFileSync(g, 'utf8'))[1].trim());
        const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(readFileSync(join(gitDir, 'HEAD'), 'utf8'));
        return m ? m[1].trim() : null;
      } catch { return null; }
    }
    const up = resolve(d, '..');
    if (up === d) return null;
    d = up;
  }
  return null;
}

// R003: reads are always allowed, anywhere, except secrets. True when a request names a secret or credential
// (~/.ssh, .env files, ~/.crux-hub keys, credential stores) or reads an environment variable.
export function touchesSecrets(tool, input = {}) {
  if (!/^(Bash|PowerShell)$/.test(tool)) {
    return [input.file_path, input.path, input.notebook_path, input.pattern].some(v => v && SECRET.test(norm(v)));
  }
  const cmd = String(input.command || '');
  if (/\$env:(?!te?mp\b)/i.test(cmd) || /\b(printenv|get-credential|get-secret)\b/i.test(cmd) || /(^|[\s;&|])env(\s|$)/.test(cmd)) return true;
  for (const part of splitParts(cmd, tool === 'PowerShell')) {
    for (const w of tokens(part)) {
      const v = /^--?[\w-]+=(.+)$/.exec(w.text)?.[1] ?? w.text;
      if (SECRET.test(norm(v))) return true;
      if (w.vars && /\$(?!_|psitem|null|true|false|\?|lastexitcode|\(|env:te?mp\b)[\w{]/i.test(w.text.replace(TEMP_VARS, ''))) return true;
    }
  }
  return false;
}

// The newest active "permission rules" requirement on a board, or null (no rules: nothing is routed).
export function rulesEntry(board) {
  return board.entries().filter(e => e.kind === 'requirement' && e.status === 'active' && /permission rules/i.test(e.title || '')).at(-1) || null;
}
