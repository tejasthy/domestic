'use client';

import { useState, useTransition } from 'react';
import { completeTurn, flagChore, respondToSwap } from '@/lib/actions';
import { Button, Card, Initials, Pill, cx } from '@/components/ui';
import { Icon } from '@/components/brand';
import { bucketFor } from '@/lib/rotation';
import type { TurnCard as Turn } from '@/lib/types';

function dueLabel(turn: Turn) {
  const bucket = bucketFor(turn.due_at);
  if (bucket === 'anytime') return { text: 'Whenever', tone: 'neutral' as const };
  if (bucket === 'overdue') return { text: 'Overdue', tone: 'danger' as const };
  if (bucket === 'today') return { text: 'Today', tone: 'warning' as const };
  if (bucket === 'tomorrow') return { text: 'Tomorrow', tone: 'neutral' as const };

  const when = new Date(turn.due_at!).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return { text: when, tone: 'neutral' as const };
}

export function TurnRow({
  turn,
  mine,
  crossComplete = false,
  className,
}: {
  turn: Turn;
  mine: boolean;
  /** Household setting: anyone can complete anyone's turn. */
  crossComplete?: boolean;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const due = dueLabel(turn);
  const canComplete = mine || crossComplete;

  function onComplete() {
    setError(null);
    // Optimistic: the row collapses immediately, because tapping "done" while
    // standing at the sink should feel instant.
    setDone(true);
    start(async () => {
      const res = await completeTurn(turn.id);
      if (!res.ok) {
        setDone(false);
        setError(res.error);
      }
    });
  }

  if (done) {
    return (
      <Card className={cx('flex items-center gap-3 p-3.5 opacity-60', className)}>
        <span className="w-9 h-9 grid place-items-center rounded-pill bg-success/15 text-success">
          <Icon.Check size={20} />
        </span>
        <p className="t-body-md text-ink-2">
          <span className="line-through">{turn.chore.name}</span> — nice.
        </p>
      </Card>
    );
  }

  return (
    <Card className={cx('p-3.5', className)}>
      <div className="flex items-center gap-3">
        <span className="text-2xl w-9 text-center shrink-0" aria-hidden>
          {turn.chore.emoji}
        </span>

        <div className="min-w-0 flex-1">
          <p className="t-title-md text-ink truncate">{turn.chore.name}</p>
          <div className="flex items-center gap-2 mt-1">
            <Pill tone={due.tone}>{due.text}</Pill>
            {!mine && (
              <span className="flex items-center gap-1.5 t-body-sm text-ink-muted">
                <Initials
                  initials={turn.assignee.initials}
                  color={turn.assignee.color}
                  size="sm"
                />
                {turn.assignee.full_name.split(' ')[0]}
              </span>
            )}
          </div>
        </div>

        {canComplete && (
          <Button
            size="md"
            onClick={onComplete}
            disabled={pending}
            aria-label={
              mine
                ? `Mark ${turn.chore.name} done`
                : `Mark ${turn.chore.name} done for ${turn.assignee.full_name.split(' ')[0]}`
            }
          >
            <Icon.Check size={18} />
            {mine ? 'Done' : `For ${turn.assignee.full_name.split(' ')[0]}`}
          </Button>
        )}
      </div>

      {error && <p className="t-body-sm text-danger mt-2">{error}</p>}
    </Card>
  );
}

/** "Dishwasher's full" — puts an on-demand chore on someone's plate now. */
export function FlagButton({
  choreId,
  emoji,
  label,
}: {
  choreId: string;
  emoji: string;
  label: string;
}) {
  const [pending, start] = useTransition();
  const [flagged, setFlagged] = useState(false);

  return (
    <button
      onClick={() => {
        setFlagged(true);
        start(async () => {
          const res = await flagChore(choreId);
          if (!res.ok) setFlagged(false);
        });
      }}
      disabled={pending || flagged}
      className={cx(
        'flex flex-col items-center justify-center gap-1.5 p-4 rounded-lg',
        'border border-line bg-card transition-colors duration-[120ms]',
        'hover:bg-hover active:bg-sunken disabled:opacity-60',
      )}
    >
      <span className="text-2xl" aria-hidden>{emoji}</span>
      <span className="t-body-sm font-medium text-ink text-center leading-tight">
        {flagged ? 'Flagged' : label}
      </span>
    </button>
  );
}

export function SwapRequestRow({
  swapId,
  choreName,
  fromName,
  message,
}: {
  swapId: string;
  choreName: string;
  fromName: string;
  message: string | null;
}) {
  const [pending, start] = useTransition();
  const [resolved, setResolved] = useState<null | boolean>(null);

  if (resolved !== null) {
    return (
      <Card className="p-3.5">
        <p className="t-body-md text-ink-2">
          {resolved ? `You took ${choreName}.` : 'Declined.'}
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-3.5">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 grid place-items-center rounded-pill bg-info/15 text-info shrink-0">
          <Icon.Swap size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="t-body-md text-ink">
            <strong className="font-semibold">{fromName}</strong> wants you to take{' '}
            <strong className="font-semibold">{choreName}</strong>.
          </p>
          {message && <p className="t-body-sm text-ink-muted mt-1">&ldquo;{message}&rdquo;</p>}
          <div className="flex gap-2 mt-3">
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                setResolved(true);
                start(() => respondToSwap(swapId, true).then(() => {}));
              }}
            >
              Take it
            </Button>
            <Button
              size="sm"
              tone="secondary"
              disabled={pending}
              onClick={() => {
                setResolved(false);
                start(() => respondToSwap(swapId, false).then(() => {}));
              }}
            >
              No thanks
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
