// Routine shapes that reached Matt as cards on 2026-11-12 (from .crux/events.jsonl, word for word), now judged as
// contained under R005, and the near misses next to each that must still stop or stay unsure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../lib/permission-rules.mjs';
import { CommandSummary } from '../lib/summarize.mjs';

// Matt's machine, as in the real cards. Paths are only compared, never touched.
const HOME = 'C:\\Users\\mshom';
const TEMP = 'C:\\Users\\mshom\\AppData\\Local\\Temp';
const CRUX = 'C:\\Users\\mshom\\Documents\\GitHub\\crux';
const at = (tool, command, agent = 'w9') => classify({ tool, input: { command }, projectDir: CRUX, tmp: TEMP, home: HOME, agent });
const why = r => `${r.route}: ${[...r.reasons, ...r.unsure].join('; ')}`;
const route = (tool, command, agent) => at(tool, command, agent).route;
const allow = (tool, command, agent) => { const r = at(tool, command, agent); assert.equal(r.route, 'allow', `${command}\n -> ${why(r)}`); return r; };
const human = (tool, command, agent) => { const r = at(tool, command, agent); assert.equal(r.route, 'human', `${command}\n -> ${why(r)}`); return r; };
const unsure = (tool, command, agent) => { const r = at(tool, command, agent); assert.equal(r.route, 'unsure', `${command}\n -> ${why(r)}`); return r; };

// The real requests.
const BOOT = String.raw`T=$(cygpath -w "$TEMP/crux-retired-shot") && CRUX_HUB_DATA="$T\\data" CRUX_HOME="$T\\home" node server.mjs --port 4791 --no-agents "$T\\f13ld.lab-materials"`;
const BOOT2 = String.raw`T=$(cygpath -w "$TEMP/crux-retired-shot2") && CRUX_HUB_DATA="$T\\data" CRUX_HOME="$T\\home" node server.mjs --port 4791 --no-agents "$T\\f13ld.lab-materials"`;
const SHOT = String.raw`cd "$TEMP/crux-retired-shot" && timeout 120 node shot.mjs 4791 "$(cygpath -w "$TEMP/crux-retired-shot/shots")"`;
const SHOT2 = String.raw`cd "$TEMP/crux-retired-shot2" && timeout 90 node shot.mjs 4791 "$(cygpath -w "$TEMP/crux-retired-shot2/shots")"`;
const BUILD = String.raw`T=$(mktemp -d) && mkdir -p "$T/home" "$T/roots" && CRUX_HOME="$T/home" CRUX_ROOTS="$T/roots" node crux/scripts/build.mjs example/demo-decisions; echo "temp=$T"`;
const EDGE = String.raw`P=$(mktemp -d) && W=$(cygpath -w "$PWD") && "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(cygpath -w "$P")" --window-size=1440,1100 --screenshot="$W\\assets\\board.png" "file:///$(cygpath -m "$PWD")/example/demo-decisions/index.html" 2>&1 | tail -2; "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(cygpath -w "$P")" --window-size=1440,1300 --screenshot="$W\\assets\\decision-page.png" "file:///$(cygpath -m "$PWD")/example/demo-decisions/0003-walking-time.html" 2>&1 | tail -2; ls -la assets; echo "profile=$P"`;
const DEMO = 'T=$(mktemp -d) && mkdir -p "$T/home" "$T/roots/trail-planner/.decisions" "$T/roots/trail-journal/.decisions" && cp example/demo-decisions/*.json "$T/roots/trail-planner/.decisions/" && cat > "$T/roots/trail-journal/.decisions/0001-distance-unit.json" <<\'EOF\'\n{"id":1,"slug":"distance-unit","title":"Which unit does the journal use for distance?","date":"2026-10-28","mode":"quick","lenses":["data-model"],"status":"decided","context":"Alex\'s trail journal records walks already done.","depends_on":[],"conflicts":[],"options":[{"key":"A","name":"Miles","summary":"Store and show miles."},{"key":"B","name":"Kilometres","summary":"Store kilometres."}],"criteria":[],"recommended":"A","recommendation":"The journal\'s first readers use miles.","confidence":"lean","chosen":"A","reason":"Matches the guidebooks.","decided_on":"2026-10-28","superseded_by":null,"challenge":null,"settles":[{"key":"distance unit","value":"miles"}]}\nEOF\nCRUX_HOME="$T/home" CRUX_ROOTS="$T/roots" node crux/scripts/build.mjs "$T/roots/trail-journal/.decisions" && CRUX_HOME="$T/home" CRUX_ROOTS="$T/roots" node crux/scripts/build.mjs "$T/roots/trail-planner/.decisions"; P=$(mktemp -d); W=$(cygpath -w "$PWD"); E="/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"; "$E" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(cygpath -w "$P")" --window-size=1440,1300 --screenshot="$W\\\\assets\\\\build-brief.png" "file:///$(cygpath -m "$PWD")/example/demo-decisions/0004-route-files.html" 2>&1 | tail -1; "$E" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(cygpath -w "$P")" --window-size=1440,1000 --screenshot="$W\\\\assets\\\\all-projects.png" "file:///$(cygpath -m "$T")/home/index.html" 2>&1 | tail -1';
const RESHOT = String.raw`P=$(mktemp -d) && "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --hide-scrollbars --user-data-dir="$(cygpath -w "$P")" --window-size=1440,1000 --screenshot="$(cygpath -w "$PWD")\\assets\\all-projects.png" "file:///C:/Users/mshom/AppData/Local/Temp/tmp.hGU6H8vrZx/home/index.html" 2>&1 | tail -1`;
const PIN_DIRS = String.raw`$t = Join-Path $env:TEMP 'crux-pinmock'; New-Item -ItemType Directory -Force "$t\data","$t\home","$t\trail-planner\.crux","$t\trail-planner\.decisions","$t\shots" | Select-Object FullName; node --version; Test-Path "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"; Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe"`;
const PIN_HUB = String.raw`$t = Join-Path $env:TEMP 'crux-pinmock'; $env:CRUX_HUB_DATA = "$t\data"; $env:CRUX_HOME = "$t\home"; node "C:\Users\mshom\Documents\GitHub\crux\.claude\worktrees\pinned-threads\hub\server.mjs" --port 4761 --no-agents "$t\trail-planner"`;
const PIN_SHOT = String.raw`$t = Join-Path $env:TEMP 'crux-pinmock'; node "C:\Users\mshom\Documents\GitHub\crux\.claude\worktrees\pinned-threads\hub\mock\capture.mjs" "$t\jobs-base.json" "$t\browser"`;
const MKLINK = String.raw`cmd /c mklink /J "C:\Users\mshom\Documents\GitHub\crux\.claude\worktrees\crux-page\hub\node_modules" "C:\Users\mshom\Documents\GitHub\crux\hub\node_modules"`;
const MKLINK_BASH = String.raw`cmd //c mklink /J "C:\Users\mshom\Documents\GitHub\crux\.claude\worktrees\perm-shapes\hub\node_modules" "C:\Users\mshom\Documents\GitHub\crux\hub\node_modules"`;
const RMTEMP = `node -e "const fs=require('fs'),os=require('os'),p=require('path').join(os.tmpdir(),'crux-page-demo');fs.rmSync(p,{recursive:true,force:true});console.log(p,'exists:',fs.existsSync(p))"`;
const CARD_NAMES = "CRUX_HOME=/c/Users/mshom/crux node --input-type=module -e \"\nimport { Memory } from './lib/memory.mjs';\nconst m = new Memory(process.env.CRUX_HOME);\nconst names = ['AcuLign','AcuLoad','Ebb','crux','f13ld.lab','f13ld.lab-wt','f13ld.mesh','f13ld.noise','f13ld.synth','life','Wardstone','f13ld','f13ld.tpms','Ebb-wt','foam','pullout','f13ldx','other'];\nconsole.log(JSON.stringify(Object.fromEntries(names.map(n => [n, m.packName(n)]))));\n\"";

test('1. a temp path held in a variable from mktemp, cygpath or Join-Path is judged like the path itself', () => {
  allow('Bash', BOOT, 'retired-list');
  allow('Bash', BUILD, 'crux-docs');
  allow('Bash', EDGE, 'crux-docs');
  allow('Bash', RESHOT, 'crux-docs');
  allow('PowerShell', PIN_DIRS, 'pin-mockups');
  // a folder $(mktemp) made in this command is its own to delete; its made-up name is not remembered
  const r = allow('Bash', 'T=$(mktemp -d) && mkdir -p "$T/a" && rm -rf "$T"');
  assert.deepEqual(r.tempMade, []);
});

test('1. near misses: a variable pointing outside temp, or a substitution the hub cannot read', () => {
  human('Bash', 'T=$(cygpath -w "/c/Windows") && rm -rf "$T/x"');
  human('Bash', 'T=$(cygpath -w "$USERPROFILE/Desktop") && echo x > "$T/a.txt"');
  human('Bash', 'W=$(cygpath -w "$PWD") && cd .. && rm -rf "$W/../other"');
  human('PowerShell', String.raw`$t = Join-Path 'C:\Users\mshom\Desktop' 'x'; Remove-Item -Recurse "$t"`);
  assert.notEqual(route('PowerShell', String.raw`$t = Join-Path $env:USERPROFILE 'Desktop'; Remove-Item -Recurse $t`), 'allow', 'Join-Path from a folder that is not temp is not read');
  human('PowerShell', String.raw`New-Item -ItemType Directory -Force "$env:TEMP\a","C:\Windows\evil"`);
  assert.notEqual(route('Bash', 'T=$(mktemp -d /c/Users/mshom/Desktop/xXXXX) && rm -rf "$T"'), 'allow', 'mktemp with a folder of its own is not read');
  unsure('Bash', 'X=$(cygpath -w "$(cat f)") && ls "$X"');
  unsure('Bash', 'P=$(mktemp -d -p /c/Users/mshom/Desktop) && ls "$P"');
  human('Bash', 'T=$(mktemp -d) && git push origin main');
  assert.equal(route('Bash', 'T=$(mktemp -d) && rm -rf "$TEMP/someone-else"'), 'unsure', 'only the folder it made is its own');
});

test('2. environment settings in front of a command, or set with $env:, are not commands in themselves', () => {
  allow('Bash', BOOT2, 'retired-list');
  allow('PowerShell', PIN_HUB, 'pin-mockups');
  allow('PowerShell', PIN_SHOT, 'pin-mockups');
});

test('2. near misses: secret-looking names, the hub port, and the live hub\'s data or profile folder', () => {
  human('Bash', 'T=$(mktemp -d) && GITHUB_TOKEN="$T/x" node server.mjs --port 4791');
  human('Bash', 'ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY node server.mjs --port 4791');
  human('Bash', 'T=$(mktemp -d) && CRUX_HUB_DATA="$T/data" node server.mjs --port 4747');
  human('Bash', 'T=$(mktemp -d) && CRUX_HUB_DATA="$T/data" node server.mjs --no-agents');
  human('Bash', 'CRUX_HUB_PORT=4747 node server.mjs --port 4791');
  human('Bash', 'CRUX_HUB_DATA=/c/Users/mshom/.crux-hub node server.mjs --port 4791');
  human('Bash', 'T=$(mktemp -d) && CRUX_HUB_DATA="$T/data" CRUX_HOME=/c/Users/mshom/crux node server.mjs --port 4791');
  human('PowerShell', String.raw`$env:CRUX_HOME = 'C:\Users\mshom\crux'; node server.mjs --port 4761`);
  assert.equal(route('Bash', 'CRUX_HOME=/c/Users/mshom/crux node crux/scripts/build.mjs x'), 'unsure', 'a setting that names a folder outside');
});

test('a test hub with no data folder of its own would share the live hub\'s settings: for the orchestrator', () => {
  for (const c of ['node server.mjs --port 4791 --no-agents', 'CRUX_HOME="$TEMP/x/home" node hub/server.mjs --port 4791']) {
    const r = unsure('Bash', c);
    assert.match(r.unsure.join(' '), /no data folder of its own/);
  }
  unsure('PowerShell', String.raw`$env:CRUX_HOME = "$env:TEMP\x\home"; node server.mjs --port 4761`);
  // with one: contained, as before; restart.mjs reuses how the hub was last started
  allow('Bash', 'CRUX_HUB_DATA="$TEMP/x/data" node server.mjs --port 4791 --no-agents');
  allow('Bash', 'export CRUX_HUB_DATA=/c/Users/mshom/AppData/Local/Temp/x/data; node hub/server.mjs --port 4750');
  allow('Bash', 'node hub/restart.mjs --port 4752 --no-open');
  // near misses: still hard stops (npm start in hub/ is covered in permission-rules.test.mjs, with a fake project)
  human('Bash', 'node server.mjs');
  human('Bash', 'node server.mjs --port 4747 --no-agents');
  human('Bash', 'CRUX_HUB_DATA=/c/Users/mshom/Documents/hubdata node server.mjs --port 4791');
  // card-names' inline script read the environment with CRUX_HOME set to Matt's real profile: still Matt's call
  const r = human('Bash', CARD_NAMES, 'card-names');
  assert.match(r.reasons.join(' '), /environment variables or the home folder/);
});

test('3. a junction made in a worktree, pointing at the project\'s own node_modules', () => {
  allow('PowerShell', MKLINK, 'crux-page');
  allow('Bash', MKLINK_BASH, 'perm-shapes');
});

test('3. near misses: a link pointing outside, made outside, into .git, or other cmd /c', () => {
  const wt = String.raw`C:\Users\mshom\Documents\GitHub\crux\.claude\worktrees\crux-page`;
  unsure('PowerShell', String.raw`cmd /c mklink /J "${wt}\hub\node_modules" "C:\Users\mshom\Desktop\x"`);
  human('PowerShell', String.raw`cmd /c mklink /J "C:\Users\mshom\Desktop\link" "${CRUX}\hub\node_modules"`);
  human('PowerShell', String.raw`cmd /c mklink /J "${CRUX}\.git\hooks" "${CRUX}\hub\node_modules"`);
  unsure('PowerShell', String.raw`cmd /c mklink /D "${wt}\hub\x" "${CRUX}\hub\node_modules"`);
  unsure('PowerShell', String.raw`cmd /c del "${wt}\hub\x"`);
  unsure('PowerShell', 'cmd /c "dir & whoami"');
});

test('4. timeout N <command> is judged as the command it runs', () => {
  allow('Bash', SHOT, 'retired-list');
  allow('Bash', SHOT2, 'retired-list');
  allow('Bash', 'timeout --preserve-status -k 5 60 npm test');
});

test('4. near misses: timeout around a hard stop or an unknown program', () => {
  human('Bash', 'timeout 60 git push origin main');
  human('Bash', 'timeout 5 rm -rf /c/Users/mshom/Documents/other');
  human('Bash', 'timeout 30 npm install left-pad');
  unsure('Bash', 'timeout 30 unknowntool --go');
  unsure('Bash', 'timeout');
});

test('5. headless Edge or Chrome taking a screenshot of a local page into a contained file', () => {
  allow('Bash', '"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --user-data-dir="C:/Users/mshom/AppData/Local/Temp/perm-shapes-work/prof" --screenshot="C:/Users/mshom/AppData/Local/Temp/perm-shapes-work/a.png" "http://127.0.0.1:4793/"');
  allow('Bash', 'P=$(mktemp -d) && "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --user-data-dir="$(cygpath -w "$P")" --screenshot="$(cygpath -w "$P")\\a.png" "http://localhost:4791/"');
});

test('5. near misses: an outside address, or a screenshot or profile written outside', () => {
  human('Bash', 'P=$(mktemp -d) && "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --user-data-dir="$(cygpath -w "$P")" --screenshot="$(cygpath -w "$P")\\a.png" "https://example.com/"');
  human('Bash', '"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --screenshot="C:/Users/mshom/Desktop/a.png" "http://localhost:4791/"');
  human('Bash', '"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --user-data-dir="C:/Users/mshom/AppData/Local/Microsoft/Edge/User Data" --screenshot="C:/Users/mshom/AppData/Local/Temp/x/a.png" "http://localhost:4791/"');
});

test('6. a heredoc that writes a file into temp', () => {
  allow('Bash', DEMO, 'crux-docs');
  allow('Bash', "T=$(mktemp -d) && cat > \"$T/notes.txt\" <<'EOF'\nplain text, $(not run)\nEOF");
});

test('6. near misses: a heredoc written outside, or one with commands inside', () => {
  human('Bash', "cat > /c/Users/mshom/Desktop/x.json <<'EOF'\n{}\nEOF");
  assert.notEqual(route('Bash', 'T=$(mktemp -d) && cat > "$T/x.sh" <<EOF\n$(git push origin main)\nEOF'), 'allow');
});

test('an inline script that deletes: its own temp folder is contained; anything it cannot name is unsure', () => {
  allow('Bash', RMTEMP, 'crux-page');
  assert.equal(route('Bash', RMTEMP, 'someone-else'), 'unsure', 'a temp folder that is not its own');
  human('Bash', `node -e "require('fs').rmSync('C:/Users/mshom/Desktop/x',{recursive:true})"`);
  unsure('Bash', `node -e "const os=require('os'),p=require('path').join(os.tmpdir());require('fs').rmSync(p,{recursive:true})"`, 'crux-page');
  unsure('Bash', `node -e "const p=process.argv[1];require('fs').rmSync(p,{recursive:true})"`);
  unsure('Bash', `node -e "let p=require('path').join(require('os').tmpdir(),'crux-page-x');p='C:/';require('fs').rmSync(p,{recursive:true})"`, 'crux-page');
  human('Bash', `node -e "require('fs').rmSync(require('os').homedir()+'/x',{recursive:true})"`);
  unsure('Bash', `python -c "import shutil; shutil.rmtree('build')"`);
});

test('git -C with a Git Bash path to a worktree is inside the project (it was read as C:/c/Users/...)', () => {
  allow('Bash', 'git -C /c/Users/mshom/Documents/GitHub/crux/.claude/worktrees/readme-refresh add -A', 'crux-docs');
  allow('Bash', 'git -C /c/Users/mshom/Documents/GitHub/crux/.claude/worktrees/readme-refresh commit -q -m "Docs: brief README, API-key Hub setup, neutral hiking-trail demo" -m "README cut to a one-minute read (skill plus Hub, image slot for assets/hub-hero.png). Skill detail moves to INSTALL.md, which gains git clone, a Mac/Linux note (untested) and Node 20+. hub/README documents API-key start-up (D0038 B, R007), Auto/Ask permissions, picks landing on docs/decisions, connectors, profile and lessons, handoffs, sub-agents, environment settings and Crux Hub.cmd, warns about events.jsonl, and lists what is not built yet. IDEAS.md marks the live map decided (17) and built. The screw demo and its screenshots are replaced by a neutral hiking-trail demo with new page images." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git -C /c/Users/mshom/Documents/GitHub/crux/.claude/worktrees/readme-refresh log --oneline -1 --stat | tail -5', 'crux-docs');
  human('Bash', 'git -C /c/Users/mshom/Documents/other commit -m x');
  human('Bash', 'git -C /c/Users/mshom/Documents/GitHub/crux/.claude/worktrees/readme-refresh push origin main');
  human('Bash', 'git -C /c/Users/mshom/Documents/GitHub/crux/.claude/worktrees/readme-refresh merge main');
});

test('card tags are honest: no fragments of assignments, and a script that deletes never reads "Reads only"', () => {
  const tags = (tool, c) => CommandSummary.of(tool, { command: c }).tags.map(t => t.text).join(' | ');
  const plain = (tool, c) => CommandSummary.of(tool, { command: c }).plain;
  for (const [tool, c] of [['Bash', BOOT], ['Bash', SHOT], ['Bash', BUILD], ['Bash', EDGE], ['Bash', DEMO], ['PowerShell', PIN_DIRS], ['PowerShell', PIN_HUB], ['PowerShell', MKLINK]]) {
    const s = `${plain(tool, c)} || ${tags(tool, c)}`;
    assert.doesNotMatch(s, /Runs? (T|P|W|E)=|\$\(|Runs? \$t\b|Runs? \$env:|Runs? timeout|Runs? cmd\b|Runs? CRUX_|Directory/, `${c.slice(0, 60)}\n -> ${s}`);
  }
  assert.match(tags('Bash', BOOT), /Test hub/);
  assert.match(plain('Bash', BOOT), /test hub on port 4791/);
  assert.match(tags('PowerShell', MKLINK), /link/i);
  assert.match(tags('Bash', EDGE), /Screenshot/);
  const rm = CommandSummary.of('Bash', { command: RMTEMP });
  assert.ok(!rm.tags.some(t => t.text === 'Reads only'), JSON.stringify(rm.tags));
  assert.ok(rm.tags.some(t => t.level === 'care' && /Deletes/.test(t.text)), JSON.stringify(rm.tags));
  assert.doesNotMatch(tags('Bash', CARD_NAMES), /Writes \[n/, 'an arrow inside a script is not a redirection');
  assert.match(tags('Bash', CARD_NAMES), /Reads settings or home/);
  assert.doesNotMatch(tags('Bash', 'git -C /c/x/readme-refresh add -A'), /readme-refresh/, 'git -C names the folder, not the step');
  const w = CommandSummary.of('Bash', { command: `node -e "require('fs').writeFileSync(out, data)"` });
  assert.ok(!w.tags.some(t => t.text === 'Reads only'), 'a script that writes is not read-only');
});
