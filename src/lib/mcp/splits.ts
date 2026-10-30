import { splitByWeight, splitEqual } from '@/lib/money';

/**
 * Turns what an assistant says ("$47.30, split between Ana and Ben") into the
 * exact per-person cents the database stores. Everything goes through
 * money.ts's remainder-safe splitters, so shares always add up to the total.
 * Pure on purpose: the arithmetic is what must be right, and it is the part
 * a test can pin down without a database.
 */

export type Share = { profile_id: string; owed_cents: number; weight: number | null };
type Failure = { ok: false; error: string };

export type PlainSplitKind = 'equal' | 'exact' | 'shares' | 'percent';

const uniq = (ids: string[]) => [...new Set(ids)];

export function buildExpenseShares(
  kind: PlainSplitKind,
  amountCents: number,
  participants: string[],
  values?: Record<string, number>,
): { ok: true; shares: Share[] } | Failure {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'The amount must be a whole number of cents greater than zero.' };
  }
  const ids = uniq(participants);
  if (ids.length === 0) return { ok: false, error: 'Split it with at least one person.' };

  if (kind === 'equal') {
    const owed = splitEqual(amountCents, ids);
    return { ok: true, shares: ids.map((id) => ({ profile_id: id, owed_cents: owed[id], weight: null })) };
  }

  const missing = ids.filter((id) => values?.[id] === undefined);
  if (missing.length > 0) {
    return { ok: false, error: `Give an amount for everyone in a ${kind} split.` };
  }

  if (kind === 'exact') {
    if (ids.some((id) => !Number.isInteger(values![id]) || values![id] < 0)) {
      return { ok: false, error: 'Exact amounts must be whole, non-negative cents.' };
    }
    const sum = ids.reduce((acc, id) => acc + values![id], 0);
    if (sum !== amountCents) {
      const diff = amountCents - sum;
      return {
        ok: false,
        error: `The exact amounts must add up to the total — they are ${Math.abs(diff)} cents ${diff > 0 ? 'short' : 'over'}.`,
      };
    }
    return { ok: true, shares: ids.map((id) => ({ profile_id: id, owed_cents: values![id], weight: null })) };
  }

  // shares / percent
  if (ids.some((id) => !(values![id] >= 0))) {
    return { ok: false, error: `A ${kind} split needs non-negative numbers.` };
  }
  const weights = Object.fromEntries(ids.filter((id) => values![id] > 0).map((id) => [id, values![id]]));
  const included = Object.keys(weights);
  if (included.length === 0) return { ok: false, error: 'Give at least one person a share.' };
  if (kind === 'percent') {
    const total = included.reduce((acc, id) => acc + weights[id], 0);
    if (Math.abs(total - 100) > 0.001) {
      return { ok: false, error: `Percentages must add up to 100 — they add up to ${total}.` };
    }
  }
  const owed = splitByWeight(amountCents, weights);
  return {
    ok: true,
    shares: included.map((id) => ({ profile_id: id, owed_cents: owed[id], weight: weights[id] })),
  };
}

/* ------------------------------------------------------------------ receipts */

export type ReceiptKind = 'item' | 'tax' | 'tip' | 'discount' | 'fee';

export type ReceiptLine = {
  name: string;
  amount_cents: number;
  kind: ReceiptKind;
  /** Profile ids who share this line; omit to use the default for its kind. */
  assigned_to?: string[];
};

export type BuiltItem = {
  name: string;
  amount_cents: number;
  kind: ReceiptKind;
  split_kind: 'equal' | 'shares';
  position: number;
  splits: Share[];
};

/**
 * Splits a receipt line by line.
 *
 *  - A line with `assigned_to` is split equally among exactly those people.
 *  - A plain item with none goes equally to everyone.
 *  - Tax, tip, fees and discounts with none are shared *in proportion to what
 *    each person's own items came to* — the standard fair way, and the one
 *    that keeps a person who bought nothing from paying tax on it.
 *
 * `total_cents` is the sum of every line, discounts included, which is what the
 * database stores as the expense total.
 */
export function buildReceiptItems(
  lines: ReceiptLine[],
  everyone: string[],
): { ok: true; items: BuiltItem[]; per_person: Record<string, number>; total_cents: number } | Failure {
  const house = uniq(everyone);
  if (lines.length === 0) return { ok: false, error: 'A receipt needs at least one line.' };
  if (house.length === 0) return { ok: false, error: 'There is no one to split with.' };

  for (const line of lines) {
    if (!Number.isInteger(line.amount_cents) || line.amount_cents === 0) {
      return { ok: false, error: `"${line.name}" needs a whole, non-zero number of cents.` };
    }
    if (line.kind === 'discount' && line.amount_cents > 0) {
      return { ok: false, error: `"${line.name}" is a discount, so its amount must be negative.` };
    }
    if (line.kind !== 'discount' && line.amount_cents < 0) {
      return { ok: false, error: `"${line.name}" is negative; only a discount line can be.` };
    }
    if (line.assigned_to && line.assigned_to.some((id) => !house.includes(id))) {
      return { ok: false, error: `"${line.name}" is assigned to someone outside the house.` };
    }
  }

  const built: (BuiltItem | null)[] = lines.map(() => null);
  const subtotal: Record<string, number> = Object.fromEntries(house.map((id) => [id, 0]));

  const assign = (index: number, ids: string[]) => {
    const line = lines[index];
    const owed = splitEqual(line.amount_cents, ids);
    built[index] = {
      name: line.name, amount_cents: line.amount_cents, kind: line.kind, split_kind: 'equal', position: index,
      splits: ids.map((id) => ({ profile_id: id, owed_cents: owed[id], weight: null })),
    };
    if (line.kind === 'item') for (const id of ids) subtotal[id] += owed[id];
  };

  // Purchases first: tax and tip are shared by what each person bought.
  lines.forEach((line, i) => {
    if (line.kind === 'item' || line.assigned_to?.length) {
      assign(i, line.assigned_to?.length ? uniq(line.assigned_to) : house);
    }
  });

  lines.forEach((line, i) => {
    if (built[i]) return;
    const weights = Object.fromEntries(house.filter((id) => subtotal[id] > 0).map((id) => [id, subtotal[id]]));
    const ids = Object.keys(weights);
    if (ids.length === 0) {
      assign(i, house);
      return;
    }
    const owed = splitByWeight(line.amount_cents, weights);
    built[i] = {
      name: line.name, amount_cents: line.amount_cents, kind: line.kind, split_kind: 'shares', position: i,
      splits: ids.map((id) => ({ profile_id: id, owed_cents: owed[id], weight: weights[id] })),
    };
  });

  const items = built as BuiltItem[];
  const per_person: Record<string, number> = {};
  for (const item of items) for (const s of item.splits) per_person[s.profile_id] = (per_person[s.profile_id] ?? 0) + s.owed_cents;

  if (Object.values(per_person).some((cents) => cents < 0)) {
    return {
      ok: false,
      error: 'A discount would leave someone owing a negative total. Assign the discount to the people who bought the discounted item.',
    };
  }

  return { ok: true, items, per_person, total_cents: items.reduce((acc, i) => acc + i.amount_cents, 0) };
}
