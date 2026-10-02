// Password gate. The password lives only in the NOTES_PASSWORD environment
// variable; the browser gets an httpOnly cookie holding an HMAC derived from it
// (never the password itself). Changing NOTES_PASSWORD logs everyone out.

export const SESSION_COOKIE = 'mm_session';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

const enc = new TextEncoder();

async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string) {
  const A = enc.encode(a);
  const B = enc.encode(b);
  let diff = A.length ^ B.length;
  for (let i = 0; i < Math.max(A.length, B.length); i++) diff |= (A[i] ?? 0) ^ (B[i] ?? 0);
  return diff === 0;
}

/** Locally you can run without a password; in production a missing password locks everything. */
export function authMode(): 'off' | 'on' | 'misconfigured' {
  if (process.env.NOTES_PASSWORD) return 'on';
  return process.env.NODE_ENV === 'production' ? 'misconfigured' : 'off';
}

export async function sessionToken() {
  const password = process.env.NOTES_PASSWORD ?? '';
  return hmac(`${process.env.NOTES_SESSION_SECRET ?? ''}:${password}`, 'meeting-master-session-v1');
}

export async function isAuthed(cookieValue: string | undefined) {
  const mode = authMode();
  if (mode === 'off') return true;
  if (mode === 'misconfigured' || !cookieValue) return false;
  return safeEqual(cookieValue, await sessionToken());
}

/** For API route handlers: a 401 response, or null when the request is signed in. */
export async function requireAuth(req: Request): Promise<Response | null> {
  const cookie = req.headers
    .get('cookie')
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  if (await isAuthed(cookie)) return null;
  return Response.json({ error: 'Not signed in. Reload the page and enter the password.' }, { status: 401 });
}
