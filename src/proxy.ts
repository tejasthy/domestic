import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

const PUBLIC_PATHS = [
  '/login', '/auth', '/kiosk', '/api/ha', '/api/cron',
  '/manifest.webmanifest', '/kiosk-manifest.webmanifest', '/sw.js',
];

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the auth cookie as a side effect — must not be removed.
  const { data: { user } } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
  // The marketing page is the one route the public gets to see logged out —
  // everything else needs a session. An exact match, never a prefix: '/'
  // would otherwise match every path via startsWith.
  const isPublic = pathname === '/' || PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    // Keep the query string (an invite code, most importantly) so it
    // survives the round trip through sign-in.
    url.searchParams.set('next', pathname + search);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons|.*\\.png$).*)'],
};
