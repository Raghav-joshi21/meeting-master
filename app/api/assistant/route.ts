import { generateText, Output } from 'ai';
import { z } from 'zod';
import { getModel, hasModelKey, stripDashes } from '../model';
import { requireAuth } from '../../auth';

// Flat action shape (no unions) so every provider's JSON-schema mode can follow it.
const action = z.object({
  type: z
    .enum(['add_task', 'update_task', 'delete_task', 'add_note'])
    .describe('What to change. Marking a task done/undone is update_task with status.'),
  taskRef: z.string().describe('For update_task/delete_task: the existing task ref like "T3". Otherwise ""'),
  task: z.string().describe('Task text (add_task, or new text for update_task). Otherwise ""'),
  owner: z.string().describe('Owner name, "Unassigned" if unknown, "" to leave unchanged'),
  due: z.string().describe('Deadline as said (e.g. "Friday"), "" if none/unchanged'),
  priority: z.enum(['high', 'medium', 'low', 'unchanged']),
  status: z.enum(['open', 'done', 'unchanged']).describe('update_task: "done" to tick it off, "open" to reopen'),
  context: z.string().describe('One short line of why, ideally quoting the meeting. "" if none'),
  section: z.enum(['keyPoints', 'decisions', 'openQuestions', 'none']).describe('For add_note'),
  text: z.string().describe('For add_note: the note text. Otherwise ""'),
});

const schema = z.object({
  reply: z.string().describe('Short, friendly answer to the user (1-4 sentences). Mention what you changed.'),
  actions: z.array(action).describe('Changes to apply. Empty if the user only asked a question.'),
  citedLines: z.array(z.number()).describe('Transcript line numbers (#n) your answer relies on, most relevant first, max 5'),
});

export type AssistantResult = z.infer<typeof schema>;
export type AssistantAction = AssistantResult['actions'][number];

type Body = {
  message?: string;
  command?: 'add'; // "/add ..." from the user: must create task(s)
  transcript?: string; // lines formatted "#12 [03:24] Priya: ..."
  tasks?: string; // lines formatted "T1 | open | high | owner | due | text"
  notes?: unknown;
  history?: { role: 'user' | 'assistant'; content: string }[];
};

export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const { message, command, transcript, tasks, notes, history } = (await req.json()) as Body;
  if (!message?.trim()) return Response.json({ error: 'Type a request first.' }, { status: 400 });
  if (!hasModelKey()) {
    return Response.json(
      { error: 'No AI key configured. Add NVIDIA_API_KEY (or ANTHROPIC_API_KEY) to .env.local and restart the dev server.' },
      { status: 500 },
    );
  }

  try {
    const { output } = await generateText({
      model: getModel(),
      output: Output.object({ schema }),
      system: [
        'You are the meeting assistant inside a live note-taking app. The user is in (or just had) a meeting.',
        'You can see the live transcript (speech-to-text, may contain recognition errors), the current to-do list and notes.',
        'Do what the user asks by returning actions, and answer briefly in "reply".',
        '',
        'How to work:',
        '- Find the relevant part of the transcript by meaning, not exact words (e.g. "printer" also matches "the copier on 3rd floor keeps jamming").',
        '- When creating a task from the discussion, make it concrete and actionable, starting with a verb; take owner and deadline from what was said.',
        '- Put a short quote or paraphrase of the discussion in "context".',
        '- To change existing tasks use update_task with their ref (T1, T2, ...); to tick one off set status "done". Never invent refs.',
        '- For add_task, taskRef must be "".',
        '- If nothing in the transcript matches, say so in reply and return no actions. Never make up discussion that did not happen.',
        '- Requests phrased as instructions ("make/create/add a task...", "remind X to...", "put ... on the list") MUST produce add_task actions; do not just point to where it was discussed.',
        '- Only pure questions (e.g. "what did Priya commit to?") get an answer in reply and no actions.',
        '- Cite the transcript line numbers you used in citedLines.',
        '- For every action fill all fields; use "" / "unchanged" / "none" for fields that do not apply.',
        '- Never use em dashes or en dashes.',
      ].join('\n'),
      messages: [
        ...(history ?? []).slice(-6).map((m) => ({ role: m.role, content: m.content })),
        {
          role: 'user' as const,
          content: [
            `Current to-do list:\n${tasks || '(empty)'}`,
            notes ? `Current notes:\n${JSON.stringify(notes)}` : '',
            `Transcript:\n${transcript || '(nothing recorded yet)'}`,
            command === 'add'
              ? `The user used the /add command. You MUST return at least one add_task action for this (more if they listed several). ` +
                `Use the transcript to fill owner, due date and context when a matching discussion exists; if nothing matches, ` +
                `still create the task from their words.\nUser request: ${message}`
              : `User request: ${message}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      ],
    });
    return Response.json(stripDashes(output));
  } catch (err) {
    console.error(err);
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: `AI request failed: ${msg}` }, { status: 500 });
  }
}
