import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getChores, getUpNext, getChoreStats, getRecentlyDone, requireModule, getGetAheadSettings } from '@/lib/data';
import { TurnRow, RecentlyDoneRow } from '@/components/turn-card';
import { Card, SectionHeader, Initials, Pill, cx } from '@/components/ui';
import { describeCadence, upcomingRotation } from '@/lib/rotation';
import { formatInTimeZone } from '@/lib/timezone';
import type { Profile } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function ChoresPage() {
  const session = await requireModule('chores');
  const { me, members, household } = session;

  const supabase = await createClient();
  const [chores, upNext, stats, recent, getAheadSettings, { data: rotations }] = await Promise.all([
    getChores(),
    getUpNext(),
    getChoreStats(),
    getRecentlyDone(12),
    getGetAheadSettings(household.id),
    supabase
      .from('chore_rotation')
      .select('chore_id, profile_id, position')
      .order('position')
      .returns<{ chore_id: string; profile_id: string; position: number }[]>(),
  ]);

  const byId = new Map(members.map((m) => [m.id, m]));
  const nextByChore = new Map(upNext.map((t) => [t.chore_id, t]));

  return (
    <div className="space-y-7 max-w-2xl">
      <header>
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="t-display-lg text-ink">Chores</h1>
          {me.is_admin && (
            <Link href="/chores/manage" className="t-body-sm text-accent font-medium">
              Manage chores →
            </Link>
          )}
        </div>
        <p className="t-body-md text-ink-muted mt-0.5">
          Same rotation as the chart on the fridge — it just counts for you now.
        </p>
      </header>

      <div className="space-y-4">
        {chores.map((chore) => {
          const turn = nextByChore.get(chore.id);
          const order = (rotations ?? [])
            .filter((r) => r.chore_id === chore.id)
            .sort((a, b) => a.position - b.position)
            .map((r) => byId.get(r.profile_id))
            .filter((p): p is Profile => Boolean(p));

          // The chart pre-prints the next several turns; so do we.
          const queue = turn
            ? upcomingRotation(order, turn.turn_number, Math.min(order.length + 1, 5))
            : [];

          const choreStats = stats.filter((s) => s.chore_id === chore.id);
          const total = choreStats.reduce((acc, s) => acc + s.done_count, 0);

          return (
            <Card key={chore.id} className="overflow-hidden">
              <div className="p-4">
                <div className="flex items-start gap-3">
                  <span className="text-2xl w-9 text-center shrink-0" aria-hidden>
                    {chore.emoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <h2 className="t-title-md text-ink">{chore.name}</h2>
                    <p className="t-body-sm text-ink-muted mt-0.5">
                      {describeCadence(chore)}
                    </p>
                  </div>
                  <Pill tone={chore.cadence === 'on_demand' ? 'neutral' : chore.cadence === 'standing' ? 'accent' : 'info'}>
                    {chore.cadence === 'on_demand' ? 'On demand' : chore.cadence === 'standing' ? 'Standing' : 'Scheduled'}
                  </Pill>
                </div>

                {/* The rotation strip — first chip is whoever is up. */}
                {queue.length > 0 && (
                  <div className="mt-4">
                    <p className="t-label text-ink-muted mb-2">Turn order</p>
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
                      {queue.map((p, i) => (
                        <div key={`${p.id}-${i}`} className="flex items-center gap-1.5 shrink-0">
                          {i > 0 && <span className="text-ink-muted" aria-hidden>›</span>}
                          <Initials
                            initials={p.initials}
                            color={p.color}
                            size={i === 0 ? 'md' : 'sm'}
                            dim={i > 0}
                            className={cx(
                              i === 0 && 'ring-2 ring-maize ring-offset-2 ring-offset-[var(--surface-card)]',
                            )}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {turn && (
                <div className="border-t border-subtle bg-sunken/50 p-3">
                  <TurnRow
                    turn={turn}
                    mine={turn.assignee_id === me.id}
                    timeZone={household.timezone}
                    className="border-0 shadow-none bg-transparent p-0"
                    members={members}
                    geofenceEnabled={household.geofence_enabled}
                    getAheadEnabled={getAheadSettings.enabled}
                  />
                </div>
              )}

              {total > 0 && (
                <div className="border-t border-subtle px-4 py-3">
                  <p className="t-label text-ink-muted mb-2">
                    Done, all time — {total}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {members.map((m) => {
                      const s = choreStats.find((x) => x.profile_id === m.id);
                      const count = s?.done_count ?? 0;
                      return (
                        <span key={m.id} className="flex items-center gap-1.5">
                          <Initials initials={m.initials} color={m.color} size="sm" />
                          <span className="t-body-sm text-ink-2 font-mono">{count}</span>
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {recent.length > 0 && (
        <section>
          <SectionHeader title="Recently done" />
          <Card className="divide-y divide-[var(--border-subtle)]">
            {recent.map((t) => (
              <RecentlyDoneRow
                key={t.id}
                turnId={t.id}
                emoji={t.chore.emoji}
                choreName={t.chore.name}
                assignee={{ initials: t.assignee.initials, color: t.assignee.color }}
                dateLabel={
                  t.completed_at
                    ? formatInTimeZone(t.completed_at, household.timezone, {
                        month: 'short',
                        day: 'numeric',
                      })
                    : ''
                }
              />
            ))}
          </Card>
        </section>
      )}
    </div>
  );
}
