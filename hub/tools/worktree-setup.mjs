#!/usr/bin/env node
// Link or unlink a worktree's node_modules (plan v3, A8). A new worktree has no packages; this makes
// <worktree>\hub\node_modules a junction to the project's own <project>\hub\node_modules, and removes it again.
//   node <project>/hub/tools/worktree-setup.mjs link   <worktree>
//   node <project>/hub/tools/worktree-setup.mjs unlink <worktree>
// The hub's checker lets an agent run this script by its full path in the project (never a copy inside a worktree, which
// the worker can edit), so it does only these two things, and refuses anything else:
// - the worktree must sit directly under <project>\.claude\worktrees, and have a hub folder;
// - link never replaces anything: a real folder or another link there is left alone;
// - unlink removes only a link that points at the project's own node_modules, with rmdir on the link itself, never a
//   recursive delete (which would empty the packages the link points to).
// Installing packages in a worktree that has the link changes the project's own packages: the checker counts that as an
// install into the main project.
import { existsSync, lstatSync, symlinkSync, rmdirSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const same = (a, b) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const isLink = p => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const isDir = p => { try { return lstatSync(p).isDirectory(); } catch { return false; } };

// The project this copy of the script belongs to: the folder that holds hub/tools/worktree-setup.mjs.
export const projectOfScript = (url = import.meta.url) => resolve(dirname(fileURLToPath(url)), '..', '..');

// Checks the worktree and returns its hub\node_modules path, or { error }.
function place(project, worktree) {
  const root = join(project, '.claude', 'worktrees');
  if (/[\\/]\.claude[\\/]worktrees[\\/]/i.test(project + '\\')) return { error: 'Run the project\'s own copy of this script, not one inside a worktree.' };
  if (!worktree) return { error: 'Give the worktree folder.' };
  const wt = resolve(worktree);
  const rel = relative(root, wt);
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || /[\\/]/.test(rel)) return { error: `The worktree must be a folder directly under ${root}.` };
  if (!isDir(wt) || isLink(wt)) return { error: `${wt} is not a worktree folder.` };
  if (!isDir(join(wt, 'hub')) || isLink(join(wt, 'hub'))) return { error: `${wt} has no hub folder.` };
  return { target: join(project, 'hub', 'node_modules'), link: join(wt, 'hub', 'node_modules') };
}

// -> { ok, message }. Changes the disk only for link (makes the junction) and unlink (removes it).
export function linkWorktree(project, worktree) {
  const p = place(project, worktree);
  if (p.error) return { ok: false, message: p.error };
  if (!isDir(p.target) || isLink(p.target)) return { ok: false, message: `The project has no packages folder of its own to link to (${p.target}). Run the install there first.` };
  if (existsSync(p.link) || isLink(p.link)) {
    if (isLink(p.link) && same(realpathSync(p.link), realpathSync(p.target))) return { ok: true, message: 'Already linked.' };
    return { ok: false, message: `${p.link} already exists and is not a link to the project's packages; left alone.` };
  }
  symlinkSync(p.target, p.link, 'junction');
  return { ok: true, message: `Linked ${p.link} to ${p.target}.` };
}

export function unlinkWorktree(project, worktree) {
  const p = place(project, worktree);
  if (p.error) return { ok: false, message: p.error };
  if (!isLink(p.link)) return existsSync(p.link)
    ? { ok: false, message: `${p.link} is a real folder, not a link; left alone.` }
    : { ok: true, message: 'No link there.' };
  let at; try { at = realpathSync(p.link); } catch { at = null; }
  if (at && !same(at, realpathSync(p.target))) return { ok: false, message: `${p.link} points somewhere other than the project's packages; left alone.` };
  rmdirSync(p.link);   // the link itself (rmdir on a junction never touches what it points to)
  return { ok: !isLink(p.link) && isDir(p.target), message: `Removed the link ${p.link}; the project's packages are untouched.` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sub, worktree, ...extra] = process.argv.slice(2);
  if (!/^(link|unlink)$/.test(sub || '') || extra.length) { console.error('Usage: node hub/tools/worktree-setup.mjs link|unlink <worktree>'); process.exit(2); }
  const r = (sub === 'link' ? linkWorktree : unlinkWorktree)(projectOfScript(), worktree);
  (r.ok ? console.log : console.error)(r.message);
  process.exit(r.ok ? 0 : 1);
}
