// Where decision records land (decision 35 A): never in the project's main folder (convention C005). Picks from the
// hub page, and the orchestrator's drafts, are written into a standing worktree, <project>/.claude/worktrees/decisions,
// on the branch docs/decisions. The hub builds the Crux pages there, commits the records (.json, .md; the pages stay
// local, decision 41), pushes, and keeps one rolling pull request open, "Decision records (rolling)". The board reads the main folder plus this worktree, so a pick shows at once.
// If pushing or the pull request fails (offline, no gh), the commit stays local, a notice says so, and the next write retries.
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureGitignore } from '../../crux/scripts/build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const BUILD = resolve(here, '../../crux/scripts/build.mjs');
export const PR_TITLE = 'Decision records (rolling)';

// The GitHub CLI: CRUX_HUB_GH, else its usual Windows install, else gh on the PATH.
function findGh() {
  if (process.env.CRUX_HUB_GH) return process.env.CRUX_HUB_GH;
  const win = 'C:/Program Files/GitHub CLI/gh.exe';
  return existsSync(win) ? win : 'gh';
}

// gh(args, cwd) -> Promise<stdout>. Replaceable in tests.
export const runGh = (args, cwd) => new Promise((res, rej) =>
  execFile(findGh(), args, { cwd, timeout: 60000, windowsHide: true }, (e, out, err) => e ? rej(new Error(String(err || e.message).trim())) : res(String(out))));

const gitAsync = (args, cwd) => new Promise((res, rej) =>
  execFile('git', args, { cwd, timeout: 120000, windowsHide: true }, (e, out, err) => e ? rej(new Error(String(err || e.message).trim())) : res(String(out))));

export class DecisionsDesk {
  constructor({ projectDir, remote = 'origin', base = 'main', branch = 'docs/decisions', gh = runGh, build = BUILD, notice = () => {} }) {
    Object.assign(this, { projectDir: resolve(projectDir), remote, base, branch, gh, build, notice });
    this.publishing = null;   // the push and pull request in flight, if any
    this.again = false;       // another write came in while publishing
  }

  get dir() { return join(this.projectDir, '.claude', 'worktrees', 'decisions'); }
  get decisionsDir() { return join(this.dir, '.decisions'); }

  git(args, cwd = this.dir) { return String(execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, windowsHide: true })).trim(); }
  tryGit(args, cwd) { try { return this.git(args, cwd); } catch { return null; } }

  // A project that is a git repo gets the worktree; one that is not keeps its records in place (C005 is about main).
  usable() { return existsSync(join(this.projectDir, '.git')); }
  ready() { return existsSync(join(this.dir, '.git')); }

  // Create the worktree if it is missing: from the existing branch, else from the remote's copy, else from origin/main.
  ensure() {
    if (this.ready()) return true;
    if (!this.usable()) return false;
    // Keep the worktree out of the main folder's git status: a local exclude, never committed.
    try {
      const ex = join(this.projectDir, '.git', 'info', 'exclude');
      const cur = existsSync(ex) ? readFileSync(ex, 'utf8') : '';
      if (!/^\/?\.claude\/worktrees\/?$/m.test(cur)) { mkdirSync(dirname(ex), { recursive: true }); writeFileSync(ex, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '/.claude/worktrees/\n'); }
    } catch { }
    this.tryGit(['fetch', '-q', this.remote], this.projectDir);
    mkdirSync(dirname(this.dir), { recursive: true });
    const has = ref => this.tryGit(['rev-parse', '--verify', '--quiet', ref], this.projectDir) !== null;
    if (has(`refs/heads/${this.branch}`)) this.git(['worktree', 'add', this.dir, this.branch], this.projectDir);
    else if (has(`refs/remotes/${this.remote}/${this.branch}`)) this.git(['worktree', 'add', '--no-track', '-b', this.branch, this.dir, `${this.remote}/${this.branch}`], this.projectDir);
    else this.git(['worktree', 'add', '--no-track', '-b', this.branch, this.dir, has(`refs/remotes/${this.remote}/${this.base}`) ? `${this.remote}/${this.base}` : 'HEAD'], this.projectDir);
    this.ignorePages();
    return true;
  }

  // Decision 41: the records go into git, the pages stay local. A .gitignore inside .decisions ignores *.html; it is
  // committed with the next record, so the branch carries it.
  ignorePages() {
    try { mkdirSync(this.decisionsDir, { recursive: true }); ensureGitignore(this.decisionsDir); }
    catch (e) { console.warn('Could not write .decisions/.gitignore:', e.message); }
  }

  // Before each write: catch up with main. A fast-forward only, so the branch is never rewritten and pushes never need
  // force. It succeeds when every earlier pick has merged (no open pull request); with picks still waiting it is skipped.
  sync() {
    this.tryGit(['fetch', '-q', this.remote]);
    this.tryGit(['merge', '--ff-only', '-q', `${this.remote}/${this.base}`]);
  }

  // Write records (file name -> record object or text), build the pages, commit, then push and update the PR.
  record(files, message) {
    this.ensure();
    this.sync();
    mkdirSync(this.decisionsDir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(this.decisionsDir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 1) + '\n');
    }
    return this.commit(message);
  }

  // Drafts the orchestrator wrote into the worktree: commit them when its turn ends.
  commitPending(message = 'Record drafts') {
    if (!this.ready()) return null;
    const changed = this.tryGit(['status', '--porcelain', '--', '.decisions']);
    if (!changed) return null;
    return this.commit(message);
  }

  commit(message) {
    this.ignorePages();
    this.rebuild();
    this.git(['add', '-A', '--', '.decisions']);
    if (this.tryGit(['diff', '--cached', '--quiet']) !== null) return null;   // nothing changed
    this.git(['commit', '-q', '-m', message]);
    return { commit: this.git(['rev-parse', '--short', 'HEAD']), published: this.publish() };
  }

  rebuild() {
    if (!existsSync(this.build) || !existsSync(this.decisionsDir)) return;
    try { execFileSync(process.execPath, [this.build, this.decisionsDir], { stdio: 'ignore', timeout: 30000, windowsHide: true }); }
    catch (e) { console.warn('Crux build failed:', e.message); }
  }

  // Push the branch and keep one open pull request. Runs in the background; writes made meanwhile are pushed after.
  publish() {
    // A test hub (or a desk told to stay local) commits but never pushes or opens a PR on the real GitHub.
    if (this.local) {
      if (!this.saidLocal) this.notice('Test hub: decision records are committed on docs/decisions here but never pushed.');
      this.saidLocal = true;
      return Promise.resolve({ ok: false, local: true });
    }
    if (this.publishing) { this.again = true; return this.publishing; }
    this.publishing = (async () => {
      try {
        do { this.again = false; await this.pushAndPr(); } while (this.again);
        this.failing = false;
        return { ok: true };
      } catch (e) {
        if (!this.failing) this.notice(`Decision records are committed on ${this.branch} but not yet on GitHub (${e.message.split('\n')[0].slice(0, 160)}). The hub tries again with the next pick.`);
        this.failing = true;
        return { ok: false, error: e.message };
      } finally { this.publishing = null; }
    })();
    return this.publishing;
  }

  async pushAndPr() {
    await gitAsync(['push', '-q', '-u', this.remote, this.branch], this.dir);
    const body = this.prBody();
    const open = JSON.parse(await this.gh(['pr', 'list', '--head', this.branch, '--state', 'open', '--json', 'number'], this.dir) || '[]');
    if (open.length) await this.gh(['pr', 'edit', String(open[0].number), '--body', body], this.dir);
    else await this.gh(['pr', 'create', '--base', this.base, '--head', this.branch, '--title', PR_TITLE, '--body', body], this.dir);
  }

  // The picks and drafts on the branch that main does not have yet, one line each.
  prBody() {
    const log = this.tryGit(['log', '--format=%s', `${this.remote}/${this.base}..HEAD`]) || '';
    const lines = log.split('\n').filter(Boolean).reverse();
    return [
      'Decision records from the Crux hub (decision 35 A). Picks from the hub page and the orchestrator\'s drafts land here, never in the main folder.',
      '',
      ...(lines.length ? lines.map(l => `- ${l}`) : ['- (none yet)']),
      '',
      'This pull request stays open and grows with each pick until it is merged.'
    ].join('\n');
  }

  // A page for the hub to serve: the worktree's copy when it has one.
  page(name) {
    const f = join(this.decisionsDir, name);
    return existsSync(f) && statSync(f).isFile() ? f : null;
  }
}

export function readJson(file) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } }
