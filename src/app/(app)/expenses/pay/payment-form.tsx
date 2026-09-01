'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { recordPayment } from '@/lib/actions';
import { Button, Field, Input, Select } from '@/components/ui';
import type { Profile } from '@/lib/types';

const METHODS = [
  { value: 'venmo', label: 'Venmo' },
  { value: 'cash', label: 'Cash' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'paypal', label: 'PayPal' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'other', label: 'Other' },
];

export function PaymentForm({ me, members }: { me: Profile; members: Profile[] }) {
  const router = useRouter();
  const [submitting, startSubmit] = useTransition();

  const [fromProfile, setFromProfile] = useState(me.id);
  const [toProfile, setToProfile] = useState(
    () => members.find((m) => m.id !== me.id)?.id ?? me.id,
  );
  const [amount, setAmount] = useState('');
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState('venmo');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const samePerson = fromProfile === toProfile;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startSubmit(async () => {
      const res = await recordPayment({
        from_profile: fromProfile,
        to_profile: toProfile,
        amount,
        paid_on: paidOn,
        method,
        note: note.trim() || undefined,
      });
      if (res.ok) router.push('/expenses');
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Who paid" className="min-w-0">
          <Select value={fromProfile} onChange={(e) => setFromProfile(e.target.value)}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === me.id ? 'You' : m.full_name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Who received it" className="min-w-0">
          <Select value={toProfile} onChange={(e) => setToProfile(e.target.value)}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === me.id ? 'You' : m.full_name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {samePerson && (
        <p className="t-body-sm text-danger">Pick two different people.</p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount" className="min-w-0">
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            required
          />
        </Field>
        <Field label="Date" className="min-w-0">
          <Input
            type="date"
            value={paidOn}
            onChange={(e) => setPaidOn(e.target.value)}
            required
            className="min-w-0"
          />
        </Field>
      </div>

      <Field label="Method">
        <Select value={method} onChange={(e) => setMethod(e.target.value)}>
          {METHODS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </Select>
      </Field>

      <Field label="Note" hint="Optional">
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What was this for?"
          maxLength={500}
        />
      </Field>

      {error && (
        <p className="t-body-sm text-danger bg-danger/10 border border-danger/25 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" full disabled={submitting || samePerson || !amount}>
        {submitting ? 'Saving…' : 'Record payment'}
      </Button>
    </form>
  );
}
