'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { addExpense } from '@/lib/actions';
import { Button, Card, Field, Initials, Input, Select, cx } from '@/components/ui';
import { Icon } from '@/components/brand';
import { splitEqual, formatCents, parseDollars } from '@/lib/money';
import type { Profile } from '@/lib/types';

const CATEGORIES = [
  'groceries', 'household', 'utilities', 'dining',
  'transport', 'entertainment', 'general',
] as const;

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

export function ExpenseForm({ me, members }: { me: Profile; members: Profile[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [submitting, startSubmit] = useTransition();

  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState(me.id);
  const [spentOn, setSpentOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState<string>('general');
  const [participants, setParticipants] = useState<string[]>(members.map((m) => m.id));

  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cents = parseDollars(amount) ?? 0;
  const preview = participants.length > 0 ? splitEqual(cents, participants) : {};

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
      if (r.total > 0) setAmount(r.total.toFixed(2));
      if (r.date) setSpentOn(r.date);
      if (r.category) setCategory(r.category);
      if (r.legible && r.total > 0) {
        setScanNote(
          r.line_items.length > 0
            ? `Read ${r.line_items.length} items. Check the total before saving.`
            : 'Check the total before saving.',
        );
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

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startSubmit(async () => {
      const res = await addExpense({
        description,
        amount,
        paid_by: paidBy,
        spent_on: spentOn,
        category,
        split_kind: 'equal',
        participants,
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
        <Field label="Amount">
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            required
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

      {/* Split */}
      <div>
        <span className="t-label text-ink-muted block mb-2">Split between</span>
        <div className="space-y-2">
          {members.map((m) => {
            const on = participants.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => toggle(m.id)}
                aria-pressed={on}
                className={cx(
                  'w-full flex items-center gap-3 p-3 rounded-md border text-left',
                  'transition-colors duration-[120ms]',
                  on
                    ? 'border-maize bg-maize/12'
                    : 'border-subtle bg-card opacity-60 hover:opacity-100',
                )}
              >
                <Initials initials={m.initials} color={m.color} size="md" dim={!on} />
                <span className="t-body-md text-ink flex-1">
                  {m.id === me.id ? 'You' : m.full_name}
                </span>
                <span className="t-body-md text-ink-2 tabular-nums font-medium">
                  {on && cents > 0 ? formatCents(preview[m.id] ?? 0) : on ? '—' : 'out'}
                </span>
              </button>
            );
          })}
        </div>
        {cents > 0 && participants.length > 0 && (
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
        {submitting ? 'Saving…' : `Add ${cents > 0 ? formatCents(cents) : 'expense'}`}
      </Button>
    </form>
  );
}
