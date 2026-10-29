'use server';

import { redirect } from 'next/navigation';
import { getSession } from '@/lib/data';
import { createClient } from '@/lib/supabase/server';

/**
 * Settles a pending OAuth authorization from Supabase's consent redirect and
 * sends the browser back to the assistant that asked. `authorization_id` is
 * single-use and bound to the signed-in person, so a forged one is rejected by
 * Supabase rather than here.
 */
export async function decideAuthorization(formData: FormData) {
  const id = String(formData.get('authorization_id') ?? '');
  if (!id) redirect('/home');
  const approve = formData.get('decision') === 'approve';

  const back = (message: string) =>
    redirect(
      `/oauth/consent?authorization_id=${encodeURIComponent(id)}&error=${encodeURIComponent(message)}`,
    );

  // Checked here as well as where the button is drawn: a form can be posted by hand.
  if (approve) {
    const session = await getSession();
    if (!session?.household || !session.modules.includes('mcp')) {
      return back('This household has not turned on AI assistants.');
    }
  }

  const supabase = await createClient();
  const { data, error } = approve
    ? await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true })
    : await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });

  if (error || !data?.redirect_url) {
    return back(error?.message ?? 'The sign-in server did not say where to send you back.');
  }
  redirect(data.redirect_url);
}
