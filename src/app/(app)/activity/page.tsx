import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getSession, getActivity } from '@/lib/data';
import { Card, EmptyState } from '@/components/ui';
import { ActivityRow } from '@/components/turn-card';
import { formatInTimeZone } from '@/lib/timezone';
import { dayKey, shiftDayKey } from '@/lib/rotation';
import type { ActivityEntry, Profile } from '@/lib/types';

/** Verb -> the chore_turns status that makes its "Undo" meaningful. */
const UNDOABLE_STATUS: Record<string, string> = {
  completed_chore: 'done',
  skipped_chore: 'skipped',
};

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
  if (!session?.me || !session.household) redirect('/login');
  const { household, members } = session;

  const activity = await getActivity(80);
  const byId = new Map(members.map((m) => [m.id, m]));
  const groups = groupByDay(activity, household.timezone);

  // Batch-fetch the current status of every turn a completion/skip entry
  // points at, so "Undo" only shows where it would actually do something —
  // hidden once the turn has already been undone, or completed a second time.
  const turnIds = [...new Set(
    activity
      .filter((a) => a.verb in UNDOABLE_STATUS)
      .map((a) => a.metadata.turn_id)
      .filter((id): id is string => typeof id === 'string'),
  )];
  const supabase = await createClient();
  const { data: turns } = turnIds.length
    ? await supabase.from('chore_turns').select('id, status').in('id', turnIds)
      .returns<{ id: string; status: string }[]>()
    : { data: [] as { id: string; status: string }[] };
  const turnStatus = new Map((turns ?? []).map((t) => [t.id, t.status]));

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
                  const turnId = typeof a.metadata.turn_id === 'string' ? a.metadata.turn_id : null;
                  const undoable =
                    turnId !== null && turnStatus.get(turnId) === UNDOABLE_STATUS[a.verb];
                  return (
                    <ActivityRow
                      key={a.id}
                      turnId={turnId}
                      summary={a.summary}
                      undoable={undoable}
                      actor={actor ? { initials: actor.initials, color: actor.color } : null}
                      timeLabel={formatInTimeZone(a.created_at, household.timezone, {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    />
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
