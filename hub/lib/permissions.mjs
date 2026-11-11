// Which agent commands can run without a card, and which "always allow" rules are safe to offer.
// Read-only commands run without asking. Each part of a chained command (&&, ||, ;, |) must pass on its own.
// Anything that writes, deletes, pushes, installs or reaches the network keeps asking every time.

const SIMPLE = new Set(['ls', 'dir', 'pwd', 'cat', 'head', 'tail', 'wc', 'echo', 'printf', 'which', 'where', 'file', 'stat', 'tree',
  'grep', 'rg', 'sort', 'uniq', 'cut', 'basename', 'dirname', 'realpath', 'date', 'whoami', 'cd', 'true', 'du', 'diff', 'cmp']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'describe', 'shortlog', 'grep', 'reflog']);
const GIT_BRANCH_FLAGS = new Set(['--show-current', '-a', '-r', '-v', '-vv', '--list', '--all', '--remotes', '--merged', '--no-merged', '--contains']);
const PS_READ = new Set(['get-childitem', 'get-content', 'get-location', 'get-item', 'get-itemproperty', 'test-path', 'select-string', 'measure-object',
  'resolve-path', 'get-date', 'select-object', 'where-object', 'sort-object', 'format-table', 'format-list', 'write-output', 'write-host',
  'get-command', 'split-path', 'join-path', 'group-object', 'compare-object', 'get-filehash']);
const PS_VERBS = /^(get|set|new|remove|add|clear|copy|move|rename|start|stop|restart|invoke|out|export|import|write|read|select|where|sort|format|measure|test|resolve|split|join|group|compare|update|install|uninstall|enable|disable|send|push|pop|suspend|resume|wait|register|unregister|convertto|convertfrom|expand|compress|mount|dismount|save|show|hide|lock|unlock|grant|revoke|publish|unpublish|find|search|close|open|enter|exit|edit|merge|use|debug|trace|request|receive|connect|disconnect|backup|restore|reset|initialize|protect|unprotect|submit|deploy|build|limit|block|unblock|checkpoint)-[a-z]+$/i;
const PS_BAD_ALIAS = /(^|[\s{;|(])(del|rm|rmdir|rd|ri|erase|mv|mi|move|cp|cpi|copy|sc|ac|ni|md|mkdir|rni|ren|clc|kill|spps|saps|start|iwr|irm|curl|wget|icm|sv|set|rv)(?=[\s;|})]|$)/i;
const PS_ALIASES = new Set(['gci', 'gc', 'sls', 'select', 'where', 'measure', 'gl', 'gi', 'type', 'ft', 'fl', '%', '?']);

// Harmless redirections that only touch stderr or discard output.
const QUIET = /\s+(2>&1|2>\s*\/dev\/null|2>\s*\$null|>\s*\/dev\/null|>\s*\$null|\|\s*Out-Null)\b/gi;
const RISKY = /\b(rm|rmdir|del|erase|rd|Remove-Item|ri|mv|move|Move-Item|cp|copy|Copy-Item|git\s+(push|reset|clean|checkout|restore|rebase|merge|branch\s+-[dD]|tag\s+-d|stash\s+(drop|clear))|curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|irm|npm\s+(publish|install|i|ci|update)|pip\s+install|winget|choco|scoop|format|shutdown|Stop-Process|kill|taskkill|Set-ExecutionPolicy|reg\s+(add|delete))\b/i;

export class CommandPolicy {
  // True when every part of the command only reads.
  static readOnly(tool, command) {
    let cmd = String(command || '').replace(QUIET, ' ').trim();
    if (!cmd) return false;
    if (/[`]|\$\(|<\(|>|\bxargs\b|\beval\b|\bexec\b|\bsource\b|^\s*\.\s/.test(cmd)) return false; // substitution, writes, indirection
    const ps = tool === 'PowerShell';
    if (ps) {
      if (/\b(iex|Invoke-Expression|Invoke-Command|Start-Process|Add-Type)\b|(^|[^&])&(?!&)/i.test(cmd)) return false;
      if (PS_BAD_ALIAS.test(cmd)) return false; // short aliases that write or delete, even inside { } blocks
      // every Verb-Noun anywhere (even inside { } script blocks, any casing) must be a reading cmdlet
      for (const vn of cmd.match(/\b[A-Za-z]+-[A-Za-z]+\b/g) || []) {
        if (PS_VERBS.test(vn) && !PS_READ.has(vn.toLowerCase())) return false;
      }
    }
    return cmd.split(/&&|\|\||;|\||\n/).every(part => CommandPolicy.partReadOnly(part.trim(), ps));
  }

  static partReadOnly(part, ps) {
    if (!part) return true;
    const words = part.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    if (/^\w+=/.test(words[0] || '')) return false; // VAR=value cmd
    const [head, ...rest] = words;
    const h = head.toLowerCase();
    if (ps && (PS_READ.has(h) || PS_ALIASES.has(h))) return true;
    if (SIMPLE.has(h)) return true;
    if (h === 'find') return !rest.some(w => /^-(delete|exec|execdir|ok|okdir|fprint|fls)/.test(w));
    if (h === 'sed') return rest.includes('-n') && !rest.some(w => /^-i|^--in-place/.test(w));
    if (h === 'node') return rest.length > 0 && rest.every((w, i) => ['-v', '--version', '--check', '-c'].includes(w) || (i > 0 && !w.startsWith('-')));
    if (h === 'npm') return ['--version', '-v', 'ls', 'list', 'config'].includes(rest[0]) && !(rest[0] === 'config' && rest[1] !== 'get' && rest[1] !== 'list');
    if (h === 'git') {
      let args = rest;
      while (args[0] === '-C' || args[0] === '--no-pager' || args[0] === '-c') args = args.slice(args[0] === '--no-pager' ? 1 : 2);
      const [sub, ...flags] = args;
      if (GIT_READ.has(sub)) return true;
      if (sub === 'branch') return flags.every(f => GIT_BRANCH_FLAGS.has(f));
      if (sub === 'remote') return flags.length === 0 || (flags.length === 1 && flags[0] === '-v') || flags[0] === 'show' || flags[0] === 'get-url';
      if (sub === 'stash') return flags[0] === 'list' || flags[0] === 'show';
      if (sub === 'config') return flags.includes('--get') || flags.includes('--list') || flags.includes('-l');
      return false;
    }
    return false;
  }

  // Rules Claude Code suggests with a prompt, made permanent (saved to the project's .claude/settings.local.json),
  // or null when the command is too risky to allow forever or the rule would be too broad.
  static alwaysRules(tool, input, suggestions) {
    const cmd = String(input?.command || '');
    if (RISKY.test(cmd)) return null;
    const keep = (suggestions || []).filter(s => s.type === 'addRules' && s.behavior === 'allow' && s.rules?.length
      && s.rules.every(r => r.ruleContent ? !RISKY.test(r.ruleContent) && !/^\s*\*?\s*$/.test(r.ruleContent.replace(/:\*$/, '')) : !/^(Bash|PowerShell)$/.test(r.toolName)));
    if (!keep.length) return null;
    return keep.map(s => ({ ...s, destination: 'localSettings' }));
  }

  // One plain line per rule, for the card.
  static describe(rules) {
    return (rules || []).flatMap(s => s.rules.map(r => r.ruleContent ? `${r.toolName}: ${r.ruleContent.replace(/:\*$/, ' …')}` : `${r.toolName} (any use)`));
  }
}
