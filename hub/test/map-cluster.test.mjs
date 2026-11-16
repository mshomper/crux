// The Expedition module on the live map (phase 2): the cluster read from a project's agents and events, where it sits
// in the strip and the full map, and that an expedition's agents are one cluster, not workers, in every count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MapModel } from '../public/map-model.js';
import { expeditionCluster, clusterCaption, clusterLine, ROLE_ORDER, slugOf, fmtDuration, fmtMoney } from '../public/expedition-map.js';
import { stripLayout, radialLayout, blendLayouts } from '../public/map-layout.js';
import { rosterOf, hubView } from '../public/all-projects.js';

const ID = '20261116-json-bench';
const T0 = Date.parse('2026-11-16T08:00:00Z');
const at = ms => new Date(T0 + ms).toISOString();
const H = 3600e3;
const agent = (name, role, extra = {}) => ({ name, role: 'worker', thread: name, state: 'idle', expedition: ID, expeditionRole: role, model: 'claude-opus-5-5', effort: 'medium', ...extra });
const evs = (...x) => x.map((e, i) => ({ id: `e${i}`, ts: at(0), ...e }));

function project({ agents = [], events = [] } = {}) {
  return { name: 'proj', agents, events, board: {}, permissionMode: 'auto' };
}
const team = () => [agent('exp-lead', 'lead', { state: 'working' }), agent('exp-advisor', 'advisor', { state: 'retired' }), agent('exp-builder', 'builder', { state: 'working' }), agent('exp-skeptic', 'skeptic', { state: 'idle' })];
const started = (env = { hours: 6, percent: 7, dollars: 19 }) => ({ type: 'expedition_started', expedition: ID, envelope: env, ts: at(0) });

test('no expedition, or one that has ended: no cluster', () => {
  assert.equal(expeditionCluster(project(), T0), null);
  const ended = [started(), { type: 'expedition_stopped', expedition: ID, reason: 'passed', ts: at(H) }, { type: 'expedition_step', expedition: ID, step: 'summary', ts: at(H) }];
  assert.equal(expeditionCluster(project({ agents: team(), events: ended }), T0 + 2 * H), null);
  assert.equal(new MapModel().cluster(), null, 'a model with no project');
});

test('the cluster: the Lead, five stations in order (empty slots for roles not started), the badge, parked and the arcs', () => {
  const events = evs(started(), { type: 'expedition_gate', expedition: ID },
    { type: 'expedition_subagent', expedition: ID, phase: 'started', taskId: 't1' }, { type: 'expedition_subagent', expedition: ID, phase: 'started', taskId: 't2' },
    { type: 'expedition_subagent', expedition: ID, phase: 'started', taskId: 't3' }, { type: 'expedition_subagent', expedition: ID, phase: 'ended', taskId: 't2' },
    { type: 'expedition_parked', expedition: ID, text: 'a third library' }, { type: 'expedition_parked', expedition: ID, text: 'a core lesson', kind: 'lesson' },
    { type: 'expedition_loop', expedition: ID, number: 1, passing: 2, progress: true },
    { type: 'usage', agent: 'exp-lead', expedition: ID, costUSD: 3 }, { type: 'usage', agent: 'exp-builder', expedition: ID, costUSD: 4 }, { type: 'usage', agent: 'other', costUSD: 50 });
  const c = expeditionCluster(project({ agents: team(), events }), T0 + 2 * H + 14 * 60e3);
  assert.equal(c.id, ID);
  assert.equal(c.name, 'json-bench');
  assert.equal(c.phase, 'building');
  assert.equal(c.lead.id, 'exp-lead');
  assert.deepEqual(c.stations.map(s => s.role), ROLE_ORDER);
  assert.equal(c.stations.length, 5);
  assert.equal(c.stations.find(s => s.role === 'synthesizer').id, 'slot:synthesizer', 'not started: an empty slot');
  assert.equal(c.stations.find(s => s.role === 'advisor').sub, 'done', 'a retired Advisor reads done');
  assert.equal(c.stations.find(s => s.role === 'skeptic').sub, 'waits');
  assert.equal(c.gatherers, 2, 'three started, one ended');
  assert.equal(c.parked, 1, 'a held core lesson is not a parked item');
  assert.equal(c.loop, 1);
  assert.equal(c.time.usedMs, 2 * H + 14 * 60e3);
  assert.ok(Math.abs(c.time.pct - (2 * H + 14 * 60e3) / (6 * H)) < 1e-9);
  assert.equal(c.budget.usedUSD, 7, 'only this expedition\'s usage counts');
  assert.ok(Math.abs(c.budget.pct - 7 / 19) < 1e-9);
  assert.equal(c.amber, false);
  assert.deepEqual(clusterCaption(c), { title: 'EXPEDITION · JSON-BENCH', time: 'time 2 h 14 m of 6 h', budget: 'budget $7 of $19', line: 'time 2 h 14 m of 6 h  budget $7 of $19' });
  assert.equal(clusterLine(c), 'building · loop 1 · 2 gatherers · 1 parked');
});

test('amber from 90% of time or of budget; stopped freezes the clock; no dollar figure means no budget arc', () => {
  const base = [started(), { type: 'expedition_gate', expedition: ID }];
  assert.equal(expeditionCluster(project({ agents: team(), events: evs(...base) }), T0 + 5.4 * H).amber, true, '90% of 6 h');
  assert.equal(expeditionCluster(project({ agents: team(), events: evs(...base) }), T0 + 5.39 * H).amber, false);
  const spent = evs(...base, { type: 'usage', agent: 'exp-lead', expedition: ID, costUSD: 17.2 });
  const c = expeditionCluster(project({ agents: team(), events: spent }), T0 + H);
  assert.equal(c.amber, true, '17.2 of 19 is over 90%');
  assert.equal(c.time.pct < 0.9, true);
  const frozen = evs(...base, { type: 'expedition_stopped', expedition: ID, reason: 'budget', ts: at(3 * H) });
  const f = expeditionCluster(project({ agents: team(), events: frozen }), T0 + 9 * H);
  assert.equal(f.phase, 'writing up');
  assert.equal(f.time.usedMs, 3 * H, 'the clock stops at expedition_stopped');
  const unset = expeditionCluster(project({ agents: team(), events: evs(started({ hours: 6, percent: 7, dollars: null }), { type: 'usage', agent: 'x', expedition: ID, costUSD: 9 }) }), T0 + H);
  assert.equal(unset.budget.totalUSD, null);
  assert.equal(unset.budget.pct, null);
  assert.equal(unset.amber, false);
  assert.equal(clusterCaption(unset).budget, 'budget figure not set');
  assert.equal(expeditionCluster(project({ agents: team(), events: evs(started({ hours: 6, dollars: 19 })) }), T0 + 100 * H).time.pct, 1, 'past the envelope the arc is full, never beyond');
});

test('a successor Lead takes over the cluster; the one answering its successor does not', () => {
  const agents = [agent('exp-lead', 'lead', { state: 'idle', retiring: 'overlap' }), agent('exp-lead-2', 'lead', { state: 'working' })];
  assert.equal(expeditionCluster(project({ agents, events: evs(started()) }), T0).lead.id, 'exp-lead-2');
});

test('MapModel: expedition agents are not stations, the cluster is separate, and the feed carries the expedition lines', () => {
  const m = new MapModel();
  const p = project({ agents: [{ name: 'orchestrator-1', role: 'orchestrator', thread: 'orchestrator', state: 'idle' }, { name: 'w1', role: 'worker', thread: 'w1', state: 'working' }, ...team()], events: evs(started()) });
  m.setProject(p, new Set());
  assert.deepEqual(m.workers().list.map(w => w.id), ['w1']);
  assert.equal(m.cluster().id, ID);
  const line = ev => m.describe({ ts: at(0), ...ev });
  assert.match(line({ type: 'expedition_decision', number: 4, text: 'parse from a file', maker: 'exp-lead' }).text, /logged decision 4: parse from a file/);
  assert.match(line({ type: 'expedition_parked', text: 'a third library' }).text, /^parked: a third library/);
  assert.equal(line({ type: 'expedition_parked', kind: 'lesson', text: 'x' }), null, 'a held lesson is not a feed line');
  assert.match(line({ type: 'expedition_loop', number: 1, passing: 3, progress: true }).text, /build loop 1: 3 passing$/);
  assert.match(line({ type: 'expedition_loop', number: 2, passing: 3, progress: false }).text, /no progress/);
  assert.equal(line({ type: 'expedition_note', note: '90%' }), null, 'other expedition events stay out of the feed');
  // a member's summary flies to its Lead, never to the core; a member's message makes no pulse
  assert.deepEqual(m.pulsesFor({ type: 'summary', from: 'exp-builder' }), [{ from: 'exp-builder', to: 'exp-lead', tone: 'summary' }]);
  assert.deepEqual(m.pulsesFor({ type: 'message', from: 'exp-builder', thread: 'exp-builder' }), []);
  assert.deepEqual(m.pulsesFor({ type: 'agent_created', agent: 'exp-skeptic', role: 'worker', expedition: ID, expeditionRole: 'skeptic' }), [{ from: 'exp-lead', to: 'exp-skeptic', tone: 'spawn', delay: 450 }]);
  // no expedition card ever shows: nothing about an expedition counts as needing you
  assert.equal(m.needsCount(), 0);
});

// ---------- layout ----------
const CL = { lead: { id: 'exp-lead' }, stations: ROLE_ORDER.map(r => ({ id: `exp-${r}` })) };
const WORKERS = [{ id: 'w1' }, { id: 'w2' }];
const inside = (s, rect, pad = 0) => s.x - s.r >= rect.left + pad && s.x + s.r <= rect.left + rect.width - pad && s.y - s.r >= rect.top + pad && s.y + s.r <= rect.top + rect.height - pad;
const noOverlap = at => {
  const list = [...at.entries()].filter(([, s]) => s.r > 3);
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const [a, p] = list[i], [b, q] = list[j];
    assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= p.r + q.r + 2, `${a} and ${b} overlap`);
  }
};

test('without a cluster the layouts are exactly what they were', () => {
  for (const [rect, phone] of [[{ left: 300, top: 0, width: 980, height: 760 }, false], [{ left: 0, top: 0, width: 360, height: 740 }, true], [{ left: 200, top: 0, width: 1400, height: 900 }, false]]) {
    const a = radialLayout(rect, WORKERS, phone), b = radialLayout(rect, WORKERS, phone, null);
    assert.deepEqual([...a.at], [...b.at]);
    assert.equal(a.cluster, undefined);
    assert.deepEqual(stripLayout({ left: 0, top: 0, width: 800, height: 124 }, WORKERS, false), stripLayout({ left: 0, top: 0, width: 800, height: 124 }, WORKERS, false, null));
  }
});

test('full map with a cluster: everything inside the rect, no overlaps, the five on a ring round the Lead (desktop and 360 px)', () => {
  for (const [rect, phone] of [[{ left: 300, top: 0, width: 980, height: 760 }, false], [{ left: 0, top: 0, width: 1280, height: 800 }, false], [{ left: 0, top: 0, width: 360, height: 740 }, true], [{ left: 0, top: 0, width: 390, height: 844 }, true]]) {
    const L = radialLayout(rect, WORKERS, phone, CL);
    const g = L.cluster, lead = L.at.get('exp-lead');
    assert.ok(g && lead, 'a cluster and its Lead');
    for (const id of ['exp-lead', ...CL.stations.map(s => s.id), 'you', 'board', 'w1', 'w2']) assert.ok(inside(L.at.get(id), rect), `${id} inside the rect (${rect.width}px)`);
    assert.ok(inside({ x: g.x, y: g.y, r: g.Ro }, rect), `the arcs fit (${rect.width}px)`);
    noOverlap(L.at);
    assert.ok(L.core.x + L.core.r <= rect.left + rect.width && L.core.x - L.core.r >= rect.left, 'the core is inside');
    const ring = CL.stations.map(s => Math.hypot(L.at.get(s.id).x - g.x, L.at.get(s.id).y - g.y));
    assert.ok(ring.every(r => Math.abs(r - g.Rs) < 1e-6), 'on one ring');
    assert.ok(g.Rb < g.Ro && g.Rs + L.at.get('exp-advisor').r < g.Rb, 'stations sit inside both arcs');
    // the caption (room for two lines and Stop) stays inside the rect too
    assert.ok(g.caption.y + 70 <= rect.top + rect.height, `caption fits (${rect.width}px: ${g.caption.y})`);
    assert.ok(g.caption.w <= rect.width);
    if (!phone) assert.ok(L.core.x < g.x - g.Ro, 'desktop: the orchestrator is in the column at the left of the cluster');
    else assert.ok(L.core.y + L.core.r < g.y - g.Ro, 'phone: the core is above the cluster');
  }
});

test('the lane shows only the Lead; the five wait on it at radius 0 and open out with the zoom', () => {
  const slot = { left: 300, top: 0, width: 980, height: 124 };
  for (const phone of [false, true]) {
    const A = stripLayout(slot, WORKERS, phone, CL);
    const lead = A.at.get('exp-lead');
    assert.ok(lead.r > 0);
    for (const s of CL.stations) { const p = A.at.get(s.id); assert.deepEqual([p.x, p.y, p.r], [lead.x, lead.y, 0]); }
    // the Lead is the station nearest the core
    const d = id => Math.abs(A.at.get(id).x - A.core.x);
    assert.ok(d('exp-lead') <= Math.min(d('w1'), d('w2')));
    const B = radialLayout({ left: 300, top: 0, width: 980, height: 760 }, WORKERS, phone, CL);
    const origin = { x: 300, y: 0 };
    const half = blendLayouts(A, B, 0.5, origin), full = blendLayouts(A, B, 1, origin), none = blendLayouts(A, B, 0, origin);
    assert.ok(half.cluster.k === 0.5 && full.cluster.k === 1 && none.cluster.k === 0);
    assert.ok(none.cluster.Ro === 0, 'closed: the arcs have no size');
    assert.ok(Math.abs(none.cluster.x - (lead.x - origin.x)) < 1e-6, 'closed: they sit on the Lead');
    assert.ok(Math.abs(full.cluster.x - (B.cluster.x - origin.x)) < 1e-6 && full.cluster.Ro === B.cluster.Ro, 'open: full size, in place');
    assert.equal(full.at.get('exp-builder').r, B.at.get('exp-builder').r);
    assert.equal(none.at.get('exp-builder').r, 0);
  }
});

// ---------- counts ----------
test('an expedition\'s agents are left out of the All projects list and every working count', () => {
  const p = { name: 'proj', permissionMode: 'auto', events: [], board: { decisions: [], entries: [] }, agents: [{ name: 'orchestrator-1', role: 'orchestrator', thread: 'orchestrator', state: 'idle' }, { name: 'w1', role: 'worker', thread: 'w1', state: 'working' }, ...team()] };
  assert.deepEqual(rosterOf(p, new Set()).map(a => a.name), ['orchestrator-1', 'w1']);
  const v = hubView([p], new Set());
  assert.equal(v.groups[0].working, 1);
  assert.equal(v.agents, 2);
});

test('small helpers', () => {
  assert.equal(slugOf('20261116-gpu-mesh-2'), 'gpu-mesh-2');
  assert.equal(fmtDuration(0), '0 m');
  assert.equal(fmtDuration(6 * H), '6 h');
  assert.equal(fmtDuration(2 * H + 14 * 60e3), '2 h 14 m');
  assert.equal(fmtMoney(7), '$7');
  assert.equal(fmtMoney(2.46), '$2.5');
  assert.equal(fmtMoney(19.4), '$19');
});
