'use client';

import { useState, useTransition } from 'react';
import { completeTurn, skipTurn, passTurn, undoTurn, flagChore, respondToSwap } from '@/lib/actions';
import { Button, Card, Initials, Pill, cx } from '@/components/ui';
import { Icon } from '@/components/brand';
import { bucketFor } from '@/lib/rotation';
import { formatInTimeZone } from '@/lib/timezone';
import type { TurnCard as Turn } from '@/lib/types';

function dueLabel(turn: Turn, timeZone: string) {
  const bucket = bucketFor(turn.due_at, timeZone);
  if (bucket === 'anytime') return { text: 'Whenever', tone: 'neutral' as const };
  if (bucket === 'overdue') return { text: 'Overdue', tone: 'danger' as const };
  if (bucket === 'today') return { text: 'Today', tone: 'warning' as const };
  if (bucket === 'tomorrow') return { text: 'Tomorrow', tone: 'neutral' as const };

  const when = formatInTimeZone(turn.due_at!, timeZone, {
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
  timeZone,
  className,
}: {
  turn: Turn;
  mine: boolean;
  /** Household setting: anyone can complete anyone's turn. */
  crossComplete?: boolean;
  timeZone: string;
  className?: string;
}) {
  const [pending, start] = useTransition();
  const [settled, setSettled] = useState<'done' | 'skipped' | 'passed' | null>(null);
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const due = dueLabel(turn, timeZone);
  const canComplete = mine || crossComplete;

  function onComplete() {
    setError(null);
    // Optimistic: the row collapses immediately, because tapping "done" while
    // standing at the sink should feel instant.
    setSettled('done');
    start(async () => {
      const res = await completeTurn(turn.id);
      if (!res.ok) {
        setSettled(null);
        setError(res.error);
      }
    });
  }

  function onSkip() {
    setError(null);
    setSettled('skipped');
    start(async () => {
      const res = await skipTurn(turn.id);
      if (!res.ok) {
        setSettled(null);
        setError(res.error);
      }
    });
  }

  function onPass() {
    setError(null);
    setSettled('passed');
    start(async () => {
      const res = await passTurn(turn.id);
      if (!res.ok) {
        setSettled(null);
        setError(res.error);
      }
    });
  }

  function onUndo() {
    setError(null);
    start(async () => {
      const res = await undoTurn(turn.id);
      if (res.ok) {
        setUndone(true);
      } else {
        setError(res.error);
      }
    });
  }

  if (undone) {
    return (
      <Card className={cx('flex items-center gap-3 p-4', className)}>
        <span className="w-9 h-9 grid place-items-center rounded-pill bg-info/15 text-info shrink-0">
          <Icon.Undo size={18} />
        </span>
        <p className="t-body-md text-ink-2">{turn.chore.name} is back on the board.</p>
      </Card>
    );
  }

  if (settled) {
    return (
      <Card className={cx('flex items-center gap-3 p-4 opacity-60', className)}>
        <span
          className={cx(
            'w-9 h-9 grid place-items-center rounded-pill shrink-0',
            settled === 'done' && 'bg-success/15 text-success',
            settled === 'skipped' && 'bg-warning/15 text-warning',
            settled === 'passed' && 'bg-info/15 text-info',
          )}
        >
          {settled === 'done' && <Icon.Check size={20} />}
          {settled === 'skipped' && <Icon.SkipForward size={18} />}
          {settled === 'passed' && <Icon.Swap size={18} />}
        </span>
        <p className="t-body-md text-ink-2 flex-1 min-w-0">
          <span className={settled === 'passed' ? undefined : 'line-through'}>{turn.chore.name}</span>
          {settled === 'done' && ' — nice.'}
          {settled === 'skipped' && ' — skipped.'}
          {settled === 'passed' && ' — passed on.'}
        </p>
        {settled !== 'passed' && (
          <button
            type="button"
            onClick={onUndo}
            disabled={pending}
            className="t-body-sm font-medium text-accent shrink-0 disabled:opacity-50"
          >
            Undo
          </button>
        )}
      </Card>
    );
  }

  return (
    <Card className={cx('p-4', className)}>
      <div className="flex items-start gap-3">
        <span className="text-2xl w-9 text-center shrink-0" aria-hidden>
          {turn.chore.emoji}
        </span>

        <div className="min-w-0 flex-1">
          <p className="t-title-md text-ink">{turn.chore.name}</p>
          <div className="flex flex-wrap items-center gap-2 mt-1.5">
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
      </div>

      {canComplete && (
        <div className="flex items-center justify-end gap-2 mt-3.5 pt-3.5 border-t border-subtle">
          <button
            type="button"
            onClick={onPass}
            disabled={pending}
            aria-label={
              mine
                ? `Pass my turn for ${turn.chore.name} to the next person`
                : `Pass ${turn.assignee.full_name.split(' ')[0]}'s turn for ${turn.chore.name} to the next person`
            }
            title="Pass — give this to the next person, same day"
            className="w-11 h-11 grid place-items-center rounded-md text-ink-muted hover:bg-hover active:bg-sunken disabled:opacity-50"
          >
            <Icon.Swap size={18} />
          </button>
          <button
            type="button"
            onClick={onSkip}
            disabled={pending}
            aria-label={
              mine
                ? `Skip my turn for ${turn.chore.name}`
                : `Skip ${turn.assignee.full_name.split(' ')[0]}'s turn for ${turn.chore.name}`
            }
            title="Skip — no one does this one"
            className="w-11 h-11 grid place-items-center rounded-md text-ink-muted hover:bg-hover active:bg-sunken disabled:opacity-50"
          >
            <Icon.SkipForward size={18} />
          </button>
          <Button
            size="lg"
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
        </div>
      )}

      {error && <p className="t-body-sm text-danger mt-2">{error}</p>}
    </Card>
  );
}

/** One row of the "Recently done" list — undoable in case that tap was a mistake. */
export function RecentlyDoneRow({
  turnId,
  emoji,
  choreName,
  assignee,
  dateLabel,
}: {
  turnId: string;
  emoji: string;
  choreName: string;
  assignee: { initials: string; color: string };
  dateLabel: string;
}) {
  const [pending, start] = useTransition();
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (undone) {
    return (
      <div className="flex items-center gap-3 px-4 py-2.5">
        <span className="w-6 h-6 grid place-items-center text-info shrink-0" aria-hidden>
          <Icon.Undo size={16} />
        </span>
        <span className="t-body-sm text-ink-muted flex-1 min-w-0">Back on the board.</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="text-lg w-6 text-center shrink-0" aria-hidden>{emoji}</span>
      <span className="t-body-md text-ink flex-1 min-w-0 truncate">{choreName}</span>
      {error && <span className="t-body-sm text-danger shrink-0">{error}</span>}
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await undoTurn(turnId);
            if (res.ok) setUndone(true);
            else setError(res.error);
          });
        }}
        aria-label={`Undo ${choreName}, done ${dateLabel}`}
        className="t-body-sm font-medium text-accent shrink-0 disabled:opacity-50"
      >
        Undo
      </button>
      <Initials initials={assignee.initials} color={assignee.color} size="sm" />
      <span className="t-body-sm text-ink-muted tabular-nums w-14 text-right shrink-0">
        {dateLabel}
      </span>
    </div>
  );
}

/** One row of the Activity feed. Undoable when it's a completion or a skip
 * and the turn is still sitting in the state that entry put it in — if it's
 * moved on since (undone already, or completed again), the button is hidden
 * rather than offering an undo that would act on a different turn than the
 * one this line is describing. */
export function ActivityRow({
  turnId,
  summary,
  timeLabel,
  actor,
  undoable,
}: {
  turnId: string | null;
  summary: string;
  timeLabel: string;
  actor: { initials: string; color: string } | null;
  undoable: boolean;
}) {
  const [pending, start] = useTransition();
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      {actor ? (
        <Initials initials={actor.initials} color={actor.color} size="sm" />
      ) : (
        <span className="w-7 h-7 shrink-0" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className={cx('t-body-md leading-snug', undone ? 'text-ink-muted' : 'text-ink')}>
          {undone ? 'Back on the board.' : summary}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <p className="t-caption text-ink-muted">{timeLabel}</p>
          {error && <p className="t-caption text-danger">{error}</p>}
        </div>
      </div>
      {undoable && !undone && turnId && (
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            start(async () => {
              const res = await undoTurn(turnId);
              if (res.ok) setUndone(true);
              else setError(res.error);
            });
          }}
          aria-label={`Undo: ${summary}`}
          className="t-body-sm font-medium text-accent shrink-0 disabled:opacity-50"
        >
          Undo
        </button>
      )}
    </div>
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
      <Card className="p-4">
        <p className="t-body-md text-ink-2">
          {resolved ? `You took ${choreName}.` : 'Declined.'}
        </p>
      </Card>
    );
  }

  return (
    <Card className="p-4">
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
