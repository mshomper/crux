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
        visuals: list.describe('Ids from post_visual that help answer the questions.')
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
        async () => out(project.workers().map(w => ({ name: w.name, state: w.state, goal: w.goal })))),

      tool('retire_worker', 'Retire a worker whose job is finished and has nothing more coming: it stops and leaves the active list. No handoff, no successor. For a worker that should continue under a fresh agent, ask the human to use Hand off instead.',
        { name: z.string(), reason: z.string().max(200).describe('One plain line, e.g. "phone access merged".') },
        async ({ name, reason }) => out(hub.retireFinished(project, name, agent.name, reason))),

      tool('message_agent','Send a message to a worker: answers, fixes, or the next step.',
        { to: z.string(), text: z.string() },
        async ({ to, text: msg }) => { hub.orchestratorToWorker(project, agent, to, msg); return out(`Sent to ${to}.`); }),

      tool('start_worker', t('Start a new worker agent. Give it a short name (letters, digits, dashes), a one-line goal {{who}} sees, and the full task as its briefing.'),
        { name: z.string().regex(/^[a-z0-9-]+$/i), goal: z.string().max(120).describe(t('One plain line for {{who}}, under 80 characters: what this worker is for.')), task: z.string() },
        async ({ name, goal, task }) => { const w = hub.startWorker(project, name, task, agent.name, goal); return out(`Started ${w.name}.`); })
    );
  }

  return createSdkMcpServer({ name: 'crux', version: '0.2.0', tools });
}

export function cruxToolNames(agent) {
  const names = ['board_index', 'board_read', 'post_entry', 'post_summary', 'propose_lesson', 'post_visual', 'profile_read', 'write_handoff'];
  if (agent.predecessor) names.push('ask_predecessor');
  if (agent.role === 'orchestrator') names.push('list_agents', 'message_agent', 'start_worker', 'retire_worker');
  return names.map(n => `mcp__crux__${n}`);
}
