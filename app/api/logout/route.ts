import { SESSION_COOKIE } from '../../auth';

export async function POST() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `${SESSION_COOKIE}=; Path=${process.env.NEXT_PUBLIC_BASE_PATH || '/'}; Max-Age=0; HttpOnly; SameSite=Lax`,
    },
  });
}
