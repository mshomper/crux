// In-process MCP tools that connect an agent to the board, the memory layers and the hub.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
const list = z.array(z.string()).optional().default([]);
const heading = what => z.array(z.string()).min(1).describe(`${what}. Write "none" if there is nothing.`);

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
      async (args) => { hub.postSummary(project, agent, args); return out('Summary posted. Stop here and wait for a reply.'); }),

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

  if (agent.predecessor) {
    tools.push(tool('ask_predecessor', 'Ask the agent you took over from one short question (at most three in all). The answer is saved with the handoff.',
      { question: z.string().max(500) },
      async ({ question }) => out(await hub.askPredecessor(project, agent, question))));
  }

  if (agent.role === 'orchestrator') {
    tools.push(
      tool('list_agents', 'List the worker agents on this project and what each is doing.', {},
        async () => out(project.workers().map(w => ({ name: w.name, state: w.state, goal: w.goal, runs_as: hub.describeSettings(w) })))),

      tool('retire_worker', 'Retire a worker whose job is finished and has nothing more coming: it stops and leaves the active list. No handoff, no successor. For a worker that should continue under a fresh agent, ask the human to use Hand off instead.',
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

      tool('message_agent','Send a message to a worker: answers, fixes, or the next step.',
        { to: z.string(), text: z.string() },
        async ({ to, text: msg }) => { hub.orchestratorToWorker(project, agent, to, msg); return out(`Sent to ${to}.`); }),

      tool('list_agent_types', 'List the agent types you can start workers as: name, description, model, effort and tool limits.', {},
        async () => {
          const types = hub.agentTypes(project).list();
          return out(types.length ? types.map(({ name, description, model, effort, tools, source }) => ({ name, description, model: model || 'default', effort: effort || 'default', tools: tools || 'all', from: source === 'project' ? 'this project' : 'all projects' })) : 'No agent types are set up yet.');
        }),

      // Decision 20: the same change as the model chip on a thread. Logged in that agent's thread and in yours.
      tool('set_agent_settings', t('Change a running or resting agent\'s model, effort or type: the same as {{who}} clicking the model chip on its thread. Model and effort switch at once on a live agent; a new type (with its tools and instructions) applies once the agent is free, and it keeps its conversation. Send only what changes. Logged in that agent\'s thread and in yours.'),
        {
          name: z.string().describe('The agent\'s name from list_agents, or "orchestrator" for yourself.'),
          model: z.string().optional().describe('opus, sonnet, haiku, fable, a full model id, or "default". Leave out to keep it.'),
          effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'default']).optional().describe('Leave out to keep it.'),
          type: z.string().optional().describe('An agent type from list_agent_types, or "none". A new type brings its own model and effort unless you set those too. Leave out to keep it.')
        },
        async ({ name, ...picks }) => {
          const changes = settingsChanges(picks);
          if (!Object.keys(changes).length) return out('Nothing to change: give a model, an effort or a type.');
          try {
            const r = await hub.setAgentSettings(project, name.trim(), changes, agent.name);
            return out(r.changed ? `${name} now runs as ${r.settings}; it applies ${r.when}.` : `No change: ${name} already runs as ${r.settings}.`);
          } catch (e) { return out(`Not changed: ${e.message}`); }
        }),

      tool('start_worker', t('Start a new worker agent. Give it a short name (letters, digits, dashes), a one-line goal {{who}} sees, and the full task as its briefing. Optionally an agent type, and a model and effort that override the type\'s.'),
        {
          name: z.string().regex(/^[a-z0-9-]+$/i),
          goal: z.string().max(120).describe(t('One plain line for {{who}}, under 80 characters: what this worker is for.')),
          task: z.string(),
          type: z.string().optional().describe('An agent type from list_agent_types.'),
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

// mark_entry_done's reply: what was marked, or the plain reason it was refused (the board throws it).
export function markEntryDone(board, id, from, note = '') {
  try {
    const ev = board.setEntryStatus(id, 'done', from, note);
    return `${ev.entryId} marked done. It is off the board index; board_read ${ev.entryId} still shows it.`;
  } catch (e) { return `Not marked: ${e.message}`; }
}

export function cruxToolNames(agent) {
  const names = ['board_index', 'board_read', 'post_entry', 'post_summary', 'propose_lesson', 'post_visual', 'profile_read', 'write_handoff'];
  if (agent.predecessor) names.push('ask_predecessor');
  if (agent.role === 'orchestrator') names.push('list_agents', 'list_agent_types', 'message_agent', 'start_worker', 'set_agent_settings', 'retire_worker', 'answer_permission', 'mark_entry_done');
  return names.map(n => `mcp__crux__${n}`);
}
