// Fictional demo content for the Crux Hub screenshots: Alex plans hikes with an app called "trailhead".
// Nothing here comes from a real project. stage.mjs turns `ago` (minutes before now) into timestamps, and
// "{{t:N}}" inside a text into the time N minutes ago, the way the hub writes it ("2026-01-01 10:00 UTC").

export const profileCore = `# Working with Alex: core

- Alex builds trailhead, a hiking-trail planner, in spare evenings.
- Plain words, short answers. Show options before building anything large.
- Distances and climbs must be believable to someone who has walked the trail.
`;

// Demo agent types (Claude Code agent files), written to the demo home folder's .claude/agents.
export const agentTypes = {
  builder: `---\nname: builder\ndescription: Builds one feature from a short brief, with tests, and reports what changed\nmodel: sonnet\neffort: high\n---\nBuild the feature in the brief. Keep the change small and tested.\n`,
  reviewer: `---\nname: reviewer\ndescription: Reads a whole change before it is tried out, and reports bugs in plain words\nmodel: sonnet\neffort: medium\ntools: Read, Grep, Glob, Bash\n---\nRead the whole change. Report bugs, worst first. Do not edit files.\n`,
  researcher: `---\nname: researcher\ndescription: Digs into a question across the code and the web, and reports sources and confidence\nmodel: opus\neffort: high\ntools: Read, Grep, Glob, WebSearch, WebFetch\n---\nAnswer the question with sources. Say how sure you are.\n`,
  'quick-fix': `---\nname: quick-fix\ndescription: Small, scoped fixes in a file or two; makes the smallest change, then stops\nmodel: haiku\neffort: low\n---\nMake the smallest change that fixes the problem, then stop.\n`
};

// The project's committed hub settings: Auto mode (work inside the project runs without asking).
export const projectHubJson = { permissions: 'auto' };

const opt = (key, name, summary) => ({ source: 'claude', key, name, summary, pros: [], cons: [], effort: 'Small' });
const record = (id, slug, title, context, options, recommended, extra = {}) => ({
  id, slug, title, date: null, mode: 'full', lenses: ['architecture'], status: 'open', context,
  depends_on: [], conflicts: [], options, criteria: [], recommended, recommendation: '', confidence: recommended ? 'lean' : null,
  chosen: null, reason: '', decided_on: null, superseded_by: null, challenge: null, settles: [], ...extra
});

// decided: 'X' fills status, chosen and decided_on in stage.mjs (with today's date).
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
    'B', { recommendation: 'Vector files keep downloads small and still show the land around the trail.' }),
  record(5, 'gpx-no-heights', 'What happens to a GPX file with no heights?',
    'Some shared files carry only positions. Without heights there is no climb to show.',
    [opt('A', 'Fill heights from map data', 'The route gets a climb figure, marked as estimated.'),
     opt('B', 'Import it flat and say so', 'Nothing is guessed; the route page shows no climb.')],
    null)
];

const O1 = 'orchestrator-1', O2 = 'orchestrator-2';
const workers = [
  { name: 'elevation', type: 'builder', model: 'claude-sonnet-5-5', effort: 'high', goal: 'Make elevation gain match what a watch records',
    task: 'Make elevation gain match what a watch records. Follow decision 2: smooth the height data, then count rises over 3 m. Check it against the three sample trails.' },
  { name: 'offline-maps', type: null, model: 'claude-sonnet-5-5', effort: 'medium', goal: 'Open a planned route with no signal',
    task: 'Open a planned route with no signal. Start with the download screen and a size estimate; storage format is still an open decision.' },
  { name: 'gpx-import', type: null, model: 'claude-haiku-5-5', effort: 'low', goal: 'Import GPX files shared by friends',
    task: 'Import GPX files shared by friends. Read tracks and waypoints, skip anything else, and say plainly what was skipped.' }
];

const busy = (ago, agent, on, contextPct) => ({ ago, type: 'agent_busy', agent, busy: on, ...(contextPct != null ? { contextPct } : {}) });
const say = (ago, thread, from, text, extra = {}) => ({ ago, type: 'message', thread, from, text, ...extra });
const entry = (ago, entryId, kind, title, summary, from, extra = {}) => ({ ago, type: 'entry', entryId, kind, title, summary, body: summary, supersedes: null, from, ...extra });
const answer = (ago, worker, command, ans, reason) => ({ ago, type: 'permission_answer', thread: 'orchestrator', approval: `demo-answered-${ago}`, worker, workerThread: worker, tool: 'Bash', command, answer: ans, reason, by: O2 });

const handoffBody = `### In flight, and why
- offline-maps: the download screen works; the store waits on the storage format (decision 4)
- gpx-import: tracks and waypoints import; files without heights need a call (decision 5)

### Promises to Alex
- No map download over mobile data without asking first
- Elevation is not called done until gain is within 5% of a watch

### Risks and things easy to miss
- Height data has gaps above the tree line (M001); long ridges may read low

### Next steps
- Get Alex's pick on decision 4, then send offline-maps on
- Ask elevation for gain per trail section

### Facts (from the hub)
Standing approvals and instructions from Alex (all so far; whole, oldest first):
- [{{t:200}}] Morning. This weekend I want three things: elevation gain that I can trust, maps that work with no signal, and a start on importing GPX files from friends.
- [{{t:194}}] 2B 3C
Workers:
- elevation (idle): Make elevation gain match what a watch records. Last summary ({{t:150}}): Show gain per trail section on the route page.
- offline-maps (working): Open a planned route with no signal. No summary yet.
- gpx-import (working): Import GPX files shared by friends. No summary yet.
Open pull requests: none. Worktrees: none.
Questions still waiting on Alex:
- none
Decisions waiting on Alex:
- D0004 How are offline maps stored on the phone? (recommended B)`;

export const events = [
  // ----- morning: orchestrator-1 sets the work up -----
  say(200, 'orchestrator', 'you', 'Morning. This weekend I want three things: elevation gain that I can trust, maps that work with no signal, and a start on importing GPX files from friends.'),
  { ago: 199.9, type: 'agent_created', agent: O1, role: 'orchestrator', task: '', goal: '', generation: 1, predecessor: null, handoffEntry: null, thread: 'orchestrator', agentType: null, model: 'claude-opus-5-5', effort: 'high' },
  { ago: 199.8, type: 'notice', thread: 'orchestrator', text: `${O1} holds the orchestrator role.` },
  { ago: 199.7, type: 'agent_session', agent: O1, sessionId: 'demo-session-orchestrator-1', model: 'claude-opus-5-5', effort: 'high', agentType: null },
  busy(199.6, O1, true),
  entry(199, 'R001', 'requirement', 'Works with no signal', 'A planned route opens, shows the map and tracks progress with the phone offline.', 'you'),
  entry(198.9, 'R002', 'requirement', 'Agent permission rules', 'Work inside trailhead runs without asking. Downloads, installs, pushes and anything outside the folder come to Alex.', 'you'),
  entry(198.8, 'C001', 'convention', 'Heights in metres inside the app', 'Store metres everywhere; convert only when showing a number.', 'you'),
  say(198, 'orchestrator', O1, 'Three workers, one per goal: **elevation**, **offline-maps** and **gpx-import**. Two calls are yours before they go far: how gain is worked out, and which units to show.'),
  ...workers.flatMap((w, i) => [
    { ago: 197 - i * 0.1, type: 'agent_created', agent: w.name, role: 'worker', task: w.task, goal: w.goal, generation: 0, predecessor: null, handoffEntry: null, thread: w.name, agentType: w.type, model: w.model, effort: w.effort },
    say(196.9 - i * 0.1, w.name, O1, w.task, { agentType: w.type, model: w.model, effort: w.effort }),
    { ago: 196.8 - i * 0.1, type: 'agent_session', agent: w.name, sessionId: `demo-session-${w.name}`, model: w.model, effort: w.effort, agentType: w.type },
    busy(196.7 - i * 0.1, w.name, true)
  ]),
  busy(195, O1, false, 24),
  say(194, 'orchestrator', 'you', '2B 3C'),
  { ago: 193.9, type: 'pick', decision: 2, choice: 'B', title: 'How is elevation gain worked out?', label: 'B: Smooth, then count rises over 3 m', reason: '', thread: 'orchestrator' },
  { ago: 193.8, type: 'pick', decision: 3, choice: 'C', title: 'Distances in kilometres or miles?', label: 'C: Follow the phone, with a switch', reason: '', thread: 'orchestrator' },

  // elevation: a finished round, and a memo for the board
  entry(151, 'M001', 'memo', 'Height data has gaps above the tree line', 'Two sample trails lose height readings on open ridges; gaps are bridged in a straight line for now.', 'elevation'),
  { ago: 150, type: 'summary', thread: 'elevation', from: 'elevation',
    done: ['Gain now smooths the height data and counts rises over 3 m', 'Checked three sample trails: all within 4% of a watch recording'],
    changed: ['src/elevation/gain.js', 'test/elevation.test.js'], questions: [], blocked_on: [], decisions_needed: [],
    next_step: 'Show gain per trail section on the route page.' },
  busy(149.9, 'elevation', false, 31),

  // ----- the role changes hands: orchestrator-1 leaves a handoff, orchestrator-2 takes over -----
  { ago: 141, type: 'notice', thread: 'orchestrator', text: `${O1} is at 61% of its context; handing the role on.` },
  entry(140, 'H001', 'handoff', `Handoff from ${O1}`, 'Get Alex\'s pick on decision 4, then send offline-maps on', O1, { body: handoffBody, role: 'orchestrator' }),
  { ago: 139.9, type: 'agent_created', agent: O2, role: 'orchestrator', task: '', goal: '', generation: 2, predecessor: O1, handoffEntry: 'H001', thread: 'orchestrator', agentType: null, model: 'claude-opus-5-5', effort: 'high' },
  { ago: 139.8, type: 'notice', thread: 'orchestrator', text: `${O1} left handoff H001; ${O2} takes over.` },
  { ago: 139.7, type: 'agent_session', agent: O2, sessionId: 'demo-session-orchestrator-2', model: 'claude-opus-5-5', effort: 'high', agentType: null },
  busy(139.6, O2, true),
  say(139, 'orchestrator', O2, 'Picked up from handoff H001. Elevation is checked; offline maps and GPX import are in flight.'),
  busy(138, O2, false, 9),
  busy(137.9, O1, false, 61),
  { ago: 137.8, type: 'agent_retired', agent: O1, thread: 'orchestrator' },
  { ago: 137.7, type: 'notice', thread: 'orchestrator', text: `${O1} retired after handoff H001.` },

  // ----- the orchestrator answers workers' permission requests (one audit line each) -----
  answer(110, 'gpx-import', 'mkdir test/fixtures/gpx', 'allow', 'Inside the project, part of its task'),
  answer(96, 'offline-maps', 'node scripts/estimate-size.mjs routes/ridge-loop.json', 'allow', 'Runs its own script inside the project'),
  answer(83, 'gpx-import', 'rm -rf ../shared-routes', 'deny', 'Outside the project folder; R002 keeps work inside trailhead'),

  // gpx-import: raises a decision, then rests
  say(72, 'gpx-import', 'gpx-import', 'Tracks and waypoints import from the five sample files. Two files carry no heights; I wrote that up as decision 5 for Alex.'),
  busy(71.9, 'gpx-import', false, 9),

  // offline-maps: asks Alex a question, and wants to download a sample (a hard stop, so it comes to Alex)
  { ago: 61, type: 'summary', thread: 'offline-maps', from: 'offline-maps',
    done: ['Download screen with a size estimate before you start', 'A downloaded route opens in flight mode'],
    changed: ['src/offline/download.js', 'src/offline/store.js'],
    questions: ['A 40 km route is about 180 MB at full detail. Should downloads wait for Wi-Fi unless you say otherwise?'],
    blocked_on: ['The storage format for offline maps'], decisions_needed: [],
    next_step: 'Build the store once the format is picked.' },
  busy(60.9, 'offline-maps', false, 22),
  { ago: 38, type: 'approval', thread: 'offline-maps', approval: 'demo-approval-download', agent: 'offline-maps', tool: 'Bash',
    input: { command: 'curl -L -o test/data/sample-region.osm.pbf https://download.example.org/sample-region.osm.pbf', description: 'Get a small sample region to test downloads with' },
    title: null, description: null, always: null,
    summary: { plain: 'Download from download.example.org', tags: [{ text: 'Internet: download.example.org', level: 'care' }, { text: 'Writes test/data/sample-region.osm.pbf', level: 'write' }] },
    routedTo: null, stops: ['uses the internet'], rules: 'R002' },

  // elevation: sent on by the new orchestrator
  say(50, 'elevation', O2, 'Good round. Next: show gain per trail section on the route page.'),
  say(49, 'elevation', 'elevation', 'On it: adding gain per section to the route page.'),

  // ----- back in the orchestrator thread -----
  say(24, 'orchestrator', 'you', 'How are we doing? Is anything stuck on me?'),
  busy(23.9, O2, true),
  say(22, 'orchestrator', O2, 'Two of three are moving. Offline maps is waiting on one call from you, below.'),
  { ago: 21, type: 'summary', thread: 'orchestrator', from: O2,
    done: ['elevation: gain within 4% of a watch on three sample trails', 'gpx-import: tracks and waypoints import from shared files'],
    changed: [], questions: [], blocked_on: [], decisions_needed: [4],
    next_step: 'Send offline-maps on as soon as you pick the storage format.' },
  busy(20.9, O2, false, 34)
];

// What a restored hub cannot show, laid over the hub's answers by overlay-proxy.mjs (no real agent runs):
// who is working or resting right now, which permission card is still waiting, and one line of live activity.
export const overlay = {
  states: { [O2]: 'idle', elevation: 'working', 'offline-maps': 'idle', 'gpx-import': 'asleep' },
  pendingApprovals: ['demo-approval-download'],
  activity: [{ agent: 'elevation', thread: 'elevation', text: 'Editing route/sections.js' }]
};
