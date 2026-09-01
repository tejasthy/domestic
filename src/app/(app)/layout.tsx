import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/data';
import { Logo } from '@/components/brand';
import { TabBar, SideNav } from '@/components/nav';
import { Initials } from '@/components/ui';
import { RegisterServiceWorker } from '@/components/register-sw';
import { InstallPrompt } from '@/components/install-prompt';
import { Intro } from '@/components/intro';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session?.me) redirect('/login');

  // No household yet — start one, or redeem an invite.
  if (!session.household) redirect('/onboarding');

  return (
    <div className="min-h-dvh bg-page">
      <RegisterServiceWorker />

      {/* First run: explain the house before showing them a board of chores. */}
      {!session.me.intro_seen_at && (
        <Intro modules={session.modules} householdName={session.household.name} />
      )}

      <div className="md:flex md:gap-8 md:max-w-5xl md:mx-auto md:px-6">
        {/* Desktop rail */}
        <aside className="hidden md:flex md:flex-col md:w-52 md:shrink-0 md:py-6 md:sticky md:top-0 md:h-dvh">
          <Link href="/home" className="flex items-center gap-2.5 px-3 mb-7">
            <Logo size={30} />
            <span className="t-title-md font-display uppercase tracking-[0.14em] text-ink">
              Domestic
            </span>
          </Link>
          <SideNav modules={session.modules} />
          <div className="mt-auto px-3 pb-2">
            <p className="t-caption text-ink-muted">{session.household.name}</p>
          </div>
        </aside>

        <div className="flex-1 min-w-0">
          {/* Phone header */}
          <header className="md:hidden sticky top-0 z-30 bg-page/95 backdrop-blur border-b border-subtle pt-safe">
            <div className="flex items-center justify-between px-4 h-12">
              <Link href="/home" className="flex items-center gap-2">
                <Logo size={22} />
                <span className="t-title-md font-display uppercase tracking-[0.14em] text-ink">
                  Domestic
                </span>
              </Link>
              <Link href="/settings" aria-label="Your settings">
                <Initials
                  initials={session.me.initials}
                  color={session.me.color}
                  size="sm"
                />
              </Link>
            </div>
          </header>

          <main className="px-4 md:px-0 py-4 md:py-6 pb-24 md:pb-10">{children}</main>
        </div>
      </div>

      <TabBar modules={session.modules} />
      <InstallPrompt />
    </div>
  );
}
