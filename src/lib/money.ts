/** Everything is integer cents. Never float dollars. */

export function formatCents(cents: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

export function parseDollars(input: string): number | null {
  const cleaned = input.replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/**
 * Split `total` across `ids`. Cents rarely divide evenly, so the remainder is
 * handed out one cent at a time in list order — the splits always sum to the
 * total exactly, which is what keeps balances from drifting over months.
 */
export function splitEqual(total: number, ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  if (ids.length === 0) return out;
  const base = Math.floor(total / ids.length);
  let remainder = total - base * ids.length;
  for (const id of ids) {
    out[id] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return out;
}

/** Split proportionally to weights (shares or percentages), remainder-safe. */
export function splitByWeight(total: number, weights: Record<string, number>): Record<string, number> {
  const ids = Object.keys(weights);
  const sum = ids.reduce((acc, id) => acc + weights[id], 0);
  if (sum <= 0) return splitEqual(total, ids);

  const out: Record<string, number> = {};
  let allocated = 0;
  for (const id of ids) {
    out[id] = Math.floor((total * weights[id]) / sum);
    allocated += out[id];
  }
  // Largest fractional parts get the leftover cents.
  const leftover = total - allocated;
  const byFraction = ids
    .map((id) => ({ id, frac: (total * weights[id]) / sum - Math.floor((total * weights[id]) / sum) }))
    .sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < leftover; i++) out[byFraction[i % byFraction.length].id] += 1;
  return out;
}

/**
 * Split `total` equally, then nudge each person's share by their adjustment
 * (positive or negative, in cents). Sums to `total` exactly because
 * `splitEqual` already is, and the adjustments are added on top of it.
 */
export function splitByAdjustment(
  total: number,
  ids: string[],
  adjustments: Record<string, number>,
): Record<string, number> {
  const sumAdj = ids.reduce((acc, id) => acc + (adjustments[id] ?? 0), 0);
  const base = splitEqual(total - sumAdj, ids);
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = base[id] + (adjustments[id] ?? 0);
  return out;
}

export type Transfer = { from: string; to: string; cents: number };

/**
 * Minimum-cash-flow settle-up: with four roommates and tangled balances you
 * would otherwise owe three separate Venmos. Greedily matching the biggest
 * debtor to the biggest creditor clears everyone in at most n-1 transfers.
 */
export function simplifyDebts(balances: Record<string, number>): Transfer[] {
  const debtors = Object.entries(balances)
    .filter(([, cents]) => cents < 0)
    .map(([id, cents]) => ({ id, cents: -cents }))
    .sort((a, b) => b.cents - a.cents);

  const creditors = Object.entries(balances)
    .filter(([, cents]) => cents > 0)
    .map(([id, cents]) => ({ id, cents }))
    .sort((a, b) => b.cents - a.cents);

  const transfers: Transfer[] = [];
  let d = 0;
  let c = 0;

  while (d < debtors.length && c < creditors.length) {
    const amount = Math.min(debtors[d].cents, creditors[c].cents);
    if (amount > 0) transfers.push({ from: debtors[d].id, to: creditors[c].id, cents: amount });
    debtors[d].cents -= amount;
    creditors[c].cents -= amount;
    if (debtors[d].cents === 0) d += 1;
    if (creditors[c].cents === 0) c += 1;
  }

  return transfers;
}
