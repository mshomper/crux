// Fictional demo content for the Crux Hub screenshots: Alex plans hikes with an app called "trailhead".
// Nothing here comes from a real project. stage.mjs turns `ago` (minutes before now) into timestamps.

export const PROJECT = 'trailhead';

export const profileCore = `# Working with Alex: core

- Alex builds trailhead, a hiking-trail planner, in spare evenings.
- Plain words, short answers. Show options before building anything large.
- Distances and climbs must be believable to someone who has walked the trail.
`;

const opt = (key, name, summary) => ({ source: 'claude', key, name, summary, pros: [], cons: [], effort: 'Small' });
const record = (id, slug, title, context, options, recommended, extra = {}) => ({
  id, slug, title, date: null, mode: 'full', lenses: ['architecture'], status: 'open', context,
  depends_on: [], conflicts: [], options, criteria: [], recommended, recommendation: '', confidence: 'lean',
  chosen: null, reason: '', decided_on: null, superseded_by: null, challenge: null, settles: [], ...extra
});

// decided: true fills status, chosen and decided_on in stage.mjs (with today's date).
export const decisions = [
  record(1, 'map-data', 'Which map data do trails come from?',
    'Trails need names, surfaces and junctions. The source also sets what the app may store offline.',
    [opt('A', 'OpenStreetMap', 'Free, detailed paths, and the licence allows offline copies.'),
     opt('B', 'A paid map service', 'Polished tiles, but offline use is limited and billed per download.')],
    'A', { decided: 'A' }),
  record(2, 'elevation-gain', 'How is elevation gain worked out?',
    'Adding up every small rise in raw height data overstates a climb by a third on rocky trails.',
    [opt('A', 'Sum every rise', 'Simple, but noise in the height data counts as climbing.'),
     opt('B', 'Smooth, then count rises over 3 m', 'Matches what a barometer watch records on the same trail.'),
     opt('C', 'Ask an elevation service', 'Accurate, but needs a signal at the trailhead.')],
    'B', { decided: 'B' }),
  record(3, 'distance-units', 'Distances in kilometres or miles?',
    'Trail signs differ by country, and friends share routes across borders.',
    [opt('A', 'Kilometres only', 'One unit everywhere; least work.'),
     opt('B', 'Miles only', 'Matches signs in a few countries.'),
     opt('C', 'Follow the phone, with a switch', 'Starts from the phone\'s region; one tap changes it.')],
    'C', { decided: 'C' }),
  record(4, 'offline-maps', 'How are offline maps stored on the phone?',
    'A weekend route has to open with no signal. Storage decides download size and how sharp the map looks.',
    [opt('A', 'Image tiles in folders', 'Easiest to build; about 180 MB for a 40 km route.'),
     opt('B', 'One vector file per region', 'About 25 MB for the same route, sharp at every zoom.'),
     opt('C', 'Only the route corridor', 'Smallest download, but nothing to see if you leave the trail.')],
    'B', { recommendation: 'Vector files keep downloads small and still show the land around the trail.' })
];

const ORCH = 'orchestrator-1';
const workers = [
  { name: 'elevation', model: 'claude-sonnet-5-5', effort: 'high', goal: 'Make elevation gain match what a watch records',
    task: 'Make elevation gain match what a watch records. Follow decision 2: smooth the height data, then count rises over 3 m. Check it against the three sample trails.' },
  { name: 'offline-maps', model: 'claude-sonnet-5-5', effort: 'medium', goal: 'Open a planned route with no signal',
    task: 'Open a planned route with no signal. Start with the download screen and a size estimate; storage format is still an open decision.' },
  { name: 'gpx-import', model: 'claude-haiku-5-5', effort: 'low', goal: 'Import GPX files shared by friends',
    task: 'Import GPX files shared by friends. Read tracks and waypoints, skip anything else, and say plainly what was skipped.' }
];

const busy = (ago, agent, on, contextPct) => ({ ago, type: 'agent_busy', agent, busy: on, ...(contextPct != null ? { contextPct } : {}) });
const say = (ago, thread, from, text, extra = {}) => ({ ago, type: 'message', thread, from, text, ...extra });

export const events = [
  say(96, 'orchestrator', 'you', 'Morning. This weekend I want three things: elevation gain that I can trust, maps that work with no signal, and a start on importing GPX files from friends.'),
  { ago: 96, type: 'agent_created', agent: ORCH, role: 'orchestrator', task: '', goal: '', generation: 1, predecessor: null, handoffEntry: null, thread: 'orchestrator', agentType: null, model: 'claude-opus-5-5', effort: 'high' },
  { ago: 96, type: 'notice', thread: 'orchestrator', text: `${ORCH} holds the orchestrator role.` },
  { ago: 96, type: 'agent_session', agent: ORCH, sessionId: 'demo-session-orchestrator', model: 'claude-opus-5-5', effort: 'high', agentType: null },
  busy(96, ORCH, true),
  { ago: 94, type: 'entry', entryId: 'R001', kind: 'requirement', title: 'Works with no signal', summary: 'A planned route opens, shows the map and tracks progress with the phone offline.', body: 'A planned route opens, shows the map and tracks progress with the phone offline. Downloads happen on Wi-Fi before the trip.', supersedes: null, from: 'you' },
  { ago: 94, type: 'entry', entryId: 'C001', kind: 'convention', title: 'Heights in metres inside the app', summary: 'Store metres everywhere; convert only when showing a number.', body: 'Store metres everywhere; convert only when showing a number.', supersedes: null, from: 'you' },
  say(93, 'orchestrator', ORCH, 'Three workers, one per goal: **elevation**, **offline-maps** and **gpx-import**. Two calls are yours before they go far: how gain is worked out, and which units to show.'),
  ...workers.flatMap(w => [
    { ago: 92, type: 'agent_created', agent: w.name, role: 'worker', task: w.task, goal: w.goal, generation: 0, predecessor: null, handoffEntry: null, thread: w.name, agentType: null, model: w.model, effort: w.effort },
    say(92, w.name, ORCH, w.task, { agentType: null, model: w.model, effort: w.effort }),
    { ago: 92, type: 'agent_session', agent: w.name, sessionId: `demo-session-${w.name}`, model: w.model, effort: w.effort, agentType: null },
    busy(92, w.name, true)
  ]),
  busy(91, ORCH, false, 11),
  say(88, 'orchestrator', 'you', '2B 3C'),
  { ago: 88, type: 'pick', decision: 2, choice: 'B', title: 'How is elevation gain worked out?', label: 'B: Smooth, then count rises over 3 m', reason: '', thread: 'orchestrator' },
  { ago: 88, type: 'pick', decision: 3, choice: 'C', title: 'Distances in kilometres or miles?', label: 'C: Follow the phone, with a switch', reason: '', thread: 'orchestrator' },

  // elevation: a finished round, and a memo for the board
  { ago: 52, type: 'entry', entryId: 'M001', kind: 'memo', title: 'Height data has gaps above the tree line', summary: 'Two sample trails lose height readings on open ridges; gaps are bridged in a straight line for now.', body: 'Two sample trails lose height readings on open ridges; gaps are bridged in a straight line for now.', supersedes: null, from: 'elevation' },
  { ago: 50, type: 'summary', thread: 'elevation', from: 'elevation',
    done: ['Gain now smooths the height data and counts rises over 3 m', 'Checked three sample trails: all within 4% of a watch recording'],
    changed: ['src/elevation/gain.js', 'test/elevation.test.js'], questions: [], blocked_on: [], decisions_needed: [],
    next_step: 'Show gain per trail section on the route page.' },
  busy(50, 'elevation', false, 31),

  // gpx-import: quietly resting
  say(64, 'gpx-import', 'gpx-import', 'Tracks and waypoints import from the five sample files. Heart-rate data is skipped, and the import screen says so.'),
  busy(64, 'gpx-import', false, 9),

  // offline-maps: waits on Alex
  { ago: 31, type: 'summary', thread: 'offline-maps', from: 'offline-maps',
    done: ['Download screen with a size estimate before you start', 'A downloaded route opens in flight mode'],
    changed: ['src/offline/download.js', 'src/offline/store.js'],
    questions: ['A 40 km route is about 180 MB at full detail. Should downloads wait for Wi-Fi unless you say otherwise?'],
    blocked_on: ['The storage format for offline maps'], decisions_needed: [],
    next_step: 'Build the store once the format is picked.' },
  busy(31, 'offline-maps', false, 22),

  // back in the orchestrator thread
  say(24, 'orchestrator', 'you', 'How are we doing? Is anything stuck on me?'),
  busy(24, ORCH, true),
  say(22, 'orchestrator', ORCH, 'Two of three are moving. Offline maps is waiting on one call from you, below.'),
  { ago: 21, type: 'summary', thread: 'orchestrator', from: ORCH,
    done: ['elevation: gain within 4% of a watch on three sample trails', 'gpx-import: tracks and waypoints import from shared files'],
    changed: [], questions: [], blocked_on: [], decisions_needed: [4],
    next_step: 'Send offline-maps on as soon as you pick the storage format.' },
  busy(21, ORCH, false, 34)
];
