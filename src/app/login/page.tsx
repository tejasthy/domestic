import { Logo } from '@/components/brand';
import { LoginForm } from './login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

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

        {error === 'link_expired' && (
          <p className="t-body-sm text-danger bg-danger/10 border border-danger/25 rounded-md px-3 py-2 mb-4">
            That link expired or was already used. Request a fresh one.
          </p>
        )}

        <LoginForm />

        <p className="t-body-sm text-ink-muted text-center mt-6">
          Four roommates, one fridge chart. No passwords.
        </p>
      </div>
    </main>
  );
}
