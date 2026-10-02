import { authMode, safeEqual, SESSION_COOKIE, SESSION_MAX_AGE, sessionToken } from '../../auth';

const cookie = (value: string, maxAge: number) =>
  [
    `${SESSION_COOKIE}=${value}`,
    `Path=${process.env.NEXT_PUBLIC_BASE_PATH || '/'}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    process.env.NODE_ENV === 'production' ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ');

export async function POST(req: Request) {
  const mode = authMode();
  if (mode === 'misconfigured') {
    return Response.json({ error: 'NOTES_PASSWORD is not set on the server.' }, { status: 500 });
  }
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (mode === 'on' && !safeEqual(password ?? '', process.env.NOTES_PASSWORD!)) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return Response.json({ error: 'Wrong password.' }, { status: 401 });
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': cookie(await sessionToken(), SESSION_MAX_AGE) },
  });
}
