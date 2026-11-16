// The Expedition module's desk (spec 4.8, phase 5): the worktree, the branch expedition/<id>, the commit, the push and the
// DRAFT pull request at the end of an expedition. Modelled on DecisionsDesk. It never merges: there is no merge call here,
// the pull request is made with --draft, and nothing is ever forced.
//
// Every operation is safe to repeat (the end sequence may run again after a restart): the worktree is made only when it is
// missing, a commit with nothing new returns the existing one, a push of the same commits is a no-op, and a pull request is
// looked up by its branch before one is made.
//
// git(args, cwd) and gh(args, cwd) return a promise of stdout (the real ones have timeouts; tests pass fakes or a real repo).
// local: a test hub commits but never pushes or opens a pull request on the real GitHub (as DecisionsDesk.local).
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { gitAsync, runGh } from './decisions-desk.mjs';

export const REPORT_DIR = 'docs/expeditions';   // where the report lands on the branch: docs/expeditions/<id>/REPORT.md

export class ExpeditionDesk {
  constructor({ ex, git = gitAsync, gh = runGh, local = false, remote = 'origin' }) {
    Object.assign(this, { ex, git, gh, local, remote });
    this.base = null;   // the branch the pull request is against, found by ensureWorktree
  }

  get projectDir() { return this.ex.project.dir; }
  get dir() { return this.ex.worktree; }
  get branch() { return this.ex.branch; }
  get reportRel() { return `${REPORT_DIR}/${this.ex.id}/REPORT.md`; }
  usable() { return existsSync(join(this.projectDir, '.git')); }
  tryGit = async (args, cwd = this.dir) => { try { return String(await this.git(args, cwd)).trim(); } catch { return null; } };
  has = async ref => (await this.tryGit(['rev-parse', '--verify', '--quiet', ref], this.projectDir)) !== null;

  // The build worktree on expedition/<id>: the Builder normally made it already; if not, it is made here from the remote's
  // main (else HEAD), so the branch carries at least the report. Never touches the main folder (convention C005).
  async ensureWorktree() {
    if (!this.usable()) throw new Error('the project is not a git repository, so there is no branch to make');
    await this.findBase();
    if (existsSync(join(this.dir, '.git'))) return this.dir;
    try {   // a local exclude, never committed: the worktrees stay out of the main folder's status
      const ex = join(this.projectDir, '.git', 'info', 'exclude');
      const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
      if (!/^\/?\.claude\/worktrees\/?$/m.test(cur)) { mkdirSync(dirname(ex), { recursive: true }); writeFileSync(ex, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '/.claude/worktrees/\n'); }
    } catch { /* best effort */ }
    mkdirSync(dirname(this.dir), { recursive: true });
    if (await this.has(`refs/heads/${this.branch}`)) await this.git(['worktree', 'add', this.dir, this.branch], this.projectDir);
    else if (await this.has(`refs/remotes/${this.remote}/${this.branch}`)) await this.git(['worktree', 'add', '--no-track', '-b', this.branch, this.dir, `${this.remote}/${this.branch}`], this.projectDir);
    else await this.git(['worktree', 'add', '--no-track', '-b', this.branch, this.dir, await this.has(`refs/remotes/${this.remote}/${this.base}`) ? `${this.remote}/${this.base}` : 'HEAD'], this.projectDir);
    return this.dir;
  }

  async findBase() {
    if (this.base) return this.base;
    await this.tryGit(['fetch', '-q', this.remote], this.projectDir);
    const head = await this.tryGit(['symbolic-ref', '--short', `refs/remotes/${this.remote}/HEAD`], this.projectDir);   // origin/main
    this.base = head ? head.replace(new RegExp(`^${this.remote}/`), '') : (await this.has(`refs/remotes/${this.remote}/main`)) ? 'main' : (await this.has(`refs/remotes/${this.remote}/master`)) ? 'master' : 'main';
    return this.base;
  }

  // Copy the report onto the branch and commit everything the worktree holds (the build, the report). A second call with
  // nothing new changes nothing and returns the commit that is already there. -> { commit (short hash), already }
  async commit(message) {
    await this.ensureWorktree();
    const from = join(this.ex.root, 'REPORT.md');
    if (!existsSync(from)) throw new Error('REPORT.md is missing, so there is nothing to put on the branch');
    const to = join(this.dir, ...this.reportRel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    await this.git(['add', '-A'], this.dir);
    const staged = String((await this.tryGit(['diff', '--cached', '--name-only'])) || '').trim();
    if (!staged) return { commit: await this.tryGit(['rev-parse', '--short', 'HEAD']), already: true };
    await this.git(['commit', '-q', '-m', message], this.dir);
    return { commit: await this.tryGit(['rev-parse', '--short', 'HEAD']), already: false };
  }

  // Push the branch (never forced). { ok, local }: a test hub does not push.
  async push() {
    if (this.local) return { ok: false, local: true };
    await this.git(['push', '-q', '-u', this.remote, this.branch], this.dir);
    return { ok: true, local: false };
  }

  // The DRAFT pull request for the branch: the one that exists, else a new one. { url, number, draft, existed }
  async pr({ title, body }) {
    if (this.local) return { ok: false, local: true };
    let list = [];
    try { list = JSON.parse(await this.gh(['pr', 'list', '--head', this.branch, '--state', 'all', '--json', 'number,url,isDraft'], this.dir) || '[]'); } catch { list = []; }
    if (list.length) return { url: list[0].url, number: list[0].number, draft: !!list[0].isDraft, existed: true };
    const out = String(await this.gh(['pr', 'create', '--draft', '--base', await this.findBase(), '--head', this.branch, '--title', title, '--body', body], this.dir));
    const url = /https?:\/\/\S+/.exec(out)?.[0] || null;
    return { url, number: Number(/\/pull\/(\d+)/.exec(url || '')?.[1]) || null, draft: true, existed: false };
  }
}
