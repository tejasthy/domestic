'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createRecurringExpense,
  setRecurringExpenseActive,
  updateRecurringExpense,
} from '@/lib/recurring-expense-actions';
import { Button, Field, Initials, Input, Select, cx } from '@/components/ui';
import { splitEqual, formatCents, parseDollars } from '@/lib/money';
import type { Profile, SplitKind } from '@/lib/types';
import type { RecurringExpenseWithParticipants } from '@/lib/data';

const CATEGORIES = [
  'groceries', 'household', 'utilities', 'dining',
  'transport', 'entertainment', 'general',
] as const;

/** Recurring expenses don't offer 'adjustment' — no receipt, nothing to nudge. */
type RecurringSplitKind = Exclude<SplitKind, 'adjustment'>;

const SPLIT_KINDS: { value: RecurringSplitKind; label: string }[] = [
  { value: 'equal', label: 'Equal' },
  { value: 'exact', label: 'Exact amounts' },
  { value: 'shares', label: 'Shares' },
  { value: 'percent', label: 'Percent' },
];

type CadencePreset = 'weekly' | 'biweekly' | 'monthly' | 'quarterly';

/** The data model only has weekly/monthly + a multiplier — these four presets
 * are the only combinations the UI exposes. */
function presetFor(cadence: string, intervalWeeks: number, intervalMonths: number): CadencePreset {
  if (cadence === 'weekly') return intervalWeeks >= 2 ? 'biweekly' : 'weekly';
  return intervalMonths >= 3 ? 'quarterly' : 'monthly';
}

function presetToFields(preset: CadencePreset) {
  switch (preset) {
    case 'weekly': return { cadence: 'weekly' as const, interval_weeks: 1, interval_months: 1 };
    case 'biweekly': return { cadence: 'weekly' as const, interval_weeks: 2, interval_months: 1 };
    case 'monthly': return { cadence: 'monthly' as const, interval_weeks: 1, interval_months: 1 };
    case 'quarterly': return { cadence: 'monthly' as const, interval_weeks: 1, interval_months: 3 };
  }
}

const WEIGHT_LABEL: Record<Exclude<RecurringSplitKind, 'equal'>, string> = {
  exact: 'Amount',
  shares: 'Shares',
  percent: 'Percent',
};

type Props =
  | { mode: 'create'; me: Profile; members: Profile[]; recurring?: undefined }
  | { mode: 'edit'; me: Profile; members: Profile[]; recurring: RecurringExpenseWithParticipants };

export function RecurringExpenseForm({ mode, me, members, recurring }: Props) {
  const router = useRouter();
  const [submitting, startSubmit] = useTransition();
  const [togglingActive, startToggleActive] = useTransition();

  const [description, setDescription] = useState(recurring?.description ?? '');
  const [amount, setAmount] = useState(
    recurring ? (recurring.amount_cents / 100).toFixed(2) : '',
  );
  const [paidBy, setPaidBy] = useState(recurring?.paid_by ?? me.id);
  const [category, setCategory] = useState<string>(recurring?.category ?? 'general');
  const [splitKind, setSplitKind] = useState<RecurringSplitKind>(
    (recurring?.split_kind as RecurringSplitKind) ?? 'equal',
  );
  const [participants, setParticipants] = useState<string[]>(
    recurring ? recurring.participants.map((p) => p.profile_id) : members.map((m) => m.id),
  );
  const [weights, setWeights] = useState<Record<string, number>>(() => {
    if (!recurring) return {};
    const out: Record<string, number> = {};
    for (const p of recurring.participants) {
      out[p.profile_id] = recurring.split_kind === 'exact'
        ? p.owed_cents / 100
        : (p.weight ?? 0);
    }
    return out;
  });

  const [preset, setPreset] = useState<CadencePreset>(
    recurring
      ? presetFor(recurring.cadence, recurring.interval_weeks, recurring.interval_months)
      : 'monthly',
  );
  const [dayOfMonth, setDayOfMonth] = useState<number>(recurring?.day_of_month ?? 1);
  const [startOn, setStartOn] = useState(() => new Date().toISOString().slice(0, 10));

  const [isActive, setIsActive] = useState(recurring?.is_active ?? true);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const cents = parseDollars(amount) ?? 0;
  const isMonthly = preset === 'monthly' || preset === 'quarterly';
  const preview = splitKind === 'equal' && participants.length > 0
    ? splitEqual(cents, participants)
    : {};

  function toggle(id: string) {
    setParticipants((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  function setWeight(id: string, value: string) {
    const n = Number(value);
    setWeights((prev) => ({ ...prev, [id]: Number.isFinite(n) ? n : 0 }));
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fields = presetToFields(preset);
    const input = {
      description,
      amount,
      paid_by: paidBy,
      category,
      split_kind: splitKind,
      participants,
      weights: splitKind === 'equal' ? undefined : weights,
      cadence: fields.cadence,
      interval_weeks: fields.interval_weeks,
      interval_months: fields.interval_months,
      day_of_month: isMonthly ? dayOfMonth : undefined,
      start_on: mode === 'create' ? startOn : undefined,
    };

    startSubmit(async () => {
      const res = mode === 'create'
        ? await createRecurringExpense(input)
        : await updateRecurringExpense(recurring.id, input);
      if (res.ok) router.push('/expenses/recurring');
      else setError(res.error);
    });
  }

  function onToggleActive() {
    if (mode !== 'edit') return;
    setError(null);
    startToggleActive(async () => {
      const res = await setRecurringExpenseActive(recurring.id, !isActive);
      if (res.ok) {
        setIsActive((prev) => !prev);
        setConfirmingDeactivate(false);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <Field label="What is it">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Rent"
          required
          maxLength={120}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount">
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            required
          />
        </Field>
        <Field label="Category">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c[0].toUpperCase() + c.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Paid by">
          <Select value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === me.id ? 'You' : m.full_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Split">
          <Select value={splitKind} onChange={(e) => setSplitKind(e.target.value as RecurringSplitKind)}>
            {SPLIT_KINDS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Repeats">
          <Select value={preset} onChange={(e) => setPreset(e.target.value as CadencePreset)}>
            <option value="weekly">Weekly</option>
            <option value="biweekly">Every 2 weeks</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </Select>
        </Field>
        {isMonthly ? (
          <Field label="Day of month">
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={dayOfMonth}
              onChange={(e) => setDayOfMonth(Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
              required
            />
          </Field>
        ) : mode === 'create' ? (
          <Field label="Starts on">
            <Input
              type="date"
              value={startOn}
              onChange={(e) => setStartOn(e.target.value)}
            />
          </Field>
        ) : null}
      </div>

      {isMonthly && mode === 'create' && (
        <Field label="Starts on" hint="Optional — defaults to today.">
          <Input
            type="date"
            value={startOn}
            onChange={(e) => setStartOn(e.target.value)}
          />
        </Field>
      )}

      {/* Split */}
      <div>
        <span className="t-label text-ink-muted block mb-2">Split between</span>
        <div className="space-y-2">
          {members.map((m) => {
            const on = participants.includes(m.id);
            return (
              <div
                key={m.id}
                className={cx(
                  'w-full flex items-center gap-3 p-3 rounded-md border',
                  'transition-colors duration-[120ms]',
                  on
                    ? 'border-maize bg-maize/12'
                    : 'border-subtle bg-card opacity-60 hover:opacity-100',
                )}
              >
                <button
                  type="button"
                  onClick={() => toggle(m.id)}
                  aria-pressed={on}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left"
                >
                  <Initials initials={m.initials} color={m.color} size="md" dim={!on} />
                  <span className="t-body-md text-ink flex-1 truncate">
                    {m.id === me.id ? 'You' : m.full_name}
                  </span>
                </button>
                {!on && <span className="t-body-md text-ink-2">out</span>}
                {on && splitKind === 'equal' && (
                  <span className="t-body-md text-ink-2 tabular-nums font-medium">
                    {cents > 0 ? formatCents(preview[m.id] ?? 0) : '—'}
                  </span>
                )}
                {on && splitKind !== 'equal' && (
                  <Input
                    type="number"
                    inputMode="decimal"
                    step={splitKind === 'exact' ? '0.01' : '1'}
                    min={0}
                    value={weights[m.id] ?? ''}
                    onChange={(e) => setWeight(m.id, e.target.value)}
                    placeholder={WEIGHT_LABEL[splitKind]}
                    aria-label={`${WEIGHT_LABEL[splitKind]} for ${m.full_name}`}
                    className="w-24 h-9 text-right"
                  />
                )}
              </div>
            );
          })}
        </div>
        {splitKind === 'equal' && cents > 0 && participants.length > 0 && (
          <p className="t-body-sm text-ink-muted mt-2">
            {formatCents(cents)} split {participants.length} ways.
            {cents % participants.length !== 0 &&
              ' The odd cents go to whoever is listed first.'}
          </p>
        )}
      </div>

      {error && (
        <p className="t-body-sm text-danger bg-danger/10 border border-danger/25 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <Button
        type="submit"
        size="lg"
        full
        disabled={submitting || participants.length === 0 || cents <= 0}
      >
        {submitting ? 'Saving…' : mode === 'create' ? 'Add recurring expense' : 'Save changes'}
      </Button>

      {mode === 'edit' && (
        <div className="pt-2 border-t border-subtle flex items-center justify-between gap-3">
          <span className="t-body-sm text-ink-muted">
            {isActive ? 'Currently posting on schedule.' : 'Currently paused.'}
          </span>
          {isActive ? (
            confirmingDeactivate ? (
              <Button
                type="button"
                tone="danger"
                size="sm"
                disabled={togglingActive}
                onClick={onToggleActive}
              >
                Really deactivate
              </Button>
            ) : (
              <Button
                type="button"
                tone="secondary"
                size="sm"
                onClick={() => setConfirmingDeactivate(true)}
              >
                Deactivate
              </Button>
            )
          ) : (
            <Button
              type="button"
              tone="secondary"
              size="sm"
              disabled={togglingActive}
              onClick={onToggleActive}
            >
              {togglingActive ? 'Reactivating…' : 'Reactivate'}
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
