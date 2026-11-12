// The board's permission rules (R004, under decisions 21, 22 and 34), read by the hub itself. Three outcomes:
// - 'human': a hard stop. Never left to the orchestrator's judgment: merging, pushing to main or master,
//   force-pushing, deleting branches, history rewrites, installs and dependency changes, writes or deletes outside
//   the project folder or a temp folder, network access, the hub on port 4747, and secrets.
// - 'unsure': the hub cannot read it with confidence (an unknown program, a script that runs other programs,
//   variables, substitutions). In auto mode these go to the orchestrator; one that also mentions a hard-stop word
//   goes to the human instead.
// - 'allow': contained work the hub could read in full: everything stays inside the project folder (which holds the
//   agents' worktrees, .claude/worktrees/...) or the system temp folder, plus feature-branch pushes and PRs.
//   classify({ tool, input, projectDir, level }) -> { route: 'allow' | 'unsure' | 'human', reasons: [hard stops], unsure: [why] }
// level (decision 45): 'standard' (Ask) and 'auto' are judged alike here (the hub decides what Ask sends on);
// 'trusted' also allows installing packages into the project and reading or downloading from any website into it.
// The fixed stops are the same at every level: force push, rewriting pushed history, deleting branches, pushing to
// main, writes outside the project or temp folder, secrets, the live hub, system-wide installers, outward connector
// actions, and merges (see THE MERGE RULE below).
import { resolve, isAbsolute, join, basename } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

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
// ---------- addresses on this machine (review of PR #51) ----------
// A web address aimed at this machine, read the way curl and browsers read it (new URL normalizes 127.1,
// 2130706433, 0x7f.1, LOCALHOST, [0:0::1] and ports like 04747): { live } where live means it could be the hub on
// 4747 (that port however written, no port at all, or a local-looking address that will not parse). null for any
// other address, and for words that are not addresses.
const LOCAL_WORD = /^(localhost\.?|[\w-]+\.localhost\.?|\[[0-9a-f:.]+\])(:\d*)?([/?#]\S*)?$|^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}(:\d+([/?#]\S*)?|[/?#]\S*)$/i;
const LOCAL_HINT = /localhost|\b127\.|\[[0-9a-f:.]*\]|0\.0\.0\.0/i;
export function localAddress(word) {
  const s = String(word || '');
  const schemed = /^[a-z][\w+.-]*:\/\//i.test(s);
  if (schemed ? !/^(https?|wss?|ftp):\/\//i.test(s) : !LOCAL_WORD.test(s)) return null;
  let u;
  try { u = new URL(schemed ? s : `http://${s}`); } catch { return LOCAL_HINT.test(s) ? { live: true } : null; }
  const h = u.hostname.toLowerCase();
  const local = h === '0.0.0.0' || /^127\./.test(h) || /(^|\.)localhost\.?$/.test(h) || h === '[::1]' || h === '[::]'
    || /^\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(h);
  if (!local) return null;
  return { live: u.port === '' || Number(u.port) === 4747 };
}

// ---------- one flag reader (review of PR #51) ----------
// How a program's options are spelled must never decide whether a check sees them. readFlags understands short flags
// combined and attached (-sSLo FILE, -oFILE, -dDATA, -qO-), long flags with =value or a separate value
// (--post-data=x, --output FILE), and PowerShell parameters by any unique prefix, with a value after a space or a
// colon (-OutF x, -Me POST, -Body:x). Each flag comes back under the name the spec gives it; anything the spec does
// not know is listed in unknown, so the caller can stop rather than guess.
//   spec: { short: { o: 'out' }, long: { output: 'out' }, valued: ['out'], whole: { '-nv': 'ok' } }
//      or { ps: { OutFile: 'out', Method: 'method' }, valued: [...] }
//   -> { flags: [{ name, value, raw }], positional: [words], unknown: [raw flags] }
export function readFlags(args, { short = {}, long = {}, valued = [], whole = {}, ps = null } = {}) {
  const V = new Set(valued), out = { flags: [], positional: [], unknown: [] };
  const add = (name, value, raw) => out.flags.push({ name, value, raw });
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') { out.positional.push(...args.slice(i + 1)); break; }
    if (ps) {
      const m = /^-([A-Za-z][\w-]*?)(?::(.*))?$/s.exec(a);
      if (!m) { out.positional.push(a); continue; }
      const key = m[1].toLowerCase(), names = Object.keys(ps);
      const exact = names.find(n => n.toLowerCase() === key);
      const hits = names.filter(n => n.toLowerCase().startsWith(key));
      const name = exact || (hits.length === 1 ? hits[0] : null);
      if (!name) { out.unknown.push(a); continue; }
      add(ps[name], V.has(ps[name]) ? (m[2] ?? args[++i]) : (m[2] ?? true), a);
      continue;
    }
    if (whole[a]) { add(whole[a], true, a); continue; }
    if (/^--[^-]/.test(a)) {
      const k = a.slice(2).split('=')[0], eq = a.includes('=') ? a.slice(a.indexOf('=') + 1) : undefined;
      const name = long[k];
      if (!name) { out.unknown.push(a); continue; }
      add(name, V.has(name) ? (eq ?? args[++i]) : (eq ?? true), a);   // a switch given =x keeps x (--global=true)
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const name = short[a[j]];
        if (!name) { out.unknown.push(`-${a[j]}`); continue; }
        if (V.has(name)) { const rest = a.slice(j + 1); add(name, rest !== '' ? rest : args[++i], a); break; }
        add(name, true, a);
      }
      continue;
    }
    out.positional.push(a);   // a lone "-" (standard input or output) included
  }
  return out;
}
const flagSpec = (pairs, valued) => {   // 'o output:out' -> short o and long --output, both named out
  const short = {}, long = {};
  for (const [names, name] of Object.entries(pairs)) for (const n of names.split(' ')) (n.length === 1 ? short : long)[n] = name;
  return { short, long, valued };
};
// curl, wget and Invoke-WebRequest / Invoke-RestMethod: what each option means for the checks.
//   out: writes that file; outdir: saves into that folder; remote: saves under the address's own name; send: sends
//   data; method: an HTTP method; creds: passes credentials; header: a request header; config: reads its options from
//   a file or a command (it could set anything); input: reads addresses from a file; ok / okv: harmless.
const CURL_FLAGS = flagSpec({
  'o output': 'out', 'output-dir': 'outdir', 'D dump-header trace trace-ascii stderr': 'out', 'O remote-name remote-name-all': 'remote',
  'J remote-header-name': 'remote', 'd data data-raw data-binary data-urlencode data-ascii json F form form-string T upload-file': 'send',
  'X request': 'method', 'u user b cookie c cookie-jar n netrc netrc-file netrc-optional oauth2-bearer E cert key U proxy-user proxy-header': 'creds',
  'H header': 'header', 'K config': 'config',
  's silent S show-error L location f fail fail-with-body k insecure v verbose i include I head G get # progress-bar N no-buffer compressed g globoff 4 6 R remote-time create-dirs http1.1 http2 q no-progress-meter ssl-no-revoke Z parallel location-trusted': 'ok',
  'A user-agent e referer m max-time connect-timeout retry retry-delay retry-max-time r range w write-out C continue-at x proxy limit-rate z time-cond max-filesize url max-redirs': 'okv'
}, ['out', 'outdir', 'send', 'method', 'creds', 'header', 'config', 'okv']);
const WGET_FLAGS = { ...flagSpec({
  'O output-document': 'doc', 'o output-file a append-output save-cookies': 'out', 'P directory-prefix': 'outdir',
  'post-data post-file body-data body-file': 'send', method: 'method',
  'user password http-user http-password ask-password load-cookies': 'creds', header: 'header',
  'e execute config': 'config', 'i input-file': 'input',
  'q quiet v verbose no-verbose c continue N timestamping r recursive k convert-links p page-requisites S server-response spider x force-directories no-check-certificate show-progress m mirror content-disposition no-clobber no-parent no-directories b background': 'ok',
  'U user-agent T timeout t tries w wait limit-rate l level max-redirect Q quota A accept R reject D domains progress': 'okv'
}, ['doc', 'out', 'outdir', 'send', 'method', 'creds', 'header', 'config', 'input', 'okv']), whole: { '-nv': 'ok', '-nc': 'ok', '-nd': 'ok', '-np': 'ok', '-nH': 'ok' } };
const IWR_FLAGS = {
  ps: { Uri: 'url', OutFile: 'out', Method: 'method', CustomMethod: 'method', Body: 'send', InFile: 'send', Form: 'send', Credential: 'creds', ProxyCredential: 'creds',
    UseDefaultCredentials: 'creds', ProxyUseDefaultCredentials: 'creds', Token: 'creds', Authentication: 'creds', Certificate: 'creds', CertificateThumbprint: 'creds',
    WebSession: 'creds', SessionVariable: 'creds', Headers: 'header', UseBasicParsing: 'ok', UserAgent: 'okv', TimeoutSec: 'okv', MaximumRedirection: 'okv',
    MaximumRetryCount: 'okv', RetryIntervalSec: 'okv', ContentType: 'okv', PassThru: 'ok', SkipCertificateCheck: 'ok', Proxy: 'okv', Resume: 'ok',
    ErrorAction: 'okv', Verbose: 'ok', DisableKeepAlive: 'ok', TransferEncoding: 'okv', SkipHeaderValidation: 'ok', SkipHttpErrorCheck: 'ok', NoProxy: 'ok' },
  valued: ['url', 'out', 'method', 'send', 'creds', 'header', 'okv']
};
// pip install / uninstall / download / wheel. place: a folder it writes to (must be inside); target: --target and the
// like (also a place); machine: installs for the user or the machine, or into another Python.
const PIP_FLAGS = (() => {
  const s = flagSpec({
    'user prefix root break-system-packages python': 'machine', 'src cache-dir log e editable': 'place',
    'r requirement c constraint i index-url extra-index-url f find-links no-binary only-binary platform python-version implementation abi progress-bar trusted-host timeout retries proxy exists-action global-option config-settings C report': 'okv',
    'U upgrade q quiet v verbose I ignore-installed no-deps pre no-cache-dir force-reinstall require-hashes no-build-isolation disable-pip-version-check no-index no-warn-script-location no-compile y yes upgrade-strategy': 'ok'
  }, ['machine', 'place', 'okv']);
  for (const k of ['t', 'target', 'd', 'dest', 'w', 'wheel-dir']) (k.length === 1 ? s.short : s.long)[k] = 'target';
  s.valued.push('target');
  return s;
})();
const webFlags = head => head === 'curl' ? CURL_FLAGS : head === 'wget' ? WGET_FLAGS : IWR_FLAGS;
// Programs that run a script handed to them, on a pipe or as a file (download-and-run, review of PR #51).
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'py', 'sh', 'bash', 'zsh', 'dash', 'pwsh', 'powershell', 'iex', 'invoke-expression',
  'cmd', 'perl', 'ruby', 'deno', 'bun', 'source', '.']);
const DOWNLOADERS = new Set([...['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer']]);

// Installers that put software on the whole machine: a stop at every level, Trusted included (decision 45).
const SYSTEM_WIDE = new Set(['winget', 'choco', 'scoop', 'apt', 'apt-get', 'brew', 'conda', 'pipx', 'gem', 'install-module', 'install-package', 'install-script', 'update-module']);
// Programs that read or download from a web address: Trusted lets them read and save into the project (decision 45).
const WEB_READ = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
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
// Variables the command sets itself ($o = 'literal', T=literal, for x in a b) are replaced by their values before the
// words are judged, so a path held in a variable is checked like any other path.
const VAR_REF = /\$\{?(env:)?(\w+)\}?|%(\w+)%/gi;
const varKey = m => `${m[1] ? 'env:' : ''}${m[2] || m[3]}`.toLowerCase();
// A value the hub can read in full: no globs, substitutions or unknown variables (path and system variables are fine).
const okValue = v => !/[`*?<>|;&\n[\]]|\$\(|\.\./.test(v) && !/[{}]/.test(v.replace(/\$\{[\w()]+\}/g, '')) &&
  [...v.matchAll(/\$\{?(?:env:)?([\w()]+)\}?|%(\w+)%/gi)].every(m => SYSTEM_VARS.test(m[1] || m[2]));
// Properties read off the result of a read-only cmdlet: (Get-Item x).LinkType, (Invoke-WebRequest ...).Content
const PROPERTY = /^(\.(content|statuscode|statusdescription|linktype|target|length|count|name|fullname|exists|attributes|lastwritetime|creationtime|extension|basename|headers|rawcontent|mode))+$/i;

// ---------- THE MERGE RULE (decision 45 B) ----------
// Matt, 2026-11-12: "install packages, open web, merge after a review with owner permission". In every project,
// Trusted included, merging a code pull request (gh pr merge) or merging into a branch (git merge) needs the owner's
// yes on that specific merge: the hub sends it to the owner as a card, and once the owner says yes the orchestrator
// does the merge. Trusted does not remove that. This one function is where that rule lives; to let a level merge
// without a card, return false for it here (and say so on the settings card, public/project-settings.js).
export const MERGE_RULE = 'Merges: the orchestrator merges after a review, once you say yes.';
export function mergeNeedsOwner({ level = 'auto' } = {}) {   // eslint-disable-line no-unused-vars
  return true;
}

// agent: the asking agent's name; madeTemp: temp folders it created earlier (full paths). Both decide which temp
// folders count as its own for deletes (R005). The result's tempMade lists temp folders this request would create.
// level: the project's permission level (decision 45); only 'trusted' changes what is allowed here.
export function classify({ tool, input = {}, projectDir, tmp = tmpdir(), home = homedir(), agent = '', madeTemp = [], level = 'auto' }) {
  const c = new Check(projectDir, tmp, home);
  c.level = level;
  c.trusted = level === 'trusted';
  c.agent = String(agent || '').toLowerCase();
  c.madeTemp = new Set([...madeTemp].map(norm));
  c.tempMade = new Set();
  c.fresh = new Set();   // temp folders $(mktemp) makes in this very command: its own, but not worth remembering by name
  c.envSet = new Map();  // environment settings the command makes for what follows (export X=, $env:X =)
  c.downloaded = new Set();   // files this command downloads: running one later in it is a stop
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
    Object.assign(this, { projectDir: resolve(projectDir), tmp, home, reasons: [], doubts: [], vars: new Map() });
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
    s = s.replace(/\$\{?PWD\}?(?!\w)/g, String(cwd).replace(/\\/g, '/'));   // the folder the step runs in
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
      if (DEP_FILES.test(rel) && !this.trusted) this.stop(`Changes dependencies (${basename(rel)})`);   // Trusted: the project's own packages
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
    // Reading docs is allowed (R004) but the hub cannot tell a docs page from any other address. Trusted: any website.
    if (tool === 'WebFetch') return this.trusted ? undefined : this.unsure(`Reads a web page (${String(input.url || '').slice(0, 80)})`);
    // The user's claude.ai connectors (Gmail, Calendar, Drive, ...): anything that sends, shares, changes or deletes is a
    // hard stop in every mode; reading goes to the orchestrator (a code project rarely needs the user's mail); a tool not on
    // the read list is a hard stop by default.
    const conn = connectorTool(tool);
    if (conn) {
      // {{who}} is the user's name from the profile: the hub personalizes these lines (Memory.personalize).
      if (conn.kind === 'read') return this.unsure(`Reads {{who}}'s ${conn.service} (${conn.name}): only if the task clearly needs it`, true);
      if (conn.kind === 'draft') return this.unsure(`Writes a draft in {{who}}'s ${conn.service} (${conn.name}); nothing is sent`, true);
      return this.stop(`Acts in {{who}}'s ${conn.service} (${conn.name}): sends, shares, changes or deletes, or is not a known read`);
    }
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
    if (!ps) s = this.knownSubs(s);
    // "stopped $($_.ProcessId)": a property of the pipeline object inside a string is only text.
    if (ps) s = s.replace(/\$\(\s*\$(?:_|psitem)(?:\.\w+)+\s*\)/gi, 'PROP');
    if (/`/.test(s.replace(/'[^']*'/g, ''))) this.unsure(ps ? 'Backtick escapes the hub cannot read' : 'Command substitution (backticks)');
    if (/\$\(|<\(|>\(/.test(s.replace(/'[^']*'/g, ''))) this.unsure('Command substitution the hub cannot read');
    let cwd = this.projectDir;
    const parts = splitParts(s, ps, true);
    this.pipeRuns(parts, s, ps);
    for (const part of parts) cwd = this.part(part.text, cwd, ps);
  }

  // The head (program name) of one part of a command, as pipeRuns and the substitution check read it.
  headOf(text) {
    const w = tokens(text).map(t => t.text);
    let k = 0; while (k < w.length - 1 && /^\w+=/.test(w[k])) k++;
    // A PowerShell assignment: $s = irm URL, $s =irm URL, $s=irm URL: the program is what comes after the =.
    if (/^\$[\w:]+$/.test(w[k] || '') && w[k + 1] === '=') k += 2;
    else if (/^\$[\w:]+$/.test(w[k] || '') && /^=./.test(w[k + 1] || '')) { w[k + 1] = w[k + 1].slice(1); k += 1; }
    else if (/^\$[\w:]+=./.test(w[k] || '')) w[k] = w[k].slice(w[k].indexOf('=') + 1);
    const first = w[k] || '';
    return { head: (this.pathLike(first) ? basename(first.replace(/\\/g, '/')) : first).toLowerCase().replace(/\.(exe|cmd|bat)$/, ''), args: w.slice(k + 1) };
  }

  // Download-and-run (review of PR #51), at every level: a download piped into a program that runs what it is given
  // (curl URL | sh, | node, | python3, iwr URL | iex) is a stop. A download from this machine piped into a program
  // that only reads it as data (curl localhost:4791/api/state | node -e "...") is fine. Anything else piped into a
  // program that takes its script from the pipe is not counted as contained. (Running a file the same command
  // downloaded is caught in simple().)
  // s: the whole command (heredocs already taken out), for the substitution check.
  pipeRuns(parts, s = '', ps = false) {
    let fetched = null;   // 'web' or 'local' once a download has been seen earlier in the command
    const heads = parts.map(p => this.headOf(p.text).head);
    // iex / Invoke-Expression (or a script block made from text) with a download anywhere in the same command:
    // iex (iwr URL), Invoke-Expression (Invoke-RestMethod URL), $s = irm URL; iex $s.
    if (heads.some(h => /^(iex|invoke-expression)$/.test(h)) && heads.some(h => DOWNLOADERS.has(h))) this.stop('Runs what it downloads (iex with a download in the same command)');
    if (/\[scriptblock\]::create/i.test(s) && heads.some(h => DOWNLOADERS.has(h))) this.stop('Runs what it downloads (a script block made from a download)');
    // A command or process substitution that downloads, feeding a program that runs scripts:
    // sh -c "$(curl URL)", bash <(curl URL), source <(curl URL), . <(curl URL), node -e "$(curl URL)".
    const fetchingSub = substitutions(s).some(inner => splitParts(inner, ps).some(p => DOWNLOADERS.has(this.headOf(p).head)));
    if (fetchingSub && heads.some(h => INTERPRETERS.has(h) || /^(eval|exec|xargs)$/.test(h))) this.stop('Runs what it downloads (a download inside a command substitution)');
    for (const { text, op } of parts) {
      const { head, args } = this.headOf(text);
      if (DOWNLOADERS.has(head)) {
        const urls = args.filter(x => /^[a-z]+:\/\/|^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(x) || localAddress(x));
        const web = !urls.length || urls.some(u => !localAddress(u));
        fetched = fetched === 'web' || web ? 'web' : 'local';
      }
      // A download piped into a program that writes it to a file (| tee a.sh, | Out-File a.ps1): that file counts
      // as downloaded, so running it later in the command is caught.
      if (fetched && op === '|' && /^(tee|tee-object|out-file|set-content|sc|add-content|ac)$/.test(head)) {
        for (const a of args.filter(x => !x.startsWith('-'))) { const p = this.abs(a, this.projectDir); if (typeof p === 'string') this.downloaded?.add(norm(p)); }
      }
      if (op !== '|' || !INTERPRETERS.has(head)) continue;
      const script = stdinScript(head, args);
      if (fetched === 'web' || (fetched && script)) this.stop(`Runs what it downloads (a download piped into ${head})`);
      else if (script) this.unsure(`Runs a script fed to ${head} through a pipe`, true);
    }
  }

  // Command substitutions whose output the hub knows, replaced by that value before the words are judged (R005):
  // $(mktemp) and $(mktemp -d) make a new file or folder in temp (Git Bash's /tmp is the Windows temp folder), so the
  // value is a fresh temp path that is this command's own; $(cygpath -w X), -m and -u only rewrite X in another form,
  // so the value is X itself. Anything else stays a substitution the hub cannot read.
  knownSubs(s) {
    s = s.replace(/\$\(\s*cygpath(?:\s+-[wmua])+\s+(?:"([^"`()\s]+)"|'([^'`()\s$]+)'|([^\s"'`()<>|;&]+))\s*\)/g, (all, dq, sq, bare) => dq ?? sq ?? bare);
    if (/\s/.test(this.tmp)) return s;   // a temp path with spaces would split into several words
    let n = 0;
    return s.replace(/\$\(\s*mktemp(?:\s+(?:-d|--directory|-t\s+[\w.-]+))*\s*\)/g, () => {
      const p = join(this.tmp, `crux-hub-mktemp-${++n}`).replace(/\\/g, '/');
      this.fresh.add(norm(p));
      return p;
    });
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
  // dir: the path itself is a folder being made (mkdir, New-Item), so it is tracked too, however deep (R005).
  noteTemp(p, cwd, dir = false) {
    const top = this.tempTop(p, cwd);
    if (top && this.fresh?.has(norm(top))) return;   // made by $(mktemp) in this command: its real name is not known
    if (top && !existsSync(top)) this.tempMade?.add(top);
    const a = dir && top ? this.abs(p, cwd) : null;
    if (typeof a === 'string' && !['null', 'tmp', 'outside'].includes(a) && !existsSync(a)) this.tempMade?.add(a);
  }
  // R005: an agent's own temp folder is one whose name carries the agent's name, or one it made this session
  // (the folder itself or anything inside it).
  ownTemp(p, cwd) {
    const top = this.tempTop(p, cwd);
    if (!top) return false;
    if (this.agent && basename(top).toLowerCase().includes(this.agent)) return true;
    const a = this.abs(p, cwd);
    return [...(this.madeTemp || []), ...(this.tempMade || []), ...(this.fresh || [])].some(m => under(a, m));
  }

  // True when a word holds a variable whose value is only known at run time ($_, or one set to something not literal).
  unresolved(t) {
    for (const m of String(t).matchAll(/\$\{?(env:)?(\w+)\}?/gi)) {
      if (/^(_|psitem)$/i.test(m[2]) || (!m[1] && this.localVars?.has(m[2].toLowerCase()))) return true;
    }
    return false;
  }
  pathLike(v) { return /[\\/]|^~|^\.\.?$|^[a-z]:/i.test(v) && !/^[\w.-]+:[^\\/]/.test(v); }
  outside(v, cwd) { return this.pathLike(v) && this.where(v, cwd) === 'outside'; }

  // One simple command. Returns the working folder for the next one (only cd changes it).
  part(raw, cwd, ps) {
    const words = tokens(raw);
    if (!words.length) return cwd;
    if (this.defineVars(words, ps, cwd)) return cwd;
    const sets = this.bind(words);
    if (!sets) { this.unsure('A loop or variable with too many values for the hub to check'); return cwd; }
    for (const ws of sets) cwd = this.simple(ws, cwd, ps);
    return cwd;
  }

  // The text of a word with the variables set earlier in this command replaced (values: one choice per variable).
  fill(text, values) {
    return text.replace(VAR_REF, (all, e, n, p) => {
      const k = varKey([all, e, n, p]);
      return values.has(k) ? values.get(k) : all;
    });
  }
  // The words once per value of each loop variable they use (one set when nothing varies); null if far too many.
  bind(words) {
    if (!this.vars.size) return [words];
    const used = new Set();
    for (const w of words) if (w.vars) for (const m of w.text.matchAll(VAR_REF)) if (this.vars.has(varKey(m))) used.add(varKey(m));
    if (!used.size) return [words];
    let sets = [new Map()];
    for (const k of used) {
      sets = sets.flatMap(m => this.vars.get(k).map(v => new Map(m).set(k, v)));
      if (sets.length > 40) return null;
    }
    return sets.map(m => words.map(w => {
      if (!w.vars) return w;
      const text = this.fill(w.text, m);
      return { ...w, text, orig: w.orig ?? w.text, vars: /\$|%\w+%/.test(text) };   // orig: as written, before filling
    }));
  }
  // A variable the command sets: bash T=value, export T=value, for x in a b; PowerShell $x = 'value', $env:X = 'value',
  // foreach ($x in 'a','b'). Only literal values count; anything else stays a variable the hub cannot check.
  // True when the part was only this (nothing else to judge).
  defineVars(words, ps, cwd) {
    // $PWD in a value is the folder it is set in ("W=$PWD", from $(cygpath -w "$PWD")), not where it is used later.
    const single = t => { const v = this.bind([{ text: t, vars: true }]); return v && v.length === 1 ? v[0][0].text.replace(/\$\{?PWD\}?(?!\w)/g, String(cwd).replace(/\\/g, '/')) : null; };
    const set = (key, vals) => {
      if (vals.length === 1 && vals[0] === 'SHORTCUT') { this.vars.delete(key); return true; }   // a COM object, not text
      const ok = vals.length && vals.every(v => v != null && okValue(v));
      if (!ok) { this.vars.delete(key); (this.localVars ||= new Set()).add(key); return false; }   // known only at run time
      if (vals.some(v => SECRET.test(norm(v)))) this.stop(`Touches secrets or credentials: ${vals.join(' ')}`);
      if (/(^|:)\w*port\w*$/.test(key) && vals.includes('4747')) this.stop("Sets a port to the hub's own 4747");
      this.vars.set(key, vals);
      if (key.startsWith('env:') || exported) this.envSet.set(key.replace(/^env:/, ''), vals[0]);   // seen by the programs it runs
      return true;
    };
    const t0 = words[0].text;
    const exported = !ps && t0 === 'export';
    if (!ps && t0 === 'for' && words[2]?.text === 'in' && /^\w+$/.test(words[1].text)) {
      return set(words[1].text.toLowerCase(), words.slice(3).map(w => single(w.text))) || void 0;
    }
    if (ps && /^\$\w+$/.test(t0) && words[1]?.text === 'in') {
      const list = words.slice(2).map(w => single(w.text)).join(' ').split(/\s*,\s*/).filter(Boolean);
      return set(t0.slice(1).toLowerCase(), list) || void 0;
    }
    let pairs = null;
    if (ps) {
      const m = /^\$(env:)?(\w+)(?:=(.*))?$/s.exec(t0);
      if (m) {
        const last = words.at(-1);
        let val = null;
        if (m[3] !== undefined && m[3] !== '' && words.length === 1) val = m[3];
        else if (m[3] === '' && words.length === 2) val = words[1].text;
        else if (m[3] === undefined && words.length === 3 && words[1].text === '=') val = words[2].text;
        else if (m[3] === undefined && words.length === 2 && /^=./.test(words[1].text)) val = words[1].text.slice(1);
        // $t = Join-Path $env:TEMP 'name' (or -Path a -ChildPath b): only joins two words, so its value is a\b.
        let joined = false;
        if (m[3] === undefined && words[1]?.text === '=' && /^join-path$/i.test(words[2]?.text || '')) {
          const r = words.slice(3).map(w => w.text);
          const [a, b] = r.length === 2 && !r.some(x => x.startsWith('-')) ? r
            : r.length === 4 && /^-path$/i.test(r[0]) && /^-childpath$/i.test(r[2]) ? [r[1], r[3]] : [];
          if (a && b && /^\$\{?env:(temp|tmp)\}?$|^[a-z]:[\\/]/i.test(a) && !/\$/.test(b)) { val = `${a}\\${b}`; joined = true; }
        }
        if (val != null && (last.quoted || joined || /^\d+$/.test(val))) pairs = [[`${m[1] ? 'env:' : ''}${m[2]}`.toLowerCase(), val]];
        else if (m[3] !== undefined || words[1]?.text === '=' || /^=/.test(words[1]?.text || '')) { this.vars.delete(`${m[1] ? 'env:' : ''}${m[2]}`.toLowerCase()); return false; }
      }
    } else {
      const ws = t0 === 'export' ? words.slice(1) : words;
      if (ws.length && ws.every(w => /^[A-Za-z_]\w*=/.test(w.text))) pairs = ws.map(w => [w.text.split('=')[0].toLowerCase(), w.text.slice(w.text.indexOf('=') + 1)]);
    }
    if (!pairs) return false;
    if (SECRET_VAR.test(pairs.map(p => p[0]).join(' ')) && pairs.some(p => /\$/.test(p[1]))) { for (const w of words) this.word(w, cwd); return false; }
    let all = true;
    for (const [k, v] of pairs) all = set(k, [single(v)]) && all;
    if (!all) for (const w of words) this.word(w, cwd);   // a value that is not a plain literal: judged as before
    return all;
  }

  // One simple command, its variables already filled in.
  simple(words, cwd, ps) {
    // redirections: > file, >> file, 2> file, < file (2>&1 needs no check)
    const keep = [], wrote = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (!w.op) { keep.push(w); continue; }
      if (/&\d$/.test(w.text)) continue;
      const target = words[++i];
      if (!target) { this.unsure('A redirection with no file'); continue; }
      this.word(target, cwd);
      if (!/^\$null$/i.test(target.text)) this.path(target.text, cwd, { write: !w.text.startsWith('<') });
      if (!w.text.startsWith('<')) wrote.push(target.text);
    }
    words = keep;
    // What a download writes through > or >> counts as downloaded: running it later in this command is a stop.
    if (wrote.length && words.length && DOWNLOADERS.has(basename(String(words.find(x => !/^\w+=/.test(x.text))?.text || '').replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat)$/, ''))) {
      for (const t of wrote) { const a = this.abs(t, cwd); if (typeof a === 'string' && !['null', 'outside'].includes(a)) this.downloaded?.add(norm(a)); }
    }
    // VAR=value cmd: judged by the command after it; the value is checked like any word (secrets, variables), and
    // the program sees it (see envAway and node: a test hub's data and profile folders).
    this.envNow = new Map();
    while (words.length && /^\w+=/.test(words[0].text) && words.length > 1) {
      if (/^\w*PORT\w*=4747$/i.test(words[0].text)) this.stop('Starts something on the hub\'s port 4747');
      if (SECRET_VAR.test(words[0].text.split('=')[0]) && /\$/.test(words[0].orig ?? words[0].text)) this.stop(`Passes what looks like a secret (${words[0].orig ?? words[0].text})`);
      this.word({ ...words[0], text: words[0].text.replace(/^\w+=/, '') }, cwd);
      this.envNow.set(words[0].text.split('=')[0].toLowerCase(), words[0].text.replace(/^\w+=/, ''));
      words = words.slice(1);
    }
    while (words.length && /^(if|then|else|elif|fi|do|done|while|until|!|time|foreach)$/.test(words[0].text)) words = words.slice(1);
    // timeout N <command> (coreutils): it only limits how long the command runs, so the command is what is judged.
    if (words[0]?.text === 'timeout') {
      let i = 1;
      while (/^(--preserve-status|--foreground|-v|--verbose)$/.test(words[i]?.text || '') || /^--(kill-after|signal)=\w+$/.test(words[i]?.text || '')) i++;
      if (/^-[ks]$/.test(words[i]?.text || '') && /^\w+$/.test(words[i + 1]?.text || '')) i += 2;
      if (/^\d+(\.\d+)?[smhd]?$/.test(words[i]?.text || '') && words.length > i + 1) words = words.slice(i + 1);
    }
    if (!words.length) return cwd;
    // A string on its own in PowerShell ("checked") is only printed.
    if (ps && words.length === 1 && words[0].quoted && !this.pathLike(words[0].text)) { this.word(words[0], cwd); return cwd; }
    // Running a program by its full path is running that program: "/c/Program Files/GitHub CLI/gh.exe" is gh.
    const first = words[0].text;
    const head = (this.pathLike(first) ? basename(first.replace(/\\/g, '/')) : first).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    const args = words.slice(1).map(w => w.text);
    // Running a file this same command just downloaded (curl ... -o a.sh && sh a.sh; ; node a.js; ./a.sh): a stop.
    if (this.downloaded?.size) {
      const got = x => { const a = this.abs(x, cwd); return typeof a === 'string' && this.downloaded.has(norm(a)); };
      if (got(first) || ((INTERPRETERS.has(head) || /^(start|start-process|saps|invoke-item|ii|call)$/.test(head)) && args.some(got))) {
        this.stop(`Runs a file this command just downloaded (${words.map(w => w.text).join(' ').slice(0, 80)})`);
      }
    }
    this.ps = ps;
    // Every word after the program: variables, addresses and secrets (paths are judged by what the program does).
    this.urlsHere = []; this.localUrls = []; this.fileUrls = [];
    // The script after powershell -Command is read as PowerShell on its own (see run), so its words are not checked here.
    const psAt = /^(powershell|pwsh)$/.test(head) ? args.findIndex(a => /^-(c|command)$/i.test(a)) : -1;
    for (const w of (psAt >= 0 ? words.slice(1, psAt + 2 - 1) : words.slice(1))) this.word(w, cwd);
    if (SECRET.test(norm(first))) this.stop(`Touches secrets or credentials: ${first}`);
    // An address is a network call, except a PR's own text, GitHub for git, and this machine (localhost).
    const github = this.urlsHere.every(u => /^(https:\/\/|git@)github\.com[/:]/i.test(u));
    const allowsAddress = (head === 'gh' && args[0] === 'pr' && args[1] === 'create') || (head === 'git' && github && args.some(a => /^(clone|fetch|pull|ls-remote)$/.test(a)));
    // Trusted (decision 45): an address is no stop by itself; what the program does with it is judged below
    // (sending data, pushing, ssh and the like stay stops). Anything that reaches git or gh keeps its own checks.
    if (this.urlsHere.length && !allowsAddress && !(this.trusted && head !== 'gh')) this.stop(`Reaches the network (${this.urlsHere[0].slice(0, 80)})`);
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
    this.noteFilters(head, args);
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
    // (Get-Item x).LinkType, (Invoke-WebRequest ...).Content: reading a property of what a cmdlet already returned.
    if (!args.length && PROPERTY.test(head)) return;
    // Running a script that sits in the project, a worktree or the temp folder is contained (its arguments were checked).
    const script = (file, rest) => file && ['inside', 'tmp'].includes(this.where(file, cwd)) && !rest.some(a => a !== file && this.outside(a, cwd));
    if (/^(powershell|pwsh)$/.test(head)) {
      const f = args.findIndex(a => /^-file$/i.test(a));
      if (f >= 0 && !args.some(a => /^-(c|command)$/i.test(a)) && script(args[f + 1], args)) return;
    }
    if (/^(sh|bash|zsh)$/.test(head) && !args.some(a => /^-[a-z]*c[a-z]*$/i.test(a))) {
      const file = args.find(a => !a.startsWith('-'));
      if (script(file, args)) return;
    }
    // cmd /c rmdir PATH (no /s) removes an empty folder or a junction, never what a junction points to.
    if (head === 'cmd') {
      const i = args.findIndex(a => /^\/\/?c$/i.test(a));   // //c is how Git Bash passes /c
      let inner = i >= 0 ? args.slice(i + 1) : [];
      if (inner.length === 1) inner = tokens(inner[0]).map(w => w.text);
      if (/^(rmdir|rd)$/i.test(inner[0] || '') && !inner.some(a => /^\/s$/i.test(a))) {
        const targets = inner.slice(1).filter(a => !a.startsWith('/'));
        if (targets.length) return this.run('rmdir', targets, words, cwd);
      }
      // cmd /c mklink /J LINK TARGET: a junction made inside the project (a worktree's node_modules) that points
      // inside the project. Made outside is a write outside; pointing outside is left as before (unsure).
      if (/^mklink$/i.test(inner[0] || '') && /^\/j$/i.test(inner[1] || '') && inner.length === 4) {
        const [link, target] = inner.slice(2);
        if (this.where(link, cwd) === 'outside') return this.stop(`Writes outside the project folder (mklink ${link})`);
        if (this.where(link, cwd) === 'inside' && this.where(target, cwd) === 'inside' && !/[*?$%`]/.test(link + target)) {
          this.path(link, cwd, { write: true });   // never inside .git, .crux or Claude Code's settings
          return;
        }
      }
    }
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
    // A downloader pointed at a file on this computer (curl file:///c/Users/me/.ssh/id_rsa -o k.txt) copies it: a stop.
    if (DOWNLOADERS.has(head) && this.fileUrls?.length) return this.stop(`Reads a file on this computer through a file:// address (${this.fileUrls[0].slice(0, 80)})`);
    // Read through readFlags, so no spelling (-sd, -d'{..}', -sXPOST, -Me POST, -Meth Post) slips past: to the hub on
    // 4747, or to this machine with no port named, only a plain GET is fine; anything the hub cannot read in full is a
    // stop there, at every level.
    if (/^(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)$/.test(head) && !this.urlsHere.length && this.localUrls.length) {
      const r = this.webFlags(head, args);
      const live = this.localUrls.some(u => localAddress(u)?.live !== false);   // port 4747 as a number, no port, or unreadable
      if (live && (r.unknown.length || r.config || r.sends || r.inputs.length)) {
        return this.stop(`Sends a change to the hub on port 4747 (or to localhost with no port named), or uses an option the hub cannot check${r.unknown.length ? ` (${r.unknown[0]})` : ''}`);
      }
      // A test hub (any other port on this machine) is contained: only where it saves is checked.
      for (const o of [...r.saves, ...r.dirs]) {
        if (o === true || o == null) { this.stop(`${head} saves to a file the hub cannot read`); continue; }
        if (o === '-' || /^(\/dev\/null|nul|\$null)$/i.test(o)) continue;
        this.path(o, cwd, { write: true });
        const a = this.abs(o, cwd); if (typeof a === 'string') this.downloaded?.add(norm(a));
      }
      if (r.intoHere) this.path(cwd, cwd, { write: true });
      return;
    }
    if (this.trusted && WEB_READ.has(head)) return this.webRead(head, args, cwd);
    if (this.trusted && /^(ping|nslookup|test-netconnection|tnc)$/.test(head)) return;   // only looks an address up
    if (NETWORK.has(head)) return this.stop(`Reaches the network (${head})`);
    // Programs that write: a target outside the project folder or a temp folder is a hard stop.
    const recursive = args.some(a => /^(-recurse|--recursive|-[rf]*r[rf]*)$/i.test(a));
    const writes = WRITE_ALL.has(head) ? positional : WRITE_LAST.has(head) ? positional.slice(-1) : head === 'sed' && args.some(a => /^-i/.test(a)) ? positional.slice(-1) : null;
    if (writes) {
      for (const t of this.items(writes)) {
        if (recursive && this.unresolved(t)) { this.stop(`Writes recursively through a path the hub cannot resolve (${head} ${t})`); continue; }
        if (this.outside(t, cwd) || (outsideHere && !this.pathLike(t))) this.stop(`Writes outside the project folder (${head} ${t})`);
        else if (this.where(t, cwd) === 'tmp') this.noteTemp(t, cwd, /^(mkdir|md|new-item|ni)$/.test(head));
      }
      return;
    }
    if (KILL.has(head)) return this.kill(head, args, cwd);
    if (/^(pip3?)$/.test(head)) return this.pip(words[0].text, args, cwd);
    if (INSTALL.has(head)) return this.stop(SYSTEM_WIDE.has(head) ? `Installs software system-wide (${head})` : `Installs software (${head})`);
    if (head === 'uv' || head === 'poetry') return this.pyProject(head, args, cwd);
    if (/^(env|printenv|set|get-credential|get-secret)$/.test(head)) return this.stop(`Reads environment variables or credentials (${head})`);
    if (INDIRECT.has(head)) return this.unsure(`Runs commands the hub cannot read (${head})`);
    // R004: deleting inside the project folder or a temp folder is contained; anywhere else is a hard stop.
    if (DELETE.has(head)) {
      const targets = this.items(args.filter(a => !a.startsWith('-')));
      if (!targets.length) return this.unsure(`${head} with nothing named`);
      // "... | ForEach-Object { Remove-Item $_ }" deletes whatever the pipeline lists: outside anywhere in it is a hard stop.
      if (targets.some(t => /^\$(_|psitem)\b/i.test(t) || (/^\$(\w+)/.test(t) && this.localVars?.has(/^\$(\w+)/.exec(t)[1].toLowerCase())))) {
        if (recursive) return this.stop(`Deletes recursively through a path the hub cannot resolve (${head} ${args.join(' ')})`);
        return this.sawOutside ? this.stop(`Deletes what a pipeline lists, and the command names a path outside the project folder (${head} ${targets.join(' ')})`) : this.unsure(`Deletes what a pipeline lists (${head} ${targets.join(' ')})`, true);
      }
      return this.deletes(targets, cwd, `${head} ${targets.join(' ')}`);
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
    // Programs that may write anywhere: given a path outside (as an argument or an environment setting), or run from
    // outside, the orchestrator decides.
    const away = outsideHere || positional.some(a => this.outside(a, cwd)) || [...this.env().values()].some(v => this.outside(v, cwd));
    if (head === 'node') { this.node(args, cwd); if (away) this.unsure('Runs node with a path outside the project folder', true); return; }
    if (/^(python3?|py)$/.test(head)) { this.python(args, words[0].text, cwd); if (away) this.unsure('Runs python with a path outside the project folder', true); return; }
    if (/^(npm|pnpm|yarn|bun)$/.test(head)) { this.npm(args, cwd, head); if (away) this.unsure('Runs npm outside the project folder', true); return; }
    if (head === 'cargo' || head === 'go' || head === 'dotnet') {
      // Trusted: adding a package to this project (cargo add, go get, dotnet add package). cargo install and go
      // install put programs on the whole machine: system-wide, a stop at every level.
      const local = (head === 'cargo' && args[0] === 'add') || (head === 'go' && args[0] === 'get') || (head === 'dotnet' && args[0] === 'add');
      if (local && this.trusted && ['inside', 'tmp'].includes(this.where(cwd, cwd))) return;
      if (/^(install|add|get)$/.test(args[0] || '')) return this.stop(`Installs software${local ? '' : ' system-wide'} (${head} ${args[0]})`);
      if (!/^(build|test|run|vet|fmt|check|clippy)$/.test(args[0] || '')) this.unsure(`Not sure what this does (${head} ${args[0] || ''})`.trim());
      return;
    }
    this.unsure(`Not sure what this does (${words[0].text})`);
  }

  // R004 and R005: deleting inside the project folder or a temp folder is contained; anywhere else is a hard stop.
  deletes(targets, cwd, what) {
    if (targets.some(t => this.where(t, cwd) === 'outside')) this.stop(`Deletes files outside the project or a temp folder (${what})`);
    else if (targets.some(t => ['.', './', '*'].includes(t) || this.where(t, cwd) === 'inside' && norm(resolve(cwd, t)) === norm(this.projectDir))) this.stop(`Deletes the whole project folder (${what})`);
    else if (targets.some(t => this.tempTop(t, cwd) === '')) this.stop(`Deletes the whole temp folder (${what})`);
    else {
      // In temp: the agent's own folders are contained; anything else there is for the orchestrator.
      const others = targets.filter(t => this.where(t, cwd) === 'tmp' && !this.ownTemp(t, cwd));
      if (others.length) this.unsure(`Deletes a temp folder that is not this agent's own (${others.join(' ')})`, true);
    }
  }
  // PowerShell lists ("$t\a","$t\b" reach here as one word): each item is a path of its own.
  items(list) { return this.ps ? list.flatMap(t => t.split(',')).filter(Boolean) : list; }
  // Environment settings the next program sees: export X= and $env:X = earlier in the command, X=v in front of it.
  env() { return new Map([...(this.envSet || []), ...(this.envNow || [])]); }

  word(w, cwd) {
    const t = w.text;
    if (w.vars) {
      // Every variable named in the word: $X, ${X}, $env:X, %X%.
      for (const m of t.matchAll(/\$\{?(env:)?([\w()]+)\}?|%(\w+)%/gi)) {
        const name = (m[2] || m[3] || '').replace(/\(x86\)$/i, '(x86)');
        if (/^(_|psitem|null|true|false|lastexitcode|\d)$/i.test(name)) continue;
        // Set by the command itself but not to a plain literal: its value is only known at run time, so a path built
        // from it cannot be judged.
        if (this.localVars?.has(name.toLowerCase()) && !m[1]) { this.unsure(`Uses a variable whose value is only known at run time (${m[0]})`); continue; }
        if (SECRET_VAR.test(name)) { this.stop(`Reads what looks like a secret (${m[0]})`); continue; }
        if (SYSTEM_VARS.test(name)) continue;
        this.unsure(`Uses a variable the hub cannot check (${m[0]})`);
      }
      if (/\$\?/.test(t)) { /* exit status: fine */ }
    }
    // Addresses: this machine (localhost in any spelling, localAddress) and local files are not the network. A file://
    // address is checked for secrets like any path, and remembered: a downloader given one is a stop (run()).
    const url = /(?:^|=)((?:https?|ftp|wss?|file):\/\/\S+)/i.exec(t)?.[1];
    const bare = t.includes('=') ? t.slice(t.indexOf('=') + 1) : t;
    if (url && /^file:/i.test(url)) {
      let p = url.replace(/^file:\/\/(localhost)?/i, '');
      try { p = decodeURIComponent(p); } catch { }
      if (SECRET.test(norm(p))) this.stop(`Touches secrets or credentials: ${url}`);
      this.fileUrls?.push(url);
      return;
    }
    if (url) { (localAddress(url) ? this.localUrls : this.urlsHere)?.push(url); return; }
    if (localAddress(bare)) { this.localUrls?.push(bare); return; }
    if (/^[\w.-]+@[\w.-]+:/.test(t)) { this.urlsHere?.push(t); return; }
    const v = /^--?[\w-]+=(.+)$/.exec(t)?.[1] ?? (t.startsWith('-') ? null : t);
    if (v == null) return;
    if (SECRET.test(norm(v))) this.stop(`Touches secrets or credentials: ${v}`);
    if (this.outside(v, cwd)) this.sawOutside = true;
  }

  git(args, cwd) {
    let a = args;
    while (a.length) {
      if (a[0] === '-C') {   // its path was checked with the other words; /c/Users/... is Git Bash's C:/Users/...
        const to = this.abs(a[1] || '.', cwd);
        cwd = to === 'outside' || to === 'null' ? resolve('/__outside__') : to; a = a.slice(2); continue;
      }
      if (a[0] === '--no-pager' || a[0] === '-P') { a = a.slice(1); continue; }
      if (/^--(git-dir|work-tree)=/.test(a[0])) { a = a.slice(1); continue; }
      if (a[0].startsWith('-')) return this.unsure(`git with options the hub cannot check (${a[0]})`);
      break;
    }
    const [sub, ...rest] = a;
    const flag = (...fs) => rest.some(x => fs.includes(x));
    if (!sub) return;
    if (sub === 'merge') return this.merge('Merges branches (git merge)');
    // In a repo outside the project folder (git -C ../other, or after cd ..), only reading is fine.
    if (this.where(cwd, cwd) === 'outside' && !GIT_READ.has(sub) && sub !== 'branch' || (sub === 'branch' && this.where(cwd, cwd) === 'outside' && rest.some(x => !x.startsWith('-')))) {
      return this.stop(`Changes a git repo outside the project folder (git ${sub})`);
    }
    if (sub === 'push') return this.push(rest, cwd);
    if (sub === 'rebase') return this.rebase(rest, cwd);
    if (GIT_HISTORY.has(sub)) return this.stop(`Rewrites history (git ${sub})`);
    if (GIT_FETCH.has(sub)) {
      const pos = rest.filter(x => !x.startsWith('-'));
      // Trusted: downloading from any https address into the project is fine too (decision 45).
      const web = this.trusted && /^https:\/\/[\w.-]+\//i.test(pos[0] || '');
      if (pos[0] && !web && !/^[\w.-]+$/.test(pos[0]) && !/^(https:\/\/|git@)github\.com[/:]/i.test(pos[0])) return this.stop(`Fetches from an address the hub cannot check (${pos[0]})`);
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

  // What a filter earlier in the command pins the processes to: a command line or path (-like, -match, a WMI filter)
  // or a local port (Get-NetTCPConnection -LocalPort). Collected from every part; stopping needs at least one.
  noteFilters(head, args) {
    this.cmdFilters ||= []; this.portFilters ||= [];
    const low = args.map(a => a.toLowerCase());
    if (/^\$(_|psitem)\.(commandline|path|executablepath|name|processname)$/i.test(head)) {
      if (low.includes('-or')) this.cmdFilters.push('*');   // a second condition that may widen the match
      args.forEach((a, i) => { if (/^-[ci]?(like|match)$/i.test(a) && args[i + 1] && /commandline|path/i.test(head + ' ' + (args[i - 1] || ''))) this.cmdFilters.push(args[i + 1]); });
      if (/^-[ci]?(like|match)$/i.test(args[0] || '') && !/commandline|path/i.test(head)) this.nameFilter = true;
    } else if (/^(get-ciminstance|get-wmiobject|gcim|gwmi)$/.test(head)) {
      const f = args[low.indexOf('-filter') + 1] || '';
      const m = /commandline\s+like\s+'([^']+)'/i.exec(f);
      if (m) this.cmdFilters.push(m[1]);
    } else if (head === 'get-nettcpconnection') {
      const i = low.indexOf('-localport');
      if (i >= 0) for (const p of String(args[i + 1] || '').split(',')) this.portFilters.push(p.trim());
    }
  }
  // 'ok': pins the processes to this agent's own temp folder. 'unsure': clearly a different temp path, so not the hub.
  // 'bad': could match the hub on 4747 (or anything).
  judgeCmd(raw, cwd) {
    const s = String(raw).replace(/\*/g, '').replace(/%(temp|tmp)%/gi, '$env:TEMP').replace(/%/g, '').replace(/\\+/g, '/').replace(/^['"]|['"]$/g, '');
    const p = s.toLowerCase();
    if (!p || /4747/.test(p)) return 'bad';
    let path = null;
    if (/^([a-z]:\/|\$env:te?mp|\$\{?env:te?mp)/i.test(s)) path = s;
    else if (/(^|\/)temp\/[^/]/.test(p)) path = join(this.tmp, s.replace(/^.*?(^|\/)temp\//i, ''));
    if (path) {
      const top = this.tempTop(path, this.projectDir);
      if (top === null || top === '') return 'bad';
      return this.ownTemp(path, this.projectDir) ? 'ok' : 'unsure';
    }
    const first = p.split('/')[0];
    if (/^(node|server\.mjs|hub|crux|claude)$/.test(first) || first.length < 5) return 'bad';
    const tracked = [...(this.madeTemp || []), ...(this.tempMade || [])].map(m => basename(m).toLowerCase());
    if (tracked.includes(first) || (this.agent.length >= 3 && first.includes(this.agent))) return 'ok';
    return /^[a-z0-9._-]{6,}$/.test(first) && !/hub|server|node|main|claude/.test(first) ? 'unsure' : 'bad';
  }
  judgePort(p) { const n = Number(p); return Number.isInteger(n) && n > 0 && n < 65536 && n !== 4747 ? 'ok' : 'bad'; }

  // Stopping processes: only ones a filter pins to this agent's own temp folder or to a port other than 4747. By name,
  // by a PID the hub cannot attribute, or with no filter, it could be the hub on 4747: a hard stop.
  kill(head, args, cwd) {
    const low = args.map(a => a.toLowerCase());
    const pipe = v => v != null && this.unresolved(v);       // $_.ProcessId, $_.OwningProcess, a variable set at run time
    let how = null;
    if (head === 'stop-process' || head === 'spps') {
      const i = low.findIndex(a => /^-(id|inputobject)$/.test(a));
      if (!low.some(a => a === '-name') && i >= 0 && pipe(args[i + 1])) how = 'id';
    } else if (head === 'taskkill') {
      const i = low.indexOf('/pid');
      if (i >= 0 && pipe(args[i + 1]) && !low.includes('/im') && !low.includes('/fi')) how = 'id';
    } else if (head === 'pkill' && low.includes('-f')) {
      const pat = args.filter(a => !a.startsWith('-'))[0];
      const v = pat ? this.judgeCmd(pat, cwd) : 'bad';
      if (v === 'ok') return;
      if (v === 'unsure') return this.unsure(`Stops processes whose command line names a folder that is not this agent's own (${pat})`, true);
    }
    const verdicts = [...(this.cmdFilters || []).map(f => this.judgeCmd(f, cwd)), ...(this.portFilters || []).map(f => this.judgePort(f))];
    if (!how || !verdicts.length || verdicts.includes('bad')) {
      return this.stop(`Stops a process (${head}) the hub cannot tell is not the hub on port 4747 (no filter on its own temp folder or a port other than 4747)`);
    }
    if (verdicts.includes('unsure')) this.unsure('Stops processes picked by a filter that excludes the hub, but not on one of this agent\'s own folders', true);
  }

  // A rebase of a branch that has no upstream, or whose upstream does not contain HEAD (the commits are not pushed), is
  // contained. A pushed branch, main, a detached HEAD and anything that runs other commands (--exec, -i) are not.
  rebase(rest, cwd) {
    const why = 'Rebases (fine for a branch only this agent has; not for a pushed or shared one)';
    if (rest.some(x => /^(-i|--interactive|-x|--exec(=.*)?|--root|--autostash)$/.test(x))) return this.unsure(why, true);
    const branch = currentBranch(cwd);
    if (!branch || /^(main|master)$/i.test(branch) || !existsSync(cwd)) return this.unsure(why, true);
    const git = (...a) => { try { return execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim(); } catch { return null; } };
    const upstream = git('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') ||
      (git('rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`) ? `origin/${branch}` : null);
    if (upstream && git('merge-base', '--is-ancestor', 'HEAD', upstream) !== null) this.unsure(why, true);   // HEAD is already pushed
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
    if (a === 'pr' && b === 'merge') return this.merge('Merges a pull request (gh pr merge)');
    if (a === 'auth' || a === 'secret' || a === 'api') return this.stop(`Touches GitHub credentials or calls its API directly (gh ${a})`);
    this.unsure(`Not sure what this does (gh ${[a, b].filter(Boolean).join(' ')})`);
  }

  node(args, cwd = this.projectDir) {
    const i = args.findIndex(x => /^(-e|-p|--eval|--print)$/.test(x));
    if (i >= 0) return this.script(args[i + 1] || '');
    const file = args.find(x => !x.startsWith('-'));
    if (file && /^(server|restart)\.mjs$/.test(basename(file))) {
      this.hubPort(args);   // restart.mjs with no port restarts the hub on 4747
      this.hubData(cwd, basename(file) === 'server.mjs');
    }
    // hub/tools/stop-test-hub.mjs <port> stops that port's process tree and refuses 4747.
    if (file && basename(file) === 'stop-test-hub.mjs') {
      const port = Number(args[args.indexOf(file) + 1]);
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || port === 4747) this.stop('Stops a hub without a port other than 4747');
    }
  }

  // A merge comes to the owner as a card unless THE MERGE RULE (top of this file) says otherwise for this level.
  merge(why) { if (mergeNeedsOwner({ level: this.level })) this.stop(why); }

  // exe: the program as written (a project's .venv/Scripts/python is that project's own Python).
  python(args, exe = 'python', cwd = this.projectDir) {
    if (args[0] === '-c') return this.script(args[1] || '');
    if (args[0] === '-m') {
      if (args[1] === 'pip') return this.pip(exe, args.slice(2), cwd);
      if (args[1] === 'ensurepip') return this.stop('Installs software (pip)');
      // Trusted: a virtual environment made inside the project (python -m venv .venv) is where its packages go.
      if (args[1] === 'venv' && this.trusted) {
        const to = args.slice(2).filter(x => !x.startsWith('-'));
        if (to.length && to.every(t => ['inside', 'tmp'].includes(this.where(t, cwd)))) return;
      }
      if (!/^(unittest|pytest|py_compile|compileall)$/.test(args[1] || '')) return this.unsure(`Not sure what this does (python -m ${args[1] || ''})`);
    }
  }

  // pip (decision 45): a stop at Ask and Auto. Trusted allows it into the project only: a pip that belongs to a
  // virtual environment inside the project or temp folder, or --target into the project. The machine's own pip, and
  // --user, --prefix or --root, install for the whole machine or the user: a stop at every level.
  pip(exe, args, cwd) {
    const sub = args.find(x => !x.startsWith('-')) || '';
    if (!this.trusted) return this.stop('Installs software (pip)');
    if (/^(list|show|freeze|check|help)$/.test(sub) || (args.length === 1 && /^(--version|-V)$/.test(args[0]))) return;
    if (!/^(install|uninstall|download|wheel)$/.test(sub)) return this.unsure(`Not sure what this does (pip ${sub})`, true);
    const r = readFlags(args, PIP_FLAGS);
    if (r.unknown.length) return this.stop(`pip with an option the hub cannot check (${r.unknown[0]})`);
    const vals = n => r.flags.filter(f => f.name === n).map(f => f.value);
    if (vals('machine').length) return this.stop('Installs Python packages for the whole machine or user (pip --user, --prefix, --root, --python)');
    const places = [...vals('place'), ...vals('target')];
    for (const t of places) {
      if (typeof t !== 'string' || !['inside', 'tmp'].includes(this.where(t, cwd))) return this.stop(`Installs Python packages outside the project (${t === true || t == null ? 'a folder the hub cannot read' : t})`);
      this.path(t, cwd, { write: true });
    }
    if (vals('target').length) return;   // --target, --dest or --wheel-dir into the project: the machine's Python is untouched
    const own = this.pathLike(exe) && ['inside', 'tmp'].includes(this.where(exe, cwd));
    if (own) return;
    if (/^(download|wheel)$/.test(sub) && ['inside', 'tmp'].includes(this.where(cwd, cwd))) return;   // files into the folder it runs in
    this.stop(`Installs Python packages for the whole machine (pip outside a virtual environment in the project): use the project's .venv`);
  }

  // uv and poetry manage a project's own packages (pyproject.toml and its virtual environment): Trusted only, and
  // only inside the project. uv tool, uv pip --system and poetry self install for the whole machine.
  pyProject(head, args, cwd) {
    // The subcommand is the first word that is not the value of a folder option given before it (poetry -C ../x add).
    const sub = args.find((x, i) => !x.startsWith('-') && !/^(-C|-P|--directory|--project|--cache-dir|--python|-p|--config-file)$/.test(args[i - 1] || '')) || '';
    const local = head === 'uv' ? /^(add|remove|sync|lock|venv|init|pip|tree)$/.test(sub) : /^(add|remove|install|update|lock|init|show|check)$/.test(sub);
    if (head === 'uv' && sub === 'run') return this.unsure('Runs a program through uv', true);
    if ((head === 'uv' && sub === 'tool') || (head === 'poetry' && sub === 'self') || args.some(x => /^--system$/.test(x))) return this.stop(`Installs software system-wide (${head} ${sub})`);
    if (!local) return this.unsure(`Not sure what this does (${head} ${sub})`.trim());
    if (!this.trusted) return this.stop(`Installs or changes packages (${head} ${sub})`);
    if (!['inside', 'tmp'].includes(this.where(cwd, cwd))) return this.stop(`Installs packages outside the project (${head} ${sub})`);
    // Every folder it is pointed at, however written (--target x, --target=x, -C x), and the folder uv venv and uv init
    // make, must be inside the project or temp. uv pip --python picks another interpreter (the machine's, unless it is
    // a path inside the project): a stop.
    const places = [];
    const PLACE = /^(--target|--prefix|--root|--directory|--project|--cache-dir|--venv|-C|-t|--python|-p)(?:=(.*))?$/;
    args.forEach((x, i) => {
      const m = PLACE.exec(x);
      if (m) places.push({ flag: m[1], v: m[2] ?? args[i + 1] });
      else if (/^-[Ct]./.test(x)) places.push({ flag: x.slice(0, 2), v: x.slice(2) });
    });
    const uvPip = head === 'uv' && sub === 'pip';
    for (const { flag, v } of places) {
      if (/^(--python|-p)$/.test(flag) && !(uvPip || head === 'poetry')) continue;   // uv venv --python 3.12: a version
      if (typeof v !== 'string' || (/^(--python|-p)$/.test(flag) && !this.pathLike(v)) || !['inside', 'tmp'].includes(this.where(v, cwd))) {
        return this.stop(`Installs packages outside the project (${head} ${sub} ${flag} ${v ?? ''})`.trim());
      }
    }
    if (head === 'uv' && /^(venv|init)$/.test(sub)) {
      const at = args.slice(args.indexOf(sub) + 1);
      const pos = at.filter((x, i) => !x.startsWith('-') && !/^(--python|-p|--prompt|--name|--build-backend|--vcs|--author-from|--description)$/.test(at[i - 1] || ''));
      for (const p of pos) if (!['inside', 'tmp'].includes(this.where(p, cwd))) return this.stop(`Makes a folder outside the project (${head} ${sub} ${p})`);
    }
  }

  // Trusted (decision 45): reading or downloading from a website, saved only into the project or a temp folder.
  // Sending anything (a form, a file, a POST) or passing credentials is not reading: a stop.
  webRead(head, args, cwd) {
    const r = this.webFlags(head, args);
    if (r.unknown.length) return this.stop(`${head} with an option the hub cannot check (${r.unknown[0]})`);
    if (r.config) return this.stop(`${head} reads its options from a file or command the hub cannot check (${r.config})`);
    if (r.sends) return this.stop(`Sends data to a website (${head})`);
    if (r.creds) return this.stop(`Passes credentials to a website (${head})`);
    for (const f of r.inputs) if (!['inside', 'tmp'].includes(this.where(f, cwd))) return this.stop(`${head} reads its addresses from a file outside the project (${f})`);
    // Where it saves: every file and folder it names, and the folder it runs in when it saves under the address's
    // own name (wget with no -O, curl -O). Remembered, so running the file later in this command is caught.
    for (const o of r.saves) {
      if (o === true || o == null) return this.stop(`${head} saves to a file the hub cannot read`);
      if (o === '-' || /^(\/dev\/null|nul|\$null)$/i.test(o)) continue;
      this.path(o, cwd, { write: true });
      const a = this.abs(o, cwd);
      if (typeof a === 'string' && !['null', 'outside'].includes(a)) this.downloaded?.add(norm(a));
    }
    if (r.intoHere) {
      const dir = r.dirs.length ? r.dirs.at(-1) : cwd;
      this.path(dir, cwd, { write: true });
      for (const u of r.urls) {
        const name = /^[a-z]+:\/\/[^/]+\/(?:[^?#]*\/)?([^/?#]+)/i.exec(u)?.[1];
        const a = name && this.abs(join(String(this.abs(dir, cwd)), decodeURIComponent(name)), cwd);
        if (typeof a === 'string') this.downloaded?.add(norm(a));
      }
    }
  }
  // What a curl, wget or Invoke-WebRequest command does, read through readFlags whatever the spelling:
  // { unknown, config, sends, creds, inputs, saves: [files], dirs: [folders], intoHere, urls }.
  webFlags(head, args) {
    const fam = head === 'curl' ? 'curl' : head === 'wget' ? 'wget' : 'iwr';
    const r = readFlags(args, webFlags(fam));
    // PowerShell splatting (iwr @p): the options sit in a variable the hub cannot read.
    if (fam === 'iwr') for (const p of r.positional) if (/^@\w/.test(p)) r.unknown.push(p);
    const vals = n => r.flags.filter(f => f.name === n).map(f => f.value);
    const methods = vals('method');
    const out = {
      unknown: r.unknown,
      config: vals('config')[0] ?? null,
      sends: vals('send').length > 0 || methods.some(m => typeof m !== 'string' || !/^(GET|HEAD)$/i.test(m)),
      creds: vals('creds').length > 0 || vals('header').some(h => typeof h !== 'string' || /authorization|cookie|token|api[-_]?key|secret|password/i.test(h)),
      inputs: vals('input').map(String),
      saves: [...vals('out'), ...vals('doc')],
      dirs: vals('outdir'),
      urls: [...r.positional, ...vals('url')].map(String).filter(u => /^[a-z]+:\/\//i.test(u))
    };
    if (out.config === true) out.config = '?';
    // curl -H @file reads its headers from a file, like --config: the hub cannot see what it sends.
    if (fam === 'curl' && !out.config) { const h = vals('header').find(v => typeof v === 'string' && v.startsWith('@')); if (h) out.config = `-H ${h}`; }
    if (out.dirs.some(d => typeof d !== 'string')) out.saves.push(true);   // a folder option with nothing after it
    // wget saves under the address's name unless -O names the file; curl only with -O (into --output-dir when given).
    out.intoHere = fam === 'wget' ? !vals('doc').length : fam === 'curl' ? vals('remote').length > 0 : false;
    return out;
  }

  npm(args, cwd, tool = 'npm') {
    const a = args.filter((x, i) => !/^--?(prefix|C|workspace|w|dir|cwd)$/.test(x) && !/^--?(prefix|C|workspace|w|dir|cwd)$/.test(args[i - 1] || ''));
    const sub = a[0] || (tool === 'yarn' ? 'install' : '');   // a bare yarn installs
    if (tool === 'yarn' && sub === 'global') return this.stop(`Installs software system-wide (yarn global ${a[1] || ''})`.trim());
    if (this.trusted && (NPM_INSTALL.has(sub) || NPM_NET.has(sub))) return this.npmTrusted(tool, sub, a, args, cwd);
    if (NPM_INSTALL.has(sub)) return this.stop(`Installs or changes packages (${tool} ${sub})`);
    if (NPM_NET.has(sub)) return this.stop(`Reaches the npm registry (${tool} ${sub})`);
    if (sub === 'config') return /^(get|list|ls)$/.test(a[1] || '') ? undefined : this.stop('Changes npm settings');
    if (!NPM_OK.has(sub)) return this.unsure(`Not sure what this does (npm ${sub})`);
    // "npm start" in a folder whose start script is the hub would start it on port 4747 unless a port is given.
    if (sub === 'start' || (sub === 'run' && a[1] === 'start')) {
      const pre = args.indexOf('--prefix');
      let start = '';
      try { start = JSON.parse(readFileSync(join(pre >= 0 ? resolve(cwd, args[pre + 1]) : cwd, 'package.json'), 'utf8')).scripts?.start || ''; } catch { }
      if (/server\.mjs/.test(start)) { this.hubPort(a); this.hubData(cwd, true); }
    }
  }

  // Trusted (decision 45): installing, updating and removing the project's own packages, and reading the registry.
  // Global installs (-g, --global, yarn global), installs into a folder outside the project, and commands that
  // download and run a package (npx, npm exec, create, dlx), link it machine-wide, or publish or log in stay stops.
  npmTrusted(tool, sub, a, args, cwd) {
    // Global in any spelling: -g, -gD, --global, --global=true, --location=global or user (only --location=project is
    // fine), yarn global, or npm settings passed through the environment (npm_config_global=true, npm_config_prefix=...).
    const globalFlag = args.some((x, i) => (/^-[A-Za-z]+$/.test(x) && x.includes('g'))
      || /^--global/i.test(x) || (/^--location/i.test(x) && !/^--location=project$/i.test(x) && !(x === '--location' && args[i + 1] === 'project')));
    const npmEnv = [...this.env().keys()].find(k => /^npm_config_/i.test(k));
    if (globalFlag || (tool === 'yarn' && sub === 'global')) return this.stop(`Installs software system-wide (${tool} ${sub}: global)`);
    if (npmEnv) return this.stop(`Changes npm's settings through the environment (${npmEnv.toUpperCase()}), which can install outside the project`);
    if (/^(publish|unpublish|deprecate|login|logout|adduser|token|owner|access)$/.test(sub)) return this.stop(`Publishes or signs in to the npm registry (${tool} ${sub})`);
    if (/^(exec|x|dlx|create|link|ln|unlink)$/.test(sub)) return this.stop(`Downloads and runs a package, or links one machine-wide (${tool} ${sub})`);
    if (/^(view|info|outdated|search|audit)$/.test(sub) && !(sub === 'audit' && a[1] === 'fix')) return;   // reads the registry
    // Where the packages land: every --prefix / -C / --dir / --cwd / --modules-folder / --global-dir given (with a
    // space, =, or attached), else the folder it runs in. All of them must be inside the project or temp.
    const places = [];
    args.forEach((x, i) => {
      const m = /^--?(prefix|C|dir|cwd|modules-folder|global-dir|global-folder|store-dir|cache|cache-folder|virtual-store-dir)(?:=(.*))?$/.exec(x);
      if (m) places.push(m[2] ?? args[i + 1]);
      else if (/^-C./.test(x)) places.push(x.slice(2));
    });
    for (const at of places.length ? places : [cwd]) {
      const target = at == null ? null : this.abs(at, cwd);
      if (typeof target !== 'string' || ['null', 'outside'].includes(target) || !['inside', 'tmp'].includes(this.where(target, cwd))) {
        return this.stop(`Installs packages outside the project (${tool} ${sub}${places.length ? ` in ${at}` : ''})`);
      }
    }
  }

  // A test hub's data and profile folders, when set, must be throwaway ones: elsewhere is the live hub's (a hard stop).
  // Starting one with no data folder of its own (CRUX_HUB_DATA) shares the live hub's settings: for the orchestrator.
  // need: server.mjs and npm start; restart.mjs reuses how the hub was last started, so it is not asked for one.
  hubData(cwd, need) {
    for (const k of ['crux_hub_data', 'crux_home']) {
      const v = this.env().get(k);
      if (v != null && !['inside', 'tmp'].includes(this.where(v, cwd))) this.stop(`Starts a hub on the live hub's data or profile folder (${k.toUpperCase()}=${v})`);
    }
    if (need && this.env().get('crux_hub_data') == null) this.unsure("Starts a test hub with no data folder of its own (CRUX_HUB_DATA), so it would share the live hub's settings", true);
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
    if (/\b(rmSync|unlinkSync|rmdirSync|rm\(|unlink\(|rmdir\(|os\.remove|os\.unlink|shutil\.rmtree)\b/.test(code)) this.scriptDeletes(code);
    if (/\b(stopTree|pidsOnPort|process\.kill|taskkill)\b/.test(code) && /4747/.test(code)) this.stop("An inline script that stops processes and names the hub's port 4747");
    if (/process\.env|os\.environ|homedir\(\)|expanduser/.test(code)) this.stop('An inline script that reads environment variables or the home folder');
    // Reading anywhere is fine; a script that writes, given a real path outside ("C:/x", "../x", not "\n"), is not.
    if (/\b(writeFile|appendFile|mkdir|rename|copyFile|cp|createWriteStream|symlink|truncate)(Sync)?\s*\(|open\([^)]*['"][wa]/.test(code)) {
      for (const m of code.matchAll(/['"`]((?:[a-z]:[\\/]|\/)[\w.~ -][^'"`\n]*|\.\.[\\/][^'"`\n]*)['"`]/gi)) {
        if (this.where(m[1], this.projectDir) === 'outside') this.stop(`An inline script that writes, with a path outside the project folder: ${m[1]}`);
      }
    }
  }

  // Deletes in an inline script (R005): judged like rm -rf on each path, but only when every delete names a path the
  // hub can read (a quoted literal, or a name set once to path.join(os.tmpdir(), 'literal', ...)). Else unsure.
  scriptDeletes(code) {
    const targets = [];
    for (const m of code.matchAll(/\b(rmSync|unlinkSync|rmdirSync|rm|unlink|rmdir|remove|rmtree)\s*\(/g)) {
      const a = /^\s*(?:(['"])([^'"`$\n]+)\1|([A-Za-z_$][\w$]*))\s*[,)]/.exec(code.slice(m.index + m[0].length));
      const p = !a || /^(remove|rmtree)$/.test(m[1]) ? null : a[2] ?? tmpJoin(code, a[3], this.tmp);
      if (!p) return this.unsure('An inline script that deletes files the hub cannot name');
      targets.push(p);
    }
    if (!targets.length) return this.unsure('An inline script that deletes files the hub cannot name');
    this.deletes(targets, this.projectDir, `an inline script deletes ${targets.join(', ')}`);
  }
}

// The text inside every command or process substitution in s: $( ... ), <( ... ), >( ... ) and `...`, nested ones
// included, skipping single-quoted text (which the shell leaves alone).
export function substitutions(s) {
  const out = [];
  s = String(s || '');
  let dq = false;   // inside "...", a single quote is only a character
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && s[i - 1] !== '\\') { dq = !dq; continue; }
    if (s[i] === "'" && !dq) { const j = s.indexOf("'", i + 1); if (j < 0) break; i = j; continue; }
    if (s[i] === '`') { const j = s.indexOf('`', i + 1); if (j < 0) break; out.push(s.slice(i + 1, j)); i = j; continue; }
    if (/[$<>]/.test(s[i]) && s[i + 1] === '(') {
      let depth = 0, j = i + 1;
      for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) break; }
      const inner = s.slice(i + 2, j);
      out.push(inner, ...substitutions(inner));
      i = j;
    }
  }
  return out;
}

// True when a program fed by a pipe takes its script from that pipe (no script file, no inline script): node,
// node -, python, sh, bash -s, pwsh -Command -, cmd without /c, iex always.
function stdinScript(head, args) {
  const has = re => args.some(a => re.test(a));
  const file = args.find(a => !a.startsWith('-') && !(head === 'cmd' && a.startsWith('/')));
  if (/^(iex|invoke-expression)$/.test(head)) return true;
  if (head === 'source' || head === '.') return !args.length || has(/^(-|\/dev\/stdin)$/);
  if (/^(node|nodejs|deno|bun)$/.test(head)) return args.includes('-') || (!has(/^(-e|-p|--eval|--print)$/) && !file);
  if (/^(python3?|py)$/.test(head)) return args.includes('-') || (!has(/^-[a-zA-Z]*[cm]$/) && !file);
  if (/^(sh|bash|zsh|dash)$/.test(head)) return has(/^-[a-z]*s[a-z]*$/) || args.includes('-') || (!has(/^-[a-z]*c[a-z]*$/) && !file);
  if (/^(pwsh|powershell)$/.test(head)) {
    const i = args.findIndex(a => /^-(c|command|f|file|e|encodedcommand)$/i.test(a));
    return i < 0 || args[i + 1] === '-' || args[i + 1] == null;
  }
  if (head === 'cmd') return !has(/^\/\/?[ck]$/i);
  if (/^(perl|ruby)$/.test(head)) return args.includes('-') || (!has(/^-[a-zA-Z]*e$/) && !file);
  return false;
}

// The value of `name` when the script sets it exactly once to path.join(os.tmpdir(), 'a', 'b'), else null.
function tmpJoin(code, name, tmp) {
  const id = name.replace(/\$/g, '\\$');
  const sets = [...code.matchAll(new RegExp(`(?<![\\w$.])${id}\\s*=(?!=)`, 'g'))];
  if (sets.length !== 1) return null;
  const m = /^\s*(?:require\(\s*['"](?:node:)?path['"]\s*\)|path)\.join\(\s*(?:os\.|require\(\s*['"](?:node:)?os['"]\s*\)\.)?tmpdir\(\)\s*((?:,\s*(['"])[\w.-]+\2\s*)+)\)/.exec(code.slice(sets[0].index + sets[0][0].length));
  if (!m) return null;
  const parts = [...m[1].matchAll(/(['"])([\w.-]+)\1/g)].map(x => x[2]);
  return parts.some(x => /^\.+$/.test(x)) ? null : join(tmp, ...parts);
}

// Split at ; && || | & newlines and PowerShell { } ( ) blocks, never inside quotes.
// withOps: each part comes back as { text, op } where op is the separator just before it ('|' for a pipe).
export function splitParts(s, ps = false, withOps = false) {
  const out = []; let cur = '', q = null, op = '', nextOp = '';
  const prev = i => s[i - 1] ?? ' ';
  const push = () => { out.push({ text: cur.trim(), op }); cur = ''; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q && (q === "'" || prev(i) !== '\\')) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '\\' && !ps && s[i + 1] === '\n') { i++; continue; } // line continuation
    const brace = (c === '{' && /[\s|(;]/.test(prev(i))) || (c === '}' && /[\s|);]|^$/.test(s[i + 1] ?? '')) || c === '(' && /[\s|;=]/.test(prev(i)) || c === ')';
    if (c === '\n' || c === '\r' || c === ';' || c === '|' || c === '&' || brace) {
      if (c === '&' && /[<>]/.test(prev(i))) { cur += c; continue; } // 2>&1
      nextOp = (c === '|' || c === '&') && s[i + 1] === c ? c + c : c;
      if (cur.trim()) { push(); op = nextOp; }
      else if (!out.length || op === '' || nextOp === '|') op = nextOp === '|' ? '|' : op || nextOp;   // "(iwr x).Content | iex": the pipe still counts
      if (nextOp.length === 2) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) push();
  return withOps ? out : out.map(x => x.text);
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

// The hub's built-in rules for a project in Auto mode whose board has no rules entry yet: R005's text, with this
// project's own folders. The orchestrator is told it is working from these, and is asked to draft a real entry.
export const DEFAULT_RULES_ID = 'the hub\'s default rules';
export function defaultRules(projectDir, tmp = tmpdir(), level = 'auto') {
  const dir = resolve(projectDir);
  const trusted = level === 'trusted' ? [`TRUSTED (set by {{who}} on the hub page, decision 45). On top of Auto, the hub also allows at once: installing, updating and removing packages into this project (npm, pnpm, yarn, bun, pip into the project's own virtual environment, uv, poetry, cargo add, go get), and reading or downloading from any website into the project or a temp folder. Still hard stops: global or system-wide installs (npm -g, winget, choco, pip outside a project virtual environment), npx and other download-and-run commands, sending data to websites, and every stop below. Merges: the orchestrator merges after a review, once {{who}} says yes to that merge (the hub sends each merge as a card).`] : [];
  return {
    entryId: DEFAULT_RULES_ID, isDefault: true, ts: 'default', from: 'the Crux hub (built in, from R005 on the crux board)',
    title: 'Default agent permission rules (built in)',
    body: [
      `These are the hub's built-in default rules, used because this project's board has no permission rules entry. {{Who}} may replace them with a rules entry on the board at any time.`,
      `AUTO MODE. The hub allows at once, with no prompt: anything whose effects stay inside the project folder (${dir}), an agent's own worktree (${join(dir, '.claude', 'worktrees')}\\...) or a temp folder the agent made under ${tmp}. That covers reading, searching, editing, creating and deleting files there; build, test, lint and running scripts and node; running installed programs by any path; local git, including read-only commands like merge-base and merge-tree; fetch, pull and ls-remote from the repo's own GitHub remote; git push of a feature branch; gh pr create, list, view and checks; starting and stopping test hubs on ports other than 4747; reading files anywhere except secrets.`,
      ...trusted,
      `HARD STOPS, always to {{who}}: the git merge subcommand into main or shared branches, and gh pr merge, unless {{who}} asks for that merge in chat; pushing to main or master; force-push; deleting branches (local or remote); history rewrites of pushed commits; package installs or dependency changes; writes, deletes or moves outside the project folder, worktree or own temp folder (including ~/.claude and ~/crux); network access other than GitHub and reading docs; stopping or restarting the hub on port 4747; secrets (~/.ssh, .env files, ~/.crux-hub keys, credential stores).`,
      `UNCLEAR requests (including commands the hub can't read in full) come to the orchestrator (answer_permission), which allows them if they are contained and part of the task, and otherwise escalates; {{who}} gets them after 2 minutes. When unsure, escalate.`
    ].join('\n')
  };
}

// claude.ai connector tools are named mcp__claude_ai_<Service>__<tool>. Only these reads (and Gmail drafts) are not
// hard stops; everything else a connector offers is, including tools added later.
const CONNECTOR_READS = {
  Gmail: ['search_threads', 'get_thread', 'get_message', 'list_labels', 'list_drafts', 'get_draft'],
  Google_Calendar: ['list_calendars', 'list_events', 'get_event', 'search_events', 'suggest_time'],
  Google_Drive: ['search_files', 'read_file_content', 'get_file_metadata', 'get_file_permissions', 'list_recent_files', 'list_shared_drives', 'get_shared_drive_metadata', 'download_file_content']
};
const CONNECTOR_DRAFTS = { Gmail: ['create_draft', 'update_draft'] };
// The claude.ai connector servers known today, disallowed by name when a project has connectors off (a server-level
// spec removes every tool of that server). New ones are kept out by disableClaudeAiConnectors, and stopped here anyway.
export const CONNECTOR_SERVERS = ['Gmail', 'Google_Calendar', 'Google_Drive', 'Claude_Docs', 'Three_js_3D_Viewer', 'Slack', 'Notion', 'Linear', 'Atlassian', 'Asana', 'Canva', 'Figma']
  .map(s => `mcp__claude_ai_${s}`);

// { service, name, kind: 'read' | 'draft' | 'act' } for a claude.ai connector tool, else null.
export function connectorTool(tool) {
  const m = /^mcp__claude_ai_(.+?)__(.+)$/.exec(String(tool || ''));
  if (!m) return null;
  const [, service, name] = m;
  const kind = CONNECTOR_READS[service]?.includes(name) ? 'read' : CONNECTOR_DRAFTS[service]?.includes(name) ? 'draft' : 'act';
  return { service: service.replace(/_/g, ' '), name, kind };
}

// The newest active "permission rules" requirement on a board, or null (no rules: nothing is routed).
export function rulesEntry(board) {
  return board.entries().filter(e => e.kind === 'requirement' && e.status === 'active' && /permission rules/i.test(e.title || '')).at(-1) || null;
}
