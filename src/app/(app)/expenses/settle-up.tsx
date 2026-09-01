'use client';

import { useState, useTransition } from 'react';
import { recordPayment } from '@/lib/actions';
import { Button } from '@/components/ui';

/** Records a Venmo that already happened — it does not move any money. */
export function SettleUpButton({
  fromId,
  toId,
  amount,
}: {
  fromId: string;
  toId: string;
  amount: string;
}) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);

  if (done) return <span className="t-body-sm text-success font-medium">Recorded</span>;

  return (
    <Button
      size="sm"
      tone="secondary"
      disabled={pending}
      onClick={() => {
        setDone(true);
        start(async () => {
          const res = await recordPayment({
            from_profile: fromId,
            to_profile: toId,
            amount,
            paid_on: new Date().toISOString().slice(0, 10),
            method: 'venmo',
          });
          if (!res.ok) setDone(false);
        });
      }}
    >
      Mark paid
    </Button>
  );
}
