// Plain mistakes, not disguise (M042, decision 73): an agent changing an EXISTING file of the project with a command-line script
// (sed -i, perl -pi, an inline node or python script that writes, PowerShell Set-Content onto the file, a > or >> redirect onto a
// tracked file) when it has the Edit and Write tools. The hub refuses these at once, in code: no card, no orchestrator, no check call.
//
//   inlineRewrite({ tool, command, cwd, projectDir }) -> the reason to refuse with, or null.
//
// It is deliberately narrow. Anything it cannot resolve to one existing file inside the project (a path built at run time, a
// variable it cannot read, a wrapper it does not know) is null: the normal path (the check or the orchestrator) decides, it never
// refuses on a guess. Never refused here: writes into a temp folder (the agent's own scratch work), a file that does not exist yet,
// scripts that only read, git's own commands, and running a committed project script. The refusal is a deny, never a hard stop.
import { statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

export const REWRITE_REASON = 'Use the Edit or Write tool to change files, not a command-line script';

const norm = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const under = (p, root) => norm(p) === norm(root) || norm(p).startsWith(norm(root) + '/');

// ---------- reading the command ----------
// Heredoc bodies are taken out (their marker word stays, naming the body) so their text is never read as commands.
function takeHeredocs(text) {
  const bodies = [];
  let out = text, pos = 0;
  for (let n = 0; n < 20; n++) {
    const re = /(?<!<)<<-?[ \t]*(["']?)([A-Za-z_]\w*)\1(?![\w<])/g;
    re.lastIndex = pos;
    const m = re.exec(out);
    if (!m) break;
    const marker = `<<HDOC${bodies.length}`;
    const start = out.indexOf('\n', m.index);
    if (start < 0) { out = out.slice(0, m.index) + marker + out.slice(m.index + m[0].length); bodies.push(''); pos = m.index + marker.length; continue; }
    const rest = out.slice(start + 1);
    const end = new RegExp(`^[ \\t]*${m[2]}[ \\t]*$`, 'm').exec(rest);
    const body = end ? rest.slice(0, end.index) : rest;
    const after = end ? rest.slice(end.index + end[0].length) : '';
    out = out.slice(0, m.index) + marker + out.slice(m.index + m[0].length, start + 1) + after.replace(/^\r?\n/, '');
    bodies.push(body);
    pos = m.index + marker.length;
  }
  return { text: out, bodies };
}

// Segments (split at && || ; | & and newlines, outside quotes) of words { text, quoted }, with the redirect operators as words
// { text: '>' | '>>' | '2>' ..., op: true }.
function segments(text, ps) {
  const segs = [];
  let words = [], cur = '', has = false, quoted = false, q = null;
  const endWord = () => { if (has) words.push({ text: cur, quoted }); cur = ''; has = false; quoted = false; };
  const endSeg = () => { endWord(); if (words.length) segs.push(words); words = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q === "'") { if (c === "'") q = null; else cur += c; continue; }
    if (q === '"') {
      if (c === '\\' && !ps && i + 1 < text.length) { cur += text[++i]; continue; }
      if (c === '`' && ps && i + 1 < text.length) { cur += text[++i]; continue; }
      if (c === '"') q = null; else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; quoted = true; continue; }
    if (c === '`' && ps && i + 1 < text.length) { cur += text[++i]; has = true; continue; }
    if (c === '$' && n === '(') {   // $( ... ): kept whole as part of the word
      let d = 0, j = i + 1;
      for (; j < text.length; j++) { if (text[j] === '(') d++; else if (text[j] === ')' && --d === 0) break; }
      cur += text.slice(i, j + 1); has = true; i = j; continue;
    }
    if (c === '`' && !ps) { const j = text.indexOf('`', i + 1); const e = j < 0 ? text.length - 1 : j; cur += text.slice(i, e + 1); has = true; i = e; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
    if (c === '\n' || c === ';') { endSeg(); continue; }
    if (c === '#' && !has) { while (i < text.length && text[i] !== '\n') i++; i--; continue; }
    if (c === '|') { endSeg(); if (n === '|') i++; continue; }
    if (c === '&' && n !== '>' && !(cur.endsWith('>'))) { endSeg(); if (n === '&') i++; continue; }
    if (c === '<' && n === '<') { endWord(); let j = i; while (j < text.length && !/\s/.test(text[j])) j++; words.push({ text: text.slice(i, j) }); i = j - 1; continue; }
    if (c === '>' || c === '<' || (c === '&' && n === '>')) {
      let fd = '';
      if (has && /^\d$/.test(cur)) { fd = cur; cur = ''; has = false; } else endWord();
      let op = fd + c, j = i;
      if (c === '&') { op += '>'; j++; }
      if (text[j + 1] === '>' ) { op += '>'; j++; }
      if (text[j + 1] === '&') { op += '&'; j++; while (/[\d-]/.test(text[j + 1] || '')) { op += text[++j]; } }
      else if (text[j + 1] === '|') { op += '|'; j++; }
      words.push({ text: op, op: true }); i = j; continue;
    }
    cur += c; has = true;
  }
  endSeg();
  return segs;
}

// ---------- paths ----------
function makeResolver({ projectDir, tmp, home, vars }) {
  // A word to one full path, or null when it is built at run time or the hub cannot tell where it is.
  return function path(word, cwd) {
    let s = String(word);
    const v = /^\$\{?(\w+)\}?$/.exec(s) || /^\$env:(\w+)$/i.exec(s);
    if (v && /^(temp|tmp|tmpdir)$/i.test(v[1])) return String(tmp).replace(/\\/g, '/');
    if (v && /^(home|userprofile)$/i.test(v[1])) return String(home).replace(/\\/g, '/');
    if (v) { const x = vars.get(v[1].toLowerCase()); if (x == null) return null; s = x; }
    s = s.replace(/^(?:\$\{?(?:TEMP|TMP|TMPDIR)\}?|\$env:(?:TEMP|TMP)|%(?:TEMP|TMP)%)(?=[\\/]|$)/i, tmp)
      .replace(/^(?:~|\$\{?HOME\}?|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i, home)
      .replace(/^\/tmp(?=\/|$)/, tmp);
    if (/[$`*?%\u0001]|\$\(/.test(s) || !s) return null;
    const m = /^\/([a-z])(\/.*)?$/i.exec(s);
    if (m) s = `${m[1]}:${m[2] || '/'}`;
    else if (/^[\\/]{1,2}(?![a-z]\/)/i.test(s) && process.platform === 'win32') return null;
    if (!isAbsolute(s)) { if (!cwd) return null; s = resolve(cwd, s); }
    return resolve(s).replace(/\\/g, '/');   // the case kept: git is asked about the file by its name
  };
}

// ---------- inline code: what it writes ----------
const lit = e => { const m = /^(["'`])((?:(?!\1)[^\\\n])*)\1$/.exec(String(e).trim()); return m && !(m[1] === '`' && m[2].includes('${')) ? m[2] : null; };
function jsWrites(code, vars) {
  const out = [];
  for (const m of code.matchAll(/\b(?:writeFileSync|appendFileSync|writeFile|appendFile)\s*\(\s*([^,)]+?)\s*[,)]/g)) out.push(lit(m[1]) ?? (/^\w+$/.test(m[1].trim()) ? vars.get(m[1].trim().toLowerCase()) ?? null : null));
  return out;
}
function pyWrites(code, vars) {
  const out = [];
  for (const m of code.matchAll(/\bopen\s*\(\s*([^,)]+?)\s*,\s*(?:mode\s*=\s*)?(["'])([^"']*)\2/g)) if (/[wa+]/.test(m[3]) && !/x/.test(m[3])) out.push(lit(m[1]) ?? (/^\w+$/.test(m[1].trim()) ? vars.get(m[1].trim().toLowerCase()) ?? null : null));
  for (const m of code.matchAll(/\bPath\s*\(\s*([^)]+?)\s*\)\s*\.\s*write_(?:text|bytes)\s*\(/g)) out.push(lit(m[1]) ?? (/^\w+$/.test(m[1].trim()) ? vars.get(m[1].trim().toLowerCase()) ?? null : null));
  return out;
}
// NAME = 'literal' (JS, Python), NAME=literal (shell), $name = 'literal' (PowerShell): the first assignment of each name.
function varsOf(text) {
  const vars = new Map();
  const add = (k, v) => { k = k.toLowerCase(); if (!vars.has(k)) vars.set(k, v); };
  for (const m of text.matchAll(/(?:^|[\s;(])(?:const\s+|let\s+|var\s+)?([A-Za-z_]\w*)\s*=\s*(["'])([^"'\n$`]*)\2/g)) add(m[1], m[3]);
  for (const m of text.matchAll(/(?:^|[\s;&|(])\$([A-Za-z_]\w*)\s*=\s*(["'])([^"'\n$`]*)\2/g)) add(m[1], m[3]);
  for (const m of text.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=([^\s"'$`;&|()<>]+)/g)) add(m[1], m[2]);
  return vars;
}

const PS_VALUE_FLAGS = /^-(value|encoding|width|inputobject|stream|filter|include|exclude|delimiter|nonewline)$/i;
const PS_PATH_FLAGS = /^-(path|literalpath|filepath)$/i;
function psTarget(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (PS_PATH_FLAGS.test(a)) return args[i + 1]?.text ?? null;
    const m = /^-(?:path|literalpath|filepath):(.+)$/i.exec(a);
    if (m) return m[1];
    if (a.startsWith('-')) { if (PS_VALUE_FLAGS.test(a)) i++; continue; }
    return a;
  }
  return null;
}
function sedTargets(args) {
  let inPlace = false, hasScript = false;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (a === '--in-place' || /^--in-place=/.test(a)) { inPlace = true; continue; }
    if (a === '-e' || a === '-f' || a === '--expression' || a === '--file') { hasScript = true; i++; continue; }
    if (/^--(expression|file)=/.test(a)) { hasScript = true; continue; }
    if (/^--/.test(a)) continue;
    if (/^-[A-Za-z]/.test(a) && !args[i].quoted) {
      if (/^-[A-Za-z]*i/.test(a)) inPlace = true;
      if (/^-[A-Za-z]*e$/.test(a)) { hasScript = true; i++; }
      continue;
    }
    pos.push(a);
  }
  return inPlace ? (hasScript ? pos : pos.slice(1)) : null;
}
function perlTargets(args) {
  let inPlace = false, sawE = false;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].text;
    if (/^-[A-Za-z]*e$/i.test(a)) { sawE = true; if (/^-[A-Za-z]*i/i.test(a)) inPlace = true; i++; continue; }
    if (/^-[A-Za-z]*i/.test(a) && !args[i].quoted) { inPlace = true; if (/e$/.test(a)) { sawE = true; i++; } continue; }
    if (a.startsWith('-') && !args[i].quoted) continue;
    files.push(a);
  }
  return inPlace && sawE ? files : null;
}

// ---------- the check ----------
export function inlineRewrite({ tool, command, cwd, projectDir, tmp = tmpdir(), home = homedir(), isTracked = defaultIsTracked, isFile = defaultIsFile } = {}) {
  if (!/^(Bash|PowerShell)$/.test(tool) || !command || !projectDir) return null;
  const ps = tool === 'PowerShell';
  const raw = String(command);
  const { text, bodies } = takeHeredocs(raw);
  const vars = varsOf(raw);
  const toPath = makeResolver({ projectDir, tmp, home, vars });
  // A path that is an existing file inside the project and not in a temp folder: the only thing refused.
  const mine = (word, at) => {
    const p = toPath(word, at);
    if (!p || under(p, tmp) || !under(p, projectDir) || !isFile(p)) return null;
    return p;
  };
  const any = (words, at) => words.some(w => w != null && mine(w, at));
  let at = cwd || projectDir;
  for (const seg of segments(text, ps)) {
    let w = seg;
    for (;;) {   // VAR=x in front, and the wrappers that only run what follows
      if (!w.length) break;
      if (!w[0].quoted && /^[A-Za-z_]\w*=/.test(w[0].text) && w.length > 1) { w = w.slice(1); continue; }
      if (/^(nohup|time|command|exec)$/i.test(w[0].text) && w.length > 1) { w = w.slice(1); continue; }
      if (/^timeout$/i.test(w[0].text) && w.length > 2) { w = w.slice(1); while (w.length > 1 && /^(-\S+|\d+(\.\d+)?[smhd]?)$/.test(w[0].text)) w = w.slice(1); continue; }
      break;
    }
    if (!w.length) continue;
    const prog = w[0].text.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
    const args = w.slice(1);
    // a cd carries to what follows; one the hub cannot work out makes relative paths unknown (nothing is then refused)
    if (/^(cd|chdir|pushd|set-location|sl)$/.test(prog)) {
      const a = args.find(x => !/^\/d$/i.test(x.text) && !/^-(path|literalpath|l|p)$/i.test(x.text));
      at = a ? toPath(a.text, at) : null;
      continue;
    }
    // output redirects onto an existing tracked file
    for (let i = 0; i < w.length; i++) {
      const o = w[i];
      if (!o.op || !/^\d*>>?\|?$/.test(o.text) || /^[02]?>&/.test(o.text)) continue;
      const t = w[i + 1];
      if (!t || t.op || /^(\/dev\/null|\$null|nul)$/i.test(t.text)) continue;
      const p = mine(t.text, at);
      if (p && isTracked(p)) return REWRITE_REASON;
    }
    if (prog === 'sed') { const t = sedTargets(args); if (t && any(t, at)) return REWRITE_REASON; continue; }
    if (prog === 'perl') { const t = perlTargets(args); if (t && any(t, at)) return REWRITE_REASON; continue; }
    if (/^(set-content|sc|add-content|ac|out-file)$/.test(prog)) { const t = psTarget(args); if (t != null && mine(t, at)) return REWRITE_REASON; continue; }
    const js = /^(node|nodejs|bun)$/.test(prog), py = /^(python[\d.]*|py|pypy[\d.]*)$/.test(prog);
    if (js || py) {
      let code = null;
      for (let i = 0; i < args.length; i++) {
        const a = args[i].text;
        if (js && /^(-e|--eval|-p|--print)$/.test(a)) { code = args[i + 1]?.text ?? null; break; }
        if (py && a === '-c') { code = args[i + 1]?.text ?? null; break; }
      }
      if (code === null) {   // a script on stdin: node - <<EOF, python3 <<EOF
        const h = args.map(x => /^<<HDOC(\d+)$/.exec(x.text)).find(Boolean);
        if (h && (args.some(x => x.text === '-') || !args.some(x => !x.op && !/^<<HDOC/.test(x.text) && !x.text.startsWith('-')))) code = bodies[Number(h[1])];
      }
      if (code) {
        const own = varsOf(code);
        for (const [k, v] of vars) if (!own.has(k)) own.set(k, v);
        const targets = js ? jsWrites(code, own) : pyWrites(code, own);
        if (any(targets, at)) return REWRITE_REASON;
      }
    }
  }
  // .NET writes named by an absolute path in PowerShell code (their relative paths follow the process folder, which may differ)
  if (ps || /\b(?:powershell|pwsh)\b/i.test(raw)) {
    for (const m of raw.matchAll(/\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines)\s*\(\s*(["'])([^"'$`]+)\1/gi)) {
      if (isAbsolute(m[2].replace(/^\/([a-z])\//i, '$1:/')) && mine(m[2], null)) return REWRITE_REASON;
    }
  }
  return null;
}

function defaultIsFile(p) { try { return statSync(p).isFile(); } catch { return false; } }
// Tracked by git: asked of git itself, with the repository's own config unable to run anything. Any failure: not tracked (not refused).
function defaultIsTracked(p) {
  try {
    execFileSync('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', 'ls-files', '--error-unmatch', '--', p.split('/').pop()], { cwd: dirname(p), stdio: 'ignore', timeout: 4000, windowsHide: true });
    return true;
  } catch { return false; }
}
