import type { Chore, Profile } from './types';

/**
 * The paper chart pre-prints the whole cycle: AB, BK, TT, NA, AB, BK...
 * Turn N belongs to members[N % members.length]. Nothing mutable, so the
 * order never drifts no matter how turns are completed, swapped or skipped.
 */
export function assigneeForTurn<T>(rotation: T[], turnNumber: number): T | null {
  if (rotation.length === 0) return null;
  const i = ((turnNumber % rotation.length) + rotation.length) % rotation.length;
  return rotation[i];
}

/** The next `count` people up, for the "up next" strip on the kiosk. */
export function upcomingRotation<T>(rotation: T[], nextTurn: number, count: number): T[] {
  if (rotation.length === 0) return [];
  return Array.from({ length: count }, (_, i) => assigneeForTurn(rotation, nextTurn + i)!);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sun & Fri, every week" / "Sat, every other week" / "Whenever it's full" */
export function describeCadence(chore: Pick<Chore, 'cadence' | 'days_of_week' | 'interval_weeks' | 'description'>): string {
  if (chore.cadence === 'standing') return chore.description ?? 'Passed along when done';
  if (chore.cadence === 'on_demand') return chore.description ?? 'As needed';

  const days = [...chore.days_of_week].sort((a, b) => a - b).map((d) => DAY_NAMES[d]);
  const when =
    days.length === 0 ? 'Unscheduled'
    : days.length === 1 ? days[0]
    : days.length === 2 ? `${days[0]} & ${days[1]}`
    : `${days.slice(0, -1).join(', ')} & ${days.at(-1)}`;

  const every =
    chore.interval_weeks <= 1 ? 'every week'
    : chore.interval_weeks === 2 ? 'every other week'
    : `every ${chore.interval_weeks} weeks`;

  return `${when}, ${every}`;
}

export type DueBucket = 'overdue' | 'today' | 'tomorrow' | 'upcoming' | 'anytime';

/** "YYYY-MM-DD" as seen in `timeZone` — lexicographically sortable, so day
 * boundaries become string comparisons instead of DST-sensitive Date math. */
export function dayKey(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

export function shiftDayKey(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Buckets by calendar day in the household's own timezone — not the server
 * process's, which is UTC in production and would otherwise mislabel turns
 * near midnight. */
export function bucketFor(dueAt: string | null, timeZone: string, now = new Date()): DueBucket {
  if (!dueAt) return 'anytime';
  const todayKey = dayKey(now, timeZone);
  const dueKey = dayKey(new Date(dueAt), timeZone);
  if (dueKey < todayKey) return 'overdue';
  if (dueKey === todayKey) return 'today';
  if (dueKey === shiftDayKey(todayKey, 1)) return 'tomorrow';
  return 'upcoming';
}

export const BUCKET_ORDER: DueBucket[] = ['overdue', 'today', 'anytime', 'tomorrow', 'upcoming'];

export const BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: 'Overdue',
  today: 'Today',
  anytime: 'Whenever',
  tomorrow: 'Tomorrow',
  upcoming: 'Coming up',
};

/** Fair-share view: how many turns each person has actually completed. */
export function tallyByPerson(
  turns: { assignee_id: string; status: string }[],
  people: Profile[],
): { profile: Profile; done: number; missed: number }[] {
  return people.map((profile) => {
    const mine = turns.filter((t) => t.assignee_id === profile.id);
    return {
      profile,
      done: mine.filter((t) => t.status === 'done').length,
      missed: mine.filter((t) => t.status === 'missed').length,
    };
  });
}
