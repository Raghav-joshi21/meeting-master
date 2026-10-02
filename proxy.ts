import { NextResponse, type NextRequest } from 'next/server';
import { isAuthed, SESSION_COOKIE } from './app/auth';

// Everything under /notes needs the password, except the login page itself.
// (API routes also check on their own; this is the front door for pages.)
const PUBLIC = ['/login', '/api/login'];

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname; // without the /notes prefix
  if (PUBLIC.includes(path)) return NextResponse.next();
  if (await isAuthed(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (path.startsWith('/api/')) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }
  // Show the login page in place (rewrite, not redirect): on raghavjoshi.dev the
  // request arrives via a rewrite from the main site, and a redirect would have
  // to name a host. After unlocking, the page simply reloads the same URL.
  const login = req.nextUrl.clone();
  login.pathname = '/login';
  login.search = '';
  return NextResponse.rewrite(login, { headers: { 'Cache-Control': 'no-store' } });
}

export const config = {
  // '/' listed separately: with basePath the catch-all doesn't match the bare /notes root.
  matcher: ['/', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
