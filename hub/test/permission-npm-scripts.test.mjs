// npm run X, npm test, npm start, yarn / pnpm / bun run X: the script text comes from package.json, which a worker can edit,
// so it is classified as an inline shell command, pre and post hooks included. A script that is missing or unreadable is
// not an allow. (Found by the check review: "deploy": "git push --force origin main" was allowed at Auto.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTmp } from './helpers/tmp.mjs';
import { classify } from '../lib/permission-rules.mjs';

const root = makeTmp('crux-npm-scripts-');
const project = join(root, 'proj');
const bare = join(root, 'bare');          // a folder with no package.json
const tmp = join(root, 'tmp');
const home = join(root, 'home');
for (const d of [project, bare, tmp, home]) mkdirSync(d, { recursive: true });
const T = tmp.replace(/\\/g, '/');
const pkg = scripts => writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'x', scripts }));
pkg({
  deploy: 'git push --force origin main',
  release: 'echo ok', prerelease: 'git push origin HEAD:main',
  ship: 'echo ok', postship: 'git push --force origin main',
  test: 'node --test', build: 'echo build', lint: 'eslint .',
  start: 'node server.mjs',
  loop: 'npm run loop', indirect: 'npm run deploy', both: 'echo a && npm run build',
  inline: `node -e "console.log(1+1)"`,
  pushit: 'git push origin',
});

const at = (command, extra = {}) => classify({ tool: 'Bash', input: { command }, projectDir: project, tmp, home, agent: 'builder', ...extra });
const why = r => `${r.route}: ${[...r.reasons, ...r.unsure].join('; ')}`;
const is = (route, c, x) => { const r = at(c, x); assert.equal(r.route, route, `${c}\n  -> ${why(r)}`); return r; };
const allow = (c, x) => is('allow', c, x);
const unsure = (c, x) => is('unsure', c, x);
const human = (c, x) => is('human', c, x);

test('a script that force-pushes main is a hard stop, whichever way it is run', () => {
  for (const c of ['npm run deploy', 'npm run-script deploy', 'yarn run deploy', 'pnpm run deploy', 'bun run deploy', 'npm run deploy --silent', 'npm run indirect']) human(c);
  human('npm run deploy -- --dry-run');
});

test('words after the script name go to the script with or without -- (npm 7+)', () => {
  human('npm run pushit main');                       // runs: git push origin main
  human('npm run pushit --silent main');
  human('npm run pushit -- main');
  human('yarn run pushit main');
  human('pnpm run pushit main');
  allow('npm run pushit feat/x');                     // a feature branch push is a feature push
  allow('npm test --prefix .');                       // npm's own folder option is not a script word
  allow('npm run build --silent');
});

test('a pre or post hook that holds the push is a hard stop, though the named script is harmless', () => {
  human('npm run release');        // prerelease: git push origin HEAD:main
  human('npm run ship');           // postship: git push --force origin main
  human('pnpm run ship');
});

test('a harmless script still allows, with or without words after --', () => {
  allow('npm test');
  allow('npm t');
  allow('npm test -- --test-name-pattern x');
  allow('npm run build');
  allow('yarn run build');
  allow('pnpm test');
  allow('npm run both');           // runs another harmless script
  allow('npm run');                // only lists the scripts
});

test('a script the hub cannot read is not an allow', () => {
  unsure('npm run nothere');
  unsure('npm run lint');          // eslint: a program the hub does not know
  unsure('npm run loop');          // runs itself: too deep to follow
  unsure('npm run deploy -w pkg'); // another package's script
  unsure('npm run inline');        // inline code in a script is a doubt too
  const r = classify({ tool: 'Bash', input: { command: 'npm test' }, projectDir: bare, tmp, home, agent: 'builder' });
  assert.equal(r.route, 'unsure', `no package.json: ${why(r)}`);
  writeFileSync(join(bare, 'package.json'), '{ not json');
  assert.equal(classify({ tool: 'Bash', input: { command: 'npm test' }, projectDir: bare, tmp, home, agent: 'builder' }).route, 'unsure', 'unreadable package.json');
  writeFileSync(join(bare, 'package.json'), JSON.stringify({ scripts: { test: ['node', '--test'] } }));
  assert.equal(classify({ tool: 'Bash', input: { command: 'npm test' }, projectDir: bare, tmp, home, agent: 'builder' }).route, 'unsure', 'a script that is not text');
});

test('npm start: the words after -- go to the script, so a test hub start is judged as before', () => {
  const DATA = `CRUX_HUB_DATA="${T}/hub/data" CRUX_HOME="${T}/hub/home"`;
  allow(`${DATA} npm start -- --port 4793`);
  human(`${DATA} npm start`);                 // no port: it would be the live hub's 4747
  human(`${DATA} npm start -- --port 4747`);
  unsure('npm start -- --port 4793');         // no data folder of its own
  allow(`${DATA} npm run start -- --port 4794`);
});

test('download-and-run stays a stop', () => {
  human('npx some-package');
  human('npm install zod');
});
