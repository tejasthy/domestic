'use client';

import { useState, useTransition } from 'react';
import { recordSettlement } from '@/lib/actions';
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
          const res = await recordSettlement(fromId, toId, amount);
          if (!res.ok) setDone(false);
        });
      }}
    >
      Mark paid
    </Button>
  );
}
