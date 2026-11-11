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
// Programs that write to every path they are given, or only to the last one (the destination of a copy).
const WRITE_ALL = new Set(['mkdir', 'md', 'touch', 'tee', 'tee-object', 'new-item', 'ni', 'set-content', 'add-content', 'ac', 'out-file',
  'clear-content', 'expand-archive', 'compress-archive', 'rename-item', 'rni', 'ren', 'mv', 'move', 'move-item', 'mi']);
const WRITE_LAST = new Set(['cp', 'copy', 'copy-item', 'cpi']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'reflog',
  'merge-base', 'merge-tree', 'show-ref', 'for-each-ref', 'rev-list', 'cat-file', 'check-ignore', 'ls-remote']);
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
  'show-ref', 'for-each-ref', 'rev-list', 'cat-file', 'check-ignore', 'branch', 'config', 'reset', 'rm', 'remote', 'clean', 'merge-tree']);
const GIT_HISTORY = new Set(['rebase', 'filter-branch', 'filter-repo', 'replace', 'update-ref', 'gc', 'prune']);
// Fetching from the repo's own remote (a named remote such as origin, or GitHub) is contained (R004).
const GIT_FETCH = new Set(['pull', 'fetch', 'clone', 'ls-remote']);
const DEP_FILES = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|requirements[\w.-]*\.txt|pyproject\.toml|pipfile(\.lock)?|cargo\.(toml|lock)|go\.(mod|sum)|gemfile(\.lock)?)$/i;
const SECRET = /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|\.git-credentials|\.pypirc|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|credentials(\.json)?|secrets?(\.\w+)?|vapid\.json|[\w-]*token\.json)$|(^|\/)(\.ssh|\.aws|\.gnupg|\.crux-hub)(\/|$)|\.(pem|key|pfx|p12)$|(^|\/)env:/i;
const KNOWN_TOOLS = new Set(['Task', 'Agent', 'TodoWrite', 'TaskStop', 'KillShell', 'KillBash', 'BashOutput', 'ToolSearch', 'Skill',
  'EnterPlanMode', 'ExitPlanMode', 'WebSearch', 'LS']);
// Path and system variables are not secrets: reading them is fine. Names that look secret are hard stops.
const SYSTEM_VARS = /^(appdata|localappdata|temp|tmp|tmpdir|userprofile|home|homedrive|homepath|path|pwd|oldpwd|os|computername|hostname|username|user|programfiles|programfiles\(x86\)|programw6432|programdata|commonprogramfiles|windir|systemroot|systemdrive|public|onedrive|processor_architecture|number_of_processors|shell|term|lang)$/i;
const SECRET_VAR = /token|key|secret|passw|pass\b|auth|cred|api|cookie|session/i;
// Where the path variables point, so a write through them is judged like any other path.
const VAR_PATHS = { appdata: ['AppData', 'Roaming'], localappdata: ['AppData', 'Local'], userprofile: [], home: [] };
const TEMP_VARS = /\$\{?(env:temp|env:tmp|tmpdir|temp|tmp)\}?(?![\w:])|%(temp|tmp)%/gi;

// agent: the asking agent's name; madeTemp: temp folders it created earlier (full paths). Both decide which temp
// folders count as its own for deletes (R005). The result's tempMade lists temp folders this request would create.
export function classify({ tool, input = {}, projectDir, tmp = tmpdir(), home = homedir(), agent = '', madeTemp = [] }) {
  const c = new Check(projectDir, tmp, home);
  c.agent = String(agent || '').toLowerCase();
  c.madeTemp = new Set([...madeTemp].map(norm));
  c.tempMade = new Set();
  const out = classifyWith(c, tool, input);
  return { ...out, tempMade: [...c.tempMade] };
}

function classifyWith(c, tool, input) {
  const cmd = String(input.command || '');
  if (/^(Bash|PowerShell)$/.test(tool)) c.command(cmd, tool === 'PowerShell');
  else c.tool(tool, input);
  // Something the hub could not read that also names a hard-stop action is not left to judgment.
  const word = c.opaque && !c.reasons.length && RISKY_PATTERNS.map(r => r.exec(cmd)).find(Boolean);
  if (word) c.stop(`Runs something the hub cannot read in full that includes "${word[0].trim()}"`);
  if (c.reasons.length) return { route: 'human', reasons: [...new Set(c.reasons)], unsure: [...new Set(c.doubts)] };
  if (c.doubts.length) return { route: 'unsure', reasons: [], unsure: [...new Set(c.doubts)] };
  return { route: 'allow', reasons: [], unsure: [] };
}

// Real hard-stop shapes, looked for in text the hub could not read in full. Only the actual subcommands count:
// "git merge-base" and "git merge-tree" only read, so they do not match.
const RISKY_PATTERNS = [
  /\bgit\b[^;&|\n]*?\s(push|merge(?![-\w])|filter-branch|filter-repo)\b/i,
  /\bgh\s+pr\s+merge\b/i, /(^|\s)(push|merge)(\s|$)/i,
  /\breset\s+--hard\b/i, /\bbranch\s+(-[dDfM]\b|--delete\b|--force\b)/,
  /\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci|uninstall|remove|publish|update)\b/i, /\b(npx|pip3?|pipx|winget|choco|scoop)\s/i,
  /\b(stop-process|taskkill|killall|pkill)\b|(^|[\s;&|(])kill\s/i,
  /\brm\s+-\w*[rf]\w*\s+(\/|~|\.\.|[a-z]:)/i, /\bremove-item\b[^;|\n]*(\.\.|~|[a-z]:\\)/i,
  /\.env\b|\.ssh\b|\.crux-hub\b|\bid_(rsa|ed25519)\b|\bcredentials?\b|\bpassword\b|\bsecret\b|api[_-]?key/i
];

class Check {
  constructor(projectDir, tmp, home) {
    Object.assign(this, { projectDir: resolve(projectDir), tmp, home, reasons: [], doubts: [] });
  }
  stop(why) { this.reasons.push(why); }
  // known: the hub read the step and only cannot tell if it is safe here (a rebase); otherwise the text is opaque.
  unsure(why, known = false) { this.doubts.push(why); if (!known) this.opaque = true; }

  // A path is fine inside the project folder or the system temp folder (where throwaway test projects go).
  where(p, cwd) {
    const abs = this.abs(p, cwd);
    if (abs === 'null' || abs === 'tmp' || abs === 'outside') return abs;
    if (under(abs, this.projectDir)) return 'inside';
    if (under(abs, this.tmp)) return 'tmp';
    return 'outside';
  }
  // The full path a word names, from the folder it is used in. Understands ~, temp variables and Git Bash's /c/... form.
  abs(p, cwd) {
    let s = String(p).replace(TEMP_VARS, this.tmp.replace(/\\/g, '/'));
    s = s.replace(/\$\{?(?:env:)?(appdata|localappdata|userprofile|home)\}?(?![\w:])|%(appdata|localappdata|userprofile|home)%/gi,
      (m, a, b) => join(this.home, ...VAR_PATHS[(a || b).toLowerCase()]).replace(/\\/g, '/'));
    if (/^~(?=[\\/]|$)/.test(s)) s = this.home + s.slice(1);
    if (/^\/dev\/null$|^nul$/i.test(s)) return 'null';
    if (/^\/tmp(\/|$)/.test(s)) return s === '/tmp' ? this.tmp : join(this.tmp, s.slice(5));
    const m = /^\/([a-z])(\/.*)?$/i.exec(s);           // Git Bash: /c/Users/... is C:/Users/...
    if (m) s = `${m[1]}:${m[2] || '/'}`;
    else if (/^[\\/](?![\\/])/.test(s) && process.platform === 'win32') return 'outside'; // /usr/bin on Windows: not a project path
    if (/^[\\/]{2}/.test(s)) return 'outside';         // network share
    return isAbsolute(s) ? resolve(s) : resolve(cwd, s);
  }
  // R004: reading anywhere is fine (secrets aside); writing outside the project folder or a temp folder is a hard stop.
  path(p, cwd, { write = false } = {}) {
    const w = this.where(p, cwd);
    if (w === 'outside' && write) this.stop(`Writes outside the project folder: ${p}`);
    if (w === 'tmp' && write) this.noteTemp(p, cwd);
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
    if (ps) {
      // Variables the command sets itself ($s = ...) are its own, not the environment's.
      this.localVars ||= new Set();
      for (const m of cmd.matchAll(/\$(\w+)\s*=(?!=)/g)) this.localVars.add(m[1].toLowerCase());
      // A shortcut opened only to read its target is a read; .Save() writes the shortcut file.
      cmd = cmd.replace(/\(\s*New-Object\s+-ComObject\s+WScript\.Shell\s*\)\.CreateShortcut\(\s*(["'])(.*?)\1\s*\)/gi, (m, q, file) => {
        if (/\.Save\(\s*\)/i.test(cmd)) this.path(file, this.projectDir, { write: true });
        return "'SHORTCUT'";
      });
    }
    // Port 4747: reading the hub (a GET) is fine; stopping, restarting or changing it is a hard stop (see curl, KILL, hubPort).
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

  // The top folder under the system temp folder that a path sits in ("C:/.../Temp/lab-tidy/x.svg" -> ".../Temp/lab-tidy"),
  // '' for the temp folder itself, null when the path is not in temp.
  tempTop(p, cwd) {
    const a = this.abs(p, cwd);
    if (typeof a !== 'string' || ['null', 'tmp', 'outside'].includes(a) || !under(a, this.tmp)) return null;
    const rel = norm(a).slice(norm(this.tmp).length).replace(/^\/+/, '');
    return rel ? join(this.tmp, rel.split('/')[0]) : '';
  }
  // A write into a temp folder that does not exist yet: this agent is making it, so it may delete it later.
  noteTemp(p, cwd) {
    const top = this.tempTop(p, cwd);
    if (top && !existsSync(top)) this.tempMade?.add(top);
  }
  // R005: an agent's own temp folder is one whose name carries the agent's name, or one it made this session.
  ownTemp(top) {
    if (!top) return false;
    const name = basename(top).toLowerCase();
    return (this.agent && name.includes(this.agent)) || this.madeTemp?.has(norm(top)) || this.tempMade?.has(top);
  }

  pathLike(v) { return /[\\/]|^~|^\.\.?$|^[a-z]:/i.test(v) && !/^[\w.-]+:[^\\/]/.test(v); }
  outside(v, cwd) { return this.pathLike(v) && this.where(v, cwd) === 'outside'; }

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
    // VAR=value cmd: judged by the command after it; the value is checked like any word (secrets, variables).
    while (words.length && /^\w+=/.test(words[0].text) && words.length > 1) {
      if (/^\w*PORT\w*=4747$/i.test(words[0].text)) this.stop('Starts something on the hub\'s port 4747');
      if (SECRET_VAR.test(words[0].text.split('=')[0]) && /\$/.test(words[0].text)) this.stop(`Passes what looks like a secret (${words[0].text})`);
      this.word({ ...words[0], text: words[0].text.replace(/^\w+=/, '') }, cwd);
      words = words.slice(1);
    }
    while (words.length && /^(if|then|else|elif|fi|do|done|while|until|!|time)$/.test(words[0].text)) words = words.slice(1);
    if (!words.length) return cwd;
    // Running a program by its full path is running that program: "/c/Program Files/GitHub CLI/gh.exe" is gh.
    const first = words[0].text;
    const head = (this.pathLike(first) ? basename(first.replace(/\\/g, '/')) : first).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    const args = words.slice(1).map(w => w.text);
    // Every word after the program: variables, addresses and secrets (paths are judged by what the program does).
    this.urlsHere = []; this.localUrls = [];
    // The script after powershell -Command is read as PowerShell on its own (see run), so its words are not checked here.
    const psAt = /^(powershell|pwsh)$/.test(head) ? args.findIndex(a => /^-(c|command)$/i.test(a)) : -1;
    for (const w of (psAt >= 0 ? words.slice(1, psAt + 2 - 1) : words.slice(1))) this.word(w, cwd);
    if (SECRET.test(norm(first))) this.stop(`Touches secrets or credentials: ${first}`);
    // An address is a network call, except a PR's own text, GitHub for git, and this machine (localhost).
    const github = this.urlsHere.every(u => /^(https:\/\/|git@)github\.com[/:]/i.test(u));
    const allowsAddress = (head === 'gh' && args[0] === 'pr' && args[1] === 'create') || (head === 'git' && github && args.some(a => /^(clone|fetch|pull|ls-remote)$/.test(a)));
    if (this.urlsHere.length && !allowsAddress) this.stop(`Reaches the network (${this.urlsHere[0].slice(0, 80)})`);
    if (['cd', 'pushd', 'set-location', 'sl', 'push-location', 'chdir'].includes(head)) {
      const to = args.find(a => !a.startsWith('-'));
      if (!to) return this.home;
      const a = this.abs(to, cwd);
      return a === 'outside' || a === 'null' ? resolve('/__outside__') : a;
    }
    this.run(head, args, words, cwd);
    return cwd;
  }

  run(head, args, words, cwd) {
    if (/^\$(_|psitem)\b/i.test(head) || /^-(and|or|not|eq|ne|gt|lt|ge|le|like|match)$/i.test(head)) return; // a PowerShell filter expression
    // Using one of its own variables ($s.TargetPath, $s = ...): an expression, judged by its other words.
    // A bare system variable as a statement just prints it ($env:ProgramFiles).
    const sys = /^\$\{?(?:env:)?([\w()]+)\}?$/i.exec(head);
    if (sys && SYSTEM_VARS.test(sys[1]) && !args.length) return;
    // A variable followed by words is being run as a command ("& $x push"): that is opaque.
    const own = /^\$(\w+)(.*)$/.exec(head);
    if (own && this.localVars?.has(own[1].toLowerCase())) {
      if (own[2] || !args.length || args[0].startsWith('=')) return;
      return this.unsure(`Runs a command held in a variable (${words.map(w => w.text).join(' ')})`);
    }
    if (head === "'shortcut'" || head === 'shortcut') return;
    // powershell -Command "...": read the PowerShell inside like any other command.
    if (/^(powershell|pwsh)$/.test(head)) {
      const i = args.findIndex(a => /^-(c|command)$/i.test(a));
      if (i < 0 || !args[i + 1] || args.slice(0, i).some(a => !/^-(noprofile|nologo|noninteractive|executionpolicy|bypass|sta|mta)$/i.test(a) && !/^(bypass|remotesigned)$/i.test(a))) {
        return this.unsure(`Runs commands the hub cannot read (${head})`);
      }
      const inner = args.slice(i + 1).join(' ').replace(/\\([$"`\\])/g, '$1');
      const saved = { urls: this.urlsHere, local: this.localUrls };
      this.command(inner, true);
      this.urlsHere = saved.urls; this.localUrls = saved.local;
      return;
    }
    const positional = args.filter(a => !a.startsWith('-'));
    const outsideHere = this.where(cwd, cwd) === 'outside';
    // A request to this machine: reading (GET) is fine anywhere, the hub on 4747 included. Sending data to the
    // hub on 4747 changes it: a hard stop. Sending data to a test hub is left to the orchestrator.
    if (/^(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)$/.test(head) && !this.urlsHere.length && this.localUrls.length) {
      const sends = args.some(a => /^(-X|--request|-d|--data(-\w+)?|-F|--form|--json|-T|--upload-file|-Method|-Body|--post-data|--post-file)$/i.test(a) || /^-X(POST|PUT|PATCH|DELETE)$/i.test(a))
        && !args.some((a, i) => /^(-X|--request|-Method)$/i.test(args[i - 1] || '') && /^(GET|HEAD)$/i.test(a));
      if (sends && this.localUrls.some(u => /:4747\b/.test(u) || !/:\d+/.test(u))) return this.stop('Sends a change to the hub on port 4747 (or to localhost with no port named)');
      // Sending to a test hub (any other port on this machine) is contained.
      const out = args.findIndex(a => /^(-o|--output|-OutFile)$/i.test(a));
      if (out >= 0 && args[out + 1]) this.path(args[out + 1], cwd, { write: true });
      return;
    }
    if (NETWORK.has(head)) return this.stop(`Reaches the network (${head})`);
    // Programs that write: a target outside the project folder or a temp folder is a hard stop.
    const writes = WRITE_ALL.has(head) ? positional : WRITE_LAST.has(head) ? positional.slice(-1) : head === 'sed' && args.some(a => /^-i/.test(a)) ? positional.slice(-1) : null;
    if (writes) {
      for (const t of writes) {
        if (this.outside(t, cwd) || (outsideHere && !this.pathLike(t))) this.stop(`Writes outside the project folder (${head} ${t})`);
        else if (this.where(t, cwd) === 'tmp') this.noteTemp(t, cwd);
      }
      return;
    }
    if (KILL.has(head)) return this.stop(`Stops a process (${head}); the hub cannot tell it is not the hub on port 4747`);
    if (INSTALL.has(head)) return this.stop(`Installs software (${head})`);
    if (/^(env|printenv|set|get-credential|get-secret)$/.test(head)) return this.stop(`Reads environment variables or credentials (${head})`);
    if (INDIRECT.has(head)) return this.unsure(`Runs commands the hub cannot read (${head})`);
    // R004: deleting inside the project folder or a temp folder is contained; anywhere else is a hard stop.
    if (DELETE.has(head)) {
      const targets = args.filter(a => !a.startsWith('-'));
      if (!targets.length) return this.unsure(`${head} with nothing named`);
      // "... | ForEach-Object { Remove-Item $_ }" deletes whatever the pipeline lists: outside anywhere in it is a hard stop.
      if (targets.some(t => /^\$(_|psitem)\b/i.test(t) || (/^\$(\w+)/.test(t) && this.localVars?.has(/^\$(\w+)/.exec(t)[1].toLowerCase())))) {
        return this.sawOutside ? this.stop(`Deletes what a pipeline lists, and the command names a path outside the project folder (${head} ${targets.join(' ')})`) : this.unsure(`Deletes what a pipeline lists (${head} ${targets.join(' ')})`, true);
      }
      if (targets.some(t => this.where(t, cwd) === 'outside')) this.stop(`Deletes files outside the project or a temp folder (${head} ${targets.join(' ')})`);
      else if (targets.some(t => ['.', './', '*'].includes(t) || this.where(t, cwd) === 'inside' && norm(resolve(cwd, t)) === norm(this.projectDir))) this.stop(`Deletes the whole project folder (${head} ${targets.join(' ')})`);
      else if (targets.some(t => this.tempTop(t, cwd) === '')) this.stop(`Deletes the whole temp folder (${head} ${targets.join(' ')})`);
      else {
        // In temp: the agent's own folders are contained; anything else there is for the orchestrator.
        const others = targets.filter(t => this.where(t, cwd) === 'tmp' && !this.ownTemp(this.tempTop(t, cwd)));
        if (others.length) this.unsure(`Deletes a temp folder that is not this agent's own (${others.join(' ')})`, true);
      }
      return;
    }
    if (head === 'find') {
      if (args.some(a => /^-(exec|execdir|ok|okdir)$/.test(a))) this.unsure('find runs other commands (-exec)');
      return;
    }
    if (SAFE.has(head) || head === 'strings' || head === 'cygpath' || /^get-[a-z]+$/.test(head) || /^(format|select|sort|measure|where|group|convertto|convertfrom|out-string)-?/.test(head) && !/^out-file$/.test(head)) return;   // reads, wherever it reads from
    if (head === 'git') return this.git(args, cwd);
    if (head === 'gh') return this.gh(args);
    // Browsers in headless mode, for screenshots: the files they write must stay contained.
    if (/^(msedge|chrome|chromium)$/.test(head)) {
      for (const a of args) { const m = /^--(screenshot|print-to-pdf|user-data-dir)=(.+)$/.exec(a); if (m) this.path(m[2], cwd, { write: true }); }
      return;
    }
    // Programs that may write anywhere: given a path outside, or run from outside, the orchestrator decides.
    const away = outsideHere || positional.some(a => this.outside(a, cwd));
    if (head === 'node') { this.node(args); if (away) this.unsure('Runs node with a path outside the project folder', true); return; }
    if (/^(python3?|py)$/.test(head)) { this.python(args); if (away) this.unsure('Runs python with a path outside the project folder', true); return; }
    if (/^(npm|pnpm|yarn|bun)$/.test(head)) { this.npm(args, cwd); if (away) this.unsure('Runs npm outside the project folder', true); return; }
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
      // Every variable named in the word: $X, ${X}, $env:X, %X%.
      for (const m of t.matchAll(/\$\{?(env:)?([\w()]+)\}?|%(\w+)%/gi)) {
        const name = (m[2] || m[3] || '').replace(/\(x86\)$/i, '(x86)');
        if (/^(_|psitem|null|true|false|lastexitcode|\d)$/i.test(name) || this.localVars?.has(name.toLowerCase())) continue;
        if (SECRET_VAR.test(name)) { this.stop(`Reads what looks like a secret (${m[0]})`); continue; }
        if (SYSTEM_VARS.test(name)) continue;
        this.unsure(`Uses a variable the hub cannot check (${m[0]})`);
      }
      if (/\$\?/.test(t)) { /* exit status: fine */ }
    }
    // Addresses: this machine (localhost) and local files are not the network.
    const url = /(?:^|=)((?:https?|ftp|wss?|file):\/\/\S+|(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/\S*)?)/i.exec(t)?.[1];
    if (url || /^[\w.-]+@[\w.-]+:/.test(t)) {
      const u = url || t;
      if (/^file:\/\//i.test(u)) return;
      if (/^(?:https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(u)) { this.localUrls?.push(u); return; }
      this.urlsHere?.push(u); return;
    }
    const v = /^--?[\w-]+=(.+)$/.exec(t)?.[1] ?? (t.startsWith('-') ? null : t);
    if (v == null) return;
    if (SECRET.test(norm(v))) this.stop(`Touches secrets or credentials: ${v}`);
    if (this.outside(v, cwd)) this.sawOutside = true;
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
    if (sub === 'merge') return this.stop('Merges branches (git merge)');
    // In a repo outside the project folder (git -C ../other, or after cd ..), only reading is fine.
    if (this.where(cwd, cwd) === 'outside' && !GIT_READ.has(sub) && sub !== 'branch' || (sub === 'branch' && this.where(cwd, cwd) === 'outside' && rest.some(x => !x.startsWith('-')))) {
      return this.stop(`Changes a git repo outside the project folder (git ${sub})`);
    }
    if (sub === 'push') return this.push(rest, cwd);
    if (sub === 'rebase') return this.unsure('Rebases (fine for a branch only this agent has; not for a shared one)', true);
    if (GIT_HISTORY.has(sub)) return this.stop(`Rewrites history (git ${sub})`);
    if (GIT_FETCH.has(sub)) {
      const pos = rest.filter(x => !x.startsWith('-'));
      if (pos[0] && !/^[\w.-]+$/.test(pos[0]) && !/^(https:\/\/|git@)github\.com[/:]/i.test(pos[0])) return this.stop(`Fetches from an address the hub cannot check (${pos[0]})`);
      if (sub === 'clone' && pos[1] && this.outside(pos[1], cwd)) return this.stop(`Clones outside the project folder (${pos[1]})`);
      return;
    }
    if (sub === 'submodule') return this.unsure('git submodule (may fetch other repos)', true);
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
    // Reading anywhere is fine; a script that writes, given a real path outside ("C:/x", "../x", not "\n"), is not.
    if (/\b(writeFile|appendFile|mkdir|rename|copyFile|cp|createWriteStream|symlink|truncate)(Sync)?\s*\(|open\([^)]*['"][wa]/.test(code)) {
      for (const m of code.matchAll(/['"`]((?:[a-z]:[\\/]|\/)[\w.~ -][^'"`\n]*|\.\.[\\/][^'"`\n]*)['"`]/gi)) {
        if (this.where(m[1], this.projectDir) === 'outside') this.stop(`An inline script that writes, with a path outside the project folder: ${m[1]}`);
      }
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
      let j = part.indexOf(c, i + 1);
      while (c === '"' && j > 0 && part[j - 1] === '\\') j = part.indexOf(c, j + 1);   // \" inside "..."
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
