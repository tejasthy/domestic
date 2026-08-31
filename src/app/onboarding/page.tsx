import { redirect } from 'next/navigation';
import { getSession } from '@/lib/data';
import { Logo } from '@/components/brand';
import { MODULES } from '@/lib/modules';
import { Onboarding } from './onboarding';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const session = await getSession();
  if (!session?.me) redirect('/login');
  if (session.household) redirect('/');

  const { code } = await searchParams;

  return (
    <main className="min-h-dvh bg-page px-6 py-10">
      <div className="max-w-md mx-auto">
        <div className="flex flex-col items-center text-center mb-8">
          <Logo size={48} />
          <h1 className="t-display-lg uppercase tracking-[0.12em] text-ink mt-4">
            Domestic
          </h1>
          <p className="t-body-md text-ink-muted mt-1">
            Set up your house, or join one you were invited to.
          </p>
        </div>

        <Onboarding
          suggestedName={session.me.full_name}
          initialCode={code ?? null}
          modules={MODULES.map((m) => ({
            key: m.key,
            name: m.name,
            tagline: m.tagline,
            emoji: m.emoji,
            defaultEnabled: m.defaultEnabled,
          }))}
        />
      </div>
    </main>
  );
}
