import Link from 'next/link';
import { cookies } from 'next/headers';
import { getSession, getChoreStats, getChores, hasPushSubscription } from '@/lib/data';
import { Card, SectionHeader, Initials, Button } from '@/components/ui';
import { signOut } from '@/lib/actions';
import { PushToggle } from './push-toggle';
import { AwayToggle } from './away-toggle';
import { ReplayIntro } from '@/components/intro';
import { ThemeToggle } from '@/components/theme-toggle';
import { THEME_COOKIE, parseThemeCookie } from '@/lib/theme';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await getSession();
  if (!session?.me || !session.household) return null;
  const { me, household, members, modules } = session;
  const theme = parseThemeCookie((await cookies()).get(THEME_COOKIE)?.value);

  const [chores, stats, subscribed] = await Promise.all([
    getChores(),
    getChoreStats(),
    hasPushSubscription(me.id),
  ]);
  const myTotal = stats
    .filter((s) => s.profile_id === me.id)
    .reduce((acc, s) => acc + s.done_count, 0);

  return (
    <div className="space-y-7 max-w-lg">
      <header className="flex items-center gap-4">
        <Initials initials={me.initials} color={me.color} size="xl" />
        <div>
          <h1 className="t-title-lg text-ink">{me.full_name}</h1>
          <p className="t-body-sm text-ink-muted">{me.email}</p>
          <p className="t-body-sm text-ink-muted mt-0.5">
            {myTotal} chore{myTotal === 1 ? '' : 's'} done
          </p>
        </div>
      </header>

      <section>
        <SectionHeader title="Appearance" />
        <Card className="p-4 flex items-center justify-between gap-3">
          <div>
            <p className="t-title-md text-ink">Theme</p>
            <p className="t-body-sm text-ink-muted mt-0.5">This device only.</p>
          </div>
          <ThemeToggle current={theme} />
        </Card>
      </section>

      <section>
        <SectionHeader title="Notifications" />
        <PushToggle
          enabled={subscribed && me.notify_push}
          vapidKey={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''}
          quietFrom={me.quiet_from}
          quietTo={me.quiet_to}
        />
      </section>

      {modules.includes('chores') && (
      <section>
        <SectionHeader title="Away" />
        <AwayToggle away={me.away ?? null} />
      </section>
      )}

      {modules.includes('chores') && (
      <section>
        <SectionHeader title="Your record" />
        <Card className="divide-y divide-[var(--border-subtle)]">
          {chores.map((c) => {
            const s = stats.find(
              (x) => x.chore_id === c.id && x.profile_id === me.id,
            );
            return (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                <span className="text-lg w-6 text-center" aria-hidden>{c.emoji}</span>
                <span className="t-body-md text-ink flex-1">{c.name}</span>
                <span className="t-code-lg text-ink tabular-nums">
                  {s?.done_count ?? 0}
                </span>
              </div>
            );
          })}
        </Card>
      </section>
      )}

      <section>
        <SectionHeader
          title="Household"
          action={
            <Link href="/settings/household" className="t-body-sm text-accent font-medium">
              {me.is_admin ? 'Manage' : 'Details'}
            </Link>
          }
        />
        <Card className="p-4">
          <p className="t-title-md text-ink">{household.name}</p>
          {household.address && (
            <p className="t-body-sm text-ink-muted">{household.address}</p>
          )}
          <p className="t-body-sm text-ink-muted mt-0.5">{household.timezone}</p>
          <div className="flex gap-2 mt-4 pt-4 border-t border-subtle">
            {members.map((m) => (
              <div key={m.id} className="flex flex-col items-center gap-1">
                <Initials initials={m.initials} color={m.color} size="md" />
                <span className="t-caption text-ink-muted">
                  {m.full_name.split(' ')[0]}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </section>

      <section>
        <SectionHeader title="Help" />
        <ReplayIntro modules={modules} householdName={household.name} />
      </section>

      <form action={signOut}>
        <Button type="submit" tone="secondary" full size="lg">
          Sign out
        </Button>
      </form>
    </div>
  );
}
