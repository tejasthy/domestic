'use client';

import { useState, useTransition } from 'react';
import { recordPayment, deleteSettlement, requestSettleUp, dismissSettleNudge } from '@/lib/actions';
import { Button, Card } from '@/components/ui';
import { Icon } from '@/components/brand';
import { formatCents } from '@/lib/money';

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

/** The in-app half of a nudge — shows up in "Needs an answer" for whoever
 * got nudged, same resolve-and-disappear shape as a swap request. */
export function SettleNudgeCard({
  nudgeId,
  fromId,
  toId,
  amountCents,
  senderName,
}: {
  nudgeId: string;
  /** The viewer's own profile id — they're always the one who owes. */
  fromId: string;
  toId: string;
  amountCents: number;
  senderName: string;
}) {
  const [pending, start] = useTransition();
  const [resolved, setResolved] = useState<null | 'paid' | 'dismissed'>(null);
  const [error, setError] = useState<string | null>(null);

  if (resolved) {
    return (
      <Card className="p-4">
        <p className="t-body-md text-ink-2">
          {resolved === 'paid' ? 'Marked paid.' : 'Dismissed.'}
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 grid place-items-center rounded-pill bg-warning/15 text-warning shrink-0">
          <Icon.Swap size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="t-body-md text-ink">
            <strong className="font-semibold">{senderName}</strong> asked you to settle up{' '}
            <strong className="font-semibold">{formatCents(amountCents)}</strong>.
          </p>
          <div className="flex gap-2 mt-3">
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                setError(null);
                start(async () => {
                  const res = await recordPayment({
                    from_profile: fromId,
                    to_profile: toId,
                    amount: (amountCents / 100).toFixed(2),
                    paid_on: new Date().toISOString().slice(0, 10),
                    method: 'venmo',
                  });
                  if (res.ok) setResolved('paid');
                  else setError(res.error);
                });
              }}
            >
              Mark paid
            </Button>
            <Button
              size="sm"
              tone="secondary"
              disabled={pending}
              onClick={() => {
                setError(null);
                start(async () => {
                  const res = await dismissSettleNudge(nudgeId);
                  if (res.ok) setResolved('dismissed');
                  else setError(res.error);
                });
              }}
            >
              Dismiss
            </Button>
          </div>
          {error && <p className="t-body-sm text-danger mt-2">{error}</p>}
        </div>
      </div>
    </Card>
  );
}
