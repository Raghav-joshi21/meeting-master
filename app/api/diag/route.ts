import { requireAuth } from '../../auth';

// Receives the recorder's event trail (no audio, no transcript text) and writes
// it to the server log, so live problems can be read with `vercel logs`.
export async function POST(req: Request) {
  const denied = await requireAuth(req);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { ua?: string; events?: unknown[] } | null;
  if (!body?.events?.length) return new Response(null, { status: 204 });
  const ua = (body.ua ?? '').match(/(Chrome|Edg|Safari|Firefox)\/[\d.]+/g)?.join(' ') ?? 'unknown';
  console.log(`[diag] ${ua} ${JSON.stringify(body.events.slice(0, 200)).slice(0, 8000)}`);
  return new Response(null, { status: 204 });
}
