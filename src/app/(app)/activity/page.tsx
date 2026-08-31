import { redirect } from 'next/navigation';
import { getSession, getActivity } from '@/lib/data';
import { Card, EmptyState, Initials } from '@/components/ui';
import { formatInTimeZone } from '@/lib/timezone';
import { dayKey, shiftDayKey } from '@/lib/rotation';
import type { ActivityEntry, Profile } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** "Today" / "Yesterday" / "Thursday, Aug 28" — same day-bucketing the
 * chore due-date labels use, so an audit entry near midnight lands on the
 * household's calendar day rather than the server's. */
function dayHeading(iso: string, timeZone: string): string {
  const key = dayKey(new Date(iso), timeZone);
  const todayKey = dayKey(new Date(), timeZone);
  if (key === todayKey) return 'Today';
  if (key === shiftDayKey(todayKey, -1)) return 'Yesterday';
  return formatInTimeZone(iso, timeZone, { weekday: 'long', month: 'short', day: 'numeric' });
}

function groupByDay(entries: ActivityEntry[], timeZone: string) {
  const groups: { heading: string; entries: ActivityEntry[] }[] = [];
  for (const entry of entries) {
    const heading = dayHeading(entry.created_at, timeZone);
    const last = groups.at(-1);
    if (last && last.heading === heading) {
      last.entries.push(entry);
    } else {
      groups.push({ heading, entries: [entry] });
    }
  }
  return groups;
}

export default async function ActivityPage() {
  const session = await getSession();
  if (!session?.me || !session.household) redirect('/');
  const { household, members } = session;

  const activity = await getActivity(80);
  const byId = new Map(members.map((m) => [m.id, m]));
  const groups = groupByDay(activity, household.timezone);

  return (
    <div className="space-y-7 max-w-2xl">
      <header>
        <h1 className="t-display-lg text-ink">Activity</h1>
        <p className="t-body-md text-ink-muted mt-0.5">
          Everything the house has done lately — chores, money, and swaps.
        </p>
      </header>

      {activity.length === 0 ? (
        <Card>
          <EmptyState
            emoji="📜"
            title="Nothing yet"
            hint="Completed chores and added expenses will show up here."
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.heading}>
              <h2 className="t-label text-ink-muted mb-2">{group.heading}</h2>
              <Card className="divide-y divide-[var(--border-subtle)]">
                {group.entries.map((a) => {
                  const actor: Profile | undefined = a.actor_id ? byId.get(a.actor_id) : undefined;
                  return (
                    <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                      {actor ? (
                        <Initials initials={actor.initials} color={actor.color} size="sm" />
                      ) : (
                        <span className="w-7 h-7 shrink-0" aria-hidden />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="t-body-md text-ink leading-snug">{a.summary}</p>
                        <p className="t-caption text-ink-muted mt-0.5">
                          {formatInTimeZone(a.created_at, household.timezone, {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </Card>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
