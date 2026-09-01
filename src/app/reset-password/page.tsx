import { redirect } from 'next/navigation';
import { Logo } from '@/components/brand';
import { createClient } from '@/lib/supabase/server';
import { ResetPasswordForm } from './reset-password-form';

export const dynamic = 'force-dynamic';

/**
 * Landed on from the "reset your password" email, after /auth/callback has
 * already turned the recovery code into a real (temporary) session — so this
 * page only needs `updateUser`, not a token from the URL.
 */
export default async function ResetPasswordPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?error=link_expired');

  return (
    <main className="min-h-dvh flex flex-col items-center justify-center px-6 bg-page">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center mb-8">
          <Logo size={56} />
          <h1 className="t-display-lg uppercase tracking-[0.12em] text-ink mt-4">
            Domestic
          </h1>
          <p className="t-body-md text-ink-muted mt-1">Pick a new password</p>
        </div>

        <ResetPasswordForm />
      </div>
    </main>
  );
}
