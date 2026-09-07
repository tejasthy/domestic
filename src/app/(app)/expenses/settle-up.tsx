'use client';

import { useState, useTransition } from 'react';
import { recordPayment, deleteSettlement, requestSettleUp } from '@/lib/actions';
import { Button } from '@/components/ui';
import { Icon } from '@/components/brand';

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
        <span className="flex items-center gap-1 t-body-sm text-success font-medium">
          <Icon.Check size={16} />
          Recorded
        </span>
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

/** A push-notification poke at whoever owes you — reminds, doesn't move
 * money. Only makes sense from the creditor's side of a transfer. */
export function NudgeButton({ fromId, amountCents }: { fromId: string; amountCents: number }) {
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent) {
    return <span className="t-body-sm text-ink-muted">Nudged</span>;
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await requestSettleUp(fromId, amountCents);
            if (res.ok) setSent(true);
            else setError(res.error);
          });
        }}
        className="t-body-sm text-accent font-medium disabled:opacity-50"
      >
        {pending ? 'Nudging…' : 'Nudge'}
      </button>
      {error && <span className="t-body-sm text-danger">{error}</span>}
    </div>
  );
}
