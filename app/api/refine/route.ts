import { generateText, Output } from 'ai';
import { z } from 'zod';
import { getModel, hasModelKey, stripDashes } from '../model';
import { requireAuth } from '../../auth';

const schema = z.object({
  title: z.string().describe('Short title naming the main topic (max 8 words), e.g. "Lunch Planning and Agenda". Never a date or "Meeting Notes"'),
  summary: z.string().describe('2-4 sentence summary of what the meeting covered'),
  keyPoints: z.array(z.string()).describe('Most important discussion points, one line each'),
  decisions: z.array(z.string()).describe('Decisions that were explicitly made'),
  tasks: z
    .array(
      z.object({
        task: z.string().describe('Clear, actionable task starting with a verb'),
        owner: z.string().describe('Person responsible (real name if known, else their speaker label), or "Unassigned"'),
        due: z.string().describe('Deadline words as spoken, including the time if one was said (e.g. "Monday 12:00", "tomorrow 3pm", "by Friday"). Never a calendar date you computed. "" if none'),
        priority: z.enum(['high', 'medium', 'low']),
        kind: z
          .enum(['commitment', 'request', 'assignment', 'suggestion', 'question'])
          .describe('commitment = someone said they will do it; request/assignment = someone was asked/told to do it'),
        quote: z.string().describe('The exact transcript words where this was committed/requested'),
        context: z.string().describe('One short line of why / supporting detail'),
      }),
    )
    .describe('Action items people actually committed to or were asked to do'),
  openQuestions: z.array(z.string()).describe('Unresolved questions or follow-ups'),
  speakerNames: z
    .array(z.object({ label: z.string(), name: z.string() }))
    .describe('Real names for generic labels like "Speaker 2", only when the transcript makes it clear; else []'),
});

export const maxDuration = 300; // the final pass over a long meeting can take a while

export type MeetingNotes = z.infer<typeof schema>;


export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const { transcript, speakers, context, existingTasks, existingNotes, currentTasks, today, final } = (await req.json()) as {
    transcript?: string;
    final?: boolean; // the meeting has ended: full, careful pass over the whole transcript
    currentTasks?: string[];
    today?: string;
    speakers?: string[];
    context?: string;
    existingTasks?: string[];
    existingNotes?: unknown;
  };

  if (!transcript || transcript.trim().length < 20) {
    return Response.json({ error: 'Transcript is too short to analyze yet.' }, { status: 400 });
  }
  if (!hasModelKey()) {
    return Response.json(
      { error: 'No AI key configured. Add NVIDIA_API_KEY (or ANTHROPIC_API_KEY) to .env.local and restart the dev server.' },
      { status: 500 },
    );
  }

  try {
    const { output } = await generateText({
      model: getModel(final ? 'final' : 'live'),
      output: Output.object({ schema }),
      system: [
        'You are an expert meeting assistant. You receive a raw speech-to-text transcript, which may contain',
        'recognition errors, filler words, and no speaker labels. Infer intent carefully.',
        'It is raw live captioning: lines can be unpunctuated, repeated, cut mid-sentence or contain misheard words.',
        'Reconstruct what people meant (e.g. "fix the print are" means "fix the printer") and write clean notes from it.',
        'Turn it into crisp meeting notes and a refined to-do list:',
        'Tasks are ONLY things someone committed to ("I will...", "I\'ll handle...") or was asked/told to do',
        '("can you...", "Arjun, please..."). Every task needs the exact quote where that happened.',
        '- Questions, musings, ideas, unclear or garbled phrases are NOT tasks. Put real unresolved questions in openQuestions.',
        '- Never turn "figure out what X means" or "clarify what someone said" into a task.',
        '- Merge duplicates. If the current to-do list already has a task, keep its wording EXACTLY; only add new ones.',
        '- Fewer, correct tasks are better than many guesses.',
        '- Use names mentioned in the transcript as owners when it is clear who committed; otherwise "Unassigned".',
        '- Priority: high = blocking/urgent/deadline soon, low = nice-to-have.',
        '- Keep everything concise and scannable.',
        '- Never use em dashes (—) or en dashes (–); use commas, periods or a plain hyphen instead.',
        'Lines may start with a speaker label ("Speaker 2: ..."). Labels come from automatic voice matching and can be',
        'slightly wrong. Use them to attribute commitments: "I\'ll send it" from Speaker 2 means Speaker 2 owns the task',
        '(use their real name if known). Fill speakerNames only when it is clear who a generic label is, e.g. someone',
        'says "thanks Priya" right after Speaker 2 spoke, or "I\'m Rahul".',
      ].join('\n'),
      prompt: [
        `Today is ${today || new Date().toDateString()}.`,
        final &&
          'THE MEETING HAS ENDED. This is the complete transcript. Write the final notes: read it all carefully, ' +
            'make the summary cover the whole meeting start to finish, capture every decision and every real commitment, ' +
            'and resolve anything that was settled later in the meeting (drop open questions that got answered). ' +
            'You may improve the wording of existing tasks.',
        context && `Meeting context from the user: ${context}`,
        currentTasks?.length &&
          `Current AI to-do list (${final ? 'improve wording if needed, drop ones that are not real tasks' : 'keep wording exactly for tasks still valid'}):\n${currentTasks.map((t) => `- ${t}`).join('\n')}`,
        speakers?.length && `Unnamed speaker labels you may identify: ${speakers.join(', ')}`,
        existingTasks?.length &&
          `Tasks the user already has (edited/added by them). Do NOT repeat these or rephrase them as new tasks:\n${existingTasks.map((t) => `- ${t}`).join('\n')}`,
        existingNotes &&
          `The user hand-edited the notes below. Keep their wording, only add what is new:\n${JSON.stringify(existingNotes)}`,
        `Transcript:\n"""\n${transcript}\n"""`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    // Drop anything that isn't a real commitment/request, or has no supporting quote.
    const tasks = output.tasks
      .filter((t) => ['commitment', 'request', 'assignment'].includes(t.kind) && t.quote.trim().length > 3 && t.task.trim())
      .map((t) => ({ ...t, due: /[a-z0-9]/i.test(t.due) ? t.due.trim() : '', context: t.quote.trim() || t.context }));
    return Response.json(stripDashes({ ...output, tasks }));
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return Response.json({ error: `AI request failed: ${message}` }, { status: 500 });
  }
}
