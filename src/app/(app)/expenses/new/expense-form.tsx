'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addExpense } from '@/lib/actions';
import { Button, Card, Field, Initials, Input, Select, cx } from '@/components/ui';
import { Icon } from '@/components/brand';
import { splitEqual, splitByWeight, splitByAdjustment, formatCents, parseDollars } from '@/lib/money';
import type { Profile, SplitKind, ExpenseItemKind } from '@/lib/types';

const CATEGORIES = [
  'groceries', 'household', 'utilities', 'dining',
  'transport', 'entertainment', 'general',
] as const;

const SPLIT_KINDS: { value: SplitKind; label: string }[] = [
  { value: 'equal', label: 'Equal' },
  { value: 'exact', label: 'Exact amounts' },
  { value: 'shares', label: 'Shares' },
  { value: 'percent', label: 'Percent' },
  { value: 'adjustment', label: 'Adjustment' },
];

const ITEM_KINDS: { value: ExpenseItemKind; label: string }[] = [
  { value: 'item', label: 'Item' },
  { value: 'tax', label: 'Tax' },
  { value: 'tip', label: 'Tip' },
  { value: 'discount', label: 'Discount' },
  { value: 'fee', label: 'Fee' },
];

const WEIGHT_LABEL: Record<Exclude<SplitKind, 'equal'>, string> = {
  exact: 'Amount',
  shares: 'Shares',
  percent: 'Percent',
  adjustment: '+/-',
};

/**
 * Phone cameras produce 4000px, 6 MB photos. Claude downsamples anything over
 * ~1568px on the long edge anyway, so shrinking here costs nothing in accuracy
 * and turns a slow, sometimes-rejected upload into a fast one.
 */
async function downscale(file: File, maxEdge = 1568): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))),
      // JPEG, not PNG: it also converts iPhone HEIC captures on the way through.
      'image/jpeg',
      0.85,
    );
  });
}

type ItemDraft = {
  key: string;
  name: string;
  amount: string;
  kind: ExpenseItemKind;
  splitKind: SplitKind;
  assignees: string[];
  weights: Record<string, number>;
};

/** Mirrors addExpense's server-side split math, for the live preview. */
function computeOwed(
  kind: SplitKind, cents: number, ids: string[], weights: Record<string, number>,
): Record<string, number> {
  if (ids.length === 0) return {};
  if (kind === 'equal') return splitEqual(cents, ids);
  if (kind === 'exact') {
    return Object.fromEntries(ids.map((id) => [id, Math.round((weights[id] ?? 0) * 100)]));
  }
  if (kind === 'adjustment') {
    const adjustments = Object.fromEntries(ids.map((id) => [id, Math.round((weights[id] ?? 0) * 100)]));
    return splitByAdjustment(cents, ids, adjustments);
  }
  return splitByWeight(cents, Object.fromEntries(ids.map((id) => [id, weights[id] ?? 0])));
}

function itemAmountCents(item: ItemDraft): number {
  return parseDollars(item.amount) ?? 0;
}

/** For an 'exact' item with 2+ people, how far the entered amounts are from
 * the item's own total — positive means short, negative means over. Null
 * when the split doesn't need this check (it always sums exactly). */
function itemMismatch(item: ItemDraft): number | null {
  if (item.splitKind !== 'exact' || item.assignees.length < 2) return null;
  const cents = itemAmountCents(item);
  const sum = item.assignees.reduce((s, id) => s + Math.round((item.weights[id] ?? 0) * 100), 0);
  return sum === cents ? null : cents - sum;
}

function itemIsValid(item: ItemDraft): boolean {
  return (
    item.name.trim().length > 0 &&
    itemAmountCents(item) !== 0 &&
    item.assignees.length > 0 &&
    itemMismatch(item) === null
  );
}

export function ExpenseForm({ me, members }: { me: Profile; members: Profile[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [submitting, startSubmit] = useTransition();

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState(me.id);
  const [spentOn, setSpentOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState<string>('general');
  const [splitKind, setSplitKind] = useState<SplitKind>('equal');
  const [participants, setParticipants] = useState<string[]>(members.map((m) => m.id));
  const [weights, setWeights] = useState<Record<string, number>>({});

  // Non-null once a scan reads line items — the form switches into
  // itemized mode and the whole-expense split picker above is hidden.
  const [items, setItems] = useState<ItemDraft[] | null>(null);

  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cents = parseDollars(amount) ?? 0;
  const preview = splitKind === 'equal' && participants.length > 0
    ? splitEqual(cents, participants)
    : {};

  const itemsTotalCents = items ? items.reduce((s, it) => s + itemAmountCents(it), 0) : 0;
  const displayCents = items ? itemsTotalCents : cents;
  const itemsValid = items !== null && items.length > 0 && items.every(itemIsValid);

  function newItem(partial: Partial<ItemDraft> = {}): ItemDraft {
    return {
      key: crypto.randomUUID(),
      name: '',
      amount: '',
      kind: 'item',
      splitKind: 'equal',
      assignees: members.map((m) => m.id),
      weights: {},
      ...partial,
    };
  }

  async function onPickReceipt(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // let the same photo be re-picked after a failure
    if (!file) return;

    setScanning(true);
    setScanNote(null);
    setError(null);

    try {
      const shrunk = await downscale(file);
      const body = new FormData();
      body.append('image', new File([shrunk], 'receipt.jpg', { type: 'image/jpeg' }));

      const res = await fetch('/api/receipt', { method: 'POST', body });
      const json = await res.json();

      if (!res.ok) {
        setError(json.error ?? 'Scan failed.');
        return;
      }

      const r = json.receipt;
      if (!r.legible) {
        setScanNote("That photo is hard to read — check the numbers below.");
      }
      if (r.merchant) setDescription(r.merchant);
      if (r.date) setSpentOn(r.date);
      if (r.category) setCategory(r.category);

      if (r.legible && r.line_items?.length > 0) {
        const drafts = r.line_items.map((li: { name: string; price: number }) =>
          newItem({ name: li.name || 'Item', amount: li.price > 0 ? li.price.toFixed(2) : '' }),
        );
        if (r.tax > 0) drafts.push(newItem({ name: 'Tax', amount: r.tax.toFixed(2), kind: 'tax' }));
        if (r.tip > 0) drafts.push(newItem({ name: 'Tip', amount: r.tip.toFixed(2), kind: 'tip' }));
        setItems(drafts);
        setScanNote(
          `Read ${r.line_items.length} item${r.line_items.length === 1 ? '' : 's'} — assign them below.`,
        );
      } else {
        setItems(null);
        if (r.total > 0) setAmount(r.total.toFixed(2));
        if (r.legible && r.total > 0) setScanNote('Check the total before saving.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that photo.');
    } finally {
      setScanning(false);
    }
  }

  function toggle(id: string) {
    setParticipants((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );
  }

  function setWeight(id: string, value: string) {
    const n = Number(value);
    setWeights((prev) => ({ ...prev, [id]: Number.isFinite(n) ? n : 0 }));
  }

  function addManualItem() {
    setItems((prev) => [...(prev ?? []), newItem()]);
  }

  function removeItem(key: string) {
    setItems((prev) => (prev ? prev.filter((it) => it.key !== key) : prev));
  }

  function updateItem(key: string, patch: Partial<ItemDraft>) {
    setItems((prev) => (prev ? prev.map((it) => (it.key === key ? { ...it, ...patch } : it)) : prev));
  }

  function toggleItemAssignee(key: string, profileId: string) {
    setItems((prev) =>
      prev
        ? prev.map((it) => {
            if (it.key !== key) return it;
            const assignees = it.assignees.includes(profileId)
              ? it.assignees.filter((id) => id !== profileId)
              : [...it.assignees, profileId];
            // Fewer than 2 people can't have a split method — nothing to split.
            return { ...it, assignees, splitKind: assignees.length < 2 ? 'equal' : it.splitKind };
          })
        : prev,
    );
  }

  function setItemWeight(key: string, profileId: string, value: string) {
    const n = Number(value);
    setItems((prev) =>
      prev
        ? prev.map((it) =>
            it.key === key
              ? { ...it, weights: { ...it.weights, [profileId]: Number.isFinite(n) ? n : 0 } }
              : it,
          )
        : prev,
    );
  }

  function buildItemPayload(item: ItemDraft, position: number) {
    const itemCents = itemAmountCents(item);
    const owed = computeOwed(item.splitKind, itemCents, item.assignees, item.weights);
    return {
      name: item.name.trim() || 'Item',
      amount_cents: itemCents,
      kind: item.kind,
      split_kind: item.splitKind,
      position,
      splits: item.assignees.map((id) => ({
        profile_id: id,
        owed_cents: owed[id] ?? 0,
        weight: item.splitKind === 'shares' || item.splitKind === 'percent' ? (item.weights[id] ?? null) : null,
      })),
    };
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startSubmit(async () => {
      const res = items
        ? await addExpense({
            description,
            paid_by: paidBy,
            spent_on: spentOn,
            category,
            items: items.map((item, i) => buildItemPayload(item, i)),
          })
        : await addExpense({
            description,
            amount,
            paid_by: paidBy,
            spent_on: spentOn,
            category,
            split_kind: splitKind,
            participants,
            weights: splitKind === 'equal' ? undefined : weights,
          });
      if (res.ok) router.push('/expenses');
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {/* Receipt scan */}
      <Card className="p-4">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onPickReceipt}
          className="sr-only"
        />
        <Button
          type="button"
          tone="secondary"
          size="lg"
          full
          disabled={scanning}
          onClick={() => fileRef.current?.click()}
        >
          <Icon.Camera size={20} />
          {scanning ? 'Reading receipt…' : 'Scan a receipt'}
        </Button>
        <p className="t-body-sm text-ink-muted text-center mt-2">
          {scanNote ?? 'Snap it and the fields fill themselves in.'}
        </p>
      </Card>

      <Field label="What was it">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Kroger run"
          required
          maxLength={120}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount" hint={items ? 'Sum of the items below.' : undefined}>
          <Input
            value={items ? formatCents(itemsTotalCents) : amount}
            onChange={(e) => !items && setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            required={!items}
            disabled={!!items}
          />
        </Field>
        <Field label="Date">
          <Input
            type="date"
            value={spentOn}
            onChange={(e) => setSpentOn(e.target.value)}
            required
          />
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

      {items ? (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="t-label text-ink-muted">Items</span>
            <Button type="button" tone="ghost" size="sm" onClick={() => setItems(null)}>
              Split as one total instead
            </Button>
          </div>

          <div className="space-y-3">
            {items.map((item) => {
              const itemCents = itemAmountCents(item);
              const owed = computeOwed(item.splitKind, itemCents, item.assignees, item.weights);
              const mismatch = itemMismatch(item);
              return (
                <Card key={item.key} className="p-3 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <Input
                      value={item.name}
                      onChange={(e) => updateItem(item.key, { name: e.target.value })}
                      placeholder="Item name"
                      aria-label="Item name"
                      className="flex-1 min-w-0"
                    />
                    <Input
                      value={item.amount}
                      onChange={(e) => updateItem(item.key, { amount: e.target.value })}
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label="Item amount"
                      className="w-24 text-right shrink-0"
                    />
                    <Select
                      value={item.kind}
                      onChange={(e) => updateItem(item.key, { kind: e.target.value as ExpenseItemKind })}
                      aria-label="Item type"
                      className="w-24 shrink-0"
                    >
                      {ITEM_KINDS.map((k) => (
                        <option key={k.value} value={k.value}>{k.label}</option>
                      ))}
                    </Select>
                    <Button
                      type="button"
                      tone="ghost"
                      size="sm"
                      onClick={() => removeItem(item.key)}
                      className="shrink-0"
                    >
                      Remove
                    </Button>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {members.map((m) => {
                      const on = item.assignees.includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => toggleItemAssignee(item.key, m.id)}
                          aria-pressed={on}
                          className={cx(
                            'flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-pill border',
                            'transition-colors duration-[120ms]',
                            on
                              ? 'border-maize bg-maize/12'
                              : 'border-subtle bg-card opacity-60 hover:opacity-100',
                          )}
                        >
                          <Initials initials={m.initials} color={m.color} size="sm" dim={!on} />
                          <span className="t-body-sm text-ink">
                            {m.id === me.id ? 'You' : m.full_name.split(' ')[0]}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {item.assignees.length >= 2 && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={item.splitKind}
                        onChange={(e) => updateItem(item.key, { splitKind: e.target.value as SplitKind })}
                        aria-label="Split method for this item"
                        className="w-40 shrink-0"
                      >
                        {SPLIT_KINDS.map((s) => (
                          <option key={s.value} value={s.value}>{s.label}</option>
                        ))}
                      </Select>
                      {item.splitKind !== 'equal' && item.assignees.map((id) => {
                        const m = members.find((mm) => mm.id === id);
                        if (!m) return null;
                        return (
                          <Input
                            key={id}
                            type="number"
                            inputMode="decimal"
                            step={item.splitKind === 'exact' ? '0.01' : '1'}
                            value={item.weights[id] ?? ''}
                            onChange={(e) => setItemWeight(item.key, id, e.target.value)}
                            placeholder={`${WEIGHT_LABEL[item.splitKind as Exclude<SplitKind, 'equal'>]} · ${m.id === me.id ? 'You' : m.full_name.split(' ')[0]}`}
                            aria-label={`${WEIGHT_LABEL[item.splitKind as Exclude<SplitKind, 'equal'>]} for ${m.full_name}`}
                            className="w-32 h-9 text-right"
                          />
                        );
                      })}
                    </div>
                  )}

                  {mismatch !== null && (
                    <p className="t-body-sm text-danger">
                      Off by {formatCents(Math.abs(mismatch))} — adjust the amounts.
                    </p>
                  )}

                  {item.assignees.length > 0 && mismatch === null && (
                    <p className="t-body-sm text-ink-muted">
                      {item.assignees
                        .map((id) => {
                          const m = members.find((mm) => mm.id === id);
                          if (!m) return null;
                          return `${m.id === me.id ? 'You' : m.full_name.split(' ')[0]} ${formatCents(owed[id] ?? 0)}`;
                        })
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  )}
                </Card>
              );
            })}
          </div>

          <Button type="button" tone="secondary" size="md" full onClick={addManualItem} className="mt-3">
            <Icon.Plus size={16} />
            Add row
          </Button>
        </div>
      ) : (
        <>
          <Field label="Split">
            <Select value={splitKind} onChange={(e) => setSplitKind(e.target.value as SplitKind)}>
              {SPLIT_KINDS.map((s) => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </Select>
          </Field>

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
        </>
      )}

      {error && (
        <p className="t-body-sm text-danger bg-danger/10 border border-danger/25 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <Button
        type="submit"
        size="lg"
        full
        disabled={submitting || (items ? !itemsValid : (participants.length === 0 || cents <= 0))}
      >
        {submitting ? 'Saving…' : `Add ${displayCents > 0 ? formatCents(displayCents) : 'expense'}`}
      </Button>
    </form>
  );
}
