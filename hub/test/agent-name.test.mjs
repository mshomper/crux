// Orchestrators are named by their project with a small "vN" chip (Matt, 2026-11-14): "crux v6", not
// "Orchestrator · #6" or "orchestrator-6". Display only: internal names, ids, logs and tools are untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nameParts, nameHtml, nameText, namesInHtml, namesInText, vchip } from '../public/agent-name.js';

const pub = f => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('an orchestrator shows as its project and holder number; the Conductor as itself; workers unchanged', () => {
  assert.deepEqual(nameParts('orchestrator-6', 'crux'), { text: 'crux', v: 6 });
  assert.deepEqual(nameParts('conductor-3', 'anything'), { text: 'Conductor', v: 3 });
  assert.deepEqual(nameParts('map-tiles', 'crux'), { text: 'map-tiles', v: null });
  assert.deepEqual(nameParts('orchestrator-helper', 'crux'), { text: 'orchestrator-helper', v: null }, 'only the role names with a number');
  assert.equal(nameText('orchestrator-12', 'AcuLoad'), 'AcuLoad v12');
  assert.equal(nameText('conductor-1'), 'Conductor v1');
  assert.equal(nameText('reviewer', 'crux'), 'reviewer');
  assert.equal(nameText('orchestrator-2'), 'Orchestrator v2', 'no project known: the role word');
});

test('as HTML: the chip keeps the internal name in its hover, and everything is escaped', () => {
  assert.equal(nameHtml('orchestrator-6', 'crux'), 'crux <span class="vchip" title="orchestrator-6">v6</span>');
  assert.equal(nameHtml('w<1>', 'crux'), 'w&lt;1&gt;');
  assert.equal(nameHtml('orchestrator-6', '<b>x</b>'), '&lt;b&gt;x&lt;/b&gt; <span class="vchip" title="orchestrator-6">v6</span>');
  assert.equal(vchip(null), '');
});

test("the hub's own lines show every orchestrator and Conductor name the same way", () => {
  const line = 'orchestrator-6 left handoff H012; orchestrator-7 takes over.';
  assert.equal(namesInText(line, 'crux'), 'crux v6 left handoff H012; crux v7 takes over.');
  assert.equal(namesInHtml('orchestrator-7 holds the orchestrator role <now>.', 'crux'),
    'crux <span class="vchip" title="orchestrator-7">v7</span> holds the orchestrator role &lt;now&gt;.');
  assert.equal(namesInText('builder finished; conductor-2 was told', 'p'), 'builder finished; Conductor v2 was told');
});

test("replies to the Conductor and the hub's phone notices name the orchestrator the same way", async () => {
  const CP = await import('../public/conductor-view.js');
  const r = { project: 'crux', from: 'orchestrator-6', request: 'req-012' };
  assert.equal(CP.replyFoldHtml(r), 'crux <span class="vchip" title="orchestrator-6">v6</span> replied · req-012');
  assert.equal(CP.toYouHtml(r), 'crux <span class="vchip" title="orchestrator-6">v6</span> to you · req-012');
  assert.equal(CP.replyFoldHtml({ project: '<x>', from: 'someone', request: 'req-1' }), '&lt;x&gt; replied · req-1', 'not an orchestrator: the project, escaped');
  assert.equal(CP.replyFold(r), 'crux replied · req-012', 'the plain text form is unchanged');
  const { cardsFor, groupCard } = await import('../lib/push.mjs');
  const s = { id: 's1', type: 'summary', project: 'crux', thread: 'orchestrator', from: 'orchestrator-6', questions: ['Ship the names change today?'], decisions_needed: [7] };
  const cards = cardsFor(s);
  assert.equal(cards.find(c => c.kind === 'question').title, 'crux v6 has a question');
  assert.equal(cards.find(c => c.kind === 'question').asker, 'orchestrator-6', 'the internal name stays for matching');
  assert.equal(groupCard(s, cards).title, 'crux v6 has 1 decision and a question for you');
  assert.equal(cardsFor({ type: 'approval', project: 'crux', thread: 'w', agent: 'builder', approval: 'a1', tool: 'Bash' })[0].title, 'builder is waiting for Allow');
});

test('the page uses it wherever an orchestrator is named, and no longer writes "Orchestrator · #N"', () => {
  const app = pub('app.js');
  assert.doesNotMatch(app, /Orchestrator · \$\{/, 'no "Orchestrator · #6" left');
  assert.doesNotMatch(app, /replace\('orchestrator-', '#'\)/);
  for (const [what, re] of [
    ['thread list row', /threadButton\(\{ id: 'orchestrator', name: orch \? NM\.nameText\(orch\.name, p\.name\) : p\.name, nameHtml: orch \? NM\.nameHtml/],
    ['thread header', /title = p\.name;\s*\n\s*titleHtml = o \? NM\.nameHtml\(o\.name, p\.name\) : null;/],
    ['question card', /<h3>\$\{NM\.nameHtml\(ev\.from, p\.name\)\} asks<\/h3>/],
    ['round summary', /<h3>\$\{NM\.nameHtml\(ev\.from, p\.name\)\} finished a round<\/h3>/],
    ['permission card', /\$\{NM\.nameHtml\(ev\.agent, p\.name\)\}: \$\{esc\(desc\)\}/],
    ['message sender', /\$\{you \? 'You' : NM\.nameHtml\(ev\.from, p\.name\)\}/],
    // one span, so the line wraps as words (a notice lays its children out side by side)
    ['hub notices (handoffs)', /case 'notice': return `<div class="notice"><span>\$\{NM\.namesInHtml\(ev\.text, p\.name\)\}<\/span><\/div>`/],
    ['agents list', /<b class="ha-name">\$\{NM\.nameHtml\(a\.name, p\.name\)\}<\/b>/],
    ['Conductor header', /<span class="vname">\$\{c\.name \? NM\.nameHtml\(c\.name\) : 'Conductor'\}<\/span>/],
    ['Conductor chat replies, folded', /<span class="cd-rl-k">\$\{CP\.replyFoldHtml\(ev\)\}<\/span>/],
    ['Conductor chat replies, to you', /<span>\$\{CP\.toYouHtml\(ev\)\}<\/span>/],
    ['orchestrator thread: its reply to the Conductor', /\$\{NM\.nameHtml\(ev\.from, p\.name\)\} replied to the Conductor/],
    ['a question waiting in another card', /\$\{NM\.nameHtml\(r\.of, p\.name\)\}'s card/]
  ]) assert.match(app, re, what);
  assert.match(pub('conversation.js'), /if \(h\.titleHtml\) \{ if \(this\.title\.innerHTML !== h\.titleHtml\) this\.title\.innerHTML = h\.titleHtml; \}/, 'the header title can carry the chip');
  assert.match(pub('map.js'), /s\.kind === 'ghost' \? nameText\(s\.name, this\.model\.project\?\.name\)/, 'live map: an outgoing orchestrator');
  assert.match(pub('map.js'), /<b>\$\{nameHtml\(l\.actor, pj\)\}/, 'live map telemetry');
  assert.match(pub('map-needs.js'), /nameHtml\(ev\.agent, ev\.project \|\| this\.pname\)/, 'the You popover');
  assert.match(pub('map-sectors.js'), /const vc = p\.v != null \? ` \$\{vchip\(p\.v\)\}` : ''/, 'All projects sectors and bays');
  assert.match(pub('style.css'), /\.vchip\{[^}]*color:inherit/, 'the chip takes the colour around it: no new colour meaning');
});
