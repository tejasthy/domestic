import { Logo } from '@/components/brand';
import { LoginForm } from './login-form';

/** Reasons the callback can hand back, in language that says what to do. */
const ERRORS: Record<string, { title: string; hint: string }> = {
  signups_disabled: {
    title: 'This project is not accepting new sign-ins yet',
    hint: 'In Supabase: Authentication → Sign In / Providers → turn on "Allow new users to sign up". Membership here is controlled by invite codes, not by that switch.',
  },
  link_expired: {
    title: 'That link expired or was already used',
    hint: 'Request a fresh one below.',
  },
  no_code: {
    title: 'That sign-in did not complete',
    hint: 'The provider sent you back without a login code. Try again.',
  },
  provider: {
    title: 'Google turned that sign-in down',
    hint: 'Usually a redirect URL mismatch. The Supabase callback must be listed in your Google OAuth client.',
  },
  exchange: {
    title: 'Could not finish signing you in',
    hint: 'The login code was rejected. Try again — if it keeps happening the detail below says why.',
  },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; detail?: string }>;
}) {
  const { error, detail } = await searchParams;
  const problem = error ? (ERRORS[error] ?? ERRORS.exchange) : null;

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center px-6 bg-page">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-8">
          <Logo size={56} />
          <h1 className="t-display-lg uppercase tracking-[0.12em] text-ink mt-4">
            Domestic
          </h1>
          <p className="t-body-md text-ink-muted mt-1">526 Detroit St.</p>
        </div>

        {problem && (
          <div className="bg-danger/10 border border-danger/25 rounded-md px-3 py-2.5 mb-4">
            <p className="t-body-md text-danger font-semibold">{problem.title}</p>
            <p className="t-body-sm text-danger/90 mt-0.5">{problem.hint}</p>
            {detail && (
              <p className="t-code text-danger/80 mt-2 break-words">{detail}</p>
            )}
          </div>
        )}

        <LoginForm />

        <p className="t-body-sm text-ink-muted text-center mt-6">
          Four roommates, one fridge chart. No passwords.
        </p>
      </div>
    </main>
  );
}
