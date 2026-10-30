import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/brand';
import { Button } from '@/components/ui';
import { getSession } from '@/lib/data';
import { createClient } from '@/lib/supabase/server';
import { decideAuthorization } from './actions';

/**
 * Supabase's OAuth server sends the person here, with `authorization_id`, once
 * an assistant (Claude, Gemini, Muse…) asks to connect. Signing in is the
 * proxy's job: it bounces to /login and back with the query string intact.
 */

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-dvh flex flex-col items-center justify-center px-6 bg-page">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-8">
          <Logo size={56} />
          <h1 className="t-display-lg uppercase tracking-[0.12em] text-ink mt-4">Domestic</h1>
        </div>
        {children}
      </div>
    </main>
  );
}

function hostOf(uri: string) {
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string; error?: string }>;
}) {
  const { authorization_id: id, error } = await searchParams;

  if (!id) {
    return (
      <Frame>
        <p className="t-body-md text-ink text-center">
          There is nothing to approve here. Start from the assistant you want to connect.
        </p>
      </Frame>
    );
  }

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${id}`)}`);
  }

  const { data, error: detailsError } = await supabase.auth.oauth.getAuthorizationDetails(id);
  if (detailsError || !data) {
    return (
      <Frame>
        <div className="bg-danger/10 border border-danger/25 rounded-md px-3 py-2.5">
          <p className="t-body-md text-danger font-semibold">That request expired or was already used</p>
          <p className="t-body-sm text-danger/90 mt-0.5">
            Go back to the assistant and connect again.
          </p>
          {detailsError && <p className="t-code text-danger/80 mt-2 break-words">{detailsError.message}</p>}
        </div>
      </Frame>
    );
  }

  // Already approved this exact client before: Supabase hands back the way home.
  if (!('authorization_id' in data)) redirect(data.redirect_url);

  const session = await getSession();
  const allowed = !!session?.household && session.modules.includes('mcp');

  return (
    <Frame>
      <h2 className="t-title-lg text-ink text-center">
        Connect {data.client.name}
        {session?.household ? ` to ${session.household.name}` : ''}?
      </h2>
      <p className="t-body-sm text-ink-muted text-center mt-1">
        Returns to {hostOf(data.redirect_uri)} afterwards.
      </p>

      {error && (
        <div className="bg-danger/10 border border-danger/25 rounded-md px-3 py-2.5 mt-5">
          <p className="t-body-sm text-danger">{error}</p>
        </div>
      )}

      {allowed ? (
        <div className="bg-card border border-line rounded-md px-4 py-3 mt-5 space-y-3">
          <div>
            <p className="t-body-md text-ink font-semibold">It will be able to</p>
            <ul className="t-body-sm text-ink-2 mt-1 list-disc pl-5 space-y-0.5">
              <li>See who lives here, who is away, and each chore with who did it and when</li>
              <li>
                See the shared expenses in full: who paid, who owes what, line items, payments
                and recurring bills
              </li>
              <li>
                As you: mark chores done, flag a chore, ask to swap a turn or answer a swap, go
                away or come back, and leave a note on the wall display
              </li>
              <li>
                As you: add an expense or itemized receipt, log a payment, and nudge a housemate
                to settle up
              </li>
            </ul>
            <p className="t-body-sm text-ink-muted mt-2">
              It is asked to show you what it will record before saving an expense or payment, and
              Domestic gives it no tool to edit or delete anything already recorded.
            </p>
          </div>
          <p className="t-body-sm text-ink-muted">
            Connecting gives it a sign-in for your account, not only those tools — approve
            assistants you trust. An admin can switch AI assistants off for the whole house
            under Settings → Household at any time.
          </p>
        </div>
      ) : (
        <div className="bg-card border border-line rounded-md px-4 py-3 mt-5">
          <p className="t-body-md text-ink font-semibold">AI assistants are off for this house</p>
          <p className="t-body-sm text-ink-muted mt-1">
            {session?.household
              ? session.me?.is_admin
                ? 'Turn them on under Settings → Household, then connect again.'
                : 'Ask a house admin to turn them on under Settings → Household, then connect again.'
              : 'Join or create a household first, then connect again.'}
          </p>
          {session?.me?.is_admin && (
            <Link href="/settings/household" className="t-body-sm text-ink underline mt-2 inline-block">
              Open household settings
            </Link>
          )}
        </div>
      )}

      <form action={decideAuthorization} className="mt-5 flex gap-3">
        <input type="hidden" name="authorization_id" value={id} />
        <Button type="submit" name="decision" value="deny" size="lg" tone="secondary" full>
          Deny
        </Button>
        {allowed && (
          <Button type="submit" name="decision" value="approve" size="lg" full>
            Approve
          </Button>
        )}
      </form>
    </Frame>
  );
}
