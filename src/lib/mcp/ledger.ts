import { fromZonedTime } from 'date-fns-tz';

/**
 * Pure helpers behind the ledger tools. Money is integer cents throughout;
 * nothing here divides or rounds, it only adds what the database stored.
 */

export type LedgerExpense = {
  amount_cents: number;
  category: string;
  paid_by: string;
  splits: { profile_id: string; owed_cents: number }[];
};

export type PersonTotals = {
  id: string;
  /** Everything this person put money down for. */
  paid_cents: number;
  /** Their own share of every expense, whoever paid. */
  share_cents: number;
  /** On expenses they paid: what everyone else owes them for it. */
  paid_for_others_cents: number;
  /** On expenses others paid: this person's share of them. */
  others_paid_for_me_cents: number;
};

/**
 * Totals over a set of expenses — what answers "how much did I cover for
 * everyone else this month", which no single row can.
 */
export function summarizeExpenses(expenses: LedgerExpense[]) {
  const people = new Map<string, PersonTotals>();
  const categories = new Map<string, number>();
  const person = (id: string) => {
    let p = people.get(id);
    if (!p) {
      p = { id, paid_cents: 0, share_cents: 0, paid_for_others_cents: 0, others_paid_for_me_cents: 0 };
      people.set(id, p);
    }
    return p;
  };

  let total = 0;
  for (const e of expenses) {
    total += e.amount_cents;
    categories.set(e.category, (categories.get(e.category) ?? 0) + e.amount_cents);
    person(e.paid_by).paid_cents += e.amount_cents;
    for (const s of e.splits) {
      person(s.profile_id).share_cents += s.owed_cents;
      if (s.profile_id !== e.paid_by) {
        person(e.paid_by).paid_for_others_cents += s.owed_cents;
        person(s.profile_id).others_paid_for_me_cents += s.owed_cents;
      }
    }
  }

  return {
    total_cents: total,
    by_person: [...people.values()],
    by_category: [...categories.entries()]
      .map(([category, cents]) => ({ category, cents }))
      .sort((a, b) => b.cents - a.cents),
  };
}

export type TurnTally = {
  id: string;
  done: number;
  missed: number;
  by_chore: { chore_id: string; done: number; missed: number }[];
};

/**
 * Counts turns per person, crediting whoever the turn belonged to — the same
 * rule as the all-time `v_chore_stats` view, so a ranged tally and the
 * lifetime one never disagree about who a turn counts for.
 */
export function tallyTurns(
  done: { chore_id: string; assignee_id: string }[],
  missed: { chore_id: string; assignee_id: string }[],
): TurnTally[] {
  const people = new Map<string, TurnTally>();
  const bump = (row: { chore_id: string; assignee_id: string }, field: 'done' | 'missed') => {
    let p = people.get(row.assignee_id);
    if (!p) {
      p = { id: row.assignee_id, done: 0, missed: 0, by_chore: [] };
      people.set(row.assignee_id, p);
    }
    p[field] += 1;
    let c = p.by_chore.find((x) => x.chore_id === row.chore_id);
    if (!c) {
      c = { chore_id: row.chore_id, done: 0, missed: 0 };
      p.by_chore.push(c);
    }
    c[field] += 1;
  };
  for (const r of done) bump(r, 'done');
  for (const r of missed) bump(r, 'missed');
  return [...people.values()];
}

export type Person = { id: string; full_name: string; initials: string };

/** Accepts an id, "me", a full name, a first name, or initials — whatever a person would say. */
export function resolvePerson(
  people: Person[],
  wanted: string,
  selfId: string,
): { id: string } | { error: string } {
  const needle = wanted.trim().toLowerCase();
  if (needle === 'me' || needle === 'myself' || needle === 'i') return { id: selfId };

  const exactId = people.find((p) => p.id === wanted.trim());
  if (exactId) return { id: exactId.id };

  const tiers = [
    (p: Person) => p.full_name.toLowerCase() === needle,
    (p: Person) => p.full_name.toLowerCase().split(/\s+/)[0] === needle,
    (p: Person) => p.initials.toLowerCase() === needle,
  ];
  for (const matches of tiers) {
    const found = people.filter(matches);
    if (found.length === 1) return { id: found[0].id };
    if (found.length > 1) {
      return { error: `"${wanted}" matches more than one person: ${found.map((p) => p.full_name).join(', ')}.` };
    }
  }
  return {
    error: `No housemate called "${wanted}". Housemates: ${people.map((p) => p.full_name).join(', ')}.`,
  };
}

export function involves(
  expense: { paid_by: string; splits: { profile_id: string }[] },
  personId: string,
): boolean {
  return expense.paid_by === personId || expense.splits.some((s) => s.profile_id === personId);
}

/** Escapes LIKE wildcards so a search for "100%" means those characters. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

/** "2026-10-29" for an instant, as the wall clock in that zone reads. */
export function localDay(instant: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(instant));
}

/** True for a real calendar day written YYYY-MM-DD ("2026-02-30" is not one). */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(value);
}

/**
 * Turns "from this day through that day, inclusive" in the house's own zone
 * into UTC instants for a timestamptz column: `from` inclusive, `before`
 * exclusive. Done in the zone so a late-evening completion lands on the day
 * the house experienced it, across daylight-saving changes too.
 */
export function dayBoundsUtc(
  since: string | undefined,
  until: string | undefined,
  timeZone: string,
): { from?: string; before?: string } {
  const out: { from?: string; before?: string } = {};
  if (since) out.from = fromZonedTime(`${since}T00:00:00`, timeZone).toISOString();
  if (until) {
    const [y, m, d] = until.split('-').map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    out.before = fromZonedTime(`${next}T00:00:00`, timeZone).toISOString();
  }
  return out;
}

export function describeRecurrence(r: {
  cadence: 'weekly' | 'monthly';
  interval_weeks: number;
  interval_months: number;
  day_of_month: number | null;
}): string {
  if (r.cadence === 'weekly') {
    return r.interval_weeks === 1 ? 'every week' : `every ${r.interval_weeks} weeks`;
  }
  const every = r.interval_months === 1 ? 'every month' : `every ${r.interval_months} months`;
  return r.day_of_month ? `${every} on the ${r.day_of_month}${ordinal(r.day_of_month)}` : every;
}

function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  return ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
}
