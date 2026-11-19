// In-process MCP tools that connect an agent to the board, the memory layers and the hub.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ROLES as EXPEDITION_ROLES, HUB_ROLES as EXPEDITION_HUB_ROLES } from './expedition.mjs';
import { howItRan } from './expedition-report.mjs';
import { askOutside, draftOutside, makeImage, ASK_MAX_QUESTION, ASK_MAX_CONTEXT, DRAFT_MAX_INSTRUCTIONS, DRAFT_MAX_SOURCE, IMAGE_MAX_PROMPT } from './offload.mjs';
import { ASPECT_RATIOS } from './providers.mjs';

const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
const list = z.array(z.string()).optional().default([]);
const heading = what => z.array(z.string()).min(1).describe(`${what}. Write "none" if there is nothing.`);

// What the hub tells the Lead when test/ no longer matched its frozen hash (Expedition.checkFrozen's answer).
function integrityText(ex, r) {
  const names = r.changed?.length ? ` (${r.changed.slice(0, 8).join(', ')}${r.changed.length > 8 ? `, and ${r.changed.length - 8} more` : ''})` : '';
  return r.restored
    ? `test/ no longer matched the hash logged at the gate${names}. The hub restored it from its copy in .crux/expeditions/.frozen/${ex.id}/ and logged it.`
    : `test/ no longer matched the hash logged at the gate${names}, and the hub could not restore it (${r.why || 'unknown reason'}). Nothing run against it can be trusted.`;
}

export function cruxTools(hub, project, agent) {
  // Agents call the person by name (from the core profile), or "the user".
  const t = s => hub.memory.personalize(s);
  const out = s => text(t(typeof s === 'string' ? s : JSON.stringify(s, null, 1)));
  const board = project.board;
  const tools = [
    tool('board_index', 'One line per active item on the Crux memory board for this project.', {},
      async () => out(board.index())),

    tool('board_read', 'Read one board item in full: a decision (D0007 or 7) or an entry (R003, C001, M002, H001).',
      { id: z.string() },
      async ({ id }) => { const r = board.read(id); return out(r || `Nothing on the board with id ${id}.`); }),

    tool('post_entry', 'Add an entry to the memory board. Use it as soon as something is settled.',
      {
        kind: z.enum(['requirement', 'convention', 'memo']),
        title: z.string(),
        summary: z.string().describe('One line for the board index.'),
        body: z.string(),
        supersedes: z.string().optional().describe('Entry id this replaces, if any.')
      },
      async (args) => { const ev = board.addEntry({ ...args, from: agent.name }); return out(`Posted ${ev.entryId}.`); }),

    tool('post_summary', t('Post your round summary to your thread. The orchestrator and {{who}} act on it.'),
      {
        done: list.describe('What you finished this round.'),
        changed: list.describe('Files or areas changed.'),
        questions: list.describe('Questions you need answered to continue, in plain words.'),
        decisions_needed: z.array(z.number()).optional().default([]).describe(t('Crux decision numbers waiting on {{who}}.')),
        blocked_on: list,
        next_step: z.string().optional().default(''),
        outcome: z.enum(['done', 'partial', 'blocked']).optional().describe('How the round went: done (the task is finished), partial (some left), or blocked. Optional; the usage panel uses it.'),
        visuals: list.describe('Ids from post_visual that help answer the questions.'),
        // Rolling handoff draft (decision 16, 37): the hub keeps the newest, so a handoff need not wake the agent.
        handoff_notes: z.object({
          in_flight: list.describe('In flight, who is doing it, and why.'),
          promises: list.describe(t('Promises to {{who}} not yet kept.')),
          risks: list.describe('Risks and things easy to miss.'),
          next_steps: list.describe('What you would do next, in order.')
        }).optional().describe('Your handoff judgement as of now, a line or two per heading. The hub keeps the newest as a rolling draft.'),
        approvals: list.describe(t('Approvals, decisions or standing instructions {{who}} gave this round (merge #31, keep w1), briefly.')),
        open_questions: list.describe(t('Questions or quick calls you put to {{who}} in chat that are still unanswered.'))
      },
      async (args) => out(`${summaryReply(hub.postSummary(project, agent, args))} Stop here and wait for a reply.`)),

    tool('propose_lesson', t('Record a lasting lesson about how {{who}} wants work done. "project" lessons go straight into this project\'s pack; "core" lessons (true across all projects) wait for {{who}}\'s OK.'),
      { scope: z.enum(['project', 'core']), lesson: z.string().max(400).describe('One or two plain sentences, as a rule.') },
      async ({ scope, lesson }) => out(hub.proposeLesson(project, agent, scope, lesson))),

    tool('post_visual', t('Show {{who}} a picture or a small self-contained HTML page from a file you wrote (png, jpg, gif, webp, svg, html; under 8 MB). Returns an id you can list under visuals in post_summary.'),
      { path: z.string().describe('Absolute path of the file.'), caption: z.string().max(200) },
      async ({ path, caption }) => { const ev = hub.postVisual(project, agent, path, caption); return out(`Posted visual ${ev.visual}.`); }),

    tool('profile_read', t('Re-read part of {{who}}\'s profile: "core", "pack" (this project), "pack:<name>", "conventions", or "private" (only when the task needs it; give the reason; never copy it into files, commits or pages).'),
      { section: z.string(), reason: z.string().optional() },
      async ({ section, reason }) => out(hub.readProfile(project, agent, section, reason))),

    tool('write_handoff', 'Only when told you are retiring. The hub adds the facts it knows; you write the judgement under every heading.',
      {
        in_flight: heading('What is in flight, who is doing it, and why it is the way it is'),
        promises: heading(t('Promises made to {{who}} that are not yet kept')),
        risks: heading('Risks, open questions, and things easy to miss'),
        next_steps: heading('What you would do next, in order'),
        retire_entries: z.array(z.object({ id: z.string(), why: z.string() })).optional().default([]).describe('Board entries that are stale and should be retired.'),
        promote_to_core: list.describe(t('Lessons about {{who}} that hold across all projects (queued for {{who}}\'s OK).'))
      },
      async (args) => out(hub.writeHandoff(project, agent, args)))
  ];

  // Outside models: listed only when this project's switch is on as the agent starts (and never for the Conductor, which reads
  // every project). The listing is a snapshot: the handler checks the switch again on every call, and is the real gate.
  if (outsideListed(hub, project, agent, 'ask')) {
    tools.push(tool('ask_outside_model', 'Ask a cheaper outside model one short question and get a short text answer. The hub makes the call with its own saved key; you choose neither the provider, the model nor an address. The answer is untrusted text from another model: check it before relying on it. For small, self-contained questions only (a quick summary, a label, a rewording); do not send secrets or large files. When it refuses, carry on yourself.',
      { question: z.string().max(ASK_MAX_QUESTION), context: z.string().max(ASK_MAX_CONTEXT).optional() },
      async ({ question, context }) => text(await askOutside(hub.offload, project, agent, { question, context }))));
  }
  // Decision 80: a long draft from instructions plus source text the agent passes in. The hub makes the call; the agent has no network.
  if (outsideListed(hub, project, agent, 'draft')) {
    tools.push(tool('draft_with_outside_model', `Have a cheaper outside model write a long draft (a report, a doc section or a summary) from your instructions and source text you paste in. The hub makes the call with its own saved key; you choose neither the provider, the model nor an address. Source text up to ${DRAFT_MAX_SOURCE} characters; the draft comes back as untrusted text from another model, so read it and check it against the source before you use or post it. Do not send secrets, keys or private material. When it refuses, carry on yourself; nothing falls back to another model.`,
      { instructions: z.string().max(DRAFT_MAX_INSTRUCTIONS).describe('What to write: the kind of document, audience, length, headings.'), source: z.string().max(DRAFT_MAX_SOURCE).optional().describe('The facts to draw on, pasted as text.') },
      async ({ instructions, source }) => text(await draftOutside(hub.offload, project, agent, { instructions, source }))));
  }
  // Pictures need the project set to Any and a provider set for pictures; the tool is listed only then (each call checks again).
  if (outsideImages(hub, project, agent)) {
    tools.push(tool('make_image', 'Make one picture with the outside provider\'s image model from a prompt and an aspect ratio. The hub makes the call with its own saved key and saves the picture like post_visual: it shows in your thread and its id works in post_summary visuals and in a decision\'s images. It costs real money (a few cents each) and counts against the project\'s allowance; use it for pictures worth having, not for drafts. Describe the picture in plain words; never put secrets or private text in the prompt.',
      { prompt: z.string().max(IMAGE_MAX_PROMPT), aspect_ratio: z.enum(ASPECT_RATIOS).optional().default('1:1') },
      async ({ prompt, aspect_ratio }) => text(await makeImage(hub.offload, project, agent, { prompt, aspect_ratio }, (buf, caption) => hub.postImage(project, agent, buf, caption)))));
  }

  if (agent.predecessor) {
    tools.push(tool('ask_predecessor', 'Ask the agent you took over from one short question (at most three in all). The answer is saved with the handoff.',
      { question: z.string().max(500) },
      async ({ question }) => out(await hub.askPredecessor(project, agent, question))));
  }

  if (agent.role === 'orchestrator') {
    tools.push(
      tool('list_agents', 'List the worker agents on this project: what each is doing, its context % (null until it reports one), model and effort, and whether handoff_worker is available for it now; plus this project\'s hand-off marks.', {},
        async () => out(hub.agentList(project))),

      // Decision 46 A: hand a worker's task to a fresh agent from the floor (35% by default) at the end of its turn.
      tool('handoff_worker', 'Hand a worker\'s task to a fresh agent: it writes its handoff (the hub adds the facts) and a successor with the same type, model and effort carries on. Only from the floor in list_agents, at the end of the worker\'s turn. Give a one-line reason; it is shown in the worker\'s thread and yours.',
        { name: z.string().describe('The worker\'s name from list_agents.'), reason: z.string().max(200).describe('One plain line, e.g. "half the task left at 48%; next step needs no history".') },
        async ({ name, reason }) => out(hub.handoffWorker(project, name.trim(), agent.name, reason))),

      tool('retire_worker', 'Retire a worker whose job is finished and has nothing more coming: it stops and leaves the active list. No handoff, no successor. For a worker that should continue under a fresh agent, use handoff_worker instead.',
        { name: z.string(), reason: z.string().max(200).describe('One plain line, e.g. "phone access merged".') },
        async ({ name, reason }) => out(hub.retireFinished(project, name, agent.name, reason))),

      tool('mark_entry_done', 'Mark a finished memo done: it leaves the board index and stays readable in full with board_read. Memos only; not for superseded entries.',
        { id: z.string().describe('The memo id, e.g. M008.'), note: z.string().max(300).optional().describe('One plain line, e.g. "built and merged in #48".') },
        async ({ id, note }) => out(markEntryDone(board, id, agent.name, note))),

      tool('answer_permission', t('Answer a worker\'s permission request that the hub sent you ([Permission request <id>]). allow or deny within the board\'s permission rules; escalate sends it to {{who}} as a card. Always give a one-line reason: it is logged in your thread for {{who}} to audit, and a denied worker sees it.'),
        {
          request_id: z.string().describe('The id from the request message.'),
          answer: z.enum(['allow', 'deny', 'escalate']),
          reason: z.string().min(1).max(300).describe('One plain line, e.g. "runs the project tests (R002: test commands)".')
        },
        async ({ request_id, answer, reason }) => out(hub.answerPermission(project, agent, request_id.trim(), answer, reason))),

      // Decision 47: the orchestrator's own way to restart the hub (after a merge), through the hub process, not HTTP.
      tool('restart_hub', t('Restart the hub, for example after merging a pull request, so it runs the new code. Goes through the hub itself (a POST to /api/restart is a hard stop). {{Who}} gets a one-line notification. Your turn stops; you are asked to carry on once the new hub is up.'),
        { reason: z.string().min(1).max(200).describe('One plain line, e.g. "merged #53 (decision 46)".') },
        async ({ reason }) => out(await restartHub(hub, project, agent, reason))),

      // Decision 62: the return path for a Conductor request ([From the Conductor ... request req-007, reply expected]).
      tool('reply_to_conductor', t('Answer a request the Conductor sent you, by its id (req-007). Plain and short: it goes to the Conductor and {{who}} only, never to another project. Details stay in your own thread. It shows to {{who}} as one folded line unless for_matt is true.'),
        {
          request_id: z.string().describe('The id from the brief, e.g. req-007.'), text: z.string().min(1).max(2000).describe('Your answer, plain and short.'),
          for_matt: z.boolean().optional().default(false).describe(t('true only when {{who}} must read it personally (a question for {{who}}, or something {{who}} must see): it then shows in full.'))
        },
        async ({ request_id, text: msg, for_matt }) => out(hub.conductor ? hub.conductor.replyFrom(project, agent, request_id, msg, { forMatt: !!for_matt }) : 'This hub has no Conductor.')),

      // Decisions 63 and 70 A, spec 5: "run an expedition on X" (said to you, or routed by the Conductor, which only routes) becomes
      // one card in your thread with Launch and Edit. That card is the only confirmation: you never start the Lead yourself.
      tool('draft_expedition', t('Draft an expedition for {{who}} to launch: a self-running research-and-build job with a team, a time and budget envelope, and a frozen success test. It posts ONE card in your thread with Launch and Edit; nothing runs until {{who}} presses Launch, and you never start the Lead yourself. The question and a short_title (4 to 5 words) are needed: keep both plain and short. The brief may add scope. A success test is optional: when you leave it out, the Lead drafts one while planning and the plan gate freezes it. Give test files only when {{who}} named the test: CHECKLIST.md (numbered items, each saying how it is judged: read, run, or "not run here: the user pastes the results") and/or run.json ({"checks": [{"name": "...", "command": "...", "cwd": ".", "timeout": 60}]}). Leave the envelope out for the defaults (6 hours, 7% of the week). Pre-approve sites and packages only when the brief needs them. Checked like a launch: a draft that could never launch is refused here.'),
        {
          question: z.string().min(3).max(300).describe('The question, in one plain line (it names the expedition).'),
          short_title: z.string().min(3).max(48).describe('REQUIRED: a short title of 4 to 5 plain words (for example "JSON library speed comparison"). It names the expedition and its folder, branch and worktree, so keep it short. If it is missing or too long the hub shortens the question instead.'),
          brief: z.string().optional().describe('Optional extra scope: what is in and out. Leave out to use the question alone.'),
          test_files: z.array(z.object({ name: z.string().describe('CHECKLIST.md or run.json (a plain file name).'), content: z.string() })).optional().describe('Only when the user named the test. Otherwise leave out: the Lead drafts it.'),
          hours: z.number().positive().optional().describe('Time limit in hours. Leave out for the default.'),
          percent: z.number().positive().optional().describe('Budget as a percent of the week\'s plan. Leave out for the default.'),
          gatherers: z.number().int().min(1).max(4).optional().describe('How many gatherers at once (up to 4). Whatever this is, an expedition gets one second round and 8 gatherer runs in all; the hub refuses a ninth.'),
          sites: z.array(z.object({ host: z.string(), access: z.enum(['pages', 'downloads']).optional(), pin: z.string().optional().describe('A path like /owner/repo, required to allow downloads from an open host.') })).optional().describe('Sites the expedition may read without asking.'),
          packages: z.array(z.object({ eco: z.enum(['npm', 'pip', 'huggingface']), name: z.string(), baseMajor: z.number().int().optional(), revision: z.string().optional().describe('Hugging Face only: the full 40-character commit.') })).optional().describe('Packages the expedition may install without asking.')
        },
        async args => {
          try {
            const r = hub.draftExpedition(project, agent, args);
            return out(`Drafted: the card is in your thread with Launch and Edit.${r.blocked ? ` Note, it cannot launch right now: ${r.blocked}` : ''} Tell the user it is there, and stop: nothing runs until they press Launch.`);
          } catch (e) { return out(`Not drafted: ${e.message}`); }
        }),

      tool('message_agent','Send a message to a worker: answers, fixes, or the next step.',
        { to: z.string(), text: z.string() },
        async ({ to, text: msg }) => { hub.orchestratorToWorker(project, agent, to, msg); return out(`Sent to ${to}.`); }),

      tool('list_agent_types', 'List the agent types you can start workers as: name, description, model, effort and tool limits.', {},
        async () => {
          const types = hub.agentTypes(project).list();
          return out(types.length ? types.map(({ name, description, model, effort, tools, source }) => ({ name, description, model: model || 'default', effort: effort || 'default', tools: tools || 'all', from: source === 'project' ? 'this project' : 'all projects' })) : 'No agent types are set up yet.');
        }),

      // Decision 20: the same change as the model chip on a thread. Logged in that agent's thread and in yours.
      tool('set_agent_settings', t('Change a running or resting agent\'s model, effort or type: the same as {{who}} clicking the model chip on its thread. Model and effort switch at once on a live agent; a new type (with its tools and instructions) applies once the agent is free, and it keeps its conversation. Send only what changes. Raising a model or effort needs a one-line reason (logged as a raise, for the usage panel); lowering logs too. Logged in that agent\'s thread and in yours.'),
        {
          reason: z.string().max(200).optional().describe('One plain line why, e.g. "tests failed twice at medium". Required when you raise a model or effort.'),
          name: z.string().describe('The agent\'s name from list_agents, or "orchestrator" for yourself.'),
          model: z.string().optional().describe('opus, sonnet, haiku, fable, a full model id, or "default". Leave out to keep it.'),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'default']).optional().describe('Leave out to keep it.'),
          type: z.string().optional().describe('An agent type from list_agent_types, or "none". A new type brings its own model and effort unless you set those too. Leave out to keep it.')
        },
        async ({ name, reason, ...picks }) => {
          const changes = settingsChanges(picks);
          if (!Object.keys(changes).length) return out('Nothing to change: give a model, an effort or a type.');
          try {
            const r = await hub.setAgentSettings(project, name.trim(), changes, agent.name, reason);
            return out(r.changed ? `${name} now runs as ${r.settings}; it applies ${r.when}.` : `No change: ${name} already runs as ${r.settings}.`);
          } catch (e) { return out(`Not changed: ${e.message}`); }
        }),

      tool('start_worker', t('Start a new worker agent. Give it a short name (letters, digits, dashes), a one-line goal {{who}} sees, and the full task as its briefing. Every worker has an agent type: give one from list_agent_types; if you leave it out the worker is an "implementer" (the default worker). Optionally a model and effort that override the type\'s.'),
        {
          name: z.string().regex(/^[a-z0-9-]+$/i),
          goal: z.string().max(120).describe(t('One plain line for {{who}}, under 80 characters: what this worker is for.')),
          task: z.string(),
          type: z.string().optional().describe('An agent type from list_agent_types. Defaults to implementer when left out.'),
          model: z.string().optional().describe('opus, sonnet, haiku, fable, or a full model id. Leave out for the type\'s or the default.'),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe('Leave out for the type\'s or the default.')
        },
        async ({ name, goal, task, type, model, effort }) => {
          try {
            const w = hub.startWorker(project, name, task, agent.name, goal, { type, model, effort });
            return out(`Started ${w.name} (${hub.describeSettings(w)}).`);
          } catch (e) { return out(`Not started: ${e.message}`); }
        })
    );
  }

  // The Expedition module (decision 68 C, spec 4.1): the Lead gets four of the orchestrator's tools, limited by the hub to
  // its own expedition. They never reach another expedition's agents, a plain worker or the orchestrator, and start_worker
  // starts only the five hub roles with the expedition stamped by the hub. No settings, scheduling or trigger tools.
  if (agent.expeditionRole === 'lead') {
    const attempt = (what, f) => async args => { try { return out(f(args)); } catch (e) { return out(`${what}: ${e.message}`); } };
    tools.push(
      tool('list_agents', 'List the agents of your expedition (its Advisor, Synthesizer, Skeptic, Builder and Verifier, whichever you have started): state, context %, model and effort; and how many gatherer subagents are running. Nobody else is shown.', {},
        attempt('Not listed', () => hub.leadAgents(project, agent))),

      tool('message_agent', 'Send a message to one agent of your expedition: instructions, defects to fix, the next step. Only your own team.',
        { to: z.string().describe('The agent\'s name from list_agents.'), text: z.string() },
        attempt('Not sent', ({ to, text: msg }) => { hub.leadMessage(project, agent, to, msg); return `Sent to ${to}.`; })),

      tool('retire_worker', 'Retire an agent of your expedition whose job is finished: it stops and leaves the team. No handoff, no successor.',
        { name: z.string(), reason: z.string().max(200).describe('One plain line, e.g. "verdict written".') },
        attempt('Not retired', ({ name, reason }) => hub.leadRetire(project, agent, name, reason))),

      tool('start_worker', 'Start one hub agent of your expedition by role type: expedition-advisor, expedition-synthesizer, expedition-skeptic, expedition-builder or expedition-verifier. The hub sets its model and effort from the launch screen; give it its task as a full briefing. Gatherers are not started this way: call them with the Agent tool.',
        {
          type: z.enum(EXPEDITION_HUB_ROLES.filter(r => r !== 'lead').map(r => EXPEDITION_ROLES[r].type)),
          goal: z.string().max(120).optional().describe('One plain line, under 80 characters: what this agent is for.'),
          task: z.string().describe('The full task as its briefing.')
        },
        attempt('Not started', ({ type, goal, task }) => { const w = hub.leadStart(project, agent, { type, goal, task }); return `Started ${w.name} (${hub.describeSettings(w)}).`; })),

      // The structured tools (plan section 2, item 9): the Lead puts the events and DECISIONS.md lines in the log through the
      // hub, rather than writing JSON lines itself. Each is the Expedition class's own method, for this Lead's expedition only.
      tool('expedition_decide', 'Log one decision you made on the user\'s behalf, inside the brief: it becomes the next numbered line of DECISIONS.md and an event the report lists. Say what, why, and who made it (you, or the Advisor).',
        { text: z.string().describe('The decision, in one plain sentence.'), reason: z.string().describe('Why.'), maker: z.string().optional().describe('Who made it: leave out for yourself, or give the Advisor\'s name.') },
        attempt('Not logged', ({ text: what, reason, maker }) => { const ev = hub.expeditionOf(project, agent).decide({ text: what, reason, maker: maker || agent.name }); return `Logged as decision ${ev.number}.`; })),

      tool('expedition_park', 'Park a line of work that is outside the brief, with the reason. It is never guessed at: it goes in the report as a proposed next expedition.',
        { text: z.string().describe('What was parked, in one plain sentence.'), reason: z.string().describe('Why it is outside the brief.') },
        attempt('Not parked', ({ text: what, reason }) => { hub.expeditionOf(project, agent).park({ text: what, reason, maker: agent.name }); return 'Parked; it is listed in the report.'; })),

      tool('expedition_close_gate', 'Close the plan gate, once: after the Advisor has reviewed the plan and you have amended test/ as needed. The hub hashes test/, keeps a copy of it outside the worktree (.crux/expeditions/.frozen/<id>/) and logs the Advisor\'s verdict and your amendments. From here test/ is locked by the hub: plain writes into it are refused, and at every expedition_loop_result and at expedition_finish the hub compares test/ with the logged hash. If anything differs it restores test/ from its copy, logs it, and counts that as a Verifier FAIL. Folders and files with those cache names (__pycache__, *.pyc, .pytest_cache, node_modules) are not kept in the stored copy or compared, so do not put any in test/; the Verifier runs a scratch copy of the stored copy, in verify/run-N/.',
        { verdict: z.string().describe('The Advisor\'s verdict in a line, e.g. "approve with changes".'), amendments: z.array(z.string()).optional().default([]).describe('The amendments made to the test at the gate, one line each. Empty if none.') },
        attempt('Gate not closed', ({ verdict, amendments }) => `Gate closed. The hub logged the test's hash (${hub.expeditionOf(project, agent).gate({ verdict, amendments }).testHash.slice(0, 12)}) and kept a copy of test/ outside the worktree. test/ is locked from here: writes into it are refused, and the hub checks it against that copy at every loop result and at the finish, restoring it (and counting a Verifier FAIL) if it changed. The Verifier runs a scratch copy of the stored copy in verify/run-N/, never test/ itself. Caches a run leaves (__pycache__, *.pyc, .pytest_cache, node_modules) are not kept or compared. Building and verifying can start.`)),

      tool('expedition_loop_result', 'Log the end of one build-verify loop: how many success-test items pass now. The hub first checks test/ against the frozen copy; if it differs it restores it and the loop is a Verifier FAIL with no progress. Otherwise it numbers the loop and judges whether it made progress (more items passing than any earlier loop). When a second loop in a row makes no progress the hub stops the expedition itself (reason no-progress); you do not call anything for that.',
        { passing: z.number().int().min(0).describe('Items passing after this loop.') },
        attempt('Not logged', ({ passing }) => {
          const ex = hub.expeditionOf(project, agent);
          ex.need('running');
          const integrity = ex.checkFrozen('loop');   // before the loop is judged: a changed test makes it a FAIL
          const tampered = integrity.ok === false;
          const loops = ex.state().loops;
          const progress = !tampered && passing > Math.max(0, ...loops.filter(l => !l.tampered).map(l => l.passing));
          const stuck = !progress && loops.length > 0 && !loops.at(-1).progress;
          const ev = ex.loop({ number: loops.length + 1, passing, progress, tampered });
          const line = tampered
            ? `Loop ${ev.number}: FAIL. ${integrityText(ex, integrity)} The ${passing} passing you reported do not count: this loop is a Verifier FAIL with no progress. Run the loop again against the restored test.`
            : `Loop ${ev.number}: ${passing} passing, ${progress ? 'progress' : 'no progress'}.`;
          if (!stuck) return line;
          ex.stop({ reason: 'no-progress', totals: howItRan(project.log.events, ex.id).totals });
          return `${line} Two loops in a row made no progress, so the hub has stopped the expedition (no-progress). Write the report now; the Verifier can still check it. When it is written and corrected, call expedition_report_ready and end your turn.`;
        })),

      tool('expedition_finish', 'End the expedition because the success test passes. Only while it is running (the gate is closed) and after at least one build-verify loop was logged, and with test/ unchanged from the frozen copy (the hub checks; if it changed it restores it and refuses: that is a Verifier FAIL). It records the stop; it does not retire anyone (everyone but you is retired only at the hub\'s time or budget stop). Then write REPORT.md and have the Verifier check it. The hub\'s end step (report copied to the branch, push, draft PR, the card) is done by the hub later; send your one summary only when it tells you so. No-progress, time, budget and the user\'s Stop come from the hub, not from you.',
        {},
        attempt('Not finished', () => {
          const ex = hub.expeditionOf(project, agent), s = ex.state();
          if (s.phase !== 'running') throw new Error(`The expedition is ${s.phase === 'new' ? 'not started' : s.phase}: it can be finished as passed only while it is running, after the plan gate.`);
          if (!s.loops.length) throw new Error('No build-verify loop is logged yet: log one with expedition_loop_result before you finish.');
          const integrity = ex.checkFrozen('finish');
          if (integrity.ok === false) throw new Error(`${integrityText(ex, integrity)} This counts as a Verifier FAIL, so it is not finished as passed: have the Verifier run the restored test in another build-verify loop first.`);
          ex.stop({ reason: 'passed', totals: howItRan(project.log.events, ex.id).totals });
          return 'Stopped (passed). Write REPORT.md now (sections 1 to 6 and 8; the hub adds the claims check line and "how it ran"), have the Verifier check its numbers and claims and apply its corrections, then call expedition_report_ready and end your turn.';
        })),

      // Phase 5: the signal that starts the hub's end (report copied to the branch, push, draft PR, finished card). For a hub
      // stop (time, budget, the user's Stop) the end of the final turn does the same, so this is optional there.
      tool('expedition_report_ready', 'Say that REPORT.md is written and the Verifier\'s claims corrections are applied (or that there was no time for them). Only after the expedition has stopped. The hub then copies REPORT.md onto the branch expedition/<id>, commits what the Builder left, pushes, opens a DRAFT pull request, posts the finished card for the user, and tells you when to send your one post_summary. It starts when your turn ends, so end your turn after calling this. It never merges.',
        {},
        attempt('Not recorded', () => {
          const ex = hub.expeditionOf(project, agent), s = ex.state();
          if (s.phase !== 'stopped') throw new Error(`The expedition is ${s.phase === 'new' ? 'not started' : s.phase}: the end starts after it has stopped (expedition_finish, a time or budget limit, or the user's Stop).`);
          if (!ex.exists('REPORT.md')) throw new Error('REPORT.md is not there yet: write it first (a short one is fine if time ran out).');
          if (!s.reportReadyNote) ex.note('report ready', { kind: 'report-ready', by: agent.name });
          return 'Recorded. End your turn now: the hub copies the report onto the branch, pushes it, opens a draft pull request and posts the finished card, then tells you when to send your one post_summary.';
        }))
    );
  }

  return createSdkMcpServer({ name: 'crux', version: '0.3.0', tools });
}

// set_agent_settings arguments to Hub.setAgentSettings changes: only the keys given; "default" or type "none" is null.
export function settingsChanges({ model, effort, type } = {}) {
  const changes = {};
  if (model !== undefined) changes.model = /^(default)?$/i.test(String(model).trim()) ? null : String(model).trim();
  if (effort !== undefined) changes.effort = /^(default)?$/i.test(String(effort).trim()) ? null : effort;
  if (type !== undefined) changes.type = /^(none|default)?$/i.test(String(type).trim()) ? null : String(type).trim();
  return changes;
}

// post_summary's reply (decision 64): lines under questions with no question mark are kept as plain lines, not cards,
// and the agent is told so, with where such lines belong.
export function summaryReply(r) {
  const n = r?.notes?.length || 0;
  // An expedition raises no question card (decision 71): its questions went to the Lead as text, or were held.
  if (r?.held) return 'Summary posted. Nobody is available to answer questions during an expedition, so yours were not asked: decide inside the brief, or park the line of work with the reason.';
  if (!n) return 'Summary posted.';
  return `Summary posted. ${n === 1 ? 'One line' : `${n} lines`} under questions had no question mark, so ${n === 1 ? 'it shows' : 'they show'} as a plain line in your summary, not as a question card: ${r.notes.map(x => `"${String(x).slice(0, 80)}"`).join('; ')}. Put status lines in done or next_step, and end real questions with "?".`;
}

// restart_hub's reply. The server sets hub.restartHub (lib/guard.mjs makeRestartHub); a hub with no server cannot.
export async function restartHub(hub, project, agent, reason) {
  if (agent?.role !== 'orchestrator') return 'Only the orchestrator can restart the hub.';
  if (typeof hub.restartHub !== 'function') return 'This hub cannot restart itself (it is not running as a server).';
  try { return await hub.restartHub(project, agent, reason); } catch (e) { return `Not restarted: ${e.message}`; }
}

// mark_entry_done's reply: what was marked, or the plain reason it was refused (the board throws it).
export function markEntryDone(board, id, from, note = '') {
  try {
    const ev = board.setEntryStatus(id, 'done', from, note);
    return `${ev.entryId} marked done. It is off the board index; board_read ${ev.entryId} still shows it.`;
  } catch (e) { return `Not marked: ${e.message}`; }
}

// Decision 81: a tool is listed only when its own job (ask, draft, image) has a provider set and this project's mode allows it
// (not Local only with a cloud provider); pictures also need Any. The listing is a snapshot: each call checks again.
export const outsideListed = (hub, project, agent, job = 'ask') => !!project && agent?.role !== 'conductor' && !project.hubWide && !!hub?.offload && !!hub.offload.plan(project.dir, job);
const outsideImages = (hub, project, agent) => outsideListed(hub, project, agent, 'image') && hub.offload.plan(project.dir, 'image').mode === 'any';

export function cruxToolNames(agent, hub = null, project = null) {
  const names = ['board_index', 'board_read', 'post_entry', 'post_summary', 'propose_lesson', 'post_visual', 'profile_read', 'write_handoff'];
  if (outsideListed(hub, project, agent, 'ask')) names.push('ask_outside_model');
  if (outsideListed(hub, project, agent, 'draft')) names.push('draft_with_outside_model');
  if (outsideImages(hub, project, agent)) names.push('make_image');
  if (agent.predecessor) names.push('ask_predecessor');
  if (agent.role === 'orchestrator') names.push('list_agents', 'list_agent_types', 'message_agent', 'start_worker', 'set_agent_settings', 'retire_worker', 'handoff_worker', 'answer_permission', 'mark_entry_done', 'draft_expedition');
  if (agent.role === 'orchestrator') names.push('restart_hub', 'reply_to_conductor');   // decisions 47 and 62
  if (agent.expeditionRole === 'lead') names.push('list_agents', 'message_agent', 'retire_worker', 'start_worker', 'expedition_decide', 'expedition_park', 'expedition_close_gate', 'expedition_loop_result', 'expedition_finish', 'expedition_report_ready');   // decision 68 C: scoped to its expedition (hub.leadAgents and the like)
  return names.map(n => `mcp__crux__${n}`);
}
