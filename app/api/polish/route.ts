import { generateText, Output } from 'ai';
import { z } from 'zod';
import { getModel, hasModelKey, stripDashes } from '../model';
import { requireAuth } from '../../auth';

// Cleans up raw live-caption lines (misheard words, punctuation, stutters)
// using the lines around them as context. Never summarises or merges lines.

const schema = z.object({
  lines: z.array(z.object({ id: z.number(), text: z.string() })).describe('One entry per target line, same ids'),
});

type Line = { id: number; speaker?: string; text: string };

const fmt = (l: Line) => `${l.speaker ? `${l.speaker}: ` : ''}${l.text}`;

export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const { lines, before, after, context, people } = (await req.json()) as {
    lines?: Line[];
    people?: string[];
    before?: Line[];
    after?: Line[];
    context?: string;
  };
  if (!lines?.length) return Response.json({ lines: [] });
  if (!hasModelKey()) return Response.json({ error: 'No AI key configured.' }, { status: 500 });

  try {
    const { output } = await generateText({
      model: getModel(),
      output: Output.object({ schema }),
      system: [
        'You clean up raw live speech-to-text captions from a meeting.',
        'For each TARGET line return the corrected text with the same id:',
        '- Fix words the recogniser obviously misheard, using the surrounding lines and topic as context',
        '  (e.g. "fix the print are" -> "fix the printer", names spelled the way others say them).',
        '- Add punctuation and capitalisation. Remove stutters, duplicated words and fillers like "um", "uh".',
        '- Keep the speaker\'s wording and meaning. Do NOT summarise, shorten meaningfully, add facts, merge or split lines.',
        '- If a line is already fine, return it unchanged. Keep the original language.',
        '- Do not include the speaker name in the text. Never use em dashes or en dashes.',
      ].join('\n'),
      prompt: [
        context && `Meeting context: ${context}`,
        people?.length &&
          `People in this meeting: ${people.join(', ')}. Words that sound like one of these names (e.g. "pre ya" for Priya) are that name.`,
        before?.length && `Earlier lines (context only, do not return):\n${before.map(fmt).join('\n')}`,
        `TARGET lines (return each, same id):\n${lines.map((l) => `[id ${l.id}] ${fmt(l)}`).join('\n')}`,
        after?.length && `Later lines (context only, do not return):\n${after.map(fmt).join('\n')}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
    const wanted = new Set(lines.map((l) => l.id));
    return Response.json(stripDashes({ lines: output.lines.filter((l) => wanted.has(l.id) && l.text.trim()) }));
  } catch (err) {
    console.error(err);
    return Response.json({ error: err instanceof Error ? err.message : 'AI request failed' }, { status: 500 });
  }
}
