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

export function bucketFor(dueAt: string | null, now = new Date()): DueBucket {
  if (!dueAt) return 'anytime';
  const due = new Date(dueAt);
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  const startOfTomorrow = new Date(startOfToday); startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const startOfDayAfter = new Date(startOfTomorrow); startOfDayAfter.setDate(startOfDayAfter.getDate() + 1);

  if (due < now && due < startOfTomorrow) return due < startOfToday ? 'overdue' : 'today';
  if (due < startOfTomorrow) return 'today';
  if (due < startOfDayAfter) return 'tomorrow';
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
