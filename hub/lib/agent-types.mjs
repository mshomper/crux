// Agent types (decision 20): Claude Code's own agent files, so the same types work in plain Claude Code.
//   ~/.claude/agents/*.md           every project
//   <project>/.claude/agents/*.md   that project only; wins on a name clash
// Frontmatter: name, description, model (opus | sonnet | haiku | fable | inherit | a full model id),
// effort (the hub's addition: low | medium | high | xhigh | max) and tools (comma list or YAML list).
// The body is the type's standing instructions. Unknown fields are ignored.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export const MODELS = [
  { key: 'opus', id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { key: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { key: 'haiku', id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { key: 'fable', id: 'claude-fable-5-2', label: 'Fable 5.2' }
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// A short name or full id to the id passed to the SDK; null means Claude Code's own default.
export function modelId(v) {
  const s = String(v ?? '').trim();
  if (!s || /^(inherit|default)$/i.test(s)) return null;
  return MODELS.find(m => m.key === s.toLowerCase())?.id || s;
}
export function effortLevel(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return EFFORTS.includes(s) ? s : null;
}
// "claude-opus-5-5" -> "Opus 5.5"; ids it does not recognise are shown as they are.
export function modelLabel(id) {
  if (!id) return 'Default model';
  const known = MODELS.find(m => m.id === id);
  if (known) return known.label;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:\b|-)/i.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : id;
}

// ---------- a small YAML-frontmatter reader (only what agent files use) ----------
const unquote = s => {
  s = s.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\(["\\nt])/g, (_, c) => ({ n: '\n', t: '\t' }[c] || c)) : inner.replace(/''/g, "'");
  }
  return s.replace(/\s+#.*$/, '');   // trailing comment on a plain value
};

export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { data: {}, body: src.trim() };
  const lines = m[1].split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line) || /^\s/.test(line)) continue;   // blank, comment, or a stray indented line
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rest] = kv;
    const block = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || (!lines[i + 1].trim() && /^\s/.test(lines[i + 2] || '')))) block.push(lines[++i]);
    const raw = rest.trim();
    if (/^[|>][+-]?$/.test(raw)) {                       // block scalar: | keeps lines, > folds them
      const indent = Math.min(...block.filter(l => l.trim()).map(l => /^\s*/.exec(l)[0].length));
      const body = block.map(l => l.slice(indent));
      data[key] = (raw[0] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ')).trim();
    } else if (raw.startsWith('[') && raw.endsWith(']')) { // flow list
      data[key] = raw.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else if (!raw && block.length && block.every(l => !l.trim() || /^\s*-\s/.test(l))) { // block list
      data[key] = block.filter(l => l.trim()).map(l => unquote(l.replace(/^\s*-\s/, '')));
    } else {                                              // plain or quoted, maybe continued on indented lines
      data[key] = unquote([raw, ...block.map(l => l.trim())].filter(Boolean).join(' '));
    }
  }
  return { data, body: src.slice(m[0].length).trim() };
}

const toList = v => (Array.isArray(v) ? v : String(v ?? '').split(',')).map(s => String(s).trim()).filter(Boolean);

export function parseAgentFile(text, fileName = '') {
  const { data, body } = parseFrontmatter(text);
  const name = String(data.name || basename(fileName, '.md')).trim();
  if (!name) return null;
  return {
    name,
    description: String(data.description || '').trim(),
    model: modelId(data.model),
    effort: effortLevel(data.effort),
    tools: data.tools == null || data.tools === '' ? null : toList(data.tools),
    prompt: body
  };
}

// Every type a project can use. Files are read on each call, so a new or edited type shows up without a restart.
export class AgentTypes {
  constructor({ home = homedir(), projectDir = null } = {}) {
    this.dirs = [['home', join(home, '.claude', 'agents')], ...(projectDir ? [['project', join(projectDir, '.claude', 'agents')]] : [])];
  }

  list() {
    const byName = new Map();
    for (const [source, dir] of this.dirs) {
      if (!existsSync(dir)) continue;
      let files = [];
      try { files = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')).sort(); } catch { continue; }
      for (const f of files) {
        let t = null;
        try { t = parseAgentFile(readFileSync(join(dir, f), 'utf8'), f); } catch { /* unreadable: skip */ }
        if (t) byName.set(t.name.toLowerCase(), { ...t, source, file: join(dir, f) });   // project comes last, so it wins
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name) {
    if (!name) return null;
    const n = String(name).trim().toLowerCase();
    return this.list().find(t => t.name.toLowerCase() === n) || null;
  }
}
