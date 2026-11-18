// Which scripts a worker's command runs, and whether each is "committed and unchanged from main" (decision 67's Auto gate in
// hub.mjs). The gate's routing is all this serves (decision 73): a command whose scripts are all committed, with everything
// they load and start, stays allowed at Auto at once; any other goes to the permission check (On) or is shadow-read (Shadow).
// A script the hub cannot resolve to a file makes the command "unread". The text of an uncommitted or changed file in the chain
// is sent with the request (permission-check.mjs scriptTexts), capped; nothing here holds an allow back or scans it for words.
//
// It FAILS CLOSED. A command counts as read only when every part of it is a shape this file positively recognises and
// has resolved. A program it does not know that carries an interpreter or a script file anywhere in its words is
// unread; so is an option it does not know on an interpreter, a quote it cannot place, an environment variable that
// changes what a program loads, a script it cannot find. parseCommand() reads the command text only (no files);
// scriptsFor() then looks at the files.
import { execFile } from 'node:child_process';
import { existsSync, statSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, basename, resolve, join, isAbsolute, relative } from 'node:path';
import { tmpdir } from 'node:os';

export const MAX_SCRIPTS = 8;                        // more scripts than this in one command: not listed, so never allowed at once
const MAX_NEST = 4;                                  // a command inside a command inside a package script ...
const MAX_FILES = 60, MAX_FILE_BYTES = 1024 * 1024;  // following imports of a committed script

const SCRIPT_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|sh|bash|ps1|psm1|bat|cmd|rb|pl|php|lua)$/i;
const DYN = '\u0001';                                // stands in for $(...) and `...` in a word

// ---------- reading the command: quotes, substitutions, heredocs ----------
// The text between $( and its matching ), as the shell would take it. -1: never closed.
function matchParen(t, i, shell) {
  let depth = 1, q = null;
  for (let j = i; j < t.length; j++) {
    const c = t[j];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (q === '"') { if (c === '\\' && shell === 'bash') { j++; continue; } if (c === '"') q = null; continue; }
    if (c === "'" && shell !== 'cmd') q = "'";
    else if (c === '"') q = '"';
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}
// Heredoc bodies are data (or the code of the command that reads them): they come out of the command text, in order of
// the markers, so a quote inside one cannot hide what follows it.
function stripHeredocs(text, why) {
  const lines = text.split('\n'), out = [], bodies = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    for (const m of line.matchAll(/(?<!<)<<(-?)[ \t]*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_]\w*))/g)) {
      const tag = m[2] || m[3] || m[4], body = [];
      let j = i + 1;
      for (; j < lines.length; j++) { if ((m[1] ? lines[j].replace(/^\t+/, '') : lines[j]) === tag) break; body.push(lines[j]); }
      if (j >= lines.length) { why.push('a heredoc that never ends'); bodies.push(body.join('\n')); i = lines.length; break; }
      bodies.push(body.join('\n'));
      i = j;
    }
  }
  return { text: out.join('\n'), bodies };
}
// Words per command, split as the shell splits them: bash (no escapes in '...', backslash outside and in "..."), PowerShell
// (backslash is a plain character; '' and "" are a quote; a backtick is an escape the hub does not follow, so it is unread),
// cmd (only "..." quotes; ^ is an escape the hub does not follow). $(...) and `...` (bash) become DYN in the word and their
// text goes to subs.
export function lex(raw, shell = 'bash') {
  const why = [], subs = [];
  let text = String(raw ?? '').replace(/\r\n?/g, '\n'), bodies = [];
  if (shell === 'bash') ({ text, bodies } = stripHeredocs(text, why));
  if (shell === 'powershell' && text.includes('`')) why.push('it has a backtick, an escape the hub does not follow in PowerShell');
  if (shell === 'cmd' && text.includes('^')) why.push('it has a ^, an escape the hub does not follow in cmd');
  if (shell === 'bash' && /\$['"]/.test(text)) why.push('it uses $\'...\' quoting, which the hub does not follow');
  const segs = [];
  let words = [], cur = '', has = false, q = null;
  const endWord = () => { if (has) words.push(cur); cur = ''; has = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  const sub = (i, open) => {   // a substitution starting at text[i]; returns the index to carry on from
    if (open === '(') {
      const j = matchParen(text, i + 2, shell);
      if (j < 0) { why.push('a $( that is never closed'); return text.length; }
      subs.push(text.slice(i + 2, j)); cur += DYN; has = true; return j;
    }
    let k = i + 1;
    while (k < text.length && text[k] !== '`') k += text[k] === '\\' ? 2 : 1;
    if (k >= text.length) { why.push('a backtick that is never closed'); return text.length; }
    subs.push(text.slice(i + 1, k)); cur += DYN; has = true; return k;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q === "'") {
      if (c === "'") { if (shell === 'powershell' && n === "'") { cur += "'"; i++; } else q = null; } else cur += c;
      continue;
    }
    if (q === '"') {
      if (shell === 'bash' && c === '\\') { if (n && '"\\$`'.includes(n)) { cur += n; i++; } else if (n === '\n') i++; else cur += c; continue; }
      if (c === '"') { if (shell !== 'bash' && n === '"') { cur += '"'; i++; } else q = null; continue; }
      if (c === '$' && n === '(' && shell !== 'cmd') { i = sub(i, '('); continue; }
      if (c === '`' && shell === 'bash') { i = sub(i, '`'); continue; }
      cur += c;
      continue;
    }
    if (c === '\\' && shell === 'bash') { has = true; if (n === undefined) cur += c; else if (n === '\n') { i++; has = cur !== ''; } else { cur += n; i++; } continue; }
    if (c === "'" && shell !== 'cmd') { q = "'"; has = true; continue; }
    if (c === '"') { q = '"'; has = true; continue; }
    if (c === '$' && n === '(' && shell !== 'cmd') { i = sub(i, '('); continue; }
    if (c === '`' && shell === 'bash') { i = sub(i, '`'); continue; }
    if (c === '&' && (cur.endsWith('>') || n === '>')) { cur += c; has = true; continue; }   // 2>&1 and &>file are redirects, not a new command
    if (c === '\n' || ';|&(){}'.includes(c)) { endSeg(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    cur += c; has = true;
  }
  if (q) why.push('a quote that is never closed');
  endSeg();
  return { segs, subs, bodies, why };
}

// $TEMP, $TMP, $TMPDIR, ${TEMP}, $env:TEMP or %TEMP% at the start of a word, followed by a slash or the end, is the temp folder (the
// folder the hub's rules call temp), not a path built at run time.
const TEMP_START = /^(?:\$\{?(?:TEMP|TMP|TMPDIR)\}?|\$env:(?:TEMP|TMP)|%(?:TEMP|TMP)%)(?=[\\/]|$)/i;
const expandTemp = w => { const m = TEMP_START.exec(w); return m ? tmpdir() + w.slice(m[0].length) : w; };

// The words of a command without its output redirects: ">" or ">>" (with an optional number in front) and the word after it, or
// the same with the target attached (>file, 2>>log), and 2>&1. Input redirects stay (they name a file the program reads).
function dropRedirects(words) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\d*>>?&?\d*$/.test(w) && !/&\d/.test(w)) { i++; continue; }   // "> file": the operator, then its target
    if (/^\d*>>?(&\d|\S)/.test(w)) continue;                                // ">file" and "2>&1"
    out.push(w);
  }
  return out;
}
const dynamic = x =>x.includes(DYN) || /\$[\w{(]|%\w+%|^~/.test(x);
const bareSpec = s => !/^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:|file:)/.test(s);   // a package name: dependency code, not a file here
const SHELLS = /^(bash|sh|zsh|dash|ksh|ash)$/;
const NODEISH = /^(node|nodejs|tsx|ts-node|ts-node-esm)$/;
const PYTHONISH = /^(python[\d.]*|py|pypy[\d.]*)$/;
// ROUND 3: the reader is an allowlist all the way down. A segment is "read" only when its head is a program the hub
// positively knows cannot start another program (SAFE_HEADS, with only the long options in SAFE_LONG), or one of the few
// it follows (an interpreter with its allowlisted flags, git with allowlisted subcommands, npm run/test/start, ...).
// Everything else (tar, gh, a dependency's bin, a program built from a quoted sum, a stranger's cmdlet) is unread, so a
// program the hub has never heard of cannot hide a worker's file in its arguments. Unread means the check can never allow it.
// Programs that only read, write or report, and never start what is in their arguments. (Not here: gh and wget, which
// can run an alias or an askpass program; tar, which runs -I; find, sed and awk, which have their own rules.)
const SAFE_HEADS = new Set(['echo', 'printf', 'cat', 'type', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'tee', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'dir', 'll', 'tree', 'stat', 'file', 'pwd', 'which', 'where', 'whereis',
  'get-command', 'gcm', 'test', '[', 'true', 'false', ':', 'sleep', 'start-sleep', 'date', 'mkdir', 'md', 'touch', 'cp', 'copy', 'mv', 'move', 'rm', 'del', 'erase', 'rmdir', 'rd', 'ri', 'remove-item', 'copy-item', 'cpi', 'move-item', 'mi',
  'new-item', 'ni', 'rename-item', 'get-childitem', 'gci', 'get-content', 'gc', 'set-content', 'sc', 'add-content', 'ac', 'select-string', 'sls', 'select-object', 'where-object', 'foreach-object', 'sort-object', 'measure-object',
  'format-table', 'format-list', 'out-null', 'out-file', 'out-string', 'write-host', 'write-output', 'write-error', 'test-path', 'join-path', 'split-path', 'resolve-path', 'get-item', 'get-date', 'get-location', 'set-variable',
  'get-process', 'get-service', 'get-filehash', 'convertto-json', 'convertfrom-json', 'basename', 'dirname', 'readlink', 'realpath', 'cygpath', 'mktemp', 'expr', 'diff', 'cmp', 'du', 'df', 'ps', 'tasklist', 'taskkill', 'stop-process',
  'netstat', 'curl', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'exit', 'return', 'popd',
  'read', 'export', 'unset', 'local', 'declare', 'shift']);
// Words that only structure a script (if/then/for ...): the command that follows one of the lead-in words is read in turn.
const LEAD_INS = /^(if|then|else|elif|elseif|do|while|until|!)$/i;
const KEYWORDS = new Set(['fi', 'done', 'esac', 'for', 'foreach', 'case', 'in', 'select', 'try', 'catch', 'finally', 'switch', 'param', 'break', 'continue', 'throw', 'if', 'else', 'elseif', 'while', 'do', 'then', 'until']);
// The long options (--name) a SAFE program may take. Any other long option could name a program to run
// (rg --pre, sort --compress-program, ...), so the segment is unread.
const SAFE_LONG = /^--(help|version|recursive|force|verbose|quiet|silent|parents|no-clobber|interactive|color|colour|count|line-number|no-line-number|ignore-case|smart-case|case-sensitive|invert-match|files-with-matches|files-without-match|word-regexp|line-regexp|fixed-strings|extended-regexp|perl-regexp|regexp|include|exclude|exclude-dir|max-count|lines|bytes|numeric-sort|reverse|unique|human-readable|all|almost-all|long|time|sort|hidden|glob|iglob|no-ignore|type|files|json|context|after-context|before-context|text|binary|null|follow|no-heading|heading|with-filename|no-filename|only-matching|dereference|preserve|update|target-directory|no-target-directory|backup|suffix|summarize|max-depth|block-size|format|date|utc|show-all|squeeze-blank|number|number-nonblank|ignore-errors|append|dry-run|output|unrestricted|no-messages|column|trim|byte-offset|stats|no-config|ignore-file|no-follow|max-filesize|threads|fail|location|silent|show-error|header|data|request|write-out|connect-timeout|max-time|retry|compressed|head|get|no-progress-meter)(=|$)/;
// git: only these subcommands are read. Any other name could be an external "git-x" program or an alias (aliases cannot
// shadow these built-in names), and `git -c`, `-C`, --git-dir, --exec ... are never read.
const GIT_SUBS = new Set(['status', 'log', 'diff', 'show', 'add', 'commit', 'branch', 'fetch', 'pull', 'push', 'checkout', 'switch', 'restore', 'stash', 'merge', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file', 'remote', 'tag',
  'blame', 'shortlog', 'describe', 'worktree', 'show-ref', 'for-each-ref', 'merge-base', 'cherry-pick', 'revert', 'mv', 'rm', 'reset', 'diff-tree', 'diff-index', 'name-rev', 'reflog', 'version']);
const GIT_MUTATES = new Set(['checkout', 'switch', 'restore', 'reset', 'merge', 'pull', 'stash', 'cherry-pick', 'revert', 'rm', 'mv', 'worktree']);
const GIT_GLOBAL_OK = /^(--no-pager|--no-optional-locks|--paginate|-p|--literal-pathspecs|--no-literal-pathspecs|--no-replace-objects|--bare)$/;
const GIT_LONG_OK = /^--(oneline|graph|stat|shortstat|numstat|name-only|name-status|no-edit|edit|amend|no-verify|message|all|force|force-with-lease|set-upstream|delete|no-track|track|porcelain|short|branch|format|pretty|since|until|after|before|author|committer|grep|abbrev-commit|abbrev|decorate|no-decorate|cached|staged|quiet|verbose|dry-run|ff-only|no-ff|ff|squash|rebase|no-rebase|prune|tags|no-tags|follow|reverse|max-count|patch|unified|word-diff|color|no-color|no-pager|no-merge|merges|first-parent|date|relative-date|stat-width|summary|find-renames|no-renames|diff-filter|full-index|binary|check|ignore-space-change|ignore-all-space|ignore-blank-lines|stdin|help|version|list|contains|merged|no-merged|show-current|sort|points-at|set-upstream-to|unset-upstream|move|copy|create|orphan|detach|ours|theirs|source|patch-with-stat|no-commit|signoff|no-gpg-sign|allow-empty|allow-empty-message|reset-author|date-order|topo-order|skip|root|exit-code|name|always|tags|long|dirty|match|unmerged|untracked-files|ignored|ahead-behind|no-ahead-behind|column|no-column|ignore-submodules|pickaxe-all|text|no-index|full-history|simplify-by-decoration|ancestry-path|left-right|boundary|pathspec-from-file|pathspec-file-nul|recurse-submodules|no-recurse-submodules|depth|unshallow|shallow-since|atomic|mirror|follow-tags|no-follow-tags|porcelain|progress|no-progress|keep|soft|mixed|hard|merge|keep-index|include-untracked|only|include|autosquash|no-autosquash|strategy|strategy-option|fixup|ignore-date|committer-date-is-author-date|cleanup|verify|no-signoff|lock|unlock|force-create|remove-empty|upstream|rename-limit|inter-hunk-context|function-context|no-prefix|src-prefix|dst-prefix|minimal|patience|histogram|diff-algorithm|dirstat|compact-summary|raw|output)(=|$)/;
// A word that names a program to run: never read when it follows git's own options.
const GIT_BAD_LONG = /^--(exec|upload-pack|receive-pack|exec-path|ext-cmd|config-env|config|git-dir|work-tree|open-files-in-pager|ext-diff|textconv|template|editor)(=|$)/;
// Flags that need no fuss for find: anything else (-exec, -ok, -fprint, -delete is fine) is unread.
const FIND_OK = /^(-name|-iname|-path|-ipath|-regex|-iregex|-type|-maxdepth|-mindepth|-mtime|-mmin|-atime|-ctime|-newer|-size|-empty|-not|-and|-or|-o|-a|!|-print|-print0|-prune|-delete|-depth|-user|-group|-perm|-readable|-writable|-executable|-xdev|-mount|-follow|-L|-H|-P|-true|-false)$/;
// Commands that change what files hold. A command that changes a script (or the tree) and runs one is not "what was read".
// Round 4: ANY write counts, whatever the file names (cp -r stage/. . changes tools/a.mjs without naming it). Not here:
// mkdir and touch (they add an empty folder or a timestamp, not content).
const WRITERS = new Set(['cp', 'copy', 'mv', 'move', 'rm', 'del', 'erase', 'rmdir', 'rd', 'ri', 'remove-item', 'tee', 'set-content', 'sc', 'add-content', 'ac', 'out-file', 'copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'new-item', 'ni']);
const DOWNLOADERS = new Set(['curl', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm']);   // write only with an output option
const WRITES_FILE = /^(-o\S*|-O|--output(=.*)?|--remote-name|-outfile)$/i;
// A redirect writes unless it goes nowhere or to another stream (2>&1, >/dev/null, > $null, > nul).
const NOWHERE = /^(&\d|\/dev\/null|\$null|nul|NUL)$/;
// What an environment variable can change in what a program loads or runs.
const ENV_LOADS = /(?:^|[^A-Za-z0-9_])(NODE_OPTIONS|NODE_PATH|NODE_REPL_EXTERNAL_MODULE|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PYTHONUSERBASE|PYTHONINSPECT|PYTHONBREAKPOINT|BASH_ENV|PERL5OPT|PERL5LIB|PERLLIB|RUBYOPT|RUBYLIB|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|GIT_SSH_COMMAND|GIT_SSH|GIT_EXTERNAL_DIFF|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER|GIT_ASKPASS|GIT_EXEC_PATH|GIT_CONFIG_\w+|GIT_DIR|GIT_WORK_TREE|COMSPEC|PATHEXT|PSModulePath)(?![A-Za-z0-9_])|npm_config_\w+|NPM_CONFIG_\w+|--node-options|(?:^|[\s;&|(])(?:export\s+|set\s+|\$env:)?PATH\s*=/i;
// Flags with no value that are safe on each interpreter. Anything else is unread: it could load or run something else.
const NODE_OK = /^(--test|--test-only|--test-update-snapshots|--no-warnings|--no-deprecation|--trace-warnings|--trace-deprecation|--throw-deprecation|--enable-source-maps|--experimental-vm-modules|--experimental-strip-types|--no-experimental-strip-types|--use-strict|--expose-gc|--check|-c|--watch|--experimental-default-type=(module|commonjs)|--input-type=(module|commonjs)|--test-reporter=(spec|tap|dot|junit|lcov)|--test-concurrency=\d+|--test-timeout=\d+|--test-name-pattern=.*|--max-old-space-size=\d+|--stack-trace-limit=\d+)$/;
const NODE_VALUE_OK = { '--input-type': /^(module|commonjs)$/, '--test-reporter': /^(spec|tap|dot|junit|lcov)$/, '--test-concurrency': /^\d+$/, '--test-timeout': /^\d+$/, '--test-name-pattern': /^[\s\S]*$/ };
const PY_OK = /^-([BuOsEIqbSd]+|OO)$/;
const BASH_OK = /^(-[euxfnvlhBCpPa]+|--norc|--noprofile|--posix|--login|--version|--help)$/;
const PS_OK = /^-(noprofile|noninteractive|nologo|mta|sta)$/i;
const PS_VALUE = /^-(ep|executionpolicy|windowstyle|outputformat|inputformat)$/i;
const PM_OK = /^(--silent|-s|--if-present|--quiet|-q|--no-progress|--no-fund|--no-audit|--ignore-scripts|--offline|--prefer-offline|--no-color|--color|--loglevel=\w+|--frozen-lockfile|--immutable)$/;
const DENO_OK = /^(-A|--allow-[a-z-]+(=.*)?|--deny-[a-z-]+(=.*)?|--no-prompt|--quiet|-q|--no-check|--check|--no-lock)$/;
// Known gap, left on purpose (LOW): on Windows a bare `node` could be picked up from the current folder as node.cmd / node.exe.
// Claude Code starts its shells with NoDefaultCurrentDirectoryInExePath set, so the current folder is not searched; an
// explicit ./node or .\node is a path, and is read as the project file it names (parseCommand, `pathy`).
const INTERP = /^(node|nodejs|tsx|ts-node|ts-node-esm|python[\d.]*|py|pypy[\d.]*|bash|sh|zsh|dash|ksh|ash|pwsh|powershell|cmd|ruby|perl|php|deno|bun|bunx|npx|pnpx|npm|pnpm|yarn|uv|poetry|pipx|hatch|pdm|cargo|go|dotnet|make|gmake|nmake|just|task)$/;

// What a command starts. files: { path, mode } with mode 'file' (as written), 'node' (a node entry: may omit the
// extension), 'module' (python -m), 'direct' (a path used as the command word). inline: code written in the command.
// nested: { cmd, shell } command text to read in turn (bash -c "...", $(...)). runners: npm-style script names.
// unread: { head, why } for anything the hub cannot read in full.
// PowerShell: (Join-Path $env:TEMP 'name') with a plain literal name is the folder $env:TEMP\name (the same text the hub already
// reads as the temp folder), so a script or a made folder named that way is looked for where it really is, not "built at run time".
// Only two words joined: a name with a variable, a space, "..", a drive or a leading slash is left as written. Used by the script
// look-up here and by the rules (permission-rules.mjs) when they match a folder against the ones the worker made.
export function resolveJoinTemp(cmd) {
  const lit = String.raw`(?:'([^'$\`\s]+)'|"([^"$\`\s]+)")`;
  const re = new RegExp(String.raw`\(\s*Join-Path\s+(?:-Path\s+)?(\$\{?env:(?:TEMP|TMP)\}?)\s+(?:-ChildPath\s+)?${lit}\s*\)`, 'gi');
  return String(cmd ?? '').replace(re, (m, base, a, b) => {
    const name = a ?? b;
    return /(^|[\\/])\.\.([\\/]|$)|^[\\/]|:/.test(name) ? m : `${base}\\${name}`;
  });
}

export function parseCommand(cmd, { shell = 'bash', cwd = '' } = {}) {
  if (shell === 'powershell') cmd = resolveJoinTemp(cmd);
  const out = { files: [], inline: [], nested: [], runners: [], unread: [], mutates: false };
  const lx = lex(cmd, shell);
  for (const why of lx.why) out.unread.push({ head: '(command)', why });
  // PowerShell's call operator and dot-sourcing, followed by an expression or a variable: &('no'+'de') evil, & $x, .(...)
  if (shell === 'powershell' && /(?:^|[;&|{(\s])[&.]\s*[($]/.test(String(cmd || ''))) out.unread.push({ head: '(command)', why: 'it calls a program named by an expression or a variable' });
  out.nested.push(...lx.subs.map(s => ({ cmd: s, at: '', shell })));
  if (ENV_LOADS.test(String(cmd || ''))) out.unread.push({ head: '(environment)', why: 'it sets something that changes what a program loads or runs (NODE_OPTIONS, PYTHONPATH, PATH ...)' });
  // "cd hub && npm test": the folder a later part of the command runs in. Each file, runner and nested command is
  // tagged with it (`at`, relative to where the whole command runs), so it is looked for where it really is.
  let at = '', bodyAt = 0;
  const tagNew = () => {
    for (const x of [...out.files, ...out.runners]) if (x.at === undefined) x.at = at;
    for (const n of out.nested) if (n.at === undefined) n.at = at;
  };
  for (const w0 of lx.segs) {
    tagNew();
    let w = w0;
    const markers = w.filter(x => /^<<-?[^<]/.test(x));   // a heredoc marker word takes the next body, in order
    const body = markers.length ? markers.map(() => lx.bodies[bodyAt++] ?? '').join('\n') : null;
    for (;;) {   // VAR=x in front, and wrappers: timeout 5 node x.mjs, env X=1 node x.mjs, sudo ..., . ./x.sh (sourced)
      if (!w.length) break;
      if (/^[A-Za-z_]\w*=/.test(w[0])) { w = w.slice(1); continue; }
      if (LEAD_INS.test(w[0]) && w.length > 1) { w = w.slice(1); continue; }   // "then node x.mjs": the command after it
      if (/^(timeout|time|nohup|env|call|start|sudo|exec|command|nice|builtin)$/i.test(w[0]) && w.length > 1) { w = w.slice(1); while (w.length && (/^(-\S+|\d+(\.\d+)?[smhd]?)$/.test(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]))) w = w.slice(1); continue; }
      break;
    }
    if (!w.length) continue;
    const word0 = w[0], rest = w.slice(1);
    const head = basename(word0.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase();
    if (dynamic(word0)) { out.unread.push({ head: '(command)', why: 'what it runs is built at run time' }); continue; }
    if (/^(cd|chdir|pushd|set-location|sl)$/.test(head)) {
      const arg = rest.find(x => !/^\/d$/i.test(x) && !/^-(path|literalpath|l|p)$/i.test(x));
      // a folder it cannot work out, or a cd inside a group or after ||, whose reach cannot be told from the text
      if (!arg || arg === '-' || dynamic(arg) || /[(){}]/.test(String(cmd)) || String(cmd).includes('||')) out.unread.push({ head: 'cd', why: 'moves to a folder the hub cannot work out' });
      else at = isAbsolute(arg) ? arg : join(at || '.', arg);
      continue;
    }
    if (word0 === '.' || head === 'source') {   // ". ./x.sh", "source x.sh"
      if (rest[0] && !dynamic(rest[0])) out.files.push({ path: rest[0], mode: 'file' }); else out.unread.push({ head: 'source', why: 'its path is built at run time' });
      continue;
    }
    if (head === 'xargs') {   // xargs [flags] cmd args: the rest is a command
      let i = 0;
      while (i < rest.length && rest[i].startsWith('-')) i += /^-[INPdELsa]$/.test(rest[i]) ? 2 : 1;
      if (i < rest.length) out.nested.push({ cmd: rest.slice(i).join(' '), shell }); else out.unread.push({ head, why: 'what it starts is not clear' });
      continue;
    }
    if (/^(start-process|saps)$/.test(head)) {
      let file = null, args = [], i = 0;
      for (; i < rest.length; i++) {
        const lx2 = rest[i].toLowerCase();
        if (lx2 === '-filepath') file = rest[++i];
        else if (lx2 === '-argumentlist') { args = rest.slice(i + 1); break; }
        else if (/^-(windowstyle|workingdirectory|redirectstandard\w+|verb|credential)$/.test(lx2)) i++;
        else if (!rest[i].startsWith('-')) { if (file === null) file = rest[i]; else args.push(rest[i]); }
      }
      if (file) out.nested.push({ cmd: [file, ...args].join(' ').replace(/,/g, ' '), shell }); else out.unread.push({ head, why: 'what it starts is not clear' });
      continue;
    }
    // "> file" and ">> file": a write. A write to code, or to a name built at run time, is noted (see scriptsFor).
    for (let k = 0; k < w.length; k++) { const m = /^\d*>>?(.*)$/.exec(w[k]); if (m) { const tgt = m[1] || w[k + 1] || ''; if (!NOWHERE.test(tgt)) out.mutates = true; } }
    // A program that is not a plain name, or that is a script file itself.
    const pathy = /[\\/]/.test(word0), absolute = pathy && (isAbsolute(word0) || /^\/[A-Za-z]\//.test(word0)), inDeps = /[\\/]node_modules[\\/]/i.test(word0);
    const known = SAFE_HEADS.has(head) || INTERP.test(head) || head === 'git' || head === 'find' || KEYWORDS.has(head);
    if (SCRIPT_EXT.test(word0)) { out.files.push({ path: word0, mode: 'file' }); continue; }   // the command word is itself a script: ./run.sh, x.ps1, build.bat
    if (pathy) {   // ./tool, .\tool: a program of the project, if it is one. Never read as the interpreter its name looks like.
      out.files.push({ path: word0, mode: 'direct', known });
      if (!((absolute || inDeps) && known)) { if (inDeps && !known) out.unread.push({ head, why: 'a program from a dependency, which can run any file it is given' }); continue; }
    }
    if (head === 'git') { gitSegment(rest, out); continue; }
    if (head === 'find') {   // -exec, -ok, -fprint ... : only the plain tests and -print / -delete are read
      const bad = rest.find(x => /^-/.test(x) && !FIND_OK.test(x));
      if (bad) out.unread.push({ head, why: `find is given an option the hub does not read (${bad})` });
      continue;
    }
    if (INTERP.test(head)) {
      // Where output goes (> "$TEMP/x.log", 2>&1) is not an argument the program runs: it is not part of "built at run time".
      const args = dropRedirects(rest).map(expandTemp);
      if (args.some(dynamic)) { out.unread.push({ head, why: 'its arguments are built at run time' }); continue; }
      starts(head, args, out, { shell, body, cwd, at });
    } else if (SAFE_HEADS.has(head)) {   // reads, writes or reports; only the long options on the short list
      const bad = rest.slice(0, rest.indexOf('--') < 0 ? rest.length : rest.indexOf('--')).find(x => x.startsWith('--') && !SAFE_LONG.test(x));
      if (bad) out.unread.push({ head, why: `an option the hub does not read (${bad}), which could name a program to run` });
      else if (WRITERS.has(head) || (DOWNLOADERS.has(head) && rest.some(x => WRITES_FILE.test(x)))) out.mutates = true;
    } else if (!KEYWORDS.has(head)) {
      // prog: only "not on the list". pathy: one of its words is a path or script, or names a file here (tar -I ./evil): that
      // is the shape decision 67's gate looks at under Auto; a bare `docker ps` is not (the check still cannot allow it).
      const pathy = rest.some(x => /[\\/]/.test(x) || SCRIPT_EXT.test(x) || (cwd && (() => { try { return existsSync(resolve(cwd, at || '', x)); } catch { return false; } })()));
      out.unread.push({ head, why: 'a program that is not on the hub\'s short list of programs that only read, write or report', prog: true, pathy });
    }
  }
  tagNew();
  return out;
}

// git: only the subcommands in GIT_SUBS, with no global option that moves it (-C, --git-dir ...) or runs something (-c).
function gitSegment(rest, out) {
  const unread = why => out.unread.push({ head: 'git', why });
  let i = 0;
  while (i < rest.length && rest[i].startsWith('-')) { if (!GIT_GLOBAL_OK.test(rest[i])) return unread(`a git option the hub does not read (${rest[i]})`); i++; }
  const sub = rest[i];
  if (sub === undefined) return;
  if (!GIT_SUBS.has(sub)) return unread(`git ${sub}: not a subcommand the hub reads (it could be an alias or an external git-${sub} program)`);
  if (GIT_MUTATES.has(sub)) out.mutates = true;
  for (const x of rest.slice(i + 1)) {
    if (x === '--') break;
    if (GIT_BAD_LONG.test(x) || /^-O/.test(x)) return unread(`git is told to run or load something (${x})`);
    if (x.startsWith('--') && !GIT_LONG_OK.test(x)) return unread(`a git option the hub does not read (${x})`);
  }
}

function starts(head, rest, out, ctx) {
  const { shell, body } = ctx;
  const unread = why => out.unread.push({ head, why });
  const file = (path, mode = 'file') => out.files.push({ path, mode });
  const nest = (cmd, sh = shell) => out.nested.push({ cmd, shell: sh });
  const odd = x => unread(`an option the hub does not read (${x})`);
  // the code comes from a heredoc on this very command, or from somewhere the hub cannot see
  const stdin = (kind = 'code') => (body ? (kind === 'shell' ? nest(body) : out.inline.push({ code: body, heredoc: true })) : unread('reads its code from standard input'));
  if (rest.length === 1 && /^(-v|-V|--version|-h|--help)$/.test(rest[0]) && !/^(npm|pnpm|yarn|bun|npx|cargo|go|dotnet)$/.test(head)) return;   // asks for a version or help: runs nothing
  if (NODEISH.test(head)) {
    let test = false;
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (/^(-e|-p|-pe|--eval|--print)$/.test(x)) { out.inline.push({ code: rest[i + 1] ?? '' }); return; }   // what follows is the code's own arguments
      const ev = /^--(?:eval|print)=([\s\S]*)$/.exec(x);
      if (ev) { out.inline.push({ code: ev[1] }); return; }
      if (/^(-r|--require|--import|--loader|--experimental-loader)$/.test(x)) { const v = rest[++i]; if (v === undefined) return unread('a preload with no name'); if (!bareSpec(v)) file(v); continue; }
      const pl = /^--(?:import|require|loader|experimental-loader)=([\s\S]*)$/.exec(x);
      if (pl) { if (!bareSpec(pl[1])) file(pl[1]); continue; }
      if (x === '--test') { test = true; continue; }
      if (x === '-') return stdin();
      if (x === '--') { const next = rest.slice(i + 1); if (next[0]) file(next[0], 'node'); else unread('no script named'); return; }
      if (NODE_VALUE_OK[x]) { if (rest[i + 1] === undefined || !NODE_VALUE_OK[x].test(rest[i + 1])) return odd(x); i++; continue; }
      if (x.startsWith('-')) { if (NODE_OK.test(x)) continue; return odd(x); }
      if (test) { for (const f of rest.slice(i)) { if (f.startsWith('-')) { if (!NODE_OK.test(f)) return odd(f); } else file(f, 'node'); } return; }
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
      if (/^-[WX]$/.test(x)) { i++; continue; }
      if (x.startsWith('-')) { if (PY_OK.test(x)) continue; return odd(x); }
      return file(x);
    }
    return stdin();
  }
  if (SHELLS.test(head)) {
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (/^-[euxfnvlhBCpPa]*c$/.test(x)) { if (rest[i + 1] === undefined) unread('no command given'); else nest(rest[i + 1], 'bash'); return; }
      if (x === '-s') return stdin('shell');
      if (/^[-+]o$/.test(x)) { if (!/^(pipefail|errexit|nounset|xtrace|noglob|verbose)$/.test(rest[i + 1] || '')) return odd(x); i++; continue; }
      if (x.startsWith('-') || x.startsWith('+')) { if (BASH_OK.test(x)) continue; return odd(x); }
      return file(x);
    }
    return stdin('shell');
  }
  if (/^(pwsh|powershell)$/.test(head)) {
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i], lx = x.toLowerCase();
      if (/^-(f|file)$/.test(lx)) { if (rest[i + 1] === undefined) unread('no file named'); else file(rest[i + 1]); return; }
      if (/^-(c|command|cm|com\w*)$/.test(lx)) { nest(rest.slice(i + 1).join(' '), 'powershell'); return; }
      if (/^-(e|ec|enc\w*)$/.test(lx)) return unread('runs an encoded command');
      if (PS_VALUE.test(lx)) { if (rest[i + 1] === undefined) return odd(x); i++; continue; }
      if (x.startsWith('-')) { if (PS_OK.test(x)) continue; return odd(x); }
      if (SCRIPT_EXT.test(x)) return file(x);
      nest(rest.slice(i).join(' '), 'powershell'); return;
    }
    return stdin('shell');
  }
  if (head === 'cmd') {
    for (let i = 0; i < rest.length; i++) {
      if (/^\/{1,2}[ck]$/i.test(rest[i])) { nest(rest.slice(i + 1).join(' '), 'cmd'); return; }
      if (!/^\/{1,2}[dsq]$/i.test(rest[i])) return odd(rest[i]);
    }
    return unread('opens a command prompt');
  }
  if (/^(ruby|perl|php)$/.test(head)) {
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i];
      if (x === '-e' || (head === 'php' && x === '-r')) { out.inline.push({ code: rest[i + 1] ?? '' }); return; }
      if (x === '-') return stdin();
      if (x.startsWith('-')) return odd(x);
      return file(x);
    }
    return stdin();
  }
  if (head === 'deno') {
    const sub = rest.find(x => !x.startsWith('-'));
    for (const x of rest.slice(0, rest.indexOf(sub) < 0 ? rest.length : rest.indexOf(sub))) if (!DENO_OK.test(x)) return odd(x);
    const after = rest.slice(rest.indexOf(sub) + 1);
    const pos = after.filter(x => !x.startsWith('-'));
    for (const x of after) if (x.startsWith('-') && !DENO_OK.test(x)) return odd(x);
    if (sub === 'run') { const t = pos[0]; if (!t) return unread('no script named'); return /^(https?|npm|jsr|data):/i.test(t) ? unread('runs code from the internet') : file(t, 'node'); }
    if (sub === 'task') return unread('runs a task from deno.json');
    if (sub === 'eval') { out.inline.push({ code: pos[0] ?? '' }); return; }
    if (sub === 'test' || sub === 'bench') { const fs = pos.filter(f => SCRIPT_EXT.test(f)); return fs.length ? fs.forEach(f => file(f, 'node')) : unread('runs every test file it finds'); }
    if (sub === 'repl') return unread('opens a prompt');
    if (!sub) return;
    if (/^(fmt|lint|info|doc|types|completions|upgrade|help|--version)$/.test(sub)) return;
    return unread(`a deno command the hub does not read (${sub})`);
  }
  if (/^(bunx|npx|pnpx)$/.test(head)) return unread('downloads and runs a package');
  if (/^(bun|npm|pnpm|yarn)$/.test(head)) {
    const dd = rest.indexOf('--'), args = dd < 0 ? rest : rest.slice(0, dd);
    for (const x of args) if (x.startsWith('-') && !PM_OK.test(x)) return odd(x);   // --prefix, -C, --workspace, --script-shell, --node-options ...
    const pos = args.filter(x => !x.startsWith('-'));
    const sub = pos[0];
    if (!sub) return;
    if (head === 'bun' && (SCRIPT_EXT.test(sub) || /[\\/]/.test(sub))) return file(sub, 'node');
    // Round 3: only run / test / start (and stop, restart). Everything else (install, pack, version, rebuild, link, publish,
    // init, create, explore, exec, a bare script name ...) can run a lifecycle script or a program from the project.
    let name = null, extra = [];
    if (['run', 'run-script', 'rum', 'urn'].includes(sub)) { name = pos[1]; extra = pos.slice(2); }
    else if (['test', 'start', 'stop', 'restart'].includes(sub) || (head === 'npm' && ['t', 'tst'].includes(sub))) { name = { t: 'test', tst: 'test' }[sub] || sub; extra = pos.slice(1); }
    if (!name) return unread(`${head} ${sub}: only run, test and start are read (the others can run lifecycle scripts or a program of the project)`);
    if (head === 'bun' && sub === 'test' && !pos[1]) return unread('runs every test file it finds');
    if (head === 'bun' && (SCRIPT_EXT.test(name) || /[\\/]/.test(name))) return file(name, 'node');
    // What follows the script name (or `--`) is appended to the script's last command: it can name a file for the
    // program inside to run (npm test -- ./evil.mjs). Only plain words, and flags on the short lists, are read.
    for (const x of [...extra, ...(dd < 0 ? [] : rest.slice(dd + 1))]) {
      if (x.startsWith('-')) { if (!(NODE_OK.test(x) || PM_OK.test(x) || /^--(coverage|reporter|bail|run|ui|passWithNoTests|runInBand|verbose|json)(=\w+)?$/.test(x))) return odd(x); continue; }
      if (/[\\/]/.test(x) || SCRIPT_EXT.test(x) || /[=:*?]/.test(x)) return unread(`an argument that could name a file for the script to run (${x})`);
      if (ctx.cwd) { try { if (existsSync(resolve(ctx.cwd, ctx.at || '', x))) return unread(`an argument that names an existing file (${x})`); } catch { /* not a file */ } }
    }
    out.runners.push({ tool: head, name, hooks: true });
    return;
  }
  if (/^(uv|poetry|hatch|pdm)$/.test(head)) {   // only `run <command>`; install, sync, pip ... build and run project code
    if (rest[0] !== 'run') return unread(`${head} ${rest[0] ?? ''}: only "run" is read`);
    const tail = rest.slice(1);
    let j = 0;
    while (j < tail.length && /^(--no-sync|--frozen|--locked|--offline|--quiet|-q|--no-project)$/.test(tail[j])) j++;
    if (j >= tail.length) return unread('no command named');
    if (tail[j].startsWith('-')) return odd(tail[j]);
    nest(tail.slice(j).join(' '));
    return;
  }
  // pipx, cargo, dotnet, go, make, just, task, npx ... build or download and run code the hub does not read.
  return unread('builds or downloads and runs code the hub does not read');
}

// The script paths as written, for the tests and the simple cases.
export function scriptPaths(cmd, opts) {
  return [...new Set(parseCommand(cmd, opts).files.map(f => f.path))];
}

// ---------- text that loads, runs or starts something unseen ----------
// A call that starts a process, a worker or a script. A regex's .exec( is not one (only files that use child_process count).
const SPAWN_CALL = /(?<![.\w])(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(|(?<![.\w])exec\s*\(|(?:\w|\))\s*\.\s*(?:spawn|spawnSync|execFile|execFileSync|execSync|fork)\s*\(|(?:\b(?:child_process|cp|childProcess|child|proc)|\))\s*\.\s*exec\s*\(|\bnew\s+Worker\b|\.\s*Worker\b|\bexecPath\b|\bargv0\b|\bvm\s*\.\s*(?:runIn\w*|Script|compileFunction)|\bchild_process\s*\.\s*\w+\s*\(/;
const SCRIPT_LITERAL = /['"`]([^'"`\n]*\.(?:mjs|cjs|js|jsx|ts|tsx|py|sh|bash|ps1|psm1|bat|cmd|rb|pl|php|lua))['"`]/g;
// Does this JS or Python text start a process, a worker or a script of its own (other than git and gh)?
export function spawns(text, python = false) {
  const t = String(text || '');
  if (python) {
    // a use of the process modules (an import alone starts nothing), other than a list call on git or gh
    const rest = t.replace(/subprocess\s*\.\s*\w+\s*\(\s*\[\s*['"](?:git|gh)['"]/g, '');
    return /\bsubprocess\s*\.\s*\w+|\bfrom\s+subprocess\s+import\b|\bmultiprocessing\b|\bpty\s*\.|\bos\s*\.\s*(?:system|exec\w*|spawn\w*|popen)|\bPopen\b|\brunpy\b|\bimportlib\b|__import__|\b(?:exec|eval|compile)\s*\(/.test(rest);
  }
  if (!/\bchild_process\b|\bWorker\b|worker_threads|\bexecPath\b|\bargv0\b|\bvm\s*\./.test(t)) return false;
  const rest = t.replace(/(?<![.\w])(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"`](?:git|gh)(?:\.exe)?['"`]/g, '').replace(/\b\w+\s*\.\s*(?:spawn|spawnSync|execFile|execFileSync)\s*\(\s*['"`](?:git|gh)(?:\.exe)?['"`]/g, '');
  return SPAWN_CALL.test(rest);
}
// Reasons text loads, runs or evals something the check cannot see (empty: nothing found).
// inline: the text is code written in the command (-e, -c): starting a process only counts there when it names a script
// file (execSync('git status') is a plain one-liner); in a script file any process it starts is unseen code.
export function loadsUnseen(text, { python = false, dir = '', skipRuns = false, inline = false } = {}) {
  const t = String(text || ''), why = [];
  const add = s => { if (!why.includes(s)) why.push(s); };
  if (/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"](?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:|file:|#)/.test(t) || /^\s*import\s*['"](?:\.{1,2}[\\/]|[\\/]|[A-Za-z]:|file:|#)/m.test(t)) add('imports another file');
  if (/\b(?:require|import)\s*\(\s*['"`](?:\.{1,2}[\\/]?|[\\/]|[A-Za-z]:|file:|#)/.test(t)) add('requires another file');
  if (/\b(?:require|import)\s*\(\s*[^'"`)\s]/.test(t)) add('loads a file named at run time');
  // Review of #99: anything but ONE plain string literal inside require( / import( is a name built at run time:
  // require('child' + '_process'), a template string with ${}, a variable, two strings joined.
  for (const m of t.matchAll(/\b(?:require|import)\s*\(\s*(?=['"`])/g)) {
    if (!/^(?:'[^'\\\n]*'|"[^"\\\n]*"|`[^`$\\]*`)\s*\)/.test(t.slice(m.index + m[0].length))) { add('loads a file named at run time'); break; }
  }
  if (/\b(?:eval|execScript)\s*\(|\bnew\s+Function\b|\bFunction\s*\(/.test(t) && !python) add('evals text');
  if (python) {
    if (/\b(?:exec|eval|__import__|compile)\s*\(|\brunpy\b|\bimportlib\b/.test(t)) add('runs text or loads a file named at run time');
    for (const m of t.matchAll(/^\s*(?:from\s+(\.+\w*|\w+)\s+import|import\s+(\w+))/gm)) {
      const mod = m[1] || m[2];
      if (/^\./.test(mod)) add('imports a sibling module');
      else if (dir && (existsSync(join(dir, `${mod}.py`)) || existsSync(join(dir, mod, '__init__.py')))) add(`imports ${mod}.py, next to it`);
    }
  }
  if (spawns(t, python) && (!inline || [...t.matchAll(SCRIPT_LITERAL)].length)) add(inline ? 'starts another script' : 'starts another program or script, which is not attached');
  // Review of #95: loading the process module at all (aliased, destructured, cp['exec' + 'Sync'], `import subprocess as sp`)
  // makes the script unread. The call forms above are only the ones the hub can see; what it starts through an alias or a
  // built-up name it cannot. (Inline one-liners keep the narrower rule above: execSync('git status') is a plain command.)
  if (!inline && (python ? /^[ \t]*(?:import|from)[ \t]+[^\n]*\bsubprocess\b/m.test(t) : /['"`](?:node:)?child_process(?:\/promises)?['"`]/.test(t))) add('can start other programs (it loads the process module), and what it starts is not attached');
  if (/^\s*(?:source|\.)\s+[^\s=]/m.test(t) || /^\s*\.\s+["'$]/m.test(t)) add('sources another script');
  if (/\b(?:iex|Invoke-Expression|Add-Type|Import-Module|ipmo|Invoke-Command|icm|Invoke-Item|Start-Job)\b|\[scriptblock\]|\[System\.Reflection|\[Reflection\./i.test(t)) add('evals text');
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
// With the real git (not a test's stand-in), the whole repository is asked once per request instead of four times per file (M054
// review, speed): the merge-base, the tracked list, what differs from the merge-base, and `git status`. Same answer, fewer
// processes; any failure of those calls falls back to the per-file questions below. Kept per request only (the `cache`), never
// longer: a file a worker has just changed must not look committed.
function gitRootOf(file) {
  let d = dirname(resolve(file));
  for (let i = 0; i < 60; i++) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}
async function mergeBaseOf(root, git, mainRefs) {
  for (const ref of mainRefs) { const b = await git(['merge-base', 'HEAD', ref], root); if (b.code === 0 && b.out.trim()) return b.out.trim(); }
  return '';
}
const lower = s => String(s).replace(/\\/g, '/').toLowerCase();
async function repoState(root, { git, mainRefs, cache }) {
  const key = `s:${norm(root)}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const sha = await mergeBaseOf(root, git, mainRefs);
      if (!sha) return { sha: '', tracked: new Set(), dirty: new Set(), dirtyDirs: [] };
      const [ls, df, st] = await Promise.all([
        git(['ls-files', '-z'], root),
        git(['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', sha], root),
        git(['status', '--porcelain', '-z', '--ignored'], root)
      ]);
      if (ls.code !== 0 || df.code !== 0 || st.code !== 0) return null;
      const dirty = new Set(), dirtyDirs = [];
      const mark = p => { const x = lower(p); if (x.endsWith('/')) dirtyDirs.push(x); else dirty.add(x); };
      for (const p of df.out.split('\0').filter(Boolean)) mark(p);
      const parts = st.out.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const e = parts[i]; if (e.length < 4) continue;
        mark(e.slice(3));
        if (/^[RC]/.test(e)) { i++; if (parts[i]) mark(parts[i]); }   // a rename or copy is followed by its old name
      }
      return { sha, tracked: new Set(ls.out.split('\0').filter(Boolean).map(lower)), dirty, dirtyDirs };
    })());
  }
  return cache.get(key);
}

// The change of one file from the merge-base with main, as text: for a changed file too big to show whole. null when there is none
// to show (an untracked file, a binary one, no merge-base, git failing). Real git or a stand-in (`git`).
export async function changedDiff(file, { git = defaultGit, mainRefs = ['origin/main', 'main'], cache = new Map() } = {}) {
  try {
    const root = gitRootOf(file);
    if (!root) return null;
    const sha = (await repoState(root, { git, mainRefs, cache }))?.sha || await mergeBaseOf(root, git, mainRefs);
    if (!sha) return null;
    const rel = relative(root, resolve(file)).replace(/\\/g, '/');
    const d = await git(['diff', '--no-ext-diff', '--no-textconv', sha, '--', rel], root);
    if (d.code !== 0 || !d.out.trim() || d.out.includes('\u0000') || /^Binary files /m.test(d.out)) return null;
    return d.out;
  } catch { return null; }
}

export async function isCommittedFile(file, { projectDir, git = defaultGit, mainRefs = ['origin/main', 'main'], cache = new Map() } = {}) {
  try {
    const key = `f:${norm(file)}`;
    if (cache.has(key)) return cache.get(key);
    const ok = await (async () => {
      if (!projectDir || !within(realpathSync(file), realpathSync(projectDir))) return false;
      if (lstatSync(file).isSymbolicLink()) return false;
      if (git === defaultGit) {
        const root = gitRootOf(file);
        const state = root ? await repoState(root, { git, mainRefs, cache }) : null;
        if (state) {
          if (!state.sha) return false;
          const rel = lower(relative(root, resolve(file)));
          return state.tracked.has(rel) && !state.dirty.has(rel) && !state.dirtyDirs.some(d => rel.startsWith(d));
        }
      }
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

// What a JS or Python file loads or starts by relative path, and whether anything it loads or starts cannot be followed
// statically. A file that starts a process, a worker or a script counts as loading what it starts: those scripts are
// followed too when they are named in the text, and a spawn whose target is not named makes the file unresolvable.
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
    if (spawns(t, true)) {
      const lits = [...t.matchAll(SCRIPT_LITERAL)].map(m => m[1]);
      if (!lits.length) unresolvable = true; else for (const l of lits) specs.add(isAbsolute(l) ? l : resolve(dir, l));
    }
    return { specs: [...specs], unresolvable };
  }
  const grab = re => { for (const m of t.matchAll(re)) specs.add(m[1]); };
  grab(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g);
  grab(/^\s*import\s*['"]([^'"]+)['"]/gm);
  grab(/\b(?:require|import)\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g);
  if (/\b(?:require|import)\s*\(\s*(?!['"`][^'"`$]*['"`]\s*\))/.test(t) || /\b(?:eval|execScript)\s*\(|\bnew\s+Function\b|\bFunction\s*\(/.test(t)) unresolvable = true;
  const files = [];
  for (const s of specs) {
    // a built-in or a dependency. Writes into node_modules / .venv that change what a committed script imports are a hard
    // stop in the permission rules (Track A), not something this reader can see.
    if (/^(node:|data:|https?:)/.test(s) || bareSpec(s) && !s.startsWith('#')) continue;
    if (s.startsWith('#') || /^file:/.test(s) && /[?#]/.test(s)) { unresolvable = true; continue; }
    files.push(s.replace(/^file:\/*/, ''));
  }
  const found = files.map(s => (isAbsolute(s) ? s : resolve(dir, s)));
  if (spawns(t)) {   // starts something: only fine when every script it names is here (and committed, which the chain checks)
    const lits = [...t.matchAll(SCRIPT_LITERAL)].map(m => m[1]);
    if (!lits.length) unresolvable = true; else for (const l of lits) found.push(isAbsolute(l) ? l : resolve(dir, l));
  }
  return { specs: found, unresolvable };
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

// "Committed and unchanged from main", for a script and everything it loads by relative import or require or starts by
// name, followed all the way down. A dynamic import, a computed require, a spawn it cannot name, or an import that
// cannot be found makes it false: such a script is attached instead, and the unread rule applies to it.
export async function isProjectScript(file, opts = {}) {
  return (await projectScriptChain(file, opts)).ok;
}

// The same walk, with the answer in parts (M054): ok, and
//   bad:    the files of the chain the permission check should be shown, { path, changed, notShown: [..] }. changed: the file is not
//           committed or has changed (its text can be shown). notShown: what the check cannot see of THIS changed file or the files
//           it loads (named at run time, too big to follow, unreadable): the check escalates on these.
//   doubts: one plain line per file about what the hub could not follow in an unchanged (committed) file, and every import
//           that could not be found anywhere. These are ordinary doubts for the model to weigh, not unseen files.
// The whole chain is walked (up to MAX_FILES), so everything is listed, not only the first failure. `ok` is true only when
// both lists are empty (the old "committed and unchanged" answer).
export async function projectScriptChain(file, opts = {}) {
  const cache = opts.cache || new Map(), seen = new Set(), todo = [file], bad = [], doubtOf = new Map();
  const doubt = (f, why) => { const k = norm(f); if (!doubtOf.has(k)) doubtOf.set(k, { path: f, why: [] }); const d = doubtOf.get(k); if (!d.why.includes(why)) d.why.push(why); };
  while (todo.length) {
    const f = todo.pop(), k = norm(f);
    if (seen.has(k)) continue;
    seen.add(k);
    const changed = !(await isCommittedFile(f, { ...opts, cache }));
    const entry = { path: f, changed, notShown: [] };
    // What cannot be followed in this file: not shown when the file itself is changed (the check has not seen what it loads), a
    // doubt when it is committed and unchanged (the hub only could not follow it).
    const unseen = why => (changed ? entry.notShown.push(why) : doubt(f, why));
    if (seen.size > MAX_FILES) { unseen(`the chain loads more than ${MAX_FILES} files, the rest are not listed`); if (changed || entry.notShown.length) bad.push(entry); break; }
    const follow = /\.(mjs|cjs|js|jsx|ts|tsx|py)$/i.test(f);   // other kinds are not followed
    if (follow) {
      let text = null;
      try { if (statSync(f).size > MAX_FILE_BYTES) unseen('too big to follow what it loads'); else text = readFileSync(f, 'utf8'); } catch { unseen('could not be read to follow what it loads'); }
      if (text !== null) {
        const { specs, unresolvable } = importsOf(text, f);
        if (unresolvable) unseen('it loads a file named at run time, not shown');
        for (const s of specs) {
          const r = resolveImport(s, /\.py$/i.test(f));
          if (!r) { doubt(f, `it loads ${basename(s)}, which could not be found`); continue; }   // a doubt everywhere: nothing there to show
          if (!/\.json$/i.test(r)) todo.push(r);
        }
      }
    }
    if (changed || entry.notShown.length) bad.push(entry);
  }
  const doubts = [...doubtOf.values()].map(d => `${d.path}: ${d.why.join('; ')}`);
  return { ok: bad.length === 0 && doubts.length === 0, bad, doubts };
}

function expandGlob(path) {
  if (!/[*?]/.test(path)) return [path];
  const dir = dirname(path), pat = basename(path);
  if (/[*?]/.test(dir)) return [];   // only a pattern in the last part
  const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^\\\\/]*').replace(/\?/g, '[^\\\\/]') + '$', 'i');
  try { return readdirSync(dir).filter(f => re.test(f)).sort().map(f => join(dir, f)).slice(0, 200); } catch { return []; }
}

const PY_MODULES_OK = new Set(['venv', 'json.tool', 'ensurepip']);   // standard modules that run nothing of the project's
const DIRECT_EXT = ['', '.ps1', '.bat', '.cmd', '.exe', '.com'];      // what PowerShell tries for .\evil
// Where the files a command names are, as the items to look at: { path } or { path, kind: 'unknown' | 'missing', note }.
function itemsFor(files, base0, projectDir) {
  const items = [];
  const add = f => items.push({ path: f });
  for (const { path: r0, mode, at, known } of files) {
    const base = at ? resolve(base0, at) : base0;   // after a cd in the command, where it really runs
    // $TEMP, $TMPDIR, ${TEMP}, $env:TEMP, %TEMP% at the start of a path is the temp folder (the same folder the hub's rules call
    // temp), not a path built at run time.
    const r = expandTemp(r0);
    if (/[$`\u0001]|^~|%\w+%/.test(r)) { items.push({ path: r, kind: 'unknown', note: 'its path is built from a variable or a command' }); continue; }
    const abs = isAbsolute(r) ? r : resolve(base, r);
    if (mode === 'module') {
      const local = [resolve(base, `${r.replace(/\./g, '/')}.py`), resolve(base, r.replace(/\./g, '/'), '__main__.py')].filter(f => existsSync(f));
      if (local.length) local.forEach(add);
      else if (!PY_MODULES_OK.has(r)) items.push({ path: `python -m ${r}`, kind: 'unknown', note: 'it runs a module the hub cannot read here' });
      continue;
    }
    if (mode === 'direct') {   // .\evil, ./evil, & .\evil: the file as named, then with .ps1 .bat .cmd .exe; not there: unread
      // Git Bash writes a Windows path as /c/Program Files/...: the same file, so it is looked for as C:/Program Files/...
      const win = process.platform === 'win32' && /^\/[A-Za-z]\//.test(r) ? `${r[1].toUpperCase()}:${r.slice(2)}` : abs;
      const found = DIRECT_EXT.map(e => win + e).filter(f => { try { return statSync(f).isFile(); } catch { return false; } });
      if (!found.length) {
        // not there: unread for a relative path or one in the project or temp (it may be made by the command itself);
        // an absolute path elsewhere is a system program this machine does not have, which cannot run anyway
        if (!isAbsolute(r) || (projectDir && within(win, projectDir)) || within(win, tmpdir())) items.push({ path: abs, kind: 'missing', note: 'no such file to run' });
        continue;
      }
      for (const f of found) {
        let real; try { real = realpathSync(f); } catch { continue; }
        const mine = (projectDir && within(real, realpathSync(projectDir))) || within(real, realpathSync(tmpdir()));
        if (mine) { if (!/[\\/]node_modules[\\/]/i.test(real)) add(f); }   // a dependency's own program is read by what its name is (parseCommand)
        else if (!isAbsolute(r)) items.push({ path: f, kind: 'unreadable', note: 'a program outside the project' });
        // a system program: fine when its name is one the hub reads (git, node, cat ...); any other one could run what it is given
        else if (!known) items.push({ path: f, kind: 'unreadable', note: 'a system program that is not on the hub\'s short list' });
      }
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
  // Python reads sitecustomize and usercustomize from the script's folder before it runs anything.
  for (const it of [...items]) if (!it.kind && /\.py$/i.test(it.path)) for (const n of ['sitecustomize.py', 'usercustomize.py']) { const f = join(dirname(it.path), n); if (existsSync(f)) add(f); }
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

// What the Auto gate (hub.mjs gateScript) learns about each script the command runs. Each entry:
//   { path, kind: 'committed' }                              project script, committed and unchanged (and everything it loads)
//   { path, kind: 'uncommitted', files, doubts }             a file that exists but is not, or loads one that is not: the check judges it.
//                                                            files: the files of its chain to show { path, changed, notShown[] };
//                                                            doubts: one plain line per file the hub could not follow (projectScriptChain)
//   { path, kind: 'missing' | 'unreadable' | 'unknown', note } a script the hub could not resolve to a file
// `unread` is true when a script could not be resolved to a file, or inline code loads one the hub has not seen. The gate lets a
// command through at once only when `unread` is false and every entry is 'committed'.
// Follows every shell string, $(...) and package script the command starts, down to MAX_NEST levels.
// shell: 'bash' (the Bash tool) or 'powershell' (the PowerShell tool): how the text is split into words.
export async function scriptsFor(cmd, { cwd, projectDir, git = defaultGit, mainRefs, shell = 'bash' } = {}) {
  const base = cwd || projectDir || process.cwd();
  const cache = new Map(), opts = { projectDir, git, mainRefs, cache };
  const out = [], inlineLoads = [], seenPaths = new Set();
  let sawWrite = false, sawRun = false;
  const queue = [{ cmd: String(cmd || ''), cwd: base, depth: 0, shell }], seenCmds = new Set();
  const items = [];
  const npmScriptShell = process.platform === 'win32' ? 'cmd' : 'bash';
  while (queue.length) {
    const q = queue.shift();
    const key = `${norm(q.cwd)}\u0000${q.shell}\u0000${q.cmd}`;
    if (seenCmds.has(key)) continue;
    seenCmds.add(key);
    if (q.depth > MAX_NEST) { out.push({ path: '(a command)', kind: 'unknown', note: 'commands inside commands go too deep to read' }); continue; }
    const p = parseCommand(q.cmd, { shell: q.shell, cwd: q.cwd });
    if (p.mutates) sawWrite = true;
    if (p.files.length || p.runners.length || p.inline.length) sawRun = true;
    for (const u of p.unread) out.push({ path: `(${u.head})`, kind: 'unknown', note: u.why });
    for (const it of itemsFor(p.files, q.cwd, projectDir)) items.push(it);
    for (const i of p.inline) for (const r of loadsUnseen(i.code, { python: !!i.python, inline: true })) if (!inlineLoads.includes(r)) inlineLoads.push(r);
    for (const n of p.nested) queue.push({ cmd: n.cmd, cwd: n.at ? resolve(q.cwd, n.at) : q.cwd, depth: q.depth + 1, shell: n.shell || q.shell });
    for (const r of p.runners) {   // npm run x: the package's own script text is the command
      const pkg = findPackageJson(r.at ? resolve(q.cwd, r.at) : q.cwd, projectDir);
      if (!pkg) { out.push({ path: `(${r.tool} ${r.name})`, kind: 'unknown', note: 'no package.json here to read the script from' }); continue; }
      // an .npmrc can set node-options (a preload) for every script it runs: one that is not committed is not read
      let npmrcBad = false;
      for (const d of new Set([dirname(pkg), projectDir].filter(Boolean))) { const f = join(d, '.npmrc'); if (existsSync(f) && !(await isCommittedFile(f, opts))) npmrcBad = true; }
      if (npmrcBad) { out.push({ path: `(${r.tool} ${r.name})`, kind: 'unknown', note: 'an .npmrc here is not committed and unchanged, and it can set what npm runs first' }); continue; }
      let scripts;
      try { if (statSync(pkg).size > 256 * 1024) throw new Error('big'); scripts = JSON.parse(readFileSync(pkg, 'utf8')).scripts; } catch { out.push({ path: pkg, kind: 'unreadable', note: 'package.json could not be read' }); continue; }
      const names = [r.hooks ? `pre${r.name}` : null, r.name, r.hooks ? `post${r.name}` : null].filter(Boolean);
      if (typeof scripts?.[r.name] !== 'string') { out.push({ path: `(${r.tool} ${r.name})`, kind: 'unknown', note: 'package.json has no such script' }); continue; }
      items.push({ path: pkg });
      for (const n of names) if (typeof scripts?.[n] === 'string') queue.push({ cmd: scripts[n], cwd: dirname(pkg), depth: q.depth + 1, shell: npmScriptShell });
    }
  }
  // A command that changes a script (or the working tree) and runs a script is not what was read: the files were looked at
  // before the command ran.
  if (sawWrite && sawRun) out.push({ path: '(command)', kind: 'unknown', note: 'it changes a script or the tree and runs a script in the same command, so what runs is not what was read' });
  const unique = new Map();   // the same file named twice is one script
  for (const it of items) unique.set(it.kind ? `${it.kind}\u0000${it.path}` : norm(it.path), it);
  items.length = 0; items.push(...unique.values());
  if (items.length > MAX_SCRIPTS) {   // more than can be told about: the rest are not seen, so it cannot be allowed
    out.push({ path: `${items.length - MAX_SCRIPTS} more scripts`, kind: 'unreadable', note: `more than ${MAX_SCRIPTS} scripts run, the rest are not listed`, notShown: true });
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
    // A script that is not committed and unchanged from main (or loads one that is not): the gate sends the command to the check.
    // `files` (only when not committed): the files of its chain that failed, so the check is shown those and not the unchanged top
    // script (a committed script that imports a changed file: the changed file is what matters).
    const chain = await projectScriptChain(it.path, opts);
    out.push(chain.ok ? { path: it.path, kind: 'committed' } : { path: it.path, kind: 'uncommitted', files: chain.bad, doubts: chain.doubts });
  }
  // Text run as a command (iex, eval) is never a file the hub could read, wherever it sits in the command.
  if (/\b(?:iex|Invoke-Expression|Add-Type|Import-Module|ipmo|Invoke-Command|icm|Invoke-Item|Start-Job)\b|(?:^|[;&|(\s])eval\s/i.test(String(cmd || '')) && !inlineLoads.includes('evals text')) inlineLoads.push('evals text');
  const unread = out.some(s => s.kind !== 'committed' && s.kind !== 'uncommitted') || inlineLoads.length > 0;
  return { scripts: out, inlineLoads, unread };
}
