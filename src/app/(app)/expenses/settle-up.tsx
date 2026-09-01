'use client';

import { useState, useTransition } from 'react';
import { recordPayment, deleteSettlement } from '@/lib/actions';
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
  const [settlementId, setSettlementId] = useState<string | null>(null);

  if (settlementId) {
    return (
      <div className="flex items-center gap-2">
        <span className="t-body-sm text-success font-medium">Recorded</span>
        <button
          type="button"
          className="t-body-sm text-accent font-medium"
          disabled={pending}
          onClick={() => {
            const id = settlementId;
            setSettlementId(null);
            start(async () => {
              const res = await deleteSettlement(id);
              if (!res.ok) setSettlementId(id);
            });
          }}
        >
          Undo
        </button>
      </div>
    );
  }

  return (
    <Button
      size="sm"
      tone="secondary"
      disabled={pending}
      onClick={() => {
        start(async () => {
          const res = await recordPayment({
            from_profile: fromId,
            to_profile: toId,
            amount,
            paid_on: new Date().toISOString().slice(0, 10),
            method: 'venmo',
          });
          if (res.ok) setSettlementId(res.id);
        });
      }}
    >
      Mark paid
    </Button>
  );
}
