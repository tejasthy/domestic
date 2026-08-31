import { NextResponse, type NextRequest } from 'next/server';
import { KIOSK_COOKIE, resolveKioskToken } from '@/lib/kiosk';

/**
 * One-time pairing for a wall tablet. An admin generates the link under
 * Settings → Household → Wall display; opening it once moves the token into an
 * httpOnly cookie and drops it from the URL, so it isn't readable off the wall.
 *
 * This is a route handler rather than a page because Server Components cannot
 * set cookies.
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const target = new URL('/kiosk', request.nextUrl.origin);

  if (!token) {
    target.searchParams.set('error', 'bad_token');
    return NextResponse.redirect(target);
  }

  // Resolving proves the token belongs to a real device before we store it.
  const householdId = await resolveKioskToken(token);
  if (!householdId) {
    target.searchParams.set('error', 'bad_token');
    return NextResponse.redirect(target);
  }

  const response = NextResponse.redirect(target);
  response.cookies.set(KIOSK_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 365 * 5,
    path: '/kiosk',
  });
  return response;
}
