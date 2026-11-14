// Voice step 2 (decision 61 A): the answer to a spoken message is read aloud. The Conductor's "Spoken:" line comes off
// the reply (never shown) and becomes up to three sentences; a reply without one has its first sentences read; a turn
// already running when the spoken message came is not its answer; speech is made in memory and handed over once; the
// page plays sentence after sentence and a stop ends it at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { liftSpoken, plain, sentences } from '../lib/voice-speech.mjs';
import { Conductor, VOICE_NOTE } from '../lib/conductor.mjs';
import { Hub } from '../lib/hub.mjs';
import { SpeechCache } from '../lib/voice.mjs';
import { VoicePlayer, voiceLine } from '../public/voice.js';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');

test('the Spoken line comes off the reply, in the ways it may be written', () => {
  const r = liftSpoken('Spoken: Two cards wait, both in Wardstone. I sent the brief.\n\nTwo cards wait in **Wardstone**:\n- a permission\n- a decision');
  assert.equal(r.spoken, 'Two cards wait, both in Wardstone. I sent the brief.');
  assert.equal(r.rest, 'Two cards wait in **Wardstone**:\n- a permission\n- a decision');
  assert.equal(liftSpoken('**Spoken:** All clear.\nNothing waits.').spoken, 'All clear.');
  assert.equal(liftSpoken('**Spoken:** All clear.\nNothing waits.').rest, 'Nothing waits.');
  assert.equal(liftSpoken('spoken - Done.').spoken, 'Done.');
  assert.deepEqual(liftSpoken('Nothing waits for you.'), { spoken: '', rest: 'Nothing waits for you.' });
  assert.equal(liftSpoken('Spoken:   \nText').spoken, '', 'an empty Spoken line is no Spoken line');
});

test('Markdown becomes plain words, and at most three sentences that fit', () => {
  assert.equal(plain('## Status\n- **AcuLoad**: see [the PR](https://x.y/1) and `npm test`\n```js\ncode()\n```'), 'Status AcuLoad: see the PR and npm test');
  assert.deepEqual(sentences('One thing waits. It is in Ebb! Shall I send it? And a fourth.'), ['One thing waits.', 'It is in Ebb!', 'Shall I send it?']);
  assert.deepEqual(sentences('Version 0.21.0 is out. Done.'), ['Version 0.21.0 is out.', 'Done.'], 'a dot inside a number is no sentence end');
  const long = sentences('word '.repeat(80) + 'end.')[0];
  assert.ok(long.length <= 221 && long.endsWith('…'));
  assert.deepEqual(sentences('```\nonly code\n```'), []);
});

// A Conductor with only what the voice turn uses.
function conductorStub() {
  const c = Object.create(Conductor.prototype);
  c.events = [];
  c.home = { log: { append: (type, data) => { const ev = { id: `e${c.events.length + 1}`, type, ...data }; c.events.push(ev); return ev; } } };
  return c;
}
// Hub.agentSaid on a Conductor home, with that stub.
function say(c, text) {
  const hub = Object.create(Hub.prototype);
  hub.conductor = c;
  return Hub.prototype.agentSaid.call(hub, c.home.hubWide !== false ? { hubWide: true, log: c.home.log } : c.home, { role: 'conductor', thread: 'conductor', name: 'conductor-1' }, text);
}

test('a voice turn: the answer loses its Spoken line, which goes up to be read on the page that spoke', () => {
  const c = conductorStub();
  c.voiceTurn = { client: 'page-a', at: Date.now(), busy: false, last: null };
  const ev = say(c, 'Spoken: Wardstone is waiting on you.\nWardstone has one card waiting: a permission for a test run.');
  assert.equal(ev.text, 'Wardstone has one card waiting: a permission for a test run.');
  const v = c.events.find(e => e.type === 'voice_say');
  assert.deepEqual(v.sentences, ['Wardstone is waiting on you.']);
  assert.equal(v.of, ev.id); assert.equal(v.client, 'page-a'); assert.equal(v.from, 'spoken');
  assert.equal(c.voiceTurn, null, 'one answer per spoken message');
  say(c, 'Spoken: a later message is not read.\nText');
  assert.equal(c.events.filter(e => e.type === 'voice_say').length, 1);
  assert.match(c.events.at(-1).text, /^Spoken: a later message/, 'outside a voice turn nothing is lifted');
});

test('a reply that is only the Spoken line logs no empty message', () => {
  const c = conductorStub();
  c.voiceTurn = { client: 'p', at: Date.now(), busy: false, last: null };
  assert.equal(say(c, 'Spoken: Done, I sent it.'), null);
  assert.deepEqual(c.events.map(e => e.type), ['voice_say']);
});

test('no Spoken line: at the end of the turn its last message has its first sentences read', () => {
  const c = conductorStub();
  c.voiceTurn = { client: 'p', at: Date.now(), busy: false, last: null };
  say(c, 'Let me look.');
  say(c, 'Nothing waits for you. Ebb is quiet. Wardstone too. And more.');
  c.voiceTurnEnded();
  const v = c.events.find(e => e.type === 'voice_say');
  assert.deepEqual(v.sentences, ['Nothing waits for you.', 'Ebb is quiet.', 'Wardstone too.']);
  assert.equal(v.from, 'first sentences');
  assert.equal(c.voiceTurn, null);
});

test('a turn already running when you spoke is not the answer; the next one is', () => {
  const c = conductorStub();
  c.voiceTurn = { client: 'p', at: Date.now(), busy: true, last: null };
  say(c, 'Spoken: from the earlier turn.\nEarlier reply.');
  assert.equal(c.events.filter(e => e.type === 'voice_say').length, 0);
  c.voiceTurnEnded();
  assert.ok(c.voiceTurn && !c.voiceTurn.busy, 'still waiting for the answer');
  say(c, 'Spoken: Your answer.\nText.');
  assert.deepEqual(c.events.find(e => e.type === 'voice_say').sentences, ['Your answer.']);
});

test('an answer that comes after 10 minutes is not read', () => {
  const c = conductorStub();
  c.voiceTurn = { client: 'p', at: Date.now() - 11 * 60 * 1000, busy: false, last: null };
  const ev = say(c, 'Spoken: late.\nText');
  assert.match(ev.text, /^Spoken: late/);
  assert.equal(c.voiceTurn, null);
});

test('the Conductor is asked for the Spoken line on a spoken message, in its note and its prompt', () => {
  assert.match(VOICE_NOTE, /Begin the message that answers it with one line "Spoken: "/);
  assert.match(src('../lib/prompts.mjs'), /Voice \(decision 61\)[\s\S]*"Spoken: "/);
  assert.match(src('../lib/conductor.mjs'), /afterTurn\(\) \{\s*this\.voiceTurnEnded\(\);/);
});

test('speech is made in order as soon as asked, handed over once, made on demand when missing, and dropped', async t => {
  const made = [];
  const voice = { say: async s => { made.push(s); return { wav: Buffer.from(s) }; } };
  const cache = new SpeechCache(voice);
  const ev = { id: 'v1', sentences: ['One.', 'Two.'] };
  cache.prepare(ev);
  assert.equal(String(await cache.take(ev, 1)), 'Two.');
  assert.deepEqual(made, ['One.', 'Two.'], 'in order');
  assert.equal(cache.items.size, 1);
  assert.equal(String(await cache.take(ev, 1)), 'Two.', 'taken already: made again on demand');
  assert.deepEqual(made, ['One.', 'Two.', 'Two.']);
  await assert.rejects(cache.take(ev, 5), /No such sentence/);
  cache.clear();
  assert.equal(cache.items.size, 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const short = new SpeechCache(voice, { keepMs: 1000 });
  short.prepare({ id: 'v2', sentences: ['A.'] });
  t.mock.timers.tick(1000);
  assert.equal(short.items.size, 0, 'unfetched speech goes after its time');
});

// An AudioContext with only what the player uses: each sentence "plays" until ended() is called.
function fakeCtx() {
  const ctx = { state: 'running', destination: {}, started: [], stopped: 0, sources: [] };
  ctx.resume = async () => { ctx.state = 'running'; };
  ctx.decodeAudioData = async bytes => ({ bytes });
  ctx.createBufferSource = () => {
    const s = { connect() { }, start() { ctx.started.push(String(Buffer.from(s.buffer.bytes))); }, stop() { ctx.stopped++; } };
    ctx.sources.push(s);
    return s;
  };
  return ctx;
}
const tick = () => new Promise(r => setImmediate(r));

test('the page plays sentence after sentence, fetching the next while one plays', async () => {
  const ctx = fakeCtx(), asked = [], changes = [];
  const p = new VoicePlayer({ ctx: () => ctx, fetchSentence: async (id, n) => { asked.push(`${id}:${n}`); return Buffer.from(`s${n}`); }, onChange: s => changes.push(s) });
  const done = p.play({ id: 'v1', sentences: ['a', 'b', 'c'] });
  await tick(); await tick();
  assert.deepEqual(ctx.started, ['s0']);
  assert.deepEqual(asked, ['v1:0', 'v1:1'], 'the next is on its way while the first plays');
  assert.equal(p.speaking, true);
  ctx.sources[0].onended(); await tick(); await tick();
  assert.deepEqual(ctx.started, ['s0', 's1']);
  ctx.sources[1].onended(); await tick(); await tick();
  ctx.sources[2].onended(); await done;
  assert.deepEqual(ctx.started, ['s0', 's1', 's2']);
  assert.equal(p.speaking, false);
  assert.deepEqual(changes, [true, false]);
});

test('a stop ends her at once and nothing after it plays', async () => {
  const ctx = fakeCtx();
  const p = new VoicePlayer({ ctx: () => ctx, fetchSentence: async (id, n) => Buffer.from(`s${n}`) });
  const done = p.play({ id: 'v1', sentences: ['a', 'b'] });
  await tick(); await tick();
  assert.equal(p.stop(), true);
  await done;
  assert.equal(ctx.stopped, 1);
  assert.deepEqual(ctx.started, ['s0']);
  assert.equal(p.speaking, false);
  assert.equal(p.stop(), false, 'nothing playing: nothing to stop');
  assert.match(voiceLine({ speaking: true }).text, /tap anywhere to stop/);
});

test('the page: only the page that spoke plays, never with its mic open; a tap anywhere stops her', () => {
  const app = src('../public/app.js');
  assert.match(app, /ev\.type === 'voice_say' && ev\.logged && ev\.project === CP\.CONDUCTOR && ev\.client === VOICE_CLIENT && S\.voice\?\.on && voiceRec\.state === 'idle'\) voicePlayer\.play\(ev\)/);
  assert.match(app, /\$\('#voice-stop'\)\.addEventListener\('pointerdown'/);
  assert.match(app, /if \(!S\.voice\.on\) voicePlayer\.stop\(\)/);
  assert.match(src('../public/index.html'), /<div id="voice-stop" class="voice-stop" hidden/);
  assert.match(src('../public/style.css'), /\.voice-stop\{position:fixed;inset:0;z-index:9000/);
  assert.match(src('../public/voice.js'), /client: VOICE_CLIENT/);
  assert.match(src('../server.mjs'), /hub\.conductor\.expectVoice\(client\)/);
});
