import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSession, getInvites, getKioskDevices } from '@/lib/data';
import { getAiConfigSummary } from '@/lib/household-actions';
import { MODULES } from '@/lib/modules';
import { Card, SectionHeader, Initials, Pill } from '@/components/ui';
import {
  MemberRow, InviteList, NewInvite, ModuleToggles, CrossCompleteToggle,
  LocationSetting, KioskDevices, AiConfig,
} from './admin';

export const dynamic = 'force-dynamic';

export default async function HouseholdSettingsPage() {
  const session = await getSession();
  if (!session?.me || !session.household) redirect('/login');
  const { me, household, members, modules } = session;

  if (!me.is_admin) {
    return (
      <div className="max-w-lg space-y-4">
        <Link href="/settings" className="t-body-sm text-accent font-medium">← You</Link>
        <h1 className="t-display-lg text-ink">{household.name}</h1>
        <Card className="p-4">
          <p className="t-body-md text-ink">
            Only an admin can change the house setup.
          </p>
          <p className="t-body-sm text-ink-muted mt-1">
            Ask{' '}
            {members.filter((m) => m.is_admin).map((m) => m.full_name.split(' ')[0]).join(' or ') ||
              'whoever set this up'}
            .
          </p>
        </Card>
        <div>
          <SectionHeader title="Housemates" />
          <Card className="divide-y divide-[var(--border-subtle)]">
            {members.map((m) => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                <Initials initials={m.initials} color={m.color} size="md" />
                <span className="t-body-md text-ink flex-1">{m.full_name}</span>
                {m.is_admin && <Pill tone="accent">admin</Pill>}
                {!!m.away && <Pill tone="neutral">away</Pill>}
              </div>
            ))}
          </Card>
        </div>
      </div>
    );
  }

  const [invites, kiosks, aiConfig] = await Promise.all([
    getInvites(),
    getKioskDevices(),
    getAiConfigSummary(),
  ]);
  const openInvites = invites.filter(
    (i) =>
      !i.revoked_at &&
      i.used_count < i.max_uses &&
      (!i.expires_at || new Date(i.expires_at) > new Date()),
  );

  return (
    <div className="max-w-lg space-y-7">
      <header>
        <Link href="/settings" className="t-body-sm text-accent font-medium">← You</Link>
        <h1 className="t-display-lg text-ink mt-1">{household.name}</h1>
        <p className="t-body-md text-ink-muted">
          {members.length} {members.length === 1 ? 'person' : 'people'} · {household.timezone}
        </p>
      </header>

      <section>
        <SectionHeader title="Housemates" />
        <Card className="divide-y divide-[var(--border-subtle)]">
          {members.map((m) => (
            <MemberRow
              key={m.id}
              id={m.id}
              name={m.full_name}
              initials={m.initials}
              color={m.color}
              isAdmin={m.is_admin}
              isSelf={m.id === me.id}
              adminCount={members.filter((x) => x.is_admin).length}
              away={!!m.away}
            />
          ))}
        </Card>
      </section>

      <section>
        <SectionHeader title="Invite someone" />
        <NewInvite householdName={household.name} />
        {openInvites.length > 0 && (
          <div className="mt-3">
            <InviteList
              householdName={household.name}
              timeZone={household.timezone}
              invites={openInvites.map((i) => ({
                id: i.id,
                code: i.code,
                email: i.email,
                fullName: i.full_name,
                expiresAt: i.expires_at,
                usedCount: i.used_count,
                maxUses: i.max_uses,
              }))}
            />
          </div>
        )}
      </section>

      <section>
        <SectionHeader title="What this house tracks" />
        <ModuleToggles
          modules={MODULES.map((m) => ({
            key: m.key,
            name: m.name,
            tagline: m.tagline,
            emoji: m.emoji,
          }))}
          enabled={modules}
        />
      </section>

      <section>
        <SectionHeader title="Who can complete what" />
        <CrossCompleteToggle enabled={household.allow_member_cross_complete} />
      </section>

      <section>
        <SectionHeader title="Receipt scanning" />
        <AiConfig summary={aiConfig} timeZone={household.timezone} />
      </section>

      {modules.includes('kiosk') && (
        <section>
          <SectionHeader title="Wall display" />
          <div className="space-y-3">
            <LocationSetting label={household.location_label} address={household.address} />
            <KioskDevices
              timeZone={household.timezone}
              devices={kiosks.map((k) => ({
                id: k.id,
                name: k.name,
                lastSeenAt: k.last_seen_at,
              }))}
            />
          </div>
        </section>
      )}
    </div>
  );
}
