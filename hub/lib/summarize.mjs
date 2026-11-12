// Plain-English summaries of what an agent's tool call will do, for permission cards.
// No model call: it reads the command itself. Each step becomes a short phrase and a tag saying
// what it touches, coloured by how much care it needs: reads, changes files, or needs real care.

const short = p => String(p || '').replace(/^["']|["']$/g, '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/');
const host = u => { try { return new URL(u).host; } catch { return String(u).replace(/^https?:\/\//, '').split('/')[0]; } };
const uniq = xs => [...new Map(xs.map(x => [x.text, x])).values()];
// "Installs web-push" -> "Install web-push": summaries read as instructions ("wants to install ...").
const base = t => t.replace(/^(\w+?)(ies|shes|ches|sses|xes|s)\b/, (m, stem, end) => stem + (end === 'ies' ? 'y' : end === 's' ? '' : end.slice(0, -2)));

export class CommandSummary {
  // { plain: 'Creates branch feat/x, then installs web-push', tags: [{ text, level: 'read'|'write'|'care' }] }
  static of(tool, input = {}) {
    if (/^(Bash|PowerShell)$/.test(tool)) return CommandSummary.command(String(input.command || ''), tool === 'PowerShell');
    const r = CommandSummary.tool(tool, input);
    return { ...r, plain: base(r.plain) };
  }

  static tool(tool, input) {
    const file = short(input.file_path || input.notebook_path || input.path);
    switch (tool) {
      case 'Edit': case 'MultiEdit': return { plain: `Edits ${file}`, tags: [{ text: `Edits ${file}`, level: 'write' }] };
      case 'Write': return { plain: `Writes ${file}`, tags: [{ text: `Writes ${file}`, level: 'write' }] };
      case 'NotebookEdit': return { plain: `Edits notebook ${file}`, tags: [{ text: `Edits ${file}`, level: 'write' }] };
      case 'Read': case 'Glob': case 'Grep': return { plain: `Reads ${file || 'files'}${input.pattern ? ` (looking for ${input.pattern})` : ''}`, tags: [{ text: 'Reads only', level: 'read' }] };
      case 'WebFetch': return { plain: `Reads a web page on ${host(input.url)}`, tags: [{ text: `Internet: ${host(input.url)}`, level: 'care' }] };
      case 'WebSearch': return { plain: `Searches the web for "${String(input.query || '').slice(0, 60)}"`, tags: [{ text: 'Internet search', level: 'care' }] };
      default: return { plain: `Uses ${tool.replace(/^mcp__\w+__/, '').replace(/_/g, ' ')}`, tags: [] };
    }
  }

  static command(cmd, ps) {
    const steps = [];
    // Inline scripts first (node -e "...", node - <<EOF ... EOF, python -c): judge them by what they touch.
    const script = /\b(node|python3?|py)(\s+--[\w-]+=\S+)*\s+(-e|-c|-|--eval|-p|--print)(?=\s|$|["'])/.test(cmd) ? cmd : '';
    const written = [...script.matchAll(/(?:writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|mkdirSync|copyFileSync)\(\s*['"`]([^'"`]+)['"`]/g)].map(m => short(m[1]));
    const read = [...script.matchAll(/(?:readFileSync|require)\(\s*['"`]([^'"`]+\.\w+)['"`]/g)].map(m => short(m[1]));
    const reaches = /\b(fetch|https?\.request|child_process|execSync|spawn|exec\()/.test(script);
    // A script that deletes or writes is never "Reads only", even when the hub cannot name what it touches.
    const deletes = /\b(rmSync|unlinkSync|rmdirSync|rm|unlink|rmdir)\s*\(|os\.(remove|unlink)\b|shutil\.rmtree/.test(script);
    const writes = /\b(writeFile|appendFile|mkdir|rename|copyFile|cp|createWriteStream|symlink|truncate)(Sync)?\s*\(|open\([^)]*['"][wa]/.test(script);
    const tempName = /tmpdir\(\)\s*,\s*['"]([\w.-]+)['"]/.exec(script)?.[1];
    if (script) {
      const named = written.length ? [...new Set(written)].join(', ') : tempName ? `temp folder ${tempName}` : 'files';
      if (deletes) steps.push({ text: `Runs a script that deletes ${named}`, tag: `Deletes ${named}`, level: 'care' });
      else if (written.length || writes) steps.push({ text: `Runs a script that changes ${named}`, tag: `Changes ${named}`, level: 'write' });
      else if (reaches) steps.push({ text: 'Runs a script that starts programs or uses the internet', tag: 'Runs code', level: 'care' });
      else if (/process\.env|os\.environ|homedir\(\)|expanduser/.test(script)) steps.push({ text: 'Runs a script that reads settings or the home folder', tag: 'Reads settings or home', level: 'care' });
      else steps.push({ text: read.length ? `Runs a small check that reads ${[...new Set(read)].join(', ')}` : 'Runs a small check', tag: 'Reads only', level: 'read' });
    }
    // Then the plain commands, skipping the body of a heredoc.
    const body = cmd.replace(/<<-?\s*'?(\w+)'?[\s\S]*?\n\1\b/g, '').replace(/\s+(2>&1|2>\s*\/dev\/null|2>\s*\$null|>\s*\/dev\/null)\b/g, ' ');
    for (const raw of CommandSummary.parts(body)) {
      let part = raw.trim();
      if (!part) continue;
      // Setting a variable is not a step of its own: T=$(cygpath ...), $t = Join-Path ..., $env:X = "...".
      // $(mktemp) makes a temp folder; any other substitution runs that program.
      const set = ps ? /^\$[\w:]+\s*=\s*(.*)$/s.exec(part) : /^[A-Za-z_]\w*=(\$\([^)]*\)|"[^"]*"|'[^']*'|\S*)$/.exec(part);
      if (set) {
        const sub = /\$\(\s*([\w.-]+)/.exec(set[1])?.[1];
        if (sub === 'mktemp') steps.push({ text: 'Makes a temp folder', tag: 'Temp folder', level: 'write' });
        else if (sub && sub !== 'cygpath') steps.push({ text: `Runs ${sub}`, tag: `Runs ${sub}`, level: 'care' });
        if (!ps || /^(["'$\d(@[]|join-path\b)/i.test(set[1].trim())) continue;
        part = set[1].trim();   // $x = Some-Command ...: the command is the step
      }
      // NAME=value in front of a command only sets it for that command; timeout N only limits how long it runs.
      part = part.replace(/^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '').replace(/^timeout\s+(?:--?[\w-]+(?:=\S+)?\s+)*\d+(?:\.\d+)?[smhd]?\s+/, '');
      const w = part.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) || [];
      const [h0raw, ...a] = w;
      // A program run by its full path is that program: "/c/Program Files/.../msedge.exe" is msedge.
      const h0 = String(h0raw || '').replace(/^["']|["']$/g, '');
      const h = (/[\\/]/.test(h0) ? h0.replace(/\\/g, '/').split('/').pop() : h0).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
      const arg = a.filter(x => !x.startsWith('-'));
      // a > inside quotes (a commit message, an arrow in a script) is text, not a redirection
      const bare = part.replace(/(>\s*)?("(?:[^"\\]|\\.)*"|'[^']*')/g, (m, gt) => gt ? m : '""');
      const redirect = /(^|[^2=-])>>?\s*([^\s&|;]+)/.exec(bare);
      if (redirect && !/\/dev\/null|\$null/.test(redirect[2])) steps.push({ text: `Writes ${short(redirect[2])}`, tag: `Writes ${short(redirect[2])}`, level: 'write' });
      if (['node', 'python', 'python3', 'py'].includes(h) && (/^(-e|-c|-)$/.test(a[0] || '') || a.some(x => /^(-e|--eval|-p|--print)$/.test(x)))) continue; // the script, handled above
      if (h === 'cd' || h === 'pushd' || h === 'popd' || h === 'set-location') continue;
      if (h.startsWith('$')) { steps.push({ text: `Runs the program named in ${h0}`, tag: `Runs ${h0}`, level: 'care' }); continue; }
      if (h === 'cmd') {
        const inner = a.slice(a.findIndex(x => /^\/\/?c$/i.test(x)) + 1);
        if (/^mklink$/i.test(inner[0] || '') && /^\/j$/i.test(inner[1] || '')) {
          const wt = /[\\/]\.claude[\\/]worktrees[\\/]([^\\/"']+)/.exec(inner[2] || '')?.[1];
          steps.push({ text: `Links ${wt ? `worktree ${wt}'s ` : ''}${short(inner[2])} to ${short(inner[3])}`, tag: 'Creates a link (junction)', level: 'write' });
        } else steps.push({ text: `Runs ${inner.join(' ').replace(/["']/g, '').slice(0, 40) || 'cmd'} through cmd`, tag: `Runs ${String(inner[0] || 'cmd').replace(/["']/g, '')} (cmd)`, level: 'care' });
        continue;
      }
      if (/^(msedge|chrome|chromium)$/.test(h)) {
        const url = [...part.matchAll(/(?:https?|file):\/\/[^\s"']*/gi)].at(-1)?.[0] || '';
        const local = /^file:/i.test(url) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url);
        const what = /^https?:/i.test(url) ? host(url) : short(String(arg.at(-1) || '').replace(/^["']|["']$/g, '')) || 'a page';
        steps.push(a.some(x => /^--(screenshot|print-to-pdf)/.test(x)) ? { text: `Takes a screenshot of ${what}`, tag: local ? 'Screenshot' : `Internet: ${what}`, level: local ? 'write' : 'care' } : { text: `Opens ${what} in a browser`, tag: 'Browser', level: 'care' });
        continue;
      }
      if (h === 'mktemp') { steps.push({ text: 'Makes a temp folder', tag: 'Temp folder', level: 'write' }); continue; }
      if (h === 'cygpath') { steps.push({ text: 'Converts a path', tag: 'Reads only', level: 'read' }); continue; }
      if (h === 'node' && /(^|[\\/])server\.mjs["']?$/.test(arg[0] || '')) {
        const port = a[a.indexOf('--port') + 1];
        if (a.includes('--port') && port !== '4747') { steps.push({ text: `Starts a test hub on port ${port}`, tag: 'Test hub', level: 'write' }); continue; }
      }
      if (h === 'git') { steps.push(CommandSummary.git(a)); continue; }
      if (h === 'npm' || h === 'pnpm' || h === 'yarn') { steps.push(CommandSummary.npm(a)); continue; }
      if (h === 'node') { const f = arg[0]; steps.push(a.includes('--check') ? { text: `Checks ${short(f)} for mistakes`, tag: 'Reads only', level: 'read' } : a.some(x => /^(-v|--version)$/.test(x)) ? { text: 'Checks the Node version', tag: 'Reads only', level: 'read' } : { text: `Runs ${short(f)}`, tag: 'Runs code', level: 'care' }); continue; }
      if (/^python3?$|^py$/.test(h)) { steps.push({ text: `Runs ${short(arg[0]) || 'a Python script'}`, tag: 'Runs code', level: 'care' }); continue; }
      if (/^(rm|rmdir|del|erase|rd|remove-item|ri)$/.test(h)) { steps.push({ text: `Deletes ${arg.map(short).join(', ') || 'files'}`, tag: `Deletes ${arg.map(short).join(', ') || 'files'}`, level: 'care' }); continue; }
      if (/^(mv|move|move-item|mi)$/.test(h)) { steps.push({ text: `Moves ${short(arg[0])} to ${short(arg[1])}`, tag: `Moves ${short(arg[0])}`, level: 'write' }); continue; }
      if (/^(cp|copy|copy-item|cpi)$/.test(h)) { steps.push({ text: `Copies ${short(arg[0])} to ${short(arg[1])}`, tag: `Writes ${short(arg[1])}`, level: 'write' }); continue; }
      if (/^(mkdir|md|new-item|ni)$/.test(h)) {
        // the word after -ItemType is a kind, not a path; "a","b" is a PowerShell list
        const made = a.filter((x, i) => !x.startsWith('-') && !/^-(itemtype|type)$/i.test(a[i - 1] || '')).flatMap(x => x.split(/["']?,["']?/)).map(short).filter(Boolean);
        const list = made.length > 3 ? `${made.slice(0, 3).join(', ')} and ${made.length - 3} more` : made.join(', ');
        steps.push({ text: `Creates ${list}`, tag: `Creates ${made[0] || 'a folder'}${made.length > 1 ? ` +${made.length - 1}` : ''}`, level: 'write' }); continue;
      }
      if (/^(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm)$/.test(h)) { const u = arg.find(x => /^["']?https?:/.test(x)) || arg[0]; steps.push({ text: `Downloads from ${host(String(u).replace(/["']/g, ''))}`, tag: `Internet: ${host(String(u).replace(/["']/g, ''))}`, level: 'care' }); continue; }
      if (/^(sed)$/.test(h) && a.some(x => /^-i/.test(x))) { steps.push({ text: `Edits ${short(arg.at(-1))} in place`, tag: `Changes ${short(arg.at(-1))}`, level: 'write' }); continue; }
      if (/^(winget|choco|scoop|pip|pip3)$/.test(h)) { steps.push({ text: `Installs software (${h} ${arg.slice(1).join(' ')})`.trim(), tag: 'Installs software', level: 'care' }); continue; }
      if (/^(where|which|get-command|ls|dir|get-childitem|gci|cat|type|get-content|gc|head|tail|wc|grep|rg|find|select-string|sls|test-path|tree|stat|echo|printf|pwd|sort|uniq|cut|measure-object|select-object|where-object)$/.test(h)) {
        steps.push({ text: CommandSummary.lookName(h, arg), tag: 'Reads only', level: 'read' }); continue;
      }
      steps.push({ text: `Runs ${h}`, tag: `Runs ${h}`, level: 'care' });
    }
    const merged = [];
    for (const s of steps) if (!merged.some(m => m.text === s.text)) merged.push(s);
    const reads = merged.filter(s => s.level === 'read');
    const acts = merged.filter(s => s.level !== 'read');
    const phrases = [...acts.map(s => s.text), ...(reads.length ? [reads.length === 1 ? reads[0].text : 'looks a few things up'] : [])];
    // "A", "A, then b", "A, b, then c"
    const out = phrases.map(base).map((p, i) => i ? p[0].toLowerCase() + p.slice(1) : p);
    const plain = !out.length ? "Runs a command" : out.length === 1 ? out[0] : `${out.slice(0, -1).join(", ")}, then ${out.at(-1)}`;
    const rank = { care: 0, write: 1, read: 2 };
    return { plain, tags: uniq(merged.map(s => ({ text: s.tag, level: s.level }))).sort((x, y) => rank[x.level] - rank[y.level]) };
  }

  // Split a command line at && || ; | and newlines, but not inside quotes.
  static parts(s) {
    const out = []; let cur = '', q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === q && s[i - 1] !== '\\') q = null; cur += c; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '\n' || c === ';' || c === '|' || (c === '&' && s[i + 1] === '&')) {
        out.push(cur); cur = '';
        if ((c === '|' && s[i + 1] === '|') || c === '&') i++;
        continue;
      }
      cur += c;
    }
    out.push(cur);
    return out;
  }

  static lookName(h, arg) {
    if (/^(where|which|get-command)$/.test(h)) return `Checks whether ${arg.map(short).join(', ') || 'a program'} is installed`;
    if (/^(ls|dir|get-childitem|gci|tree|test-path|stat)$/.test(h)) return `Looks at ${arg.map(short).join(', ') || 'the folder'}`;
    if (/^(grep|rg|select-string|sls|find)$/.test(h)) return `Searches ${arg.slice(1).map(short).join(', ') || 'files'}`;
    if (/^(cat|type|get-content|gc|head|tail)$/.test(h)) return arg.length ? `Reads ${arg.map(short).join(', ')}` : 'Trims the output';
    return 'Looks something up';
  }

  static git(a) {
    a = a.filter((x, i) => x !== '-C' && a[i - 1] !== '-C');   // git -C <folder> runs in that folder
    const sub = a.find(x => !x.startsWith('-'));
    const rest = a.slice(a.indexOf(sub) + 1);
    const named = rest.filter(x => !x.startsWith('-'));
    switch (sub) {
      case 'status': case 'diff': case 'log': case 'show': case 'blame': case 'ls-files': case 'rev-parse': case 'remote': case 'describe':
        return { text: 'Checks the git history and changes', tag: 'Reads only', level: 'read' };
      case 'checkout': case 'switch':
        if (rest.some(x => /^-(b|B|c|C)$/.test(x))) return { text: `Switches to a new branch, ${named[0]}`, tag: `New branch ${named[0]}`, level: 'write' };
        if (rest.includes('--') || rest.some(x => /\.\w+$/.test(x))) return { text: `Throws away changes to ${named.map(short).join(', ')}`, tag: 'Discards changes', level: 'care' };
        return { text: `Switches to branch ${named[0]}`, tag: `Switches to ${named[0]}`, level: 'write' };
      case 'branch': return rest.some(x => /^-[dD]$/.test(x)) ? { text: `Deletes branch ${named[0]}`, tag: 'Deletes a branch', level: 'care' } : named.length ? { text: `Creates branch ${named[0]}`, tag: `New branch ${named[0]}`, level: 'write' } : { text: 'Lists branches', tag: 'Reads only', level: 'read' };
      case 'add': return { text: `Stages ${named.length ? named.map(short).join(', ') : 'changes'} for a commit`, tag: 'Stages changes', level: 'write' };
      case 'commit': { const m = /-m\s+["']([^"']+)/.exec(a.join(' ')); return { text: `Commits${m ? ` "${m[1].slice(0, 60)}"` : ' the staged changes'}`, tag: 'Commit', level: 'write' }; }
      case 'push': return { text: 'Pushes to GitHub', tag: 'Pushes to GitHub', level: 'care' };
      case 'pull': case 'fetch': return { text: 'Gets the latest from GitHub', tag: 'Internet: GitHub', level: 'write' };
      case 'merge': return { text: `Merges ${named[0] || 'a branch'}`, tag: 'Merge', level: 'care' };
      case 'reset': return { text: rest.includes('--hard') ? 'Throws away uncommitted work (reset --hard)' : 'Unstages changes', tag: rest.includes('--hard') ? 'Discards changes' : 'Unstages', level: rest.includes('--hard') ? 'care' : 'write' };
      case 'stash': return { text: 'Sets uncommitted changes aside (stash)', tag: 'Stash', level: 'write' };
      case 'clean': return { text: 'Deletes untracked files', tag: 'Deletes files', level: 'care' };
      default: return { text: `Runs git ${sub || ''}`.trim(), tag: `git ${sub || ''}`.trim(), level: 'care' };
    }
  }

  static npm(args) {
    const a = args.filter((x, i) => !/^--?(prefix|C|workspace|w)$/.test(x) && !/^--?(prefix|C|workspace|w)$/.test(args[i - 1] || ''));
    const [sub, ...rest] = a;
    const pkgs = rest.filter(x => !x.startsWith('-')).map(p => p.replace(/@[\^~]?[\d.]+.*$/, ''));
    switch (sub) {
      case 'install': case 'i': case 'add': return pkgs.length ? { text: `Installs ${pkgs.join(', ')} from the internet`, tag: `New package: ${pkgs.join(', ')}`, level: 'care' } : { text: 'Installs the project\'s packages', tag: 'Installs packages', level: 'care' };
      case 'ci': return { text: 'Reinstalls the project\'s packages', tag: 'Installs packages', level: 'care' };
      case 'uninstall': case 'remove': case 'rm': return { text: `Removes package ${pkgs.join(', ')}`, tag: 'Removes a package', level: 'care' };
      case 'test': case 't': return { text: 'Runs the tests', tag: 'Runs tests', level: 'write' };
      case 'run': return { text: `Runs the "${pkgs[0]}" script`, tag: `Runs ${pkgs[0]}`, level: 'write' };
      case 'start': return { text: 'Starts the app', tag: 'Runs the app', level: 'write' };
      case 'publish': return { text: 'Publishes the package to npm', tag: 'Publishes', level: 'care' };
      case 'ls': case 'list': case 'view': case '--version': case '-v': return { text: 'Checks installed packages', tag: 'Reads only', level: 'read' };
      default: return { text: `Runs npm ${sub || ''}`.trim(), tag: `npm ${sub || ''}`.trim(), level: 'care' };
    }
  }
}
