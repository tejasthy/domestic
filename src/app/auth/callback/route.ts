import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * Landing point for both magic links and OAuth.
 *
 * Every failure used to collapse into "link expired", which is wrong for most
 * of them and actively misleading when the real cause is a provider or project
 * setting. Pass the actual reason through instead.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = searchParams.get('next') ?? '/home';

  const fail = (reason: string, detail?: string | null) => {
    const url = new URL('/login', origin);
    url.searchParams.set('error', reason);
    if (detail) url.searchParams.set('detail', detail.slice(0, 300));
    return NextResponse.redirect(url);
  };

  // Supabase reports provider-side and project-side rejections here rather
  // than by omitting `code` — e.g. signups disabled, or a redirect mismatch.
  const providerError = searchParams.get('error') ?? searchParams.get('error_code');
  if (providerError) {
    const description = searchParams.get('error_description');
    console.error('[auth] provider returned an error', providerError, description);

    // Supabase's actual wording is "Signups not allowed for this instance",
    // which an is-it-disabled pattern misses.
    if (/signups?[\s_-]*(not allowed|disabled)|disabled.*signup/i.test(
      `${providerError} ${description}`,
    )) {
      return fail('signups_disabled');
    }
    return fail('provider', description ?? providerError);
  }

  const code = searchParams.get('code');
  if (!code) return fail('no_code');

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    console.error('[auth] code exchange failed', error.status, error.message);
    if (/signups?[\s_-]*(not allowed|disabled)/i.test(error.message)) {
      return fail('signups_disabled');
    }
    return fail('exchange', error.message);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
