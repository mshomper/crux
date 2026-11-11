// In-process MCP tools that connect an agent to the board and the hub.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
const list = z.array(z.string()).optional().default([]);

export function cruxTools(hub, project, agent) {
  const board = project.board;
  const tools = [
    tool('board_index', 'One line per active item on the Crux memory board for this project.', {},
      async () => text(board.index())),

    tool('board_read', 'Read one board item in full: a decision (D0007 or 7) or an entry (R003, C001, M002, H001).',
      { id: z.string() },
      async ({ id }) => { const r = board.read(id); return text(r || `Nothing on the board with id ${id}.`); }),

    tool('post_entry', 'Add an entry to the memory board. Use it as soon as something is settled.',
      {
        kind: z.enum(['requirement', 'convention', 'memo', 'handoff']),
        title: z.string(),
        summary: z.string().describe('One line for the board index.'),
        body: z.string(),
        supersedes: z.string().optional().describe('Entry id this replaces, if any.')
      },
      async (args) => { const ev = board.addEntry({ ...args, from: agent.name }); return text(`Posted ${ev.entryId}.`); }),

    tool('post_summary', 'Post your round summary to your thread. The orchestrator and the human act on it.',
      {
        done: list.describe('What you finished this round.'),
        changed: list.describe('Files or areas changed.'),
        questions: list.describe('Questions you need answered to continue.'),
        decisions_needed: z.array(z.number()).optional().default([]).describe('Crux decision numbers waiting on the human.'),
        blocked_on: list,
        next_step: z.string().optional().default('')
      },
      async (args) => { hub.postSummary(project, agent, args); return text('Summary posted. Stop here and wait for a reply.'); })
  ];

  if (agent.role === 'orchestrator') {
    tools.push(
      tool('list_agents', 'List the worker agents on this project and what each is doing.', {},
        async () => text(project.workers().map(w => ({ name: w.name, state: w.state, goal: w.goal })))),

      tool('message_agent', 'Send a message to a worker: answers, fixes, or the next step.',
        { to: z.string(), text: z.string() },
        async ({ to, text: t }) => { hub.orchestratorToWorker(project, agent, to, t); return text(`Sent to ${to}.`); }),

      tool('start_worker', 'Start a new worker agent. Give it a short name (letters, digits, dashes), a one-line goal the human sees, and the full task as its briefing.',
        { name: z.string().regex(/^[a-z0-9-]+$/i), goal: z.string().max(120).describe('One plain line for the human, under 80 characters: what this worker is for.'), task: z.string() },
        async ({ name, goal, task }) => { const w = hub.startWorker(project, name, task, agent.name, goal); return text(`Started ${w.name}.`); })
    );
  }

  return createSdkMcpServer({ name: 'crux', version: '0.1.0', tools });
}

export function cruxToolNames(role) {
  const names = ['board_index', 'board_read', 'post_entry', 'post_summary'];
  if (role === 'orchestrator') names.push('list_agents', 'message_agent', 'start_worker');
  return names.map(n => `mcp__crux__${n}`);
}
