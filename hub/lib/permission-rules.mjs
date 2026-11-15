// The board's permission rules (R004, under decisions 21, 22 and 34), read by the hub itself. Three outcomes:
// - 'human': a hard stop. Never left to the orchestrator's judgment: merging, pushing to main or master,
//   force-pushing, deleting branches, history rewrites, installs and dependency changes, writes or deletes outside
//   the project folder or a temp folder, network access, the hub on port 4747, and secrets.
// - 'unsure': the hub cannot read it with confidence (an unknown program, a script that runs other programs,
//   variables, substitutions). In auto mode these go to the orchestrator; one that also mentions a hard-stop word
//   goes to the human instead.
// - 'allow': contained work the hub could read in full: everything stays inside the project folder (which holds the
//   agents' worktrees, .claude/worktrees/...) or the system temp folder, plus feature-branch pushes and PRs.
//   classify({ tool, input, projectDir, cwd, level }) -> { route: 'allow' | 'unsure' | 'human', reasons: [hard stops], unsure: [why] }
// cwd (decision 64 A): the folder the agent's command really runs in (its worktree, as Claude Code reports it to the
// hub's hook), so a bare git push or "cd .." is read from there; without it, the project folder, as before.
// level (decision 45): 'standard' (Ask) and 'auto' are judged alike here (the hub decides what Ask sends on);
// 'trusted' also allows installing packages into the project and reading or downloading from any website into it.
// The fixed stops are the same at every level: force push, rewriting pushed history, deleting branches, pushing to
// main, writes outside the project or temp folder, secrets, the live hub, system-wide installers, outward connector
// actions, and merges (see THE MERGE RULE below).
import { resolve, isAbsolute, join, basename, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { readFileSync, existsSync, statSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gitReadRuns, gitNoIndex, GIT_SAFE_CONFIG } from './permissions.mjs';

const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// ---------- Windows 8.3 short names (M039 2) ----------
// CLAUDE~1, PACKAG~1.JSO, CRUX-H~1 open the real files (.claude, package.json, .crux-hub), so a full path with a part
// like that is read as the long name it stands for. Each such part that exists is replaced by its own long name
// (the real path's last part; links are not followed: a part that is a link is unreadable). A part that does not
// exist names nothing yet and stays as written (git's HEAD~1 is untouched). null: the hub cannot tell.
const SHORT_PART = /~\d/;
// ~user (Git Bash: that user's home, a sibling of this one) and Windows device forms (\\?\C:\x, \\.\C:\x, //?/C:/x)
// read as the plain path they open (review round 1). \\?\UNC\server\x stays a network path.
// A device path with no drive letter after its prefix (\\?\GLOBALROOT\Device\HarddiskVolume4\..., \\.\Volume{guid}\...,
// \\.\PhysicalDrive0, \\.\pipe\x) can open any file on the machine, so it is kept as written: abs() reads it as
// outside (a stop for writes and deletes), and secretAt / touchesSecrets count it as a secret (review round 2).
export const opaqueDevice = s => {
  const d = /^[\\/]{2}[?.][\\/](.*)$/s.exec(String(s));
  return !!d && !/^([a-z]:([\\/]|$)|unc[\\/])/i.test(d[1]);
};
export function homeAndDevice(s, home = homedir()) {
  s = String(s);
  const dev = /^[\\/]{2}[?.][\\/](.*)$/s.exec(s);
  if (dev && opaqueDevice(s)) return s;
  if (dev) s = /^unc[\\/]/i.test(dev[1]) ? `//${dev[1].slice(4)}` : dev[1];
  const user = /^~([\w.-]+)(?=[\\/]|$)/.exec(s);
  if (user) s = join(dirname(home), user[1]) + s.slice(user[0].length);
  return s;
}
// Trailing dots and spaces dropped from each part of a full path, as Windows does when it opens it.
const trimPath = p => (process.platform !== 'win32' ? String(p)
  : String(p).split(/([\\/])/).map(x => (/^[\\/]$/.test(x) || x === '.' || x === '..' || /^[a-z]:$/i.test(x) ? x : x.replace(/[. ]+$/, '') || x)).join(''));
export function longPath(p) {
  const s = String(p);
  if (process.platform !== 'win32' || !SHORT_PART.test(s)) return s;
  const parts = s.split(/[\\/]+/);
  if (!parts.some(x => SHORT_PART.test(x))) return s;
  let out = /^[a-z]:$/i.test(parts[0]) ? `${parts[0]}\\` : parts[0] || '\\';
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    if (!seg) continue;
    const here = join(out, seg);
    if (!SHORT_PART.test(seg)) { out = here; continue; }
    let st;
    try { st = lstatSync(here); } catch (e) { return ['ENOENT', 'ENOTDIR'].includes(e.code) ? join(here, ...parts.slice(i + 1)) : null; }
    if (st.isSymbolicLink()) return null;
    try { out = join(out, basename(realpathSync.native(here))); } catch { return null; }
  }
  return out;
}
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
  return { live: u.port === '' || LIVE_PORTS.has(Number(u.port)) };
}
// The live hub listens on 4747 (this PC) and 4748 (the phone's port, server.mjs): both are the hub you use.
export const LIVE_PORTS = new Set([4747, 4748]);

// ---------- one flag reader (review of PR #51) ----------
// How a program's options are spelled must never decide whether a check sees them. readFlags understands short flags
// combined and attached (-sSLo FILE, -oFILE, -dDATA, -qO-), long flags with =value or a separate value
// (--post-data=x, --output FILE), and PowerShell parameters by any unique prefix, with a value after a space or a
// colon (-OutF x, -Me POST, -Body:x). Each flag comes back under the name the spec gives it; anything the spec does
// not know is listed in unknown, so the caller can stop rather than guess.
//   spec: { short: { o: 'out' }, long: { output: 'out' }, valued: ['out'], whole: { '-nv': 'ok' } }
//      or { ps: { OutFile: 'out', Method: 'method' }, valued: [...] }
//   -> { flags: [{ name, value, raw, key }], positional: [words], unknown: [raw flags] }
//   key: the option's own name (its letter, its long name, or the full PowerShell parameter name), for allow-lists.
export function readFlags(args, { short = {}, long = {}, valued = [], whole = {}, ps = null } = {}) {
  const V = new Set(valued), out = { flags: [], positional: [], unknown: [] };
  const add = (name, value, raw, key) => out.flags.push({ name, value, raw, key });
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
      add(ps[name], V.has(ps[name]) ? (m[2] ?? args[++i]) : (m[2] ?? true), a, name);
      continue;
    }
    if (whole[a]) { add(whole[a], true, a, a); continue; }
    if (/^--[^-]/.test(a)) {
      const k = a.slice(2).split('=')[0], eq = a.includes('=') ? a.slice(a.indexOf('=') + 1) : undefined;
      const name = long[k];
      if (!name) { out.unknown.push(a); continue; }
      add(name, V.has(name) ? (eq ?? args[++i]) : (eq ?? true), a, k);   // a switch given =x keeps x (--global=true)
      continue;
    }
    if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const name = short[a[j]];
        if (!name) { out.unknown.push(`-${a[j]}`); continue; }
        if (V.has(name)) { const rest = a.slice(j + 1); add(name, rest !== '' ? rest : args[++i], a, a[j]); break; }
        add(name, true, a, a[j]);
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
  'H header': 'header', 'K config variable': 'config',
  // Where the request really goes: a proxy, --connect-to (the address after the last two colons), --resolve, --url.
  'x proxy preproxy socks4 socks4a socks5 socks5-hostname': 'proxy', 'connect-to': 'connectto', resolve: 'resolve', url: 'url',
  's silent S show-error L location f fail fail-with-body k insecure v verbose i include I head G get # progress-bar N no-buffer compressed g globoff 4 6 R remote-time create-dirs http1.0 http1.1 http2 q no-progress-meter ssl-no-revoke Z parallel location-trusted': 'ok',
  'A user-agent e referer m max-time connect-timeout retry retry-delay retry-max-time r range w write-out C continue-at limit-rate z time-cond max-filesize max-redirs': 'okv'
}, ['out', 'outdir', 'send', 'method', 'creds', 'header', 'config', 'proxy', 'connectto', 'resolve', 'url', 'okv']);
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
    MaximumRetryCount: 'okv', RetryIntervalSec: 'okv', ContentType: 'okv', PassThru: 'ok', SkipCertificateCheck: 'ok', Proxy: 'proxy', Resume: 'ok',
    ErrorAction: 'okv', Verbose: 'ok', DisableKeepAlive: 'ok', TransferEncoding: 'okv', SkipHeaderValidation: 'ok', SkipHttpErrorCheck: 'ok', NoProxy: 'ok' },
  valued: ['url', 'out', 'method', 'send', 'creds', 'header', 'proxy', 'okv']
};
// Environment settings that send a program's web requests somewhere else.
const PROXY_VARS = /^(https?_proxy|all_proxy|ftp_proxy|socks_proxy|socks5_proxy)$/i;
// Environment settings that make curl or wget read a settings file the hub cannot see (like -K): a stop in front of
// a website download at Trusted.
const CONFIG_HOME_VARS = /^(curl_home|home|xdg_config_home|appdata|userprofile|wgetrc|systemwgetrc|homedrive|homepath)$/i;
// Requests to this machine (any port) pass only with options on these short lists (fourth review of PR #51): every
// option is first resolved against the program's full list (so -Me is Method, never a shortened something else), then
// its own name must be here. -X / -d / --json and -Method / -Body change things, so only towards a test hub's port.
const LOCAL_OK = {
  curl: new Set('s silent S show-error f fail fail-with-body L location i include I head N no-buffer m max-time connect-timeout retry w write-out A user-agent b cookie u user H header o output X request d data data-raw data-binary data-urlencode json G get compressed http1.0 http1.1 http2'.split(' ')),
  wget: new Set('q quiet S server-response T timeout t tries header O output-document post-data body-data method -nv no-verbose'.split(' ')),
  iwr: new Set(['Uri', 'Method', 'Body', 'ContentType', 'Headers', 'UseBasicParsing', 'TimeoutSec', 'OutFile', 'ErrorAction'])
};
// git config keys that make git run a program, or send fetches and pushes somewhere else (aliases with !, pagers,
// editors, hooks, fsmonitor, diff and merge drivers, filters, credential helpers, URL rewrites, push defaults).
const GIT_RUNS_CONFIG = /^(alias\..+|core\.(pager|fsmonitor|hookspath|sshcommand|editor|askpass|gitproxy|worktree|attributesfile|excludesfile)|sequence\.editor|diff\.(external|.+\.(textconv|command))|difftool\..+|mergetool\..+|merge\..+\.driver|filter\..+|credential(\..+)?\.helper|gpg(\..+)?\.program|pager\..+|include\.path|includeif\..+|url\..+\.(insteadof|pushinsteadof)|remote\..+\.(url|pushurl|receivepack|uploadpack|proxy|push|vcs)|push\.default|remote\.pushdefault|branch\..+\.(remote|pushremote|merge)|http(\..+)?\.proxy|init\.templatedir|submodule\..+\.update|.+\.\w*(cmd|command|program|helper|driver|hook|filter))$/i;
// Environment settings that make git run another program or point it at another repo.
const GIT_RUNS_VARS = /^(git_(pager|editor|sequence_editor|external_diff|ssh|ssh_command|askpass|proxy_command|exec_path|dir|work_tree|config\w*|index_file|template_dir|alternate_object_directories|object_directory|namespace|common_dir)|pager|editor|visual|lessopen|lessclose|ssh_askpass)$/i;
// The only environment settings allowed in front of a request to this machine (VAR=value, export, $env:).
const LOCAL_ENV_OK = new Set(['crux_hub_data', 'crux_home', 'no_color']);
// Shell variables curl and wget read (settings files, proxies, certificates and key logs, their own options): set
// earlier in a command, exported or not, they count as set in front of it (HOME and APPDATA are already exported).
const DOWNLOADER_READS = /^(curl\w*|wget\w*|system_?wgetrc|home\w*|userprofile|appdata|localappdata|xdg_\w+|\w*proxy\w*|ssl\w*|qlogdir)$/i;
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
// Programs that run what a folder or file holds (M039 4): run inside a fresh clone or download, or handed one, a stop.
const RUNNERS = new Set(['start', 'start-process', 'saps', 'invoke-item', 'ii', 'call', 'make', 'cmake', 'npm', 'pnpm', 'yarn', 'bun', 'deno',
  'cargo', 'go', 'dotnet', 'java', 'php', 'uv', 'poetry', 'msbuild', 'gradle', 'gradlew', 'mvn', 'tsx', 'ts-node', 'pytest', 'rscript']);
// A download written anywhere in a command's text, not only as its first word: the downloaders by name, and
// PowerShell's download cradles (Net.WebClient, DownloadString / DownloadFile / DownloadData, HttpClient, WebRequest).
const DOWNLOAD_TEXT = /(^|[^\w-])(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod|start-bitstransfer)(?![\w-])|net\.webclient|\.download(string|file|data)(async|taskasync)?\s*\(|httpclient|\.getstring(async)?\s*\(|\[(system\.)?net\.(http)?webrequest\]/i;

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
// ~/.crux-hub holds the hub's keys, guard and settings: secret, except its voice helper folder (decision 64 A), whose
// programs and models are read like any other files (named files in it, like a .key or token.json, stay secret).
// Review round 1: Claude Code's own login file is ~/.claude/.credentials.json (\.?credentials), and Windows drops
// trailing dots and spaces from a name (Get-Content .env. reads .env), so every path part is trimmed before the test.
const trimParts = s => String(s).split('/').map(x => (x === '.' || x === '..' ? x : x.replace(/[. ]+$/, ''))).join('/');
const trimmed = re => ({ test: s => re.test(trimParts(s)) || re.test(s), source: re.source });
const SECRET = trimmed(/(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|\.git-credentials|\.pypirc|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.?credentials(\.json)?|secrets?(\.\w+)?|vapid\.json|[\w-]*token\.json)$|(^|\/)(\.ssh|\.aws|\.gnupg|\.crux-hub(?!\/voice(?:\/(?!\.\.?(?:\/|$))[^/]+)*\/?$))(\/|$)|\.(pem|key|pfx|p12)$|(^|\/)env:/i);
const KNOWN_TOOLS = new Set(['Task', 'Agent', 'TodoWrite', 'TaskStop', 'KillShell', 'KillBash', 'BashOutput', 'ToolSearch', 'Skill',
  'EnterPlanMode', 'ExitPlanMode', 'WebSearch', 'LS']);
// Path and system variables are not secrets: reading them is fine. Names that look secret are hard stops.
const SYSTEM_VARS = /^(appdata|localappdata|temp|tmp|tmpdir|userprofile|home|homedrive|homepath|path|pwd|oldpwd|os|computername|hostname|username|user|programfiles|programfiles\(x86\)|programw6432|programdata|commonprogramfiles|windir|systemroot|systemdrive|public|onedrive|processor_architecture|number_of_processors|shell|term|lang)$/i;
const SECRET_VAR = /token|key|secret|passw|pass\b|auth|cred|api|cookie|session/i;
// Where the path variables point, so a write through them is judged like any other path.
const VAR_PATHS = { appdata: ['AppData', 'Roaming'], localappdata: ['AppData', 'Local'], userprofile: [], home: [] };
const TEMP_VARS = /\$\{?(env:temp|env:tmp|tmpdir|temp|tmp)\}?(?![\w:])|%(temp|tmp)%/gi;
// System folders known only through a variable abs() does not resolve: a path starting with one is outside.
const SYSTEM_DIR_VAR = /^(?:\$\{?(?:env:)?|%)(programfiles(?:\(x86\))?|programw6432|programdata|commonprogramfiles(?:\(x86\))?|commonprogramw6432|windir|systemroot|systemdrive|public|onedrive\w*|homedrive|homepath|oldpwd|allusersprofile|driverdata|pshome)(?![\w(])/i;
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
// Trusted included, merging a code pull request (gh pr merge) or merging into main, master or another shared branch
// (git merge) needs the owner's yes on that specific merge: the hub sends it to the owner as a card, and once the owner
// says yes the orchestrator does the merge. Trusted does not remove that. This one function is where that rule lives;
// to let a level merge without a card, return false for it here (and say so on the settings card,
// public/project-settings.js).
// into (decision 64 A): the branch that receives a git merge (the one checked out where it runs). Merging main INTO a
// feature branch only brings that branch up to date: contained. Unknown (detached, not a repo) counts as shared.
export const MERGE_RULE = 'Merges: the orchestrator merges after a review, once you say yes.';
export const SHARED_BRANCH = /^(main|master|trunk|develop|development|dev|staging|production|prod|release([/-].*)?|gh-pages|docs\/decisions)$/i;
export function mergeNeedsOwner({ level = 'auto', into = null } = {}) {   // eslint-disable-line no-unused-vars
  return !into || SHARED_BRANCH.test(into);
}

// agent: the asking agent's name; madeTemp: temp folders it created earlier (full paths). Both decide which temp
// folders count as its own for deletes (R005). The result's tempMade lists temp folders this request would create.
// level: the project's permission level (decision 45); only 'trusted' changes what is allowed here.
// downloaded: files this agent downloaded in earlier requests (the result's downloaded lists this request's too), so
// running one later (bash x.sh, node x.js, .\x.ps1) is a stop across tool calls (review of decision 64 A).
export function classify({ tool, input = {}, projectDir, cwd = null, tmp = tmpdir(), home = homedir(), agent = '', madeTemp = [], downloaded = [], level = 'auto' }) {
  const c = new Check(projectDir, tmp, home, cwd);
  c.level = level;
  c.trusted = level === 'trusted';
  c.agent = String(agent || '').toLowerCase();
  c.madeTemp = new Set([...madeTemp].map(norm));
  c.tempMade = new Set();
  c.fresh = new Set();   // temp folders $(mktemp) makes in this very command: its own, but not worth remembering by name
  c.envSet = new Map();  // environment settings the command makes for what follows (export X=, $env:X =)
  c.downloaded = new Set([...downloaded].map(norm));   // files downloaded (earlier, or in this command): running one is a stop
  c.cmdText = String(input.command || '');   // the whole command, for checks that look at all of it ($PSDefaultParameterValues)
  c.assigned = new Set();     // every shell variable the command assigns, exported or not (see envNames)
  const out = classifyWith(c, tool, input);
  return { ...out, tempMade: [...c.tempMade], downloaded: [...c.downloaded] };
}

function classifyWith(c, tool, input) {
  const cmd = String(input.command || '');
  if (/^(Bash|PowerShell)$/.test(tool)) c.command(cmd, tool === 'PowerShell');
  else c.tool(tool, input);
  // Something the hub could not read that also names a hard-stop action is not left to judgment. Decision 64 A: only
  // the text the hub could not read counts (riskyText), without commit messages, quoted text and here-strings.
  const text = c.riskyText(cmd);
  const word = c.opaque && !c.reasons.length && RISKY_PATTERNS.map(r => r.exec(text)).find(Boolean);
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
  // rm -rf of the root, home, a drive or ../, but not of a named folder in Git Bash's /tmp (with no .. in it).
  /\brm\s+-\w*[rf]\w*\s+(\/(?!tmp\/(?![^\s;&|]*\.\.)[\w-])|~|\.\.|[a-z]:)/i, /\bremove-item\b[^;|\n]*(\.\.|~|[a-z]:\\)/i,
  /\.env\b|\.ssh\b|\.crux-hub\b|\bid_(rsa|ed25519)\b|\bcredentials?\b|\bpassword\b|\bsecret\b|api[_-]?key/i
];
// PowerShell text with its quotes and commas opened ('push','origin' -> push origin), for the risky-word scan.
const psOpen = t => String(t).replace(/'((?:''|[^'])*)'|"((?:""|`.|[^"`])*)"/g, (m, a, b) => ` ${a ?? b} `).replace(/[,()@]/g, ' ');
// What $(git branch --show-current) and its like stand for until part() knows the folder (knownSubs).
const CURRENT_BRANCH = 'CRUX-CURRENT-BRANCH';
// Programs whose quoted arguments are only printed text (scanPiece, mayMoveBranch).
const TEXT_ONLY = new Set(['echo', 'printf', 'write-output', 'write-host', 'write-warning', 'write-verbose', 'write-information', 'write-debug', 'write-error', 'out-host']);
// Programs and forms that run text as commands (read with quoted text taken out): where one sits in a part the hub
// could not read, any text in the command may become a command, so the risky-word scan reads all of it.
const EVALUATES = /(^|[\s;&|(){}\/\\])(eval|exec|iex|invoke-expression|invoke-command|icm|xargs|parallel|source|wsl|sudo|runas|doas|su|env|sh|bash|zsh|dash|ksh|fish|cmd|powershell|pwsh|wscript|cscript|mshta|rundll32)(\.exe)?(?=[\s;&|(){}]|$)|(^|[;&|({]\s*)\.\s+[\w$.\/\\~"']/i;
// Quoted text that is a script running other programs (node -e, python -c, perl -e): kept for the risky-word scan.
const RUNS_TEXT = /child_process|\bexec(Sync|File|FileSync)?\s*\(|\bspawn(Sync)?\s*\(|\bfork\s*\(|subprocess|\bos\.(system|popen|exec\w*|spawn\w*)|\bPopen\b|\bsystem\s*\(|Start-Process|Invoke-Expression|\biex\b|ShellExecute|WScript\.Shell|Diagnostics\.Process|Process\]::Start|\beval\s*\(|new\s+Function\s*\(/i;

class Check {
  constructor(projectDir, tmp, home, cwd = null) {
    // The roots in their long form (a temp folder given as C:\Users\FIRSTN~1\...), so paths compare alike (M039 2).
    const lp = x => longPath(x) ?? x;
    Object.assign(this, { projectDir: lp(resolve(projectDir)), tmp: lp(tmp), home: lp(home), reasons: [], doubts: [], vars: new Map() });
    // Where the command starts: the agent's own folder when the hub knows it (decision 64 A), else the project folder.
    this.cwd0 = cwd ? lp(resolve(String(cwd))) : this.projectDir;
    this.opaqueN = 0;            // how many opaque doubts so far, so command() can tell which parts the hub could not read
    this.scanBits = null;        // the text the risky-word scan reads (riskyText); null: the whole command
    this.scanAll = false;        // something runs text as commands (iex, sh -c, ...): scan the whole command, as before
    this.branchSet = new Map();  // repo folder -> the branch an earlier git checkout / switch in this command left it on
  }
  stop(why) { this.reasons.push(why); }
  // known: the hub read the step and only cannot tell if it is safe here (a rebase); otherwise the text is opaque.
  unsure(why, known = false) { this.doubts.push(why); if (!known) { this.opaque = true; this.opaqueN++; } }

  // The text the risky-word scan reads (decision 64 A): the parts of the command the hub could not read in full, the
  // inside of command substitutions, and scripts that run other programs; not the parts it read in full, and not
  // commit messages, quoted text or here-strings. When anything runs text as commands, the whole command, as before.
  riskyText(cmd) { return this.scanAll || !this.scanBits ? String(cmd) : this.scanBits.join('\n'); }
  // One piece of command text for the scan: quoted strings are dropped unless they hold a command substitution or a
  // script call that runs programs; a piece where something runs text as commands is kept whole and turns scanAll on.
  // Review of decision 64 A: quoted text is kept unless it is plainly only text: what echo, printf or Write-Output
  // print, a string on its own, git commit / tag messages, and a pull request's title and body. A program the hub does
  // not know, or one that can run text (git -c alias, npm pkg set scripts, perl -e, schtasks /tr), keeps it.
  scanPiece(text, ps) {
    const t = String(text || '');
    const quoted = ps ? /'(?:''|[^'])*'|"(?:""|`.|[^"`])*"/g : /'[^']*'|"(?:\\.|[^"\\])*"/g;
    const bare = t.replace(quoted, ' ');
    if (EVALUATES.test(bare) || /\[scriptblock\]::create/i.test(t) || (ps && /(^|[\s;|({])[&.]\s*\$/.test(bare)) || (ps && /`/.test(bare))) { this.scanAll = true; return t; }
    // PowerShell: also read with its quotes and commas opened, so Start-Process git -ArgumentList 'push','origin','main'
    // and @('push','origin') arrays show their words (M039 6).
    if (!this.onlyText(t, ps)) return ps ? `${t}\n${psOpen(t)}` : t;
    return t.replace(quoted, q => (RUNS_TEXT.test(q) || (!ps && /`/.test(q)) ? q : "''"));
  }
  // True when every quoted string in a part is only text (see scanPiece).
  onlyText(t, ps) {
    if (ps ? /^'(?:''|[^'])*'$|^"(?:""|`.|[^"`])*"$/.test(t.trim()) : false) return true;   // a string on its own: printed
    const w = tokens(t, ps).map(x => x.text);
    let k = 0; while (k < w.length - 1 && /^\w+=/.test(w[k])) k++;
    const head = String(w[k] || '').toLowerCase();
    if (TEXT_ONLY.has(head)) return true;
    if (head === 'git' && /^(commit|tag)$/.test(w[k + 1] || '')) return true;
    if (head === 'gh' && w[k + 1] === 'pr' && w[k + 2] === 'create') return true;
    return false;
  }
  // Could a part the hub could not read in full have switched the checked-out branch (review of decision 64 A)? A git
  // command other than ones that only read, stage, commit or push could, and so could a script or a program the hub
  // does not know; a reading program (echo, cat, grep, Get-...) or a filter cannot, unless a substitution in it could.
  mayMoveBranch(text, ps) {
    if (substitutions(text).some(inner => this.mayMoveBranch(inner, ps))) return true;
    const { head, args } = this.headOf(text);
    if (!head || /^\$(_|psitem)\b/i.test(head) || /^-(and|or|not|x?or)$/i.test(head) || /^['"]/.test(String(text).trim())) return false;
    if (head === 'git') return !/^(add|commit|status|diff|log|show|fetch|push|tag|rm|mv|restore|stash|blame|grep|ls-files|rev-parse|describe|shortlog|reflog|merge-base|merge-tree|show-ref|for-each-ref|rev-list|cat-file|check-ignore|ls-remote|remote|clean|notes)$/.test(args[0] || '');
    return !(SAFE.has(head) || TEXT_ONLY.has(head) || /^get-[a-z]+$/.test(head) || PROPERTY.test(head));
  }
  // The branch checked out in the repo holding dir, after any git checkout / switch earlier in this command. Unknown
  // (null) once something earlier in the command could have switched it unseen (branchUnknown).
  branchIn(dir) {
    if (this.branchUnknown) return null;
    const top = gitTop(dir);
    if (top && this.branchSet.has(norm(top))) return this.branchSet.get(norm(top));
    return currentBranch(dir);
  }

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
    s = homeAndDevice(s, this.home);   // ~user, \\?\C:\..., //?/C:/... (review round 1)
    s = s.replace(/\$\{?PWD\}?(?!\w)/g, String(cwd).replace(/\\/g, '/'));   // the folder the step runs in
    if (/^\/dev\/null$|^nul$|^\$null$/i.test(s)) return 'null';
    // A system folder named through its variable ($PROGRAMFILES\x, $env:windir, %ProgramData%) is not a folder
    // inside the one the step runs in: outside, whatever comes after it.
    if (SYSTEM_DIR_VAR.test(s)) return 'outside';
    if (/^\/tmp(\/|$)/.test(s)) return s === '/tmp' ? this.tmp : join(this.tmp, s.slice(5));
    const m = /^\/([a-z])(\/.*)?$/i.exec(s);           // Git Bash: /c/Users/... is C:/Users/...
    if (m) s = `${m[1]}:${m[2] || '/'}`;
    else if (/^[\\/](?![\\/])/.test(s) && process.platform === 'win32') return 'outside'; // /usr/bin on Windows: not a project path
    if (/^[\\/]{2}/.test(s)) return 'outside';         // network share
    const full = isAbsolute(s) ? resolve(s) : resolve(cwd, s);
    // A short name (CLAUDE~1) is read as its long name; one the hub cannot expand counts as outside (a stop for
    // writes) and as a secret for reads (secretAt), M039 2.
    const long = longPath(full);
    if (long === null) { this.shortFail = true; return 'outside'; }
    return trimPath(long);   // Windows drops trailing dots and spaces: .claude/settings.json. is settings.json
  }
  // A word that names a secret: as written; as the full path it stands for from the folder the step runs in (so
  // "cd ~/.crux-hub/voice && cat ../settings.json" is the hub's settings file); and, for a glob or a {a,b} list,
  // every file it would match on disk (cat ~/.ss*/id_*, cat .en?) (review of decision 64 A).
  secretAt(p, cwd) {
    const raw = String(p);
    if (SECRET.test(norm(raw)) || opaqueDevice(raw)) return true;
    for (const one of this.ps ? [raw] : braceWords(raw)) {
      if (one !== raw && SECRET.test(norm(one))) return true;
      this.shortFail = false;
      const a = this.abs(one, cwd);
      if (this.shortFail) return true;   // a short name the hub could not expand: it may be any file (M039 2)
      if (typeof a !== 'string' || ['null', 'outside'].includes(a)) continue;
      if (SECRET.test(norm(a))) return true;
      if (/[*?[]/.test(one) && (this.pathLike(one) || /^\.|^[\w.-]*[*?[]/.test(one))) {
        const found = globMatches(a);
        if (found === null || found.some(m => SECRET.test(norm(m)))) return true;   // null: too wide to check
      }
    }
    return false;
  }
  // Does a word name a file or folder on disk (a short name the hub cannot expand counts as one)?
  patternOnDisk(p, cwd) {
    if (opaqueDevice(p)) return true;
    this.shortFail = false;
    const a = this.abs(p, cwd);
    if (this.shortFail) return true;
    if (typeof a !== 'string' || ['null', 'outside', 'tmp'].includes(a)) return false;
    try { return existsSync(a); } catch { return false; }
  }
  // R004: reading anywhere is fine (secrets aside); writing outside the project folder or a temp folder is a hard stop.
  path(p, cwd, { write = false } = {}) {
    const w = this.where(p, cwd);
    if (w === 'outside' && write) this.stop(`Writes outside the project folder: ${p}`);
    if (w === 'tmp' && write) this.noteTemp(p, cwd);
    if (this.secretAt(p, cwd)) this.stop(`Touches secrets or credentials: ${p}`);
    // Any repo's settings or hooks, nested or in temp (git init sub && ... > sub/.git/config): git runs what they
    // name (core.fsmonitor, hooks), so a later read-only git there would run it (review round 1).
    if (write && w !== 'null' && /(^|\/)\.git\/(config|hooks)(\/|$)/.test(norm(this.abs(p, cwd)))) this.stop(`Writes a git repo's settings or hooks (${p})`);
    if (write && w === 'inside') {
      // From the full path abs() reads (short names expanded: CLAUDE~1/SETTIN~1.JSO is .claude/settings.local.json).
      const rel = norm(this.abs(p, cwd)).slice(norm(this.projectDir).length + 1);
      if (DEP_FILES.test(rel) && !this.trusted) this.stop(`Changes dependencies (${basename(rel)})`);   // Trusted: the project's own packages
      if (/^\.git(\/|$)/.test(rel)) this.stop('Writes inside .git (history)');
      if (/^\.crux(\/|$)/.test(rel)) this.stop("Writes the hub's own log (.crux)");
      if (/(^|\/)\.claude\/settings/.test(rel)) this.stop("Changes Claude Code's permission settings");
    }
    return w;
  }

  tool(tool, input) {
    const cwd = this.cwd0;
    if (['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'].includes(tool)) {
      for (const k of ['file_path', 'path', 'notebook_path']) if (input[k]) this.path(input[k], cwd);
      if (input.pattern && /^([a-z]:|[\\/~])/i.test(input.pattern) && tool === 'Glob') this.path(input.pattern.replace(/[*?[{].*$/, '') || '/', cwd);
      // Grep reads every file under its folder (hidden ones too): rooted at the home folder or above a secret folder it
      // reads ~/.ssh and ~/.crux-hub (M039 5). A file filter that names a secret aims at one.
      if (tool === 'Grep') {
        const root = input.path ? this.abs(input.path, cwd) : cwd;
        if (secretTree(root, this.home)) this.stop(`Searches every file under the home folder or a folder holding secrets (${input.path || cwd})`);
        if (grepGlobSecret(input.glob)) this.stop(`Touches secrets or credentials: ${input.glob}`);
      }
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

  // start: the folder the command runs in (the agent's own folder for a whole command; the folder a sh -c or a
  // powershell -Command runs from for the script inside it).
  command(cmd, ps, start = this.cwd0) {
    if (!cmd.trim()) return this.unsure('An empty command');
    // PowerShell reads curly quotes as quotes (‘ ’ ‚ ‛ as ', “ ” „ as "): read them the same way, so a quote the hub
    // missed cannot hide where a value ends (follow-up to PR #51).
    if (ps) cmd = cmd.replace(/[‘’‚‛]/g, "'").replace(/[“”„]/g, '"');
    this.scanBits ||= [];   // what the risky-word scan reads (riskyText); a nested command adds to the same list
    const bit = t => this.scanBits.push(this.scanPiece(t, ps));
    // A block of text taken out of the command (a heredoc, a here-string): the scan reads it only when it is a script
    // that runs other programs. Literal ones are kept by name, so a script handed to python -c $code is still read.
    this.blocks ||= new Map();
    const block = (body, literal) => {
      if (RUNS_TEXT.test(body) || (!ps && /`/.test(body))) this.scanBits.push(body);
      const name = `CRUXTEXT${this.blocks.size + 1}`;
      this.blocks.set(name, literal ? body : null);
      return `'${name}'`;
    };
    if (ps) {
      // Variables the command sets itself ($s = ...) are its own, not the environment's.
      this.localVars ||= new Set();
      for (const m of cmd.matchAll(/\$(\w+)\s*=(?!=)/g)) this.localVars.add(m[1].toLowerCase());
      // A shortcut opened only to read its target is a read; .Save() writes the shortcut file.
      cmd = cmd.replace(/\(\s*New-Object\s+-ComObject\s+WScript\.Shell\s*\)\.CreateShortcut\(\s*(["'])(.*?)\1\s*\)/gi, (m, q, file) => {
        if (/\.Save\(\s*\)/i.test(cmd)) this.path(file, start, { write: true });
        return "'SHORTCUT'";
      });
      this.tempListings(cmd, start);
    }
    // Port 4747: reading the hub (a GET) is fine; stopping, restarting or changing it is a hard stop (see curl, KILL, hubPort).
    // A commit message passed through a quoted heredoc is plain text: $(cat <<'EOF' ... EOF)
    let s = cmd.replace(/\$\(\s*cat\s+<<-?\s*'(\w+)'[^\n]*\n([\s\S]*?)\n\s*\1\s*\n?\s*\)/g, (all, tag, body) => block(body, true));
    // PowerShell here-strings: literal when single-quoted
    s = s.replace(/@'\r?\n([\s\S]*?)\r?\n'@/g, (all, body) => block(body, true));
    s = s.replace(/@"\r?\n([\s\S]*?)\r?\n"@/g, (all, body) => {
      if (!/\$[\w({]/.test(body)) return block(body, true);
      this.unsure('A here-string with variables the hub cannot read');
      for (const inner of substitutions(body)) { bit(inner); if (this.mayMoveBranch(inner, ps)) this.branchUnknown = true; }   // $( ... ) inside it runs
      return block(body, false);
    });
    // Other heredocs: a script fed to node or python is checked as a script; anything else is data.
    s = s.replace(/^([^\n]*?)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n([\s\S]*?)\n\s*\3\s*(?=\n|$)/gm, (all, before, q, tag, after, body) => {
      if (!q && /\$\(|`/.test(body)) {
        this.unsure('A heredoc with commands inside');
        for (const inner of substitutions(body)) { bit(inner); if (this.mayMoveBranch(inner, ps)) this.branchUnknown = true; }
      }
      if (/\b(node|python3?|py)\s+-(\s|$)/.test(before)) this.script(body);
      block(body, !!q);
      return `${before}${after}`;
    });
    s = this.knownSubs(s, ps);
    // "stopped $($_.ProcessId)": a property of the pipeline object inside a string is only text.
    if (ps) s = s.replace(/\$\(\s*\$(?:_|psitem)(?:\.\w+)+\s*\)/gi, 'PROP');
    if (/`/.test(s.replace(/'[^']*'/g, ''))) { this.unsure(ps ? 'Backtick escapes the hub cannot read' : 'Command substitution (backticks)'); if (ps) this.scanAll = true; }
    if (/\$\(|<\(|>\(/.test(s.replace(/'[^']*'/g, ''))) this.unsure('Command substitution the hub cannot read');
    // What runs inside $( ), <( ), >( ) and backticks: read by the scan, and it may switch the branch (branchIn).
    for (const inner of substitutions(s)) { bit(inner); if (this.mayMoveBranch(inner, ps)) this.branchUnknown = true; }
    // iex("..."), Invoke-Expression("..."), [scriptblock]::Create("..."), InvokeScript("..."): text run as a command.
    // Never readable, and the whole command is scanned, quotes and all (review of decision 64 A).
    if (ps && /\b(iex|invoke-expression)\s*\(|\[(system\.management\.automation\.)?scriptblock\]::create|\.(invokescript|newscriptblock)\s*\(/i.test(s)) {
      this.unsure('Runs text as a command (iex, Invoke-Expression or a script block made from text)');
      this.scanAll = true;
      // A literal string handed over (iex("Set-Content C:\x\a.ps1 x"), [scriptblock]::Create('...')) is read as the
      // PowerShell it is, so a write outside or a push inside it is caught like anywhere else (M039 6).
      for (const m of s.matchAll(/(?:\b(?:iex|invoke-expression)|::create|\.(?:invokescript|newscriptblock))\s*\(\s*(?:'((?:''|[^'])*)'|"((?:""|`.|[^"`$])*)")\s*\)/gi)) {
        if (this.depth > 6) break;
        this.depth = (this.depth || 0) + 1;
        this.command(m[1] != null ? m[1].replace(/''/g, "'") : m[2].replace(/""/g, '"'), true, start);
        this.depth--;
      }
    }
    let cwd = start;
    const parts = splitParts(s, ps, true);
    this.pipeRuns(parts, s, ps);
    const piped = this.pipedIn;   // a nested command (sh -c, powershell -Command) keeps the outer part's
    let tainted = false;
    for (const part of parts) {
      const before = this.opaqueN;
      // PowerShell ( ... ) or @( ... ) given as an argument (git push origin @("main")): what runs inside it is read
      // as a command, the argument itself cannot be read, and the scan reads it with its quotes opened.
      if (part.groups?.length) {
        for (const g of part.groups) this.command(g, ps, cwd);
        this.unsure(`An argument in brackets the hub cannot read (${part.text.slice(0, 80)})`);
        this.scanBits.push(psOpen(part.text));
      }
      this.pipedIn = part.op === '|';   // fed by a pipe (see DELETE)
      // Fed by a pipe from a part that read a download (cat a.sh | tee b.sh): what it writes counts as downloaded.
      this.taintIn = this.pipedIn && tainted;
      this.partTainted = false;
      cwd = this.part(part.text, cwd, ps);
      tainted = this.partTainted;
      if (this.opaqueN > before) {
        bit(part.text);   // a part the hub could not read in full: the scan reads it
        if (this.mayMoveBranch(part.text, ps)) this.branchUnknown = true;   // see branchIn
      }
    }
    this.pipedIn = piped;
  }

  // The head (program name) of one part of a command, as pipeRuns and the substitution check read it.
  headOf(text) {
    const w = tokens(text).map(t => t.text);
    let k = 0; while (k < w.length - 1 && /^\w+=/.test(w[k])) k++;
    k = unwrap(w, k);   // timeout 60 bash ..., nohup sh ..., command curl ..., sudo bash ..., busybox sh ...
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
    // A download anywhere in the command: a downloader as a program, or a PowerShell download cradle anywhere in the
    // text ((New-Object Net.WebClient).DownloadString(...), HttpClient, irm inside a script block).
    const downloads = heads.some(h => DOWNLOADERS.has(h)) || DOWNLOAD_TEXT.test(s);
    // iex / Invoke-Expression, a script block made from text, or Invoke-Command -ScriptBlock, with a download
    // anywhere in the same command: iex (iwr URL), $s = irm URL; iex $s, & ([scriptblock]::Create((irm URL))).
    const runsText = heads.some(h => /^(iex|invoke-expression)$/.test(h)) || /\[scriptblock\]::create/i.test(s)
      || (heads.some(h => /^(invoke-command|icm)$/.test(h)) && /\s-s(c(r(i(p(t(b(l(o(c(k)?)?)?)?)?)?)?)?)?)?\b/i.test(s));
    if (runsText && downloads) this.stop('Runs what it downloads (iex or a script block with a download in the same command)');
    // (New-Object Net.WebClient).DownloadFile(URL, 'a.ps1'): that file counts as downloaded.
    for (const m of s.matchAll(/\.DownloadFile(?:Async|TaskAsync)?\s*\(\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]/gi)) {
      const p = this.abs(m[1], this.cwd0); if (typeof p === 'string') this.downloaded?.add(norm(p));
    }
    // A command or process substitution that downloads, feeding a program that runs scripts:
    // sh -c "$(curl URL)", bash <(curl URL), source <(curl URL), . <(curl URL), node -e "$(curl URL)".
    const subs = substitutions(s);
    const fetchingSub = subs.some(inner => DOWNLOAD_TEXT.test(inner) || splitParts(inner, ps).some(p => DOWNLOADERS.has(this.headOf(p).head)));
    if (fetchingSub && heads.some(h => INTERPRETERS.has(h) || /^(eval|exec|xargs)$/.test(h))) this.stop('Runs what it downloads (a download inside a command substitution)');
    // A download that reaches a program running scripts inside a process substitution: curl URL | tee >(sh).
    if (downloads && /[>]\(\s*(\S+)/.test(s) && [...s.matchAll(/>\(\s*([^\s)]+)/g)].some(m => INTERPRETERS.has(basename(m[1]).toLowerCase().replace(/\.exe$/, '')))) {
      this.stop('Runs what it downloads (a script runner inside a process substitution)');
    }
    for (const { text, op } of parts) {
      const { head, args } = this.headOf(text);
      if (DOWNLOADERS.has(head)) {
        const urls = args.filter(x => /^[a-z]+:\/\/|^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(x) || localAddress(x));
        const web = !urls.length || urls.some(u => !localAddress(u));
        fetched = fetched === 'web' || web ? 'web' : 'local';
      }
      // A download piped into a program that writes it to a file (| tee a.sh, | Out-File a.ps1, | cat > a.sh,
      // | tr -d x > a.sh, ... &> a.sh): that file counts as downloaded, so running it later in the command is caught.
      if (fetched && op === '|') {
        const files = /^(tee|tee-object|out-file|set-content|sc|add-content|ac)$/.test(head) ? args.filter(x => !x.startsWith('-')) : [];
        const w = tokens(text);
        for (let i = 0; i < w.length - 1; i++) if (w[i].op && !w[i].text.startsWith('<') && !/&\d$/.test(w[i].text)) files.push(w[i + 1].text);
        for (const a of files) { const p = this.abs(a, this.cwd0); if (typeof p === 'string') this.downloaded?.add(norm(p)); }
      }
      // xargs runs the program after it with the piped text as its words: curl URL | xargs sh -c.
      if (head === 'xargs' && op === '|') {
        const i = args.findIndex(x => !x.startsWith('-'));
        if (i >= 0 && INTERPRETERS.has(basename(args[i]).toLowerCase())) { if (fetched) this.stop(`Runs what it downloads (a download piped into xargs ${args[i]})`); continue; }
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
  // $(git branch --show-current), $(git rev-parse --abbrev-ref HEAD) and $(git symbolic-ref --short HEAD) only read
  // the checked-out branch (decision 64 A): they become CURRENT_BRANCH, which part() replaces with the branch of the
  // folder that part runs in (PowerShell too).
  knownSubs(s, ps = false) {
    s = s.replace(/\$\(\s*git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+HEAD|symbolic-ref\s+--short\s+(?:-q\s+)?HEAD)\s*\)/g, CURRENT_BRANCH);
    if (ps) return s;
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

  // M039 4: a file this agent downloaded, or anything inside a folder it downloaded (a fresh clone, an unpacked
  // archive, a copy of either). holds: the path holds something downloaded (cp -r of a temp folder).
  isDown(x, cwd, holds = false) {
    if (!this.downloaded?.size) return false;
    const a = this.abs(String(x).replace(/^\(+|\)+$/g, ''), cwd);
    if (typeof a !== 'string' || ['null', 'outside'].includes(a)) return false;
    return [...this.downloaded].some(d => under(a, d) || (holds && under(d, a)));
  }
  markDown(x, cwd) {
    const a = this.abs(x, cwd);
    if (typeof a === 'string' && !['null', 'outside'].includes(a)) this.downloaded?.add(norm(a));
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
    // $(git branch --show-current) is the branch checked out where this part runs (knownSubs); unknown stays the marker.
    if (raw.includes(CURRENT_BRANCH)) {
      const b = this.branchIn(cwd);
      raw = raw.split(CURRENT_BRANCH).join(b && /^[\w./+-]+$/.test(b) ? b : CURRENT_BRANCH);
    }
    // A part that is one quoted string and nothing else (PowerShell prints it): see simple().
    this.wholeString = ps && /^'(?:''|[^'])*'$|^"(?:""|`.|[^"`])*"$/.test(raw.trim());
    const words = tokens(raw, ps);
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
      if (!ok) {   // known only at run time; an environment setting is still noted by name (its value unknown)
        this.vars.delete(key); (this.localVars ||= new Set()).add(key);
        if (key.startsWith('env:') || exported) this.envSet.set(key.replace(/^env:/, ''), null);
        return false;
      }
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
        if (val != null && !last.built && (last.quoted || joined || /^\d+$/.test(val))) pairs = [[`${m[1] ? 'env:' : ''}${m[2]}`.toLowerCase(), val]];
        else if (m[3] !== undefined || words[1]?.text === '=' || /^=/.test(words[1]?.text || '')) {
          this.vars.delete(`${m[1] ? 'env:' : ''}${m[2]}`.toLowerCase());
          if (m[1]) this.envSet.set(m[2].toLowerCase(), null);   // $env:X = <something not literal>: still an environment setting
          return false;
        }
      }
    } else {
      const ws = t0 === 'export' ? words.slice(1) : words;
      if (ws.length && ws.every(w => /^[A-Za-z_]\w*=/.test(w.text))) pairs = ws.map(w => [w.text.split('=')[0].toLowerCase(), w.text.slice(w.text.indexOf('=') + 1)]);
      // Exported or not, a shell assignment counts as an environment setting for curl and wget: HOME, USERPROFILE and
      // APPDATA are already in the environment, so HOME=. changes what the next curl reads (fifth review of PR #51).
      if (pairs) for (const [k] of pairs) this.assigned.add(k);
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
    // Only when the whole part is that one string: iex("...") and 'iex'(...) are not strings on their own.
    if (ps && this.wholeString && words.length === 1 && words[0].quoted && !this.pathLike(words[0].text)) { this.word(words[0], cwd); return cwd; }
    // Running a program by its full path is running that program: "/c/Program Files/GitHub CLI/gh.exe" is gh.
    const first = words[0].text;
    const head = (this.pathLike(first) ? basename(first.replace(/\\/g, '/')) : first).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
    const args = words.slice(1).map(w => w.text);
    // Running a file this same command just downloaded (curl ... -o a.sh && sh a.sh; ; node a.js; ./a.sh): a stop.
    // M039 4: anything inside a fresh clone or an unpacked download counts too (git clone URL t && bash t/install.sh),
    // and so does running a project's own tools inside one (cd t && npm test, npm --prefix t test, make -C t).
    // A downloader's own output is a download (curl URL | tar -xz: the unpacked files count; review round 1).
    this.partTainted = !!this.taintIn || DOWNLOADERS.has(head);
    if (this.downloaded?.size) {
      const got = x => this.isDown(x, cwd);
      const runner = INTERPRETERS.has(head) || RUNNERS.has(head);
      if (got(first) || (runner && (args.some(got) || got(cwd)))) {
        this.stop(`Runs a file this agent downloaded (${words.map(w => w.text).join(' ').slice(0, 80)})`);
      }
      // What it reads from a download, it may write: those files count as downloaded too (cat a.sh > b.sh).
      if (words.slice(1).some(w => this.isDown(w.text, cwd, /^(cp|copy|copy-item|cpi|robocopy|xcopy)$/.test(head)))) this.partTainted = true;
    }
    if (this.partTainted) for (const t of wrote) this.markDown(t, cwd);
    this.ps = ps;
    // Every word after the program: variables, addresses and secrets (paths are judged by what the program does).
    this.urlsHere = []; this.localUrls = []; this.fileUrls = [];
    // The script after powershell -Command is read as PowerShell on its own (see run), so its words are not checked here.
    const psAt = /^(powershell|pwsh)$/.test(head) ? args.findIndex(a => /^-(c|command)$/i.test(a)) : -1;
    // A search pattern (grep -n "homedir\|\.crux-hub" x) is text, not a path or an address: only its variables count.
    const pat = patternWords(words.map(w => w.text));
    (psAt >= 0 ? words.slice(1, psAt + 2 - 1) : words.slice(1)).forEach((w, i) => this.word(w, cwd, pat.has(i + 1)));
    if (SECRET.test(norm(first))) this.stop(`Touches secrets or credentials: ${first}`);
    // An address is a network call, except a PR's own text, GitHub for git, and this machine (localhost).
    const github = this.urlsHere.every(u => /^(https:\/\/|git@)github\.com[/:]/i.test(u));
    // R005, "GitHub fetches are fine" (decision 64 A): curl, wget or Invoke-WebRequest reading only from GitHub
    // (release files, raw files) is judged in run() like a website read at Trusted, and must stay on GitHub there.
    this.githubRead = WEB_READ.has(head) && this.urlsHere.length > 0 && this.urlsHere.every(githubReadUrl);
    const allowsAddress = (head === 'gh' && args[0] === 'pr' && args[1] === 'create') || (head === 'git' && github && args.some(a => /^(clone|fetch|pull|ls-remote)$/.test(a))) || this.githubRead;
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
    // It may switch the checked-out branch unseen, so a later bare push or merge in the command cannot trust .git/HEAD.
    const script = (file, rest) => {
      const ok = file && ['inside', 'tmp'].includes(this.where(file, cwd)) && !rest.some(a => a !== file && this.outside(a, cwd));
      if (ok) this.branchUnknown = true;
      return ok;
    };
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
      this.command(inner, true, cwd);
      this.urlsHere = saved.urls; this.localUrls = saved.local;
      return;
    }
    const positional = args.filter(a => !a.startsWith('-'));
    const outsideHere = this.where(cwd, cwd) === 'outside';
    // A request to this machine: reading (GET) is fine anywhere, the hub on 4747 included. Sending data to the
    // hub on 4747 changes it: a hard stop. Sending data to a test hub is left to the orchestrator.
    // A downloader pointed at a file on this computer (curl file:///c/Users/me/.ssh/id_rsa -o k.txt) copies it: a stop.
    if (DOWNLOADERS.has(head) && this.fileUrls?.length) return this.stop(`Reads a file on this computer through a file:// address (${this.fileUrls[0].slice(0, 80)})`);
    // PowerShell's $PSDefaultParameterValues can give Invoke-RestMethod an address or a method no word shows.
    if (DOWNLOADERS.has(head) && /\$PSDefaultParameterValues/i.test(this.cmdText || '')) return this.stop(`${head} in a command that sets $PSDefaultParameterValues (hidden options)`);
    // curl and wget find settings files through HOME, USERPROFILE, APPDATA, CURL_HOME, XDG_CONFIG_HOME, WGETRC and
    // SYSTEMWGETRC. A command that runs one and names any of them anywhere (for HOME in .; printf -v HOME; read HOME;
    // declare HOME=.) is a stop: there are too many ways to set a variable to follow each one.
    if ((head === 'curl' || head === 'wget') && configHomeNamed(this.cmdText || '')) return this.stop(`${head} in a command that names a variable curl or wget reads its settings through (${configHomeNamed(this.cmdText)})`);
    // Requests to this machine (any port) pass on an allow-list (fourth review of PR #51): every option on LOCAL_OK, no
    // environment setting in front but LOCAL_ENV_OK, and the target taken only from the addresses themselves (curl and
    // wget: their positional words; iwr / irm: -Uri or the first positional word). To the hub on 4747, or to this
    // machine with no port, only a plain GET; changes only towards a test hub's port.
    if (/^(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)$/.test(head) && !this.urlsHere.length && this.localUrls.length) {
      const fam = head === 'curl' ? 'curl' : head === 'wget' ? 'wget' : 'iwr';
      const r = readFlags(args, webFlags(fam));
      const why = m => this.stop(`${head} to this machine ${m}`);
      if (args.some(openHashtable)) return why('with a hashtable whose braces do not close');
      const envBad = this.envNames(head).find(k => !LOCAL_ENV_OK.has(k));
      if (envBad) return why(`with ${envBad.toUpperCase()} set in front (only ${[...LOCAL_ENV_OK].map(k => k.toUpperCase()).join(', ')} may be)`);
      if (r.unknown.length) return why(`with an option the hub cannot check (${r.unknown[0]})`);
      const off = r.flags.find(f => !LOCAL_OK[fam].has(f.key));
      if (off) return why(`with an option outside the short safe list (${off.raw})`);
      const vals = n => r.flags.filter(f => f.name === n).map(f => f.value);
      if (r.flags.some(f => f.value === undefined)) return why('with an option that has nothing after it');
      if (fam === 'curl' && vals('header').some(h => typeof h !== 'string' || h.startsWith('@'))) return why('with headers read from a file (-H @file)');
      const wOut = fam === 'curl' && writeOutFile(r);
      if (wOut) return why(`with -w writing to a file or read from one (${wOut})`);
      let targets;
      if (fam === 'iwr') {
        const uris = [...vals('url'), ...r.positional.slice(0, 1)];
        if (r.positional.length > 1 || r.positional.some(p => /^@/.test(p))) return why(`with words the hub cannot place (${r.positional.slice(1).join(' ') || r.positional[0]})`);
        if (uris.length !== 1 || typeof uris[0] !== 'string') return why('without exactly one -Uri');
        targets = uris;
      } else targets = r.positional;
      if (!targets.length) return why('without an address');
      // A target off this machine is the network (Auto) or a website download (Trusted).
      const away = targets.find(a => !localAddress(a));
      if (away && !this.trusted) return this.stop(`Reaches the network (${String(away).slice(0, 80)})`);
      if (away) return this.webRead(head, args, cwd);
      const methods = vals('method');
      const sends = vals('send').length > 0 || methods.some(m => typeof m !== 'string' || !/^(GET|HEAD)$/i.test(m));
      const live = targets.some(u => localAddress(u)?.live !== false);   // port 4747 as a number, no port, or unreadable
      if (live && sends) return this.stop('Sends a change to the live hub (port 4747 or its phone port 4748, or this machine with no port named)');
      const saves = [...vals('out'), ...vals('doc')];
      // A test hub (any other port on this machine) is contained: only where it saves is checked.
      const intoHere = fam === 'wget' && !vals('doc').length;
      r.saves = saves; r.dirs = []; r.intoHere = intoHere;
      for (const o of [...r.saves, ...r.dirs]) {
        if (o === true || o == null) { this.stop(`${head} saves to a file the hub cannot read`); continue; }
        if (o === '-' || /^(\/dev\/null|nul|\$null)$/i.test(o)) continue;
        this.path(o, cwd, { write: true });
        const a = this.abs(o, cwd); if (typeof a === 'string') this.downloaded?.add(norm(a));
      }
      if (r.intoHere) this.path(cwd, cwd, { write: true });
      return;
    }
    if (this.githubRead && !this.trusted && WEB_READ.has(head)) return this.webRead(head, args, cwd, { githubOnly: true });
    if (this.trusted && WEB_READ.has(head)) return this.webRead(head, args, cwd);
    if (this.trusted && /^(ping|nslookup|test-netconnection|tnc)$/.test(head)) return;   // only looks an address up
    if (NETWORK.has(head)) return this.stop(`Reaches the network (${head})`);
    const deep = this.recursiveSecret(head, args, cwd);
    if (deep) return this.stop(`Reads or copies every file under the home folder or a folder holding secrets (${head} ${deep})`);
    // Programs on the read list that can also run commands or write files (awk system(), sed e / w, rg --pre, sort
    // --compress-program, find -delete, xxd and uniq output files, ...): judged here; true when that settled it.
    if (this.readerExec(head, args, cwd) !== false) return;
    // A downloaded file moved or copied keeps counting as downloaded: curl -o a.sh URL; mv a.sh b.sh; bash b.sh.
    // M039 4: any copy of a download, of a folder holding one, or of a fresh clone (cp -r, Copy-Item -Recurse, tee, Out-File)
    // keeps counting: the destination, and the source's name inside it, are marked.
    if (this.partTainted && (WRITE_ALL.has(head) || WRITE_LAST.has(head)) && positional.length) {
      const items = this.items(positional), dst = items.at(-1);
      for (const t of WRITE_ALL.has(head) && !/^(mv|move|move-item|mi|rename-item|rni|ren)$/.test(head) ? items : [dst]) this.markDown(t, cwd);
      for (const src of items.slice(0, -1)) this.markDown(join(dst, basename(src)), cwd);
      // Expand-Archive with no -DestinationPath makes a folder named after the archive where it runs.
      if (/^expand-archive$/.test(head) && !args.some(a => /^-d/i.test(a))) this.markDown(join(cwd, basename(String(items[0])).replace(/\.zip$/i, '')), cwd);
    }
    // tar, unzip and 7z unpacking a download: the folder it unpacks into counts as downloaded; with none named, the
    // files land among the project's own under names the hub cannot see: a stop (M039 4).
    if (/^(tar|bsdtar|unzip|7z|7za)$/.test(head) && this.partTainted) {
      const dir = args.flatMap((a, i) => /^(-C|--directory|-d)$/.test(a) ? [args[i + 1]] : /^--directory=(.+)$/.exec(a)?.[1] ? [a.slice(12)] : head.startsWith('7z') && /^-o(.+)$/.exec(a) ? [a.slice(2)] : []).filter(Boolean);
      if (!dir.length) return this.stop(`Unpacks a download where the hub cannot track its files (${head} with no folder named)`);
      for (const d of dir) this.markDown(d, cwd);
    }
    // Programs that write: a target outside the project folder or a temp folder is a hard stop.
    // -r, -rf, --recursive, and PowerShell's -Recurse by any prefix (-Rec), also written -Recurse:$true.
    const recursive = args.some(a => /^(--recursive|-[rf]*r[rf]*|-re(c(u(r(se?)?)?)?)?)(:\$true)?$/i.test(a));
    // A copy writes its last word, and also the folder named by cp -t / --target-directory or PowerShell's
    // -Destination (any start of it), wherever it stands (cp -t C:/x a, Copy-Item -Destination C:/x -Path a).
    const named = WRITE_LAST.has(head) ? args.flatMap((a, i) => {
      const v = /^(-t|--target-directory)$/.test(a) || (this.ps && /^-d(e(s(t(i(n(a(t(i(on?)?)?)?)?)?)?)?)?)?$/i.test(a)) ? args[i + 1]
        : /^--target-directory=(.+)$/.exec(a)?.[1] ?? (!a.startsWith('--') ? /^-t(.+)$/.exec(a)?.[1] : null) ?? (this.ps ? /^-d(?:e(?:s(?:t(?:i(?:n(?:a(?:t(?:i(?:on?)?)?)?)?)?)?)?)?)?:(.+)$/i.exec(a)?.[1] : null);
      return v != null ? [v] : [];
    }) : [];
    const writes = WRITE_ALL.has(head) ? positional : WRITE_LAST.has(head) ? [...positional.slice(-1), ...named] : null;
    if (writes) {
      for (const t of this.items(writes)) {
        if (recursive && this.unresolved(t)) { this.stop(`Writes recursively through a path the hub cannot resolve (${head} ${t})`); continue; }
        if (this.outside(t, cwd) || (outsideHere && !this.pathLike(t))) this.stop(`Writes outside the project folder (${head} ${t})`);
        else if (this.where(t, cwd) === 'tmp') this.noteTemp(t, cwd, /^(mkdir|md|new-item|ni)$/.test(head));
        // Inside, the same files as any write: .git, the hub's .crux log, Claude Code's settings, dependency files
        // (follow-up to M039 2: cp, mv, tee and Set-Content were checked for outside only).
        else if (this.where(t, cwd) === 'inside') this.path(t, cwd, { write: true });
      }
      return;
    }
    if (KILL.has(head)) return this.kill(head, args, cwd);
    if (/^(pip3?)$/.test(head)) return this.pip(words[0].text, args, cwd);
    if (INSTALL.has(head)) return this.stop(SYSTEM_WIDE.has(head) ? `Installs software system-wide (${head})` : `Installs software (${head})`);
    if (head === 'uv' || head === 'poetry') return this.pyProject(head, args, cwd);
    if (/^(env|printenv|set|get-credential|get-secret)$/.test(head)) return this.stop(`Reads environment variables or credentials (${head})`);
    // sh -c 'SCRIPT', bash -lc "SCRIPT" and eval "SCRIPT": the script is read like any command, so a hard stop inside
    // (curl URL | sh, git push --force) is caught. The whole thing still goes to the orchestrator, as before.
    if (/^(sh|bash|zsh|dash)$/.test(head)) {
      const i = args.findIndex(a => /^-[a-z]*c[a-z]*$/i.test(a));
      if (i >= 0 && args[i + 1] != null) this.innerCommand(args[i + 1], cwd);
    }
    if (head === 'eval' && args.length) this.innerCommand(args.join(' '), cwd);
    // iex 'text' / Invoke-Expression -Command "text": a literal is read as PowerShell (M039 6); still unsure below.
    if (/^(iex|invoke-expression)$/.test(head) && this.ps) {
      const lit = words.slice(1).filter(w => !/^-c(o(m(m(a(nd?)?)?)?)?)?$/i.test(w.text));
      if (lit.length === 1 && lit[0].quoted && !lit[0].vars && (this.depth || 0) <= 6) {
        this.depth = (this.depth || 0) + 1;
        this.command(lit[0].text, true, cwd);
        this.depth--;
      }
    }
    if (INDIRECT.has(head)) return this.unsure(`Runs commands the hub cannot read (${head})`);
    // R004: deleting inside the project folder or a temp folder is contained; anywhere else is a hard stop.
    if (DELETE.has(head)) {
      const targets = this.items(args.filter(a => !a.startsWith('-')));
      // foreach ($d in $list) { Remove-Item -LiteralPath $d.FullName -Recurse }, where $list came from Get-ChildItem of
      // a folder under temp (tempListings): each item sits in temp, so the delete stays in temp. Not this agent's own
      // by name, so for the orchestrator (M038 c9), never a hard stop on its own.
      const fed = this.tempFed(head, args);
      if (fed) return this.unsure(`Deletes what a listing of a temp folder returns (${fed})`, true);
      // Get-ChildItem C:\ | Remove-Item -Recurse: deletes what the pipeline lists, with no path named.
      if (!targets.length && this.pipedIn && this.ps) {
        if (recursive || this.sawOutside) return this.stop(`Deletes recursively what a pipeline lists, or with a path outside the project folder named (${head} ${args.join(' ')})`.trim());
        return this.unsure(`Deletes what a pipeline lists (${head})`, true);
      }
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
      // -delete deletes under the folders it starts from; -fprint, -fprint0, -fprintf and -fls write a file.
      const starts = []; for (const a of args) { if (/^[-(!]/.test(a)) break; starts.push(a); }
      if (args.includes('-delete')) {
        for (const s of starts.length ? starts : ['.']) {
          const w = this.where(s, cwd);
          if (w === 'outside') this.stop(`Deletes files outside the project or a temp folder (find ${s} -delete)`);
          else if (w === 'tmp' && !this.ownTemp(s, cwd)) this.unsure(`Deletes in a temp folder that is not this agent's own (find ${s} -delete)`, true);
        }
      }
      args.forEach((a, i) => { if (/^-(fprint0?|fprintf|fls)$/.test(a) && args[i + 1]) this.path(args[i + 1], cwd, { write: true }); });
      return;
    }
    if (SAFE.has(head) || head === 'strings' || head === 'cygpath' || /^get-[a-z]+$/.test(head) || /^(format|select|sort|measure|where|group|convertto|convertfrom|out-string)-?/.test(head) && !/^out-file$/.test(head)) return;   // reads, wherever it reads from
    if (head === 'git') return this.git(args, cwd);
    if (head === 'gh') return this.gh(args, cwd);
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

  // M039 5: a recursive read or copy rooted at the home folder, above it, or at a folder holding .ssh, .aws, .gnupg or
  // .crux-hub reads every secret in it (grep -r ~, rg --hidden ~, Get-ChildItem ~ -Recurse | Select-String,
  // cp -r ~ ./x, Copy-Item ~ -Recurse, find ~ -exec cat). The root it names, else null.
  recursiveSecret(head, args, cwd) {
    const hit = roots => (roots.length ? roots : ['.']).find(r => secretTree(this.abs(r, cwd), this.home)) ?? null;
    // The words that are not the pattern or an option's value: where it reads from.
    const roots = valued => { const pat = patternWords([head, ...args]); return args.filter((a, i) => !a.startsWith('-') && !pat.has(i + 1) && !valued.test(args[i - 1] || '')); };
    // GNU grep takes a long option by any unique start (--rec, --dir=recurse, --directories recurse), and a value by
    // any unique start too (rec); a cluster may hold digits (-1r). Review round 1.
    const long = (a, full) => { const n = a.split('=')[0]; return n.length >= 4 && full.startsWith(n); };
    if (/^(grep|egrep|fgrep)$/.test(head)) {
      const rec = args.some((a, i) => (/^-[a-zA-Z0-9]*[rR]/.test(a) && !a.startsWith('--')) || long(a, '--recursive') || long(a, '--dereference-recursive')
        || (a === '-d' && /^rec/.test(args[i + 1] || '')) || /^-d\s*rec/.test(a)
        || (long(a, '--directories') && /^rec/.test((a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1]) || '')));
      return rec ? hit(roots(SEARCH_VALUED.grep)) : null;
    }
    if (head === 'rg') {
      const us = args.filter(a => /^-[a-zA-Z0-9]+$/.test(a)).join('').replace(/[^u]/g, '').length;
      const hidden = us >= 2 || args.some(a => /^(-\.|-[a-zA-Z0-9]*\.[a-zA-Z0-9]*)$/.test(a) || long(a, '--hidden') || long(a, '--unrestricted'));
      return hidden ? hit(roots(SEARCH_VALUED.rg)) : null;
    }
    // Archives and folder copies of a whole tree: tar -czf x.tgz ~, zip -r x.zip ~, 7z a x.7z ~, robocopy ~ h /E.
    if (/^(tar|bsdtar)$/.test(head) && args.some((a, i) => (i === 0 && /^-?[a-zA-Z]*c/.test(a) && !a.startsWith('--')) || /^-[a-zA-Z]*c/.test(a) && !a.startsWith('--') || long(a, '--create') || a === '-c')) {
      return hit([...args.filter(a => !a.startsWith('-')), ...args.flatMap((a, i) => (a === '-C' || a === '--directory' ? [args[i + 1]] : []))].filter(Boolean));
    }
    // xcopy and robocopy are Windows programs: every /X word is a switch (/C, /E, /MIR, /R:3), never the C: drive;
    // a Git Bash path (/c/Users/...) still has a second slash (review round 2).
    if (/^(robocopy|xcopy)$/.test(head)) return hit(args.filter(a => !/^-/.test(a) && !/^\/[^/\\]*$/.test(a)));
    if (/^(zip|7z|7za)$/.test(head)) return hit(args.filter(a => !/^[-/]/.test(a) || /^\/[a-z](\/|$)/i.test(a)));
    if (/^(cp|copy)$/.test(head) && args.some(a => /^(-[a-zA-Z]*[rRa][a-zA-Z]*|--recursive|--archive)$/.test(a))) return hit(args.filter(a => !a.startsWith('-')));
    const psRec = args.some(a => /^-(r(e(c(u(r(se?)?)?)?)?)?|depth)(:\$true)?$/i.test(a));
    if (/^(copy-item|cpi)$/.test(head) && psRec) {
      const r = readFlags(args, { ps: { Path: 'src', LiteralPath: 'src', Destination: 'dst', Recurse: 'ok', Force: 'ok', Container: 'ok', PassThru: 'ok', Filter: 'okv', Include: 'okv', Exclude: 'okv', ErrorAction: 'okv', Verbose: 'ok', WhatIf: 'ok', Confirm: 'ok' }, valued: ['src', 'dst', 'okv'] });
      const srcs = [...r.flags.filter(f => f.name === 'src').map(f => f.value), ...r.positional.slice(0, r.flags.some(f => f.name === 'dst') ? undefined : 1)];
      return hit(srcs.filter(s => typeof s === 'string').flatMap(s => s.split(',')).filter(Boolean));
    }
    // -s is Get-ChildItem's own alias for -Recurse (review round 1).
    if (/^(get-childitem|gci|dir|ls)$/.test(head) && this.ps && (psRec || args.some(a => /^-s(:\$true)?$/i.test(a))) &&/\b(select-string|sls|get-content|gc|cat|type|copy-item|cpi|cp|copy|compress-archive|foreach-object|readall\w*)\b|\|\s*%/i.test(this.cmdText || '')) {
      const r = readFlags(args, { ps: { Path: 'src', LiteralPath: 'src', Recurse: 'ok', Depth: 'okv', Force: 'ok', File: 'ok', Directory: 'ok', Hidden: 'ok', Name: 'ok', Filter: 'okv', Include: 'okv', Exclude: 'okv', Attributes: 'okv', ErrorAction: 'okv', FollowSymlink: 'ok' }, valued: ['src', 'okv'] });
      return hit([...r.flags.filter(f => f.name === 'src').map(f => f.value), ...r.positional].filter(s => typeof s === 'string'));
    }
    if (head === 'find' && args.some(a => /^-(exec|execdir|ok|okdir)$/.test(a))) {
      const starts = []; for (const a of args) { if (/^[-(!]/.test(a)) break; starts.push(a); }
      return hit(starts);
    }
    return null;
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

  // ---------- temp clean-ups through a listing (M038 c9, decision 64 A) ----------
  // $t = $env:TEMP; $o = Get-ChildItem $t -Directory -Filter 'crux-*' | Where-Object { ... }; $all = @($c) + @($o);
  // foreach ($d in $all) { Remove-Item -LiteralPath $d.FullName -Recurse -Force }. Finds the foreach variables ($d)
  // whose every item comes from Get-ChildItem (not recursive) of a folder under temp, through filters only. Anything
  // that could put another item in the list (a second assignment, Select-Object with a made-up property, Add-Member,
  // aliases) and the variable is not counted.
  tempListings(cmd, start) {
    this.tempItems ||= new Set();
    if (/\b(set-variable|new-variable|clear-variable|remove-variable|set-alias|new-alias|add-member|update-typedata)\b|\b(sv|nv|sal|nal)\s|\.psobject\b|\[ref\]/i.test(cmd)) return;
    const assigns = name => (cmd.match(new RegExp(`\\$(?:script:|global:|local:)?${name}\\s*[-+*/]?=(?!=)`, 'gi')) || []).length;
    const paths = new Map(), lists = new Set();
    for (const st of psStatements(cmd)) {
      const m = /^\$(\w+)\s*=\s*([\s\S]+)$/.exec(st.trim());
      if (!m || assigns(m[1]) !== 1) continue;
      const name = m[1].toLowerCase(), rhs = m[2].trim();
      const p = this.psPath(rhs, paths, start);
      if (p) paths.set(name, p);
      else if (this.psTempList(rhs, paths, lists, start)) lists.add(name);
    }
    for (const m of cmd.matchAll(/\bforeach\s*\(\s*\$(\w+)\s+in\s+\$(\w+)\s*\)/gi)) {
      const d = m[1].toLowerCase();
      const loops = (cmd.match(new RegExp(`\\bforeach\\s*\\(\\s*\\$${d}\\s+in\\b`, 'gi')) || []).length;
      if (lists.has(m[2].toLowerCase()) && loops === 1 && assigns(d) === 0) this.tempItems.add(d);
    }
  }
  // A PowerShell value that names a folder: $env:TEMP, [IO.Path]::GetTempPath(), a variable set to one, a quoted
  // literal, or Join-Path A 'b' (in brackets or not). The full path, or null.
  psPath(v, paths, start) {
    let s = String(v).trim();
    const inner = /^\(([\s\S]*)\)$/.exec(s);
    if (inner) s = inner[1].trim();
    if (/^"?\$\{?env:(temp|tmp)\}?"?$/i.test(s) || /^\[(system\.)?io\.path\]::gettemppath\(\s*\)$/i.test(s)) return this.tmp;
    const own = /^\$(\w+)$/.exec(s);
    if (own) return paths.get(own[1].toLowerCase()) || null;
    const j = /^join-path\s+(\S+|\([^()]*\))\s+(?:'([^'$`]+)'|"([^"$`]+)"|([\w.-]+))$/i.exec(s);
    if (j) {
      const base = this.psPath(j[1], paths, start), leaf = j[2] ?? j[3] ?? j[4];
      return base && !/(^|[\\/])\.\.([\\/]|$)/.test(leaf) ? join(base, leaf) : null;
    }
    const q = /^'([^'$`]+)'$|^"([^"$`]+)"$/.exec(s);
    if (q) { const a = this.abs(q[1] ?? q[2], start); return typeof a === 'string' && !['null', 'tmp', 'outside'].includes(a) ? a : null; }
    return null;
  }
  // True when a right-hand side lists items in a folder under temp: Get-ChildItem PATH with only harmless options
  // (no -Recurse, -Depth or -Name), then only Where-Object, Sort-Object or Select-Object -First/-Last/-Skip; or a
  // sum of such lists (@($c) + @($o)).
  psTempList(rhs, paths, lists, start) {
    if (/^(@\(\s*\$\w+\s*\)|\$\w+)(\s*\+\s*(@\(\s*\$\w+\s*\)|\$\w+))*$/.test(rhs)) {
      return [...rhs.matchAll(/\$(\w+)/g)].every(m => lists.has(m[1].toLowerCase()));
    }
    const stages = psStatements(rhs, '|');
    const g = /^(?:get-childitem|gci|dir|ls)\s+([\s\S]+)$/i.exec(stages[0] || '');
    if (!g) return false;
    let rest = g[1].trim(), where = null;
    const named = /^-(?:path|literalpath)\s+/i.exec(rest);
    if (named) rest = rest.slice(named[0].length);
    const group = rest.startsWith('(') ? balanced(rest, 0) : -1;
    const end = group > 0 ? group + 1 : (/^'[^']*'|^"[^"]*"|^\S+/.exec(rest)?.[0].length ?? 0);
    where = this.psPath(rest.slice(0, end), paths, start);
    if (!where || this.where(where, start) !== 'tmp') return false;
    const opts = tokens(rest.slice(end), true).map(t => t.text);
    for (let i = 0; i < opts.length; i++) {
      if (/^-(directory|file|force|hidden|ad|af)$/i.test(opts[i])) continue;
      if (/^-(filter|include|exclude|attributes|erroraction|ea)$/i.test(opts[i]) && opts[i + 1] != null && !/\$/.test(opts[i + 1])) { i++; continue; }
      return false;
    }
    return stages.slice(1).every(st => /^(where-object|where|\?)\s*\{[\s\S]*\}$/i.test(st.trim()) || /^(sort-object|sort)(\s+-?[\w]+)*$/i.test(st.trim())
      || /^(select-object|select)(\s+-(first|last|skip)\s+\d+)+$/i.test(st.trim()));
  }
  // Remove-Item (or an alias) whose every path is $d or $d.FullName for a temp-listing variable (tempListings), with
  // options it knows: what it deletes, else null.
  tempFed(head, args) {
    if (!this.ps || !this.tempItems?.size || !/^(remove-item|ri|rm|del|erase|rd|rmdir)$/.test(head)) return null;
    const r = readFlags(args, { ps: { Path: 'path', LiteralPath: 'path', Recurse: 'ok', Force: 'ok', Confirm: 'ok', WhatIf: 'ok', ErrorAction: 'okv', WarningAction: 'okv', Verbose: 'ok' }, valued: ['path', 'okv'] });
    if (r.unknown.length) return null;
    const paths = [...r.flags.filter(f => f.name === 'path').map(f => f.value), ...r.positional];
    if (!paths.length || !paths.every(p => typeof p === 'string' && /^\$(\w+)(\.fullname)?$/i.test(p) && this.tempItems.has(/^\$(\w+)/.exec(p)[1].toLowerCase()))) return null;
    return `${head} ${args.join(' ')}`;
  }
  // Environment settings the next program sees: export X= and $env:X = earlier in the command, X=v in front of it.
  env() { return new Map([...(this.envSet || []), ...(this.envNow || [])]); }
  // The names of every environment setting a downloader may see: env() plus, for curl and wget, every shell
  // assignment earlier in the command (HOME=.; curl ...), exported or not, whose name curl or wget reads. A plain
  // shell variable they never read (J='...js...' handed to a script) is not passed to them (decision 64 A).
  envNames(head) { return [...new Set([...this.env().keys(), ...(/^(curl|wget)$/.test(head) ? [...(this.assigned || [])].filter(k => DOWNLOADER_READS.test(k)) : [])])]; }

  word(w, cwd, pattern = false) {
    // A PowerShell hashtable (one word, as written): every word inside it is checked like any other.
    if (w.hashtable) { for (const x of tokens(w.text.replace(/^@\{|\}$/g, ' ').replace(/[;=]/g, ' '))) this.word(x, cwd); return; }
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
    // A search pattern: text, not a path or an address. One that also names a file on disk keeps its secret check,
    // in case the hub misread which word is the pattern (review round 2).
    if (pattern) {
      if (!t.startsWith('-') && this.patternOnDisk(t, cwd) && this.secretAt(t, cwd)) this.stop(`Touches secrets or credentials: ${t}`);
      return;
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
    // --file=x, and PowerShell's -Path:x, name x too.
    const v = /^--?[\w-]+[=:](.+)$/.exec(t)?.[1] ?? (t.startsWith('-') ? null : t);
    if (v == null) return;
    if (this.secretAt(v, cwd)) this.stop(`Touches secrets or credentials: ${v}`);
    if (this.outside(v, cwd)) this.sawOutside = true;
  }

  git(args, cwd) {
    let a = args, otherRepo = false, cfgSeen = null;
    while (a.length) {
      if (a[0] === '-C') {   // its path was checked with the other words; /c/Users/... is Git Bash's C:/Users/...
        const to = this.abs(a[1] || '.', cwd);
        cwd = to === 'outside' || to === 'null' ? resolve('/__outside__') : to; a = a.slice(2); continue;
      }
      if (a[0] === '--no-pager' || a[0] === '-P') { a = a.slice(1); continue; }
      // --git-dir / --work-tree: the repo is not the folder's own, so its checked-out branch is not known here.
      if (/^--(git-dir|work-tree)=/.test(a[0])) { otherRepo = true; a = a.slice(1); continue; }
      // git -c KEY=VALUE / --config-env=KEY=VAR: a setting that runs a program (core.pager, core.fsmonitor,
      // diff.external, ...) runs it at once: a stop (M039 1). Any other -c stays with the orchestrator, as before.
      const cfg = a[0] === '-c' ? a[1] : /^--config-env(?:=(.*))?$/.exec(a[0]) ? (a[0].includes('=') ? a[0].slice(13) : a[1]) : null;
      if (cfg != null || a[0] === '-c') {
        const key = String(cfg ?? '').split('=')[0];
        if (!key || GIT_RUNS_CONFIG.test(key)) return this.stop(`git with a setting that runs a program (-c ${key || '?'})`);
        if (!GIT_SAFE_CONFIG.test(key)) cfgSeen ||= `${a[0]} ${cfg}`;   // display-only keys (color.ui) are fine
        a = a.slice(a[0] === '-c' || !a[0].includes('=') ? 2 : 1); continue;
      }
      if (a[0].startsWith('-')) return this.unsure(`git with options the hub cannot check (${a[0]})`);
      break;
    }
    if (cfgSeen) return this.unsure(`git with options the hub cannot check (${cfgSeen})`);
    const [sub, ...rest] = a;
    const flag = (...fs) => rest.some(x => fs.includes(x));
    if (!sub) return;
    // Settings that make git run another program or work on another repo (follow-up to PR #51): GIT_PAGER=sh,
    // GIT_EXTERNAL_DIFF, GIT_SSH_COMMAND, GIT_DIR=..., EDITOR, LESSOPEN. GIT_PAGER / PAGER set to cat or nothing are fine.
    const genv = [...this.env()].find(([k, v]) => GIT_RUNS_VARS.test(k) && !(/^(git_)?pager$/i.test(k) && /^(cat|less|)$/.test(String(v ?? 'x'))));
    if (genv) return this.stop(`git with ${genv[0].toUpperCase()} set in front (it can make git run another program or use another repo)`);
    // git grep -O / --open-files-in-pager runs a program on the matches; --output writes a file anywhere.
    // Clustered (-iOprog) and shortened (--open) spellings too (follow-up to M039 1).
    if (sub === 'grep' && rest.some(x => gitReadRuns('grep', x) && !/^--ou/.test(x))) return this.stop('git grep runs another program (-O)');
    // git grep --no-index searches the whole folder tree, dot folders included (review round 1): rooted at home or
    // a folder holding secrets, a stop.
    if (sub === 'grep' && rest.some(gitNoIndex)) {
      const roots = [cwd, ...rest.filter(x => !x.startsWith('-') && this.pathLike(x)).map(x => this.abs(x, cwd))];
      if (roots.some(r => secretTree(r, this.home))) return this.stop(`Searches every file under the home folder or a folder holding secrets (git grep --no-index)`);
    }
    rest.forEach((x, i) => {
      // --output and --output-directory by any unique start (--outp=x), with = or a separate value.
      const out = gitReadRuns('', x);
      const v = (x === '-o' || (out && !x.includes('='))) && /^(diff|log|show|format-patch|range-diff|whatchanged)$/.test(sub) ? rest[i + 1] : out && x.includes('=') ? x.slice(x.indexOf('=') + 1) : null;
      if (v != null) this.path(v, cwd, { write: true });
    });
    // In a repo outside the project folder (git -C ../other, or after cd ..), only reading is fine: the read-only
    // commands, a branch listing, git worktree list, and git remote, remote -v and remote get-url (decision 64 A).
    const readOnly = GIT_READ.has(sub) || (sub === 'worktree' && rest[0] === 'list') ||
      (sub === 'remote' && (!rest.length || (rest.length === 1 && rest[0] === '-v') || (rest[0] === 'get-url' && rest.length <= 3)));
    if (this.where(cwd, cwd) === 'outside' && !readOnly && sub !== 'branch' || (sub === 'branch' && this.where(cwd, cwd) === 'outside' && rest.some(x => !x.startsWith('-')))) {
      return this.stop(`Changes a git repo outside the project folder (git ${sub})`);
    }
    // git merge merges into the branch checked out where it runs: a card only when that is main, master or another
    // shared branch, or cannot be told (THE MERGE RULE, decision 64 A).
    if (sub === 'merge') return this.merge('Merges branches (git merge)', otherRepo ? null : cwd);
    if (!otherRepo) this.noteBranch(sub, rest, cwd);
    if (sub === 'push') return this.push(rest, cwd, otherRepo);
    if (sub === 'rebase') return otherRepo ? this.unsure('Rebases a repo named with --git-dir', true) : this.rebase(rest, cwd);
    if (GIT_HISTORY.has(sub)) return this.stop(`Rewrites history (git ${sub})`);
    if (GIT_FETCH.has(sub)) {
      // The values of options that take one are not addresses or folders (git clone --depth 1 URL t).
      const RUNS = sub === 'clone' ? /^(-u|--upload-pack|--template|--config|-c|--separate-git-dir)(=|$)/ : /^(--upload-pack|--receive-pack|--exec)(=|$)/;
      const runs = rest.find(x => RUNS.test(x));
      if (runs) return this.stop(`git ${sub} with an option that runs a program or sets git settings (${runs})`);
      const VALUED = /^(--depth|-b|--branch|-o|--origin|--reference|--reference-if-able|--shallow-since|--shallow-exclude|-j|--jobs|--filter|--deepen|--negotiation-tip|--server-option|--bundle-uri|--recurse-submodules-default)$/;
      const pos = rest.filter((x, i) => !x.startsWith('-') && !VALUED.test(rest[i - 1] || ''));
      // Trusted: downloading from any https address into the project is fine too (decision 45).
      const web = this.trusted && /^https:\/\/[\w.-]+\//i.test(pos[0] || '');
      if (pos[0] && !web && !/^[\w.-]+$/.test(pos[0]) && !/^(https:\/\/|git@)github\.com[/:]/i.test(pos[0])) return this.stop(`Fetches from an address the hub cannot check (${pos[0]})`);
      if (sub === 'clone' && pos[1] && this.outside(pos[1], cwd)) return this.stop(`Clones outside the project folder (${pos[1]})`);
      // A clone from the web is a download: running anything from it later is a stop (M039 4).
      if (sub === 'clone' && pos[0] && /:\/\/|^[\w.-]+@[\w.-]+:/.test(pos[0])) {   // dest: pos[1], else the repo's name
        this.markDown(pos[1] || pos[0].replace(/[\\/]+$/, '').replace(/\.git$/i, '').split(/[\\/:]/).pop(), cwd);
      }
      // git pull REMOTE BRANCH merges BRANCH into the checked-out branch: on main (or a shared branch, or one the hub
      // cannot tell) that is a merge into main, unless BRANCH is the checked-out branch itself (review of decision 64 A).
      if (sub === 'pull' && pos.length >= 2 && (otherRepo || gitTop(cwd))) {   // no repo at all: git pull only fails
        const into = otherRepo ? null : this.branchIn(cwd);
        for (const spec of pos.slice(1)) {
          const [src, dst] = spec.replace(/^\+/, '').split(':').map(x => (x || '').replace(/^(refs\/+)?heads\/+/i, ''));
          if (dst && SHARED_BRANCH.test(dst)) return this.stop(`Pulls into ${dst} (git pull ${spec})`);
          if (src !== into && mergeNeedsOwner({ level: this.level, into })) return this.stop(`Pulls (merges) ${src} into ${into || 'a branch the hub cannot tell'} (git pull)`);
        }
      }
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
    if (sub === 'reflog' && /^(expire|delete|drop)$/.test(rest[0] || '')) this.stop('Rewrites history (reflog)');
    if (sub === 'remote' && rest.length && !(rest.length === 1 && rest[0] === '-v') && rest[0] !== 'get-url') this.stop(`Changes or contacts remotes (git remote ${rest[0]})`);
    // git 2.46+ subcommands (git config set / unset / get / list ...) come before the key (M039 3).
    const cfgSub = sub === 'config' ? rest.find((x, i) => !x.startsWith('-') && !/^(-f|--file|--type|--default|--blob)$/.test(rest[i - 1] || '')) : null;
    const cfgVerb = /^(set|unset|get|list|edit|rename-section|remove-section)$/.test(cfgSub || '') ? cfgSub : null;
    if (sub === 'config' && !flag('--get', '--list', '-l', '--get-all', '--show-origin', '--get-regexp') && !/^(get|list)$/.test(cfgVerb || '')) {
      // Settings that make git run a program, or send pushes somewhere else, are hard stops whatever they are set to
      // (review of decision 64 A); so is writing the user's or the machine's git settings (outside the project).
      const words = cfgVerb ? rest.slice(rest.indexOf(cfgVerb) + 1) : rest;
      const key = words.find((x, i) => !x.startsWith('-') && !/^(-f|--file|--type|--default|--blob|--value|--comment)$/.test(words[i - 1] || ''));
      // -f / --file FILE writes that file: outside the project it is a write outside.
      rest.forEach((x, i) => { const f = /^(-f|--file)$/.test(x) ? rest[i + 1] : /^--file=(.+)$/.exec(x)?.[1]; if (f && this.where(f, cwd) === 'outside') this.stop(`Writes git settings outside the project folder (git config --file ${f})`); });
      if (flag('--global', '--system')) this.stop('Changes git settings outside the project (git config --global or --system)');
      // rename-section can move a harmless setting into one that runs a program (foo.pager -> core.pager).
      else if (cfgVerb === 'rename-section' || flag('--rename-section')) this.stop('Renames a git settings section (it can move settings into ones that run a program)');
      else if (key && GIT_RUNS_CONFIG.test(key)) this.stop(`Sets a git setting that runs a program or redirects pushes (git config ${key})`);
      else this.unsure('Changes git settings', true);
    }
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
    if (!p || /474[78]/.test(p)) return 'bad';
    let path = null;
    if (/^([a-z]:\/|\$env:te?mp|\$\{?env:te?mp)/i.test(s)) path = s;
    else if (/(^|\/)temp\/[^/]/.test(p)) path = join(this.tmp, s.replace(/^.*?(^|\/)temp\//i, ''));
    if (path) {
      const top = this.tempTop(path, this.cwd0);
      if (top === null || top === '') return 'bad';
      return this.ownTemp(path, this.cwd0) ? 'ok' : 'unsure';
    }
    const first = p.split('/')[0];
    if (/^(node|server\.mjs|hub|crux|claude)$/.test(first) || first.length < 5) return 'bad';
    const tracked = [...(this.madeTemp || []), ...(this.tempMade || [])].map(m => basename(m).toLowerCase());
    if (tracked.includes(first) || (this.agent.length >= 3 && first.includes(this.agent))) return 'ok';
    return /^[a-z0-9._-]{6,}$/.test(first) && !/hub|server|node|main|claude/.test(first) ? 'unsure' : 'bad';
  }
  judgePort(p) { const n = Number(p); return Number.isInteger(n) && n > 0 && n < 65536 && !LIVE_PORTS.has(n) ? 'ok' : 'bad'; }

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
    // git rebase -x "CMD" / --exec CMD runs CMD after each commit: read like any command, so a hard stop inside it
    // counts, and the scan reads it (review of decision 64 A).
    rest.forEach((x, i) => {
      const run = /^(-x|--exec)$/.test(x) ? rest[i + 1] : /^--exec=(.*)$/s.exec(x)?.[1] ?? (/^-x(.+)$/s.exec(x)?.[1]);
      if (run == null) return;
      this.unsure(`git rebase runs a command after each commit (${String(run).slice(0, 60)})`);
      this.scanBits?.push(String(run));
      this.innerCommand(String(run), cwd);
    });
    if (rest.some(x => /^(-i|--interactive|-x|--exec(=.*)?|--root|--autostash)$|^-x./.test(x))) return this.unsure(why, true);
    // A branch switched earlier in this command: .git/HEAD does not show it yet, so the hub cannot check it.
    const top = gitTop(cwd);
    if (this.branchUnknown || (top && this.branchSet.has(norm(top)))) return this.unsure(why, true);
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
  // otherRepo: --git-dir / --work-tree named another repo, so the branch checked out is unknown.
  push(rest, cwd = this.projectDir, otherRepo = false) {
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
    // The branch checked out where it runs (the agent's worktree, decision 64 A), after any git checkout earlier in it.
    const here = () => (otherRepo ? null : this.branchIn(cwd));
    const specs = named.length ? named : [here() || '?'];
    for (let spec of specs) {
      if (spec.startsWith('+')) { this.stop(`Force-pushes (${spec})`); continue; }
      let [src, dst = src] = spec.includes(':') ? spec.split(':') : [spec];
      if (spec.includes(':') && !src) { this.stop(`Deletes a remote branch (${spec})`); continue; }
      if (src === CURRENT_BRANCH) src = '?';   // $(git branch --show-current) where the branch could not be read
      if (dst === CURRENT_BRANCH) dst = '?';
      if (/^(head|@)$/i.test(src)) { src = here() || '?'; if (/^(head|@)$/i.test(dst)) dst = src; }
      // git reads heads/main and refs/heads/main as the branch main (review of decision 64 A).
      const d = dst.replace(/^(refs\/+)?heads\/+/i, '');
      if (d === '?' || src === '?') this.stop('git push where the hub cannot tell which branch it pushes');
      else if (/^(main|master)$/i.test(d)) this.stop(`Pushes to ${d}`);
      else if (/[*]|^refs\/(?!heads\/)/.test(spec) || !/^[\w./-]+$/.test(d)) this.stop(`git push of a ref the hub cannot check (${spec})`);
    }
  }

  gh(args, cwd = this.cwd0) {
    const [a, b] = args;
    // gh repo clone OWNER/REPO [DIR]: a download, like git clone from the web (review round 1). Still unsure below.
    if (a === 'repo' && b === 'clone' && args[2] && !args[2].startsWith('-')) {
      const dir = args[3] && !args[3].startsWith('-') ? args[3] : args[2].replace(/[\\/]+$/, '').replace(/\.git$/i, '').split(/[\\/:]/).pop();
      if (this.outside(dir, cwd)) return this.stop(`Clones outside the project folder (${dir})`);
      this.markDown(dir, cwd);
    }
    if (a === 'pr' && /^(create|list|view|status|diff|checks)$/.test(b || '')) return;
    if (a === 'release' && /^(list|view)$/.test(b || '')) return;   // reads the repo's releases on GitHub (R005)
    if (a === 'pr' && b === 'merge') return this.merge('Merges a pull request (gh pr merge)');
    if (a === 'auth' || a === 'secret' || a === 'api') return this.stop(`Touches GitHub credentials or calls its API directly (gh ${a})`);
    this.unsure(`Not sure what this does (gh ${[a, b].filter(Boolean).join(' ')})`);
  }

  node(args, cwd = this.projectDir) {
    const i = args.findIndex(x => /^(-e|-p|--eval|--print)$/.test(x));
    if (i >= 0) return this.script(this.blockText(args[i + 1] || ''));
    const file = args.find(x => !x.startsWith('-'));
    if (file && /^(server|restart)\.mjs$/.test(basename(file))) {
      this.hubPort(args);   // restart.mjs with no port restarts the hub on 4747
      this.hubData(cwd, basename(file) === 'server.mjs');
    }
    // hub/tools/stop-test-hub.mjs <port> stops that port's process tree and refuses 4747.
    if (file && basename(file) === 'stop-test-hub.mjs') {
      const port = Number(args[args.indexOf(file) + 1]);
      if (!Number.isInteger(port) || port <= 0 || port > 65535 || LIVE_PORTS.has(port)) this.stop('Stops a hub without a port other than 4747 and 4748 (the live hub)');
    }
  }

  // A script handed to sh -c or eval, read as its own command; what it finds about addresses stays with it.
  innerCommand(script, cwd = this.cwd0) {
    const saved = { urls: this.urlsHere, local: this.localUrls, files: this.fileUrls };
    this.command(String(script), false, cwd);
    this.urlsHere = saved.urls; this.localUrls = saved.local; this.fileUrls = saved.files;
  }

  // Programs on the read list that can also run commands or write files (follow-up to PR #51). Returns false when the
  // program goes on to the usual checks (a plain read); anything else means this settled it (stopped, sent on, or allowed).
  readerExec(head, args, cwd) {
    if (/^(g|m|n)?awk$/.test(head)) {
      const progs = []; let fromFile = false, i = 0;
      for (; i < args.length; i++) {
        const a = args[i];
        if (a === '--') { i++; break; }
        if (/^(-l|--load)/.test(a)) return void this.stop(`${head} loads an extension library (${a})`);
        if (/^(-f|-E|-i|--file|--exec|--include)$/.test(a)) { fromFile = true; i++; continue; }
        if (/^(-f|-E|-i).|^--(file|exec|include)=/.test(a)) { fromFile = true; continue; }
        if (/^(-e|--source)$/.test(a)) { progs.push(args[++i] || ''); continue; }
        if (/^--source=/.test(a)) { progs.push(a.slice(9)); continue; }
        if (/^-(F|v)$/.test(a)) { i++; continue; }
        if (a.startsWith('-')) continue;   // -F: attached, -vX=1, --posix, ...
        break;
      }
      if (!progs.length && !fromFile) progs.push(args[i] || '');
      const p = progs.join('\n');
      // system(), getline (reads a command's output), print | "cmd", |& (coprocess), print > "file", @load.
      if (/\bsystem\s*\(|\bgetline\b|\|&|@load\b|\bprintf?\b[^;{}]*[|>]/.test(p)) return void this.stop(`${head} runs a command or writes a file from its program (${p.slice(0, 60)})`);
      if (fromFile) return void this.unsure(`${head} runs a program from a file the hub cannot read`, true);
      return true;
    }
    if (head === 'sed') {
      const scripts = []; const files = []; let fromFile = false, inPlace = false;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (/^(-e|--expression)$/.test(a)) { scripts.push(args[++i] || ''); continue; }
        if (/^--expression=/.test(a)) { scripts.push(a.slice(13)); continue; }
        if (/^-e./.test(a)) { scripts.push(a.slice(2)); continue; }
        if (/^(-f|--file)$/.test(a)) { fromFile = true; i++; continue; }
        if (/^-f.|^--file=/.test(a)) { fromFile = true; continue; }
        if (/^(-l|--line-length)$/.test(a)) { i++; continue; }
        if (/^--in-place/.test(a) || (/^-[a-zA-Z]*i/.test(a) && !a.startsWith('--'))) { inPlace = true; continue; }
        if (a.startsWith('-')) continue;
        files.push(a);
      }
      if (!scripts.length && !fromFile) scripts.push(files.shift() ?? '');
      const bad = scripts.find(sedRunsOrWrites);
      if (bad != null) return void this.stop(`sed runs a command or writes a file from its script (${bad.slice(0, 60)})`);
      if (fromFile) return void this.unsure('sed runs a script from a file the hub cannot read', true);
      // sed -i writes every file it is given: each must be inside the project or a temp folder.
      if (inPlace) for (const f of files) {
        if (this.where(f, cwd) === 'outside') this.stop(`Writes outside the project folder (sed -i ${f})`);
        else if (this.where(f, cwd) === 'tmp') this.noteTemp(f, cwd);
      }
      return true;
    }
    if (head === 'rg') {
      const run = args.find(a => /^--(pre|hostname-bin)(=|$)/.test(a));
      if (run) return void this.stop(`rg runs another program on each file (${run})`);
      return false;
    }
    if (head === 'sort') {
      if (args.some(a => /^--compress-program(=|$)/.test(a))) return void this.stop('sort runs another program (--compress-program)');
      args.forEach((a, i) => {   // -o FILE, -oFILE, --output=FILE, and -T / --temporary-directory: what it writes
        const v = /^(-o|-T|--output|--temporary-directory)$/.test(a) ? args[i + 1] : (/^-[oT](.+)$/.exec(a)?.[1] ?? /^--(output|temporary-directory)=(.+)$/.exec(a)?.[2]);
        if (v != null) this.path(v, cwd, { write: true });
      });
      return false;
    }
    if (head === 'xxd' || head === 'uniq') {   // a second file name is where they write
      const pos = args.filter(a => !a.startsWith('-') || a === '-');
      if (pos[1] && pos[1] !== '-') this.path(pos[1], cwd, { write: true });
      return false;
    }
    if (head === 'tree') { args.forEach((a, i) => { if (a === '-o' && args[i + 1]) this.path(args[i + 1], cwd, { write: true }); }); return false; }
    if (head === 'date' && args.some(a => /^(-s|--set)(=|$)/.test(a))) return void this.stop('Changes the system clock (date --set)');
    return false;
  }

  // A merge comes to the owner as a card unless THE MERGE RULE (top of this file) says otherwise. cwd: where a git
  // merge runs, so the branch receiving it is known; none for gh pr merge (it merges into the pull request's base).
  merge(why, cwd = null) {
    const into = cwd && existsSync(cwd) ? this.branchIn(cwd) : null;
    if (mergeNeedsOwner({ level: this.level, into })) this.stop(into ? `${why} into ${into}` : why);
  }

  // git checkout / switch / branch -m earlier in a command change which branch a later bare git push, git merge or
  // rebase works on, though .git/HEAD does not show it yet: remembered per repo (branchIn). A target the hub cannot
  // name (a commit, -, @{-1}, origin/x) leaves the branch unknown, which counts as main for merges and pushes.
  noteBranch(sub, rest, cwd) {
    if (!['checkout', 'switch', 'branch', 'symbolic-ref'].includes(sub)) return;
    const top = gitTop(cwd);
    if (!top) return;
    const set = b => this.branchSet.set(norm(top), b === CURRENT_BRANCH ? this.branchIn(cwd) : b);
    const named = b => (/^[\w./+-]+$/.test(b || '') && !/^(-|HEAD|@.*|origin\/.*|refs\/.*|[0-9a-f]{7,40})$/i.test(b) && !/[~^]/.test(b) ? b : null);
    const pos = rest.filter((x, i) => !x.startsWith('-') && !/^(--conflict|--pathspec-from-file)$/.test(rest[i - 1] || ''));
    if (sub === 'symbolic-ref') {   // git symbolic-ref HEAD refs/heads/X points HEAD at X
      if (pos.length >= 2) set(named(pos[1].replace(/^refs\/heads\//, '')));
      return;
    }
    if (sub === 'branch') {   // git branch -m [OLD] NEW renames the checked-out branch (or OLD); -M is already a stop
      if (!rest.some(x => x === '-m' || x === '--move')) return;
      if (pos.length === 1) set(named(pos[0]));
      else if (pos.length === 2 && pos[0] === this.branchIn(cwd)) set(named(pos[1]));
      return;
    }
    if (rest.includes('--')) return;   // git checkout [ref] -- paths: restores files
    const make = rest.findIndex(x => /^(-b|-B|--orphan|-c|-C|--create|--force-create)$/.test(x));
    if (make >= 0) return set(named(rest[make + 1]));
    if (rest.some(x => /^(--detach|-d|-)$/.test(x))) return set(null);   // detached, or back to the previous branch
    if (!pos.length) return;
    // git checkout X where X is a file or folder here, or git checkout REF FILE..., restores files; main, master and
    // the other shared names always count as the branch.
    const here = x => existsSync(resolve(cwd, x));
    if (sub === 'checkout' && !SHARED_BRANCH.test(pos[0]) && (pos.length > 1 ? pos.slice(1).every(here) : here(pos[0]))) return;
    set(named(pos[0]));
  }

  // exe: the program as written (a project's .venv/Scripts/python is that project's own Python).
  python(args, exe = 'python', cwd = this.projectDir) {
    // -c and -m count after Python's own options too (python -I -c ..., python -X utf8 -m pip ...).
    let k = 0;
    while (k < args.length && /^-[IuBEsSOqvbdRP]+$|^-OO$|^-[WX]$/.test(args[k])) k += /^-[WX]$/.test(args[k]) ? 2 : 1;
    args = args.slice(k);
    const joined = /^-[IuBEsSOqvbdRP]+([cm])$/.exec(args[0] || '');   // -Bc "code", -Im pip: the same as -c, -m
    if (joined) args = [`-${joined[1]}`, ...args.slice(1)];
    if (args[0] === '-c') return this.script(this.blockText(args[1] || ''));
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
  // The text of a block the command took out (a literal here-string handed over as $code): the script itself, so
  // python -c $code and node -e $code are read like any inline script. One the hub cannot read stays unread.
  blockText(code) {
    const m = /^CRUXTEXT\d+$/.exec(String(code));
    if (!m || !this.blocks?.has(m[0])) return code;
    const body = this.blocks.get(m[0]);
    if (body == null) { this.unsure('A script in a here-string with variables the hub cannot read'); return ''; }
    return body;
  }

  // pip (decision 45): a stop at Ask and Auto. Trusted allows it into the project only: a pip that belongs to a
  // virtual environment inside the project or temp folder, or --target into the project. The machine's own pip, and
  // --user, --prefix or --root, install for the whole machine or the user: a stop at every level.
  pip(exe, args, cwd) {
    const sub = args.find(x => !x.startsWith('-')) || '';
    // Reading what is installed, at every level (decision 64 A): pip --version, list, show, freeze, check and help,
    // with no option that asks the package index (list --outdated / --uptodate, an index or proxy).
    if (args.length === 1 && /^(--version|-V)$/.test(args[0])) return;
    // ... and none that writes a file (--log, --log-file, --cache-dir, --report).
    if (/^(list|show|freeze|check|help)$/.test(sub) && !args.some(x => /^(-o|-u|--outdated|--uptodate|-i|--index-url|--extra-index-url|-f|--find-links|--proxy|--trusted-host|--cert|--client-cert|--log|--log-file|--cache-dir|--report)(=|$)/.test(x))) return;
    if (!this.trusted) return this.stop('Installs software (pip)');
    if (/^(list|show|freeze|check|help)$/.test(sub)) return;
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
    if (args.length === 1 && /^(--version|-V)$/.test(args[0])) return;   // uv --version, poetry --version (decision 64 A)
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
  // githubOnly (R005, decision 64 A, every level): the same read, from GitHub only. Every address it is given, and
  // every way the request could go elsewhere (a proxy, --connect-to, --resolve, addresses read from a file), must
  // stay on GitHub; anything else is the network.
  webRead(head, args, cwd, { githubOnly = false } = {}) {
    // curl and wget read settings files found through the environment (CURL_HOME/.curlrc, HOME, XDG_CONFIG_HOME,
    // APPDATA, USERPROFILE, WGETRC): set in front of them, that is -K by another name.
    const home = (head === 'curl' || head === 'wget') && this.envNames(head).find(k => CONFIG_HOME_VARS.test(k));
    if (home) return this.stop(`${head} with ${home.toUpperCase()} set in front: it reads a settings file the hub cannot check`);
    const r = this.webFlags(head, args);
    if (r.unknown.length) return this.stop(`${head} with an option the hub cannot check (${r.unknown[0]})`);
    if (githubOnly) {
      const off = r.addrs.find(a => !githubReadUrl(a));
      if (off || !r.addrs.length) return this.stop(`Reaches the network (${String(off || head).slice(0, 80)})`);
      if (r.routes.length) return this.stop(`Reaches the network through a proxy or another address (${String(r.routes[0]).slice(0, 80)})`);
      if (r.inputs.length) return this.stop(`${head} reads its addresses from a file (${r.inputs[0]})`);
      if (r.headers.length) return this.stop(`${head} to GitHub with a request header (${String(r.headers[0]).slice(0, 60)})`);
    }
    if (r.config) return this.stop(`${head} reads its options from a file or command the hub cannot check (${r.config})`);
    if (r.sends) return this.stop(`Sends data to a website (${head})`);
    if (r.creds) return this.stop(`Passes credentials to a website (${head})`);
    for (const f of r.inputs) if (!['inside', 'tmp'].includes(this.where(f, cwd))) return this.stop(`${head} reads its addresses from a file outside the project (${f})`);
    // Where it saves: every file and folder it names, and the folder it runs in when it saves under the address's
    // own name (wget with no -O, curl -O). Remembered, so running the file later in this command is caught.
    // From GitHub at Auto, a file may land only in this agent's own temp folder (review of decision 64 A): never in
    // the project, where it could be run or committed without anyone looking.
    const ownOnly = where => {
      if (!githubOnly) return true;
      const top = this.tempTop(where, cwd), a = this.abs(where, cwd);
      if (top && typeof a === 'string' && norm(top) !== norm(a) && this.ownTemp(where, cwd)) return true;   // inside a folder, not loose in temp
      this.stop(`Saves a GitHub download outside this agent's own temp folder (${where})`);
      return false;
    };
    for (const o of r.saves) {
      if (o === true || o == null) return this.stop(`${head} saves to a file the hub cannot read`);
      if (o === '-' || /^(\/dev\/null|nul|\$null)$/i.test(o)) continue;
      this.path(o, cwd, { write: true });
      if (!ownOnly(o)) return;
      const a = this.abs(o, cwd);
      if (typeof a === 'string' && !['null', 'outside'].includes(a)) this.downloaded?.add(norm(a));
    }
    if (r.intoHere) {
      const dir = r.dirs.length ? r.dirs.at(-1) : cwd;
      this.path(dir, cwd, { write: true });
      if (!ownOnly(join(String(this.abs(dir, cwd)), 'x'))) return;
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
    // PowerShell splatting (iwr @p): the options sit in a variable the hub cannot read. A hashtable that does not
    // close could swallow what follows it.
    if (fam === 'iwr') for (const p of r.positional) if (/^@\w/.test(p)) r.unknown.push(p);
    for (const a of args) if (openHashtable(a)) r.unknown.push(String(a).slice(0, 40));
    const vals = n => r.flags.filter(f => f.name === n).map(f => f.value);
    const methods = vals('method');
    const out = {
      unknown: r.unknown,
      config: vals('config')[0] ?? null,
      sends: vals('send').length > 0 || methods.some(m => typeof m !== 'string' || !/^(GET|HEAD)$/i.test(m)),
      creds: vals('creds').length > 0 || vals('header').some(h => typeof h !== 'string' || /authorization|cookie|token|api[-_]?key|secret|password/i.test(h)),
      inputs: vals('input').map(String),
      headers: vals('header'),
      saves: [...vals('out'), ...vals('doc')],
      dirs: vals('outdir'),
      urls: [...r.positional, ...vals('url')].map(String).filter(u => /^[a-z]+:\/\//i.test(u))
    };
    if (out.config === true) out.config = '?';
    // curl -H @file reads its headers from a file, like --config: the hub cannot see what it sends. -w @file reads its
    // format from a file, and -w '%output{file}' writes to any file: the same.
    if (fam === 'curl' && !out.config) { const h = vals('header').find(v => typeof v === 'string' && v.startsWith('@')); if (h) out.config = `-H ${h}`; }
    if (fam === 'curl' && !out.config) { const w = writeOutFile(r); if (w) out.config = `-w ${w}`; }
    if (out.dirs.some(d => typeof d !== 'string')) out.saves.push(true);   // a folder option with nothing after it
    // wget saves under the address's name unless -O names the file; curl only with -O (into --output-dir when given).
    out.intoHere = fam === 'wget' ? !vals('doc').length : fam === 'curl' ? vals('remote').length > 0 : false;
    // Every address the request is aimed at (named, --url, -Uri, -Uri:x), and every place it may really go instead:
    // proxies (options and the http_proxy / all_proxy family in the environment), --connect-to and --resolve.
    const strs = l => l.filter(v => typeof v === 'string');
    out.addrs = strs([...r.positional, ...vals('url')]);
    out.routes = [];
    const bad = l => l.some(v => typeof v !== 'string');
    if (bad(vals('url')) || bad(vals('proxy')) || bad(vals('connectto')) || bad(vals('resolve'))) out.unknown.push('an address option with nothing after it');
    out.routes.push(...strs(vals('proxy')));
    for (const v of strs(vals('connectto'))) {   // HOST1:PORT1:HOST2:PORT2, HOST2 empty meaning HOST1
      const f = splitHostFields(v);
      if (f.length !== 4) { out.unknown.push(`--connect-to ${v}`); continue; }
      out.routes.push(`${f[2] || f[0]}:${f[3]}`);
    }
    for (const v of strs(vals('resolve'))) {     // [+]HOST:PORT:ADDR[,ADDR]...
      const f = splitHostFields(v.replace(/^\+/, ''));
      if (f.length < 3) { out.unknown.push(`--resolve ${v}`); continue; }
      for (const a of f.slice(2).join(':').split(',')) out.routes.push(`${/:/.test(a) && !a.startsWith('[') ? `[${a}]` : a}:${f[1]}`);
    }
    for (const [k, v] of this.env()) if (PROXY_VARS.test(k) && v) out.routes.push(String(v));
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

  // An inline script (node -e, python -c, a heredoc into node -) is judged by what it reaches for. The standard XML
  // namespace names (xmlns="http://www.w3.org/2000/svg" in an SVG the script writes) are names, never fetched: they
  // do not count as the network (decision 64 A); a real call (fetch, http.get, require('https')) still does.
  script(code) {
    const reach = String(code).replace(/https?:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|1998\/Math\/MathML|XML\/1998\/namespace|2000\/xmlns\/?)(?![\w./-])/g, 'XMLNS');
    if (/\b(fetch|https?|net|dgram|tls|http2|XMLHttpRequest|WebSocket|urllib|requests|socket)\b/.test(reach)) this.stop('An inline script that could reach the network');
    if (/\b(child_process|execSync|execFileSync|spawn|spawnSync|exec\(|execFile|subprocess|os\.system|os\.popen)\b/.test(code)) this.unsure('An inline script that runs other programs');
    if (/\b(rmSync|unlinkSync|rmdirSync|rm\(|unlink\(|rmdir\(|os\.remove|os\.unlink|shutil\.rmtree)\b/.test(code)) this.scriptDeletes(code);
    if (/\b(stopTree|pidsOnPort|process\.kill|taskkill)\b/.test(code) && /474[78]/.test(code)) this.stop("An inline script that stops processes and names the live hub's port (4747 or 4748)");
    if (/process\.env|os\.environ|homedir\(\)|expanduser/.test(code)) this.stop('An inline script that reads environment variables or the home folder');
    // Reading anywhere is fine; a script that writes, given a real path outside ("C:/x", "../x", not "\n"), is not.
    if (/\b(writeFile|appendFile|mkdir|rename|copyFile|cp|createWriteStream|symlink|truncate)(Sync)?\s*\(|open\([^)]*['"][wa]/.test(code)) {
      for (const m of code.matchAll(/['"`]((?:[a-z]:[\\/]|\/)[\w.~ -][^'"`\n]*|\.\.[\\/][^'"`\n]*)['"`]/gi)) {
        if (this.where(m[1], this.cwd0) === 'outside') this.stop(`An inline script that writes, with a path outside the project folder: ${m[1]}`);
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
    this.deletes(targets, this.cwd0, `an inline script deletes ${targets.join(', ')}`);
  }
}

// True when a sed script runs a command or writes a file: the e command or the s///e flag (GNU sed runs the text as
// a shell command), the w / W commands or the s///w flag (write a file). Text after a, i and c, and regular
// expressions, are skipped so their letters do not count.
function sedRunsOrWrites(script) {
  let s = String(script);
  // s/re/repl/flags and y/a/b/ with any delimiter: keep only s's flags.
  s = s.replace(/(^|[;\n{}!\s\d$/,])s(.)((?:\\.|(?!\2)[^\n])*)\2((?:\\.|(?!\2)[^\n])*)\2([^;\n}]*)/g, (all, pre, d, re, rep, flags) => `${pre}\u0001${flags.trim()}\u0002`);
  s = s.replace(/(^|[;\n{}!\s\d$/,])y(.)((?:\\.|(?!\2)[^\n])*)\2((?:\\.|(?!\2)[^\n])*)\2/g, '$1Y');
  if (/\u0001[^\u0002]*[ew]/.test(s)) return true;   // s///e runs the result; s///w writes it to a file
  s = s.replace(/\u0001[^\u0002]*\u0002/g, 'S');
  // Addresses /re/ and \cREc become A; a, i and c take the rest of the line as text.
  s = s.replace(/\/((?:\\.|[^/\n])*)\//g, 'A').replace(/\\(.)((?:\\.|(?!\1).)*)\1/g, 'A');
  s = s.replace(/(^|[;\n{])(\s*(?:A|\d+|\$)?\s*(?:,\s*(?:A|\d+|\$|[+~]\d+))?\s*!?\s*)[aic](\\?\s|\\\n)[^\n]*/g, '$1$2T');
  return /(^|[;\n{}])\s*(?:A|\d+|\$)?\s*(?:,\s*(?:A|\d+|\$|[+~]\d+))?\s*!?\s*[ewW](\s|;|$|\n|})/.test(s);
}

// The variables curl and wget read their settings files through, named anywhere in a command: as a shell name
// (HOME, in capitals: bash names are case-sensitive, so a path like /home/x does not count), as $env:home in
// PowerShell or %home% in cmd (both case-insensitive). The name found, or null.
const CONFIG_HOME_NAMES = 'HOME|USERPROFILE|APPDATA|CURL_HOME|XDG_CONFIG_HOME|WGETRC|SYSTEMWGETRC|HOMEDRIVE|HOMEPATH';
function configHomeNamed(text) {
  const m = new RegExp(`(?:^|[^\\w$:%])\\$?\\{?(${CONFIG_HOME_NAMES})(?!\\w)`).exec(text)
    || new RegExp(`\\$env:(${CONFIG_HOME_NAMES})(?!\\w)|%(${CONFIG_HOME_NAMES})%`, 'i').exec(text);
  return m ? (m[1] || m[2]).toUpperCase() : null;
}

// Programs that only run the program after them (timeout 60 X, nohup X, command X, sudo X, busybox X, nice -n 5 X,
// stdbuf -oL X, time X, exec X): the index in w of the program that really runs, from k.
const WRAPPERS = /^(timeout|nohup|command|builtin|exec|sudo|doas|busybox|nice|ionice|stdbuf|time|chronic|unbuffer|setsid|winpty)$/;
function unwrap(w, k) {
  for (let guard = 0; guard < 8 && WRAPPERS.test(String(w[k] || '').toLowerCase()) && k < w.length - 1; guard++) {
    const name = String(w[k]).toLowerCase();
    k++;
    // Their own options, and the values those take (sudo -u root, nice -n 5, timeout -s KILL 60, stdbuf -o L).
    while (k < w.length - 1 && /^-/.test(w[k])) k += /^-(u|g|n|s|k|o|e|i|c|p|C|h)$/.test(w[k]) ? 2 : 1;
    if (name === 'timeout' && /^\d+(\.\d+)?[smhd]?$/.test(w[k] || '') && k < w.length - 1) k++;   // the duration
  }
  return k;
}

// curl -w / --write-out given a format read from a file (@file) or one that writes to a file (%output{...}): the
// offending value, else null.
function writeOutFile(r) {
  const w = r.flags.find(f => (f.key === 'w' || f.key === 'write-out') && (typeof f.value !== 'string' || f.value.startsWith('@') || /%output/i.test(f.value)));
  return w ? String(w.value ?? '(nothing)').slice(0, 60) : null;
}

// The index of the } that closes the { at s[open], counting braces outside quotes only ('{' and "{" are text);
// -1 when it never closes.
function hashtableEnd(s, open) {
  let depth = 0, q = null;
  for (let j = open; j < s.length; j++) {
    const d = s[j];
    if (q) { if (d === q && !(q === '"' && s[j - 1] === '`')) q = null; continue; }
    if (d === "'" || d === '"') { q = d; continue; }
    if (d === '{') depth++;
    else if (d === '}' && --depth === 0) return j;
  }
  return -1;
}
// True when a word written as a PowerShell hashtable (@{...}) does not close.
const openHashtable = w => String(w).startsWith('@{') && hashtableEnd(String(w), 1) < 0;

// Every file and folder on disk a glob path (already made absolute) matches, segment by segment: * ? and [...] in any
// part, dot files included, and .. for a part that starts with a dot (some shells let .* reach the folder above).
// null when it would list too many to check.
export function globMatches(pattern, cap = 5000) {
  const segs = String(pattern).replace(/\\/g, '/').split('/');
  let bases = [segs[0] === '' ? '/' : `${segs[0]}/`];
  for (const seg of segs.slice(1)) {
    if (!seg) continue;
    if (!/[*?[]/.test(seg)) { bases = bases.map(b => join(b, seg)); continue; }
    const re = globRegex(seg), next = [];
    for (const b of bases) {
      let names = [];
      try { names = readdirSync(b); } catch { }
      if (seg.startsWith('.')) names.push('..');
      for (const n of names) if (re.test(n)) next.push(join(b, n));
      if (next.length > cap) return null;
    }
    bases = next;
    if (!bases.length) return [];
  }
  return bases;
}
function globRegex(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[' && seg.indexOf(']', i + 2) > i) {
      const j = seg.indexOf(']', i + 2);
      const cls = seg.slice(i + 1, j).replace(/^!/, '^').replace(/[\\\]]/g, '\\$&');
      re += `[${cls}]`; i = j;
    } else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  try { return new RegExp(`^${re}$`, 'i'); } catch { return /^.*$/; }   // a class the hub cannot read: anything
}
// Bash {a,b} lists in a word, opened (one level at a time, at most 64 words): ~/.{ssh,aws}/x -> ~/.ssh/x, ~/.aws/x.
function braceWords(word, depth = 0) {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(word);
  if (!m || depth > 3) return [word];
  const out = m[1].split(',').flatMap(x => braceWords(word.slice(0, m.index) + x + word.slice(m.index + m[0].length), depth + 1));
  return out.length > 64 ? [word] : out;
}

// The index of the ) that closes the ( at s[open], with quoted text skipped; -1 when it never closes.
function balanced(s, open) {
  let depth = 0, q = null;
  for (let j = open; j < s.length; j++) {
    const d = s[j];
    if (q) { if (d === q) q = null; continue; }
    if (d === "'" || d === '"') { q = d; continue; }
    if (d === '(') depth++;
    else if (d === ')' && --depth === 0) return j;
  }
  return -1;
}

// A PowerShell command split into its statements (at ; and line ends) or, with sep '|', a pipeline into its stages,
// only where nothing is open: no quotes, here-strings, ( ), { } or [ ].
function psStatements(text, sep = ';') {
  const s = String(text || ''), out = [];
  let cur = '', depth = 0, q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (q.length === 2) { if (c === '@' && s[i - 1] === q[1] && /[\r\n]/.test(s[i - 2] || '')) q = null; continue; }
      if (q === '"' && c === '`') { cur += s[++i] ?? ''; continue; }
      if (c === q) { if (s[i + 1] === q) cur += s[++i]; else q = null; }
      continue;
    }
    if (c === '@' && (s[i + 1] === "'" || s[i + 1] === '"') && /[\r\n]/.test(s[i + 2] || '')) { q = '@' + s[i + 1]; cur += c + s[++i]; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth = Math.max(0, depth - 1);
    const end = depth === 0 && (sep === '|' ? c === '|' && s[i + 1] !== '|' && s[i - 1] !== '|' : c === ';' || c === '\n' || c === '\r');
    if (end) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// R005 "GitHub fetches are fine" (decision 64 A): an https address on GitHub's own hosts for repos, release files and
// raw files, with no user name, password or port in it. github.com.evil.example and github.com@evil.example are not.
const GITHUB_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'codeload.github.com']);
export function githubReadUrl(word) {
  const s = String(word || '');
  if (!/^https:\/\//i.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && GITHUB_HOSTS.has(u.hostname.toLowerCase()) && !u.username && !u.password && u.port === '';
  } catch { return false; }
}

// "localhost:4791:[::1]:4747" -> ['localhost', '4791', '[::1]', '4747']: colon-separated fields, brackets kept whole.
function splitHostFields(v) {
  const out = []; let cur = '', br = false;
  for (const c of String(v)) {
    if (c === '[') br = true; else if (c === ']') br = false;
    if (c === ':' && !br) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
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

// PowerShell operators: a ( after one of them starts an expression of its own, not a command's argument.
const PS_OPERATORS = /^-[ic]?(eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split|join|is|isnot|as|f)$|^-(and|or|xor|not|band|bor|bxor|bnot|shl|shr)$|^[=+\-*/%,!]$|[=+\-*/%,!(]$/i;
// Statement keywords whose ( is their own syntax: foreach ($x in ...), if (...), switch (...).
const PS_KEYWORDS = /^(foreach|for|if|elseif|while|until|switch|catch|trap|param|function|filter|return|throw|do|else|try|finally)$/i;
// True when a ( or @( met after `cur` (the part so far) is an argument of the command in it: git push origin ("main"),
// git @("branch","-D","main"). False at the start of a statement, after an operator or an assignment, and after
// keywords like foreach and if (decision 64 A, review: such an argument is never a statement of its own).
function psArgument(cur) {
  const words = cur.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  if (PS_KEYWORDS.test(words[0])) return false;
  return !PS_OPERATORS.test(words.at(-1));
}
// The index of the ) closing the ( at s[open], with quotes skipped (PowerShell rules); -1 when it never closes.
function psGroupEnd(s, open) {
  let depth = 0, q = null;
  for (let j = open; j < s.length; j++) {
    const d = s[j];
    if (q) { if (d === q) q = null; else if (q === '"' && d === '`') j++; continue; }
    if (d === "'" || d === '"') { q = d; continue; }
    if (d === '(') depth++;
    else if (d === ')' && --depth === 0) return j;
  }
  return -1;
}

// Split at ; && || | & newlines and PowerShell { } ( ) blocks, never inside quotes.
// withOps: each part comes back as { text, op, groups } where op is the separator just before it ('|' for a pipe)
// and groups lists the text inside PowerShell ( ) or @( ) arguments the part holds (psArgument).
export function splitParts(s, ps = false, withOps = false) {
  const out = []; let cur = '', q = null, op = '', nextOp = '', ht = 0, groups = [];
  const prev = i => s[i - 1] ?? ' ';
  const push = () => { out.push({ text: cur.trim(), op, groups }); cur = ''; groups = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q && (q === "'" || prev(i) !== '\\')) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    // A PowerShell hashtable @{ a = 1; b = 2 } is one value: its ; and } do not end the command, so the options
    // after it (-Method Post) stay with the command they belong to.
    if (ps && c === '{' && prev(i) === '@') { ht++; cur += c; continue; }
    if (ht > 0) { if (c === '}') ht--; cur += c; continue; }
    if (c === '\\' && !ps && s[i + 1] === '\n') { i++; continue; } // line continuation
    // PowerShell ( ... ) or @( ... ) after a command word is that command's argument: kept in the part whole, its
    // inside noted (groups) so the hub reads it as a command too and counts the argument as unreadable.
    if (ps && (c === '(' || (c === '@' && s[i + 1] === '(')) && /[\s,=]/.test(prev(i)) && psArgument(cur)) {
      const open = c === '@' ? i + 1 : i, end = psGroupEnd(s, open), stop = end < 0 ? s.length - 1 : end;
      groups.push(s.slice(open + 1, end < 0 ? s.length : end));
      cur += s.slice(i, stop + 1); i = stop; continue;
    }
    // PowerShell's @( ... ) (an array of what the commands inside return) is read like ( ... ) (M038 c11).
    if (ps && c === '@' && s[i + 1] === '(' && /[\s|;=(,]/.test(prev(i))) continue;
    const brace = (c === '{' && /[\s|(;]/.test(prev(i))) || (c === '}' && /[\s|);]|^$/.test(s[i + 1] ?? '')) || c === '(' && /[\s|;=]/.test(prev(i) === '@' && ps ? ' ' : prev(i)) || c === ')';
    if (c === '\n' || c === '\r' || c === ';' || c === '|' || c === '&' || brace) {
      if (c === '&' && /[<>]/.test(prev(i))) { cur += c; continue; } // 2>&1
      if (c === '&' && s[i + 1] === '>') { cur += c; continue; }       // &> file, &>> file: a redirection, not & then >

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
// ps: a PowerShell hashtable @{ a = 'b'; c = '{' } is one word, kept as written (quotes and all); its braces are
// counted with quotes respected, and one that does not close is marked unbalanced.
export function tokens(part, ps = false) {
  const out = []; let cur = null;
  const push = () => { if (cur) out.push(cur); cur = null; };
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (/\s/.test(c)) { push(); continue; }
    if (ps && !cur && c === '@' && part[i + 1] === '{') {
      const end = hashtableEnd(part, i + 1);
      const text = part.slice(i, end < 0 ? part.length : end + 1);
      out.push({ text, quoted: true, vars: /\$/.test(text), hashtable: true, unbalanced: end < 0 });
      i = end < 0 ? part.length : end;
      continue;
    }
    if (c === '>' || c === '<') {   // a redirection is its own word, even when written hard against a file name
      let op = c;
      if (cur && !cur.quoted && c === '>' && /&$/.test(cur.text)) {   // &> file, also written hard against a word
        cur.text = cur.text.slice(0, -1); if (cur.text) push(); else cur = null; op = '&>';
      } else if (cur && !cur.quoted && /^\d$/.test(cur.text)) { op = cur.text + c; cur = null; } else push();   // 2>

      if (part[i + 1] === c) op += part[++i];
      if (part[i + 1] === '&' && /\d/.test(part[i + 2] || '')) { op += part.slice(i + 1, i + 3); i += 2; }
      out.push({ text: op, quoted: false, vars: false, op: true });
      continue;
    }
    cur ||= { text: '', quoted: false, vars: false };
    // PowerShell 'pu'+'sh' is text joined at run time, not one literal word (built: review round 2).
    if (ps && ((c === '+' && cur.quoted) || ((c === "'" || c === '"') && cur.text.endsWith('+')))) cur.built = true;
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

// The folder holding the .git (a folder, or a worktree's .git file) of the repo that holds `dir`; null if none.
export function gitTop(dir) {
  let d = resolve(String(dir));
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(d, '.git'))) return d;
    const up = resolve(d, '..');
    if (up === d) return null;
    d = up;
  }
  return null;
}

// R003: reads are always allowed, anywhere, except secrets. True when a request names a secret or credential
// (~/.ssh, .env files, ~/.crux-hub keys, credential stores) or reads an environment variable.
// This gate lets the hub answer plain reads without the full check, so it is stricter than classify: all of
// ~/.crux-hub counts (the voice folder too, which classify reads on its resolved path), a glob is matched against the
// files it would really read from cwd (the folder the agent runs in), and a glob or ../ after a cd goes to classify,
// which follows the cd (review of decision 64 A).
const SECRET_STRICT = trimmed(/(^|\/)(\.env(\.[\w-]+)?|\.npmrc|\.netrc|\.git-credentials|\.pypirc|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.?credentials(\.json)?|secrets?(\.\w+)?|vapid\.json|[\w-]*token\.json)$|(^|\/)(\.ssh|\.aws|\.gnupg|\.crux-hub)(\/|$)|\.(pem|key|pfx|p12)$|(^|\/)env:/i);
// ---------- recursive reads near secrets (M039 5) ----------
// Folders whose every file is a secret. A recursive read or copy rooted at the home folder, above it, or at a folder
// that holds one of these reads them all.
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.crux-hub', '.credentials.json'];   // and ~/.claude's login file (review round 1)
export function secretTree(dir, home = homedir()) {
  if (typeof dir !== 'string' || ['null', 'outside', 'tmp'].includes(dir)) return false;
  const d = norm(dir), h = norm(longPath(home) ?? home);
  if (d === h || h.startsWith(`${d}/`)) return true;
  return SECRET_DIRS.some(n => existsSync(join(dir, n)));
}
// Programs that can read or copy a whole folder tree, whatever their options are called (the shortcut gate sends
// them to the full check when they name the home folder or above; review round 1).
const DEEP_PROGRAMS = /(^|[\s;&|({])(grep|egrep|fgrep|rg|git|find|tar|bsdtar|zip|7z|7za|robocopy|xcopy|cp|copy|copy-item|cpi|get-childitem|gci|dir|select-string|sls|compress-archive|findstr)(\.exe)?(?=[\s;&|)}]|$)/i;

// The words of a search command that are its search pattern, not a path: searching for ".crux-hub" is not reading
// it (orchestrator-7, 2026-11-15: four cards for grep -n "homedir\|\.crux-hub" test/x.mjs). grep, egrep, fgrep,
// rg, git grep, findstr, Select-String. Indexes into w (words, head first, VAR=value words allowed in front).
const SEARCH_VALUED = {
  grep: /^(-f|-m|-A|-B|-C|-d|-D|--file|--max-count|--context|--after-context|--before-context|--directories|--devices|--include|--exclude|--exclude-dir|--label|--color|--colour|--binary-files)$/,
  rg: /^(-f|-m|-A|-B|-C|-g|-t|-T|-j|-M|-r|-E|--file|--max-count|--context|--after-context|--before-context|--glob|--iglob|--type|--type-not|--threads|--max-columns|--max-depth|--max-filesize|--sort|--sortr|--color|--colors|--encoding|--engine|--replace|--pre|--pre-glob|--ignore-file|--path-separator|--type-add|--context-separator|--field-match-separator)$/
};
// Short options that take a value (besides -e, the pattern, and -f, a patterns file).
const SHORT_VALUED = { grep: 'mABCdD', rg: 'mABCgtTjMrE', 'git-grep': 'mABCO' };
export function patternWords(w) {
  const out = new Set();
  let k = 0; while (k < w.length - 1 && /^\w+=/.test(w[k])) k++;
  let head = basename(String(w[k] || '').replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
  let i = k + 1;
  if (head === 'git') {
    while (i < w.length && /^-/.test(w[i])) i += /^(-C|-c)$/.test(w[i]) ? 2 : 1;
    if (w[i] !== 'grep') return out;
    head = 'git-grep'; i++;
  }
  if (/^(grep|egrep|fgrep|rg|git-grep)$/.test(head)) {
    const valued = head === 'rg' ? SEARCH_VALUED.rg : SEARCH_VALUED.grep;
    const shortValued = SHORT_VALUED[head] || SHORT_VALUED.grep;
    let explicit = false, first = -1;
    for (let j = i; j < w.length; j++) {
      const a = String(w[j]);
      if (a === '--') { if (first < 0 && !explicit) first = j + 1; break; }
      if (a.startsWith('--')) {
        // Long options by any unique start, as GNU grep takes them (--reg=x is --regexp=x; review round 2).
        const name = a.split('=')[0];
        if (name.length >= 5 && '--regexp'.startsWith(name)) { if (a.includes('=')) out.add(j); else { out.add(j + 1); j++; } explicit = true; continue; }
        if (name === '--file') { explicit = true; if (!a.includes('=')) j++; continue; }   // patterns read from a file: that file is a path
        if (head === 'rg' && /^--(files|type-list)$/.test(a)) explicit = true;   // no pattern at all: every word is a path
        if (!a.includes('=') && valued.test(a)) j++;
        continue;
      }
      if (a === '-') continue;   // standard input
      if (/^-./.test(a)) {
        // A cluster of short options (-ie<pat>, -we<pat>, -n1e <pat>): the first one that takes a value takes the rest
        // of the word, or the next word when nothing is left (review round 2).
        for (let c = 1; c < a.length; c++) {
          const ch = a[c], rest = a.slice(c + 1);
          if (ch === 'e') { if (rest) out.add(j); else { out.add(j + 1); j++; } explicit = true; break; }
          if (ch === 'f') { explicit = true; if (!rest) j++; break; }   // the patterns file is a path
          if (shortValued.includes(ch)) { if (!rest && !(head === 'git-grep' && ch === 'O')) j++; break; }   // git grep -O's value is attached only
        }
        continue;
      }
      if (first < 0) first = j;
    }
    if (!explicit && first >= 0) out.add(first);
  } else if (head === 'findstr') {
    // /g:file reads the patterns from a file: every other word is a file to search (review round 2).
    if (!w.some((a, j) => j > k && /^\/g:/i.test(a))) {
      const c = w.findIndex((a, j) => j > k && /^\/c:/i.test(a));
      if (c >= 0) out.add(c);
      else { const j = w.findIndex((a, j2) => j2 > k && !String(a).startsWith('/')); if (j >= 0) out.add(j); }
    }
  } else if (/^(select-string|sls)$/.test(head)) {
    // PowerShell takes a parameter by any unique start: -Lit is -LiteralPath, -Patt is -Pattern (-Pat is ambiguous with
    // -Path and fails), -Inc is -Include (review round 2). -Name:value carries its value in the same word.
    const ps = (a, full, min) => { const n = a.slice(1).split(':')[0].toLowerCase(); return n.length >= min && full.startsWith(n); };
    let named = false, first = -1;
    for (let j = i; j < w.length; j++) {
      const a = String(w[j]);
      if (!a.startsWith('-')) { if (first < 0) first = j; continue; }
      const joined = a.includes(':');
      if (ps(a, 'pattern', 4)) { out.add(joined ? j : j + 1); named = true; if (!joined) j++; continue; }
      if (ps(a, 'path', 4) || ps(a, 'literalpath', 3) || /^-(lp|pspath)(:|$)/i.test(a) || ps(a, 'include', 3) || ps(a, 'exclude', 2)
        || ps(a, 'encoding', 2) || ps(a, 'context', 2) || ps(a, 'culture', 2) || ps(a, 'inputobject', 3)) { if (!joined) j++; continue; }
    }
    if (!named && first >= 0) out.add(first);
  }
  return out;
}
// A Grep file filter that names a secret once its wildcards are dropped: .env*, *.pem, **/.ssh/**, *token.json.
// *.json and * name none (a filter only narrows what Grep reads under its folder).
export function grepGlobSecret(glob) {
  if (!glob) return false;
  return braceWords(String(glob)).some(g => {
    const bare = g.replace(/\[[^\]]*\]|[*?]/g, '');
    return SECRET_STRICT.test(norm(bare)) || bare.split('/').some(seg => seg && SECRET_STRICT.test(norm(seg)));
  });
}

export function touchesSecrets(tool, input = {}, cwd = null) {
  // ~, ~user, Git Bash's /c/..., and \\?\ or //?/ device forms, read as the plain path (review round 1).
  const full = v => {
    let s = homeAndDevice(String(v).replace(/^~(?=[\\/]|$)/, homedir()));
    const m = /^\/([a-z])(\/.*)?$/i.exec(s);
    if (m && process.platform === 'win32') s = `${m[1]}:${m[2] || '/'}`;
    return isAbsolute(s) ? resolve(s) : resolve(cwd || '.', s);
  };
  const globHits = v => {
    if (!cwd || !/[*?[]/.test(v)) return false;
    const found = globMatches(full(v));
    return found === null || found.some(m => SECRET_STRICT.test(norm(m)));
  };
  // A short name (CRUX-H~1, SSH~1) is checked as the long name it stands for; one the hub cannot expand is a
  // secret (M039 2). Words that name no file (git's HEAD~1) stay as they are.
  const shortSecret = v => {
    if (!SHORT_PART.test(String(v))) return false;
    const long = longPath(full(v));
    return long === null || SECRET_STRICT.test(norm(long));
  };
  // Paths are also tested in their plain form (device prefix dropped, /c/ mapped), short names expanded.
  const named = v => SECRET_STRICT.test(norm(v)) || opaqueDevice(v) || SECRET_STRICT.test(norm(full(v))) || shortSecret(v);
  // A word read as a search pattern that also names a file on disk keeps its secret check: if the hub misread
  // which word is the pattern, that word is a file the search reads (review round 2).
  const onDisk = v => { try { const f = full(v); const l = longPath(f); return l === null || existsSync(l); } catch { return false; } };
  if (!/^(Bash|PowerShell)$/.test(tool)) {
    // Grep's pattern is the text it searches for, not a path: searching for ".crux-hub" is not reading it.
    const paths = [input.file_path, input.path, input.notebook_path, tool === 'Grep' ? null : input.pattern];
    if (paths.some(v => v && (named(v) || (v !== input.pattern && globHits(String(v)))))) return true;
    // Grep reads every file under its folder: rooted at the home folder or above it, that is ~/.ssh and ~/.crux-hub
    // (M039 5); and a file filter that names a secret (.env*, *.pem, **/.ssh/**) aims at one (follow-up to M039).
    if (tool === 'Grep') return secretTree(input.path ? (longPath(full(input.path)) ?? full(input.path)) : (cwd || '.')) || grepGlobSecret(input.glob);
    return false;
  }
  const cmd = String(input.command || '');
  if (/\$env:(?!te?mp\b)/i.test(cmd) || /\b(printenv|get-credential|get-secret)\b/i.test(cmd) || /(^|[\s;&|])env(\s|$)/.test(cmd)) return true;
  const parts = splitParts(cmd, tool === 'PowerShell');
  const moves = parts.some(p => /^(cd|pushd|chdir|set-location|sl|push-location)(\s|$)/i.test(p.trim()));
  // A program that can read or copy a whole tree (any spelling of its recursive option: grep --rec, --dir=recurse,
  // gci -s), naming the home folder or a folder above a secret one: the full check decides (M039 5, review round 1).
  const deep = DEEP_PROGRAMS.test(cmd);
  for (const part of parts) {
    const ws = tokens(part);
    const pat = patternWords(ws.map(x => x.text));
    for (const [i, w] of ws.entries()) {
      if (pat.has(i)) {
        if (w.vars && /\$(?!_|psitem|null|true|false|\?|lastexitcode|\(|env:te?mp\b)[\w{]/i.test(w.text.replace(TEMP_VARS, ''))) return true;
        if (!w.text.startsWith('-') && named(w.text) && onDisk(w.text)) return true;
        continue;
      }
      // --file=x, and PowerShell's -Path:x / -Lit:x, name x too (review round 2).
      const v = /^--?[\w-]+=(.+)$/.exec(w.text)?.[1] ?? (tool === 'PowerShell' ? /^-[\w-]+:(.+)$/.exec(w.text)?.[1] : null) ?? w.text;
      if (named(v) || braceWords(v).some(x => SECRET_STRICT.test(norm(x)))) return true;
      if (deep && !/^-/.test(v) && /^(~|[\\/]|[a-z]:|\.\.?$|\.\.[\\/])/i.test(v) && secretTree(longPath(full(v)) ?? full(v))) return true;
      if (/[*?[]/.test(v) && (moves || !cwd || globHits(v))) return true;
      if (moves && /(^|[\\/])\.\.([\\/]|$)/.test(v)) return true;
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
      `UNCLEAR requests (including commands the hub can't read in full) come to the orchestrator (answer_permission), which allows them if they are contained and part of the task, and otherwise escalates; {{who}} gets them after the hub's timeout (5 minutes unless {{who}} changes it). When unsure, escalate.`
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
