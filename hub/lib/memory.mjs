// The layers above a project's board (decision 13): what is known about the user, and what all projects share.
// They live in the private memory folder (decision 14): ~/crux, or CRUX_HOME.
//   profile/core.md          loaded by every agent (decision 15)
//   profile/packs/<name>.md  loaded only by agents in that project
//   profile/private.md       read on request, never loaded by default
//   conventions.md           the cross-project roll-up Crux writes
//   media/<project>/         visuals agents post to the hub (kept out of project repos)
import { readFileSync, existsSync, appendFileSync, mkdirSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const read = f => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
export const VISUAL_TYPES = { '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image', '.html': 'page' };

export class Memory {
  constructor(home = process.env.CRUX_HOME || join(homedir(), 'crux')) {
    this.home = home;
    this.profileDir = join(home, 'profile');
    this.packsDir = join(this.profileDir, 'packs');
    this.mediaDir = join(home, 'media');
  }

  core() { return read(join(this.profileDir, 'core.md')).trim(); }

  // The person's name, from the core's title ("# Working with Matt: core"). Agents use it instead of "the user".
  userName() {
    const m = /^#\s*Working with\s+([^:<\n]+?)\s*:/m.exec(this.core());
    return m ? m[1] : null;
  }
  personalize(s) {
    const name = this.userName();
    return String(s).replaceAll('{{who}}', name || 'the user').replaceAll('{{Who}}', name || 'The user');
  }
  private() { return read(join(this.profileDir, 'private.md')).trim(); }
  conventions() { return read(join(this.home, 'conventions.md')).trim(); }

  // Which pack a project folder uses: packs/_index.md may map folder names ("- demo.md: demo.lab, demo.*"),
  // otherwise the folder name itself.
  packName(project) {
    const name = project.toLowerCase();
    for (const line of read(join(this.packsDir, '_index.md')).split('\n')) {
      // "- demo.md: demo.lab, demo.*" or a table row "| `demo.md` | `demo.lab`, `demo.*` (alpha, beta) | ... |"
      const m = /^\s*\|\s*`?([\w.-]+)\.md`?\s*\|\s*([^|]+)\|/.exec(line) || /([\w.-]+)\.md\b.*?:\s*(.+)$/.exec(line);
      if (!m) continue;
      // Notes in brackets are for people, not folder names. "demo.*" matches any folder starting "demo.".
      const globs = m[2].replace(/\([^)]*\)/g, '').split(/[,;]/).map(s => s.replace(/[`_]/g, '').trim().toLowerCase()).filter(Boolean);
      if (globs.some(g => g === name || (g.endsWith('.*') && name.startsWith(g.slice(0, -1))))) return m[1];
    }
    return existsSync(join(this.packsDir, `${name}.md`)) ? name : null;
  }
  pack(project) { const n = this.packName(project); return n ? read(join(this.packsDir, `${n}.md`)).trim() : ''; }
  packs() { try { return readdirSync(this.packsDir).filter(f => f.endsWith('.md') && !f.startsWith('_')).map(f => f.slice(0, -3)); } catch { return []; } }

  readSection(section, project) {
    if (section === 'core') return this.core();
    if (section === 'private') return this.private();
    if (section === 'conventions') return this.conventions();
    const name = section === 'pack' ? this.packName(project) : section.replace(/^pack:/, '');
    return name && this.packs().includes(name) ? read(join(this.packsDir, `${name}.md`)) : '';
  }

  // A project lesson goes straight into the project's pack (decision 15); the pack is created if missing.
  addProjectLesson(project, text, from) {
    mkdirSync(this.packsDir, { recursive: true });
    const name = this.packName(project) || project.toLowerCase();
    const file = join(this.packsDir, `${name}.md`);
    const body = read(file);
    const head = body ? '' : `# ${project} pack\n`;
    const section = body.includes('\n## Lessons added by agents') ? '' : '\n## Lessons added by agents\n';
    appendFileSync(file, `${head}${section}- ${today()} (${from}): ${text.trim()}\n`);
    return name;
  }

  // A core lesson the user approved.
  addCoreLesson(text, from) {
    const file = join(this.profileDir, 'core.md');
    const body = read(file);
    const section = body.includes('\n## Lessons added by agents') ? '' : '\n\n## Lessons added by agents\n';
    appendFileSync(file, `${section}- ${today()} (${from}, approved): ${text.trim()}\n`);
  }

  // Copy a visual an agent made into the media folder; returns its stored name and kind.
  storeVisual(project, path) {
    const ext = extname(path).toLowerCase();
    const kind = VISUAL_TYPES[ext];
    if (!kind) throw new Error(`Visuals must be one of ${Object.keys(VISUAL_TYPES).join(', ')}`);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`No file at ${path}`);
    if (statSync(path).size > 8 * 1024 * 1024) throw new Error('Visuals must be under 8 MB');
    const dir = join(this.mediaDir, safe(project));
    mkdirSync(dir, { recursive: true });
    const file = `${randomUUID().slice(0, 8)}-${safe(basename(path, ext))}${ext}`;
    copyFileSync(path, join(dir, file));
    return { file, kind };
  }
  mediaPath(project, file) { return join(this.mediaDir, safe(project), basename(file)); }
}

const today = () => new Date().toISOString().slice(0, 10);
const safe = s => String(s).replace(/[^\w.-]+/g, '-').slice(0, 60);
