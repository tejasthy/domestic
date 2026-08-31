'use client';

import { createContext, useContext, useEffect, useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  kioskCompleteTurn, kioskFlagChore, kioskRespondSwap, kioskSetChoreActive, kioskDismissMessage,
} from '@/lib/kiosk-actions';
import { Card, Initials, cx } from '@/components/ui';
import { Icon } from '@/components/brand';

/**
 * Ticks on an interval, subscription-style. The snapshot is a bucketed integer
 * rather than a Date so it stays referentially stable between ticks, and the
 * server snapshot is null — the wall clock is the one value guaranteed to
 * differ between server and client.
 */
function useTick(intervalMs: number): number | null {
  return useSyncExternalStore(
    (onChange) => {
      const id = setInterval(onChange, intervalMs);
      return () => clearInterval(id);
    },
    () => Math.floor(Date.now() / intervalMs),
    () => null,
  );
}

export function KioskClock({ timezone }: { timezone: string }) {
  const tick = useTick(15_000);
  if (tick === null) return <div className="h-16" />;

  const now = new Date(tick * 15_000);

  return (
    <div className="text-right">
      <p className="t-display-lg text-ink leading-none tabular-nums">
        {now.toLocaleTimeString('en-US', {
          timeZone: timezone,
          hour: 'numeric',
          minute: '2-digit',
        })}
      </p>
      <p className="t-body-md text-ink-muted mt-1">
        {now.toLocaleDateString('en-US', {
          timeZone: timezone,
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        })}
      </p>
    </div>
  );
}

/** Keeps the wall display current without anyone touching it. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);

  return null;
}

/* ------------------------------------------------------------- acting as */

/**
 * Who's standing at the kiosk right now. Tap-to-select, no PIN — the kiosk
 * lives inside the house, same trust model as a paper chart on the fridge.
 * Pure client state: it resets on the next auto-refresh, and nothing about it
 * ever touches the server until an action is actually taken.
 */
type ActingAsState = {
  actingId: string | null;
  setActingId: (id: string | null) => void;
};

const ActingAsContext = createContext<ActingAsState | null>(null);

function useActingAs() {
  const ctx = useContext(ActingAsContext);
  if (!ctx) throw new Error('useActingAs must be used inside ActingAsProvider');
  return ctx;
}

export function ActingAsProvider({ children }: { children: React.ReactNode }) {
  const [actingId, setActingId] = useState<string | null>(null);
  return (
    <ActingAsContext.Provider value={{ actingId, setActingId }}>
      {children}
    </ActingAsContext.Provider>
  );
}

type KioskMember = { id: string; full_name: string; initials: string; color: string };

export function ActingAsBar({ members }: { members: KioskMember[] }) {
  const { actingId, setActingId } = useActingAs();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="t-label text-ink-muted mr-1">Acting as</span>
      {members.map((m) => {
        const selected = m.id === actingId;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => setActingId(selected ? null : m.id)}
            className={cx(
              'flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-pill border transition-colors duration-[120ms]',
              selected
                ? 'border-accent bg-accent/10'
                : 'border-line bg-card hover:bg-hover',
            )}
          >
            <Initials initials={m.initials} color={m.color} size="sm" />
            <span className="t-body-sm font-medium text-ink">{m.full_name.split(' ')[0]}</span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- completing */

export function KioskTurnCard({
  turnId,
  choreName,
  className,
  children,
}: {
  turnId: string;
  choreName: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const disabled = !actingId || pending || done;

  if (done) {
    return (
      <Card className={cx('p-5 opacity-60 grid place-items-center', className)}>
        <span className="w-10 h-10 grid place-items-center rounded-pill bg-success/15 text-success">
          <Icon.Check size={22} />
        </span>
      </Card>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!actingId) return;
        start(async () => {
          const res = await kioskCompleteTurn(turnId, actingId);
          if (res.ok) {
            setDone(true);
            router.refresh();
          }
        });
      }}
      aria-label={
        actingId ? `Mark ${choreName} done` : `Tap your name above first to mark ${choreName} done`
      }
      className={cx(
        'text-left w-full transition-opacity duration-[120ms]',
        !actingId && 'opacity-50',
        pending && 'opacity-70',
      )}
    >
      <Card className={className}>{children}</Card>
    </button>
  );
}

/** "Dishwasher's full" — flags an on-demand chore from the kiosk. */
export function KioskFlagButton({
  choreId,
  emoji,
  label,
}: {
  choreId: string;
  emoji: string;
  label: string;
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [flagged, setFlagged] = useState(false);

  return (
    <button
      type="button"
      disabled={!actingId || pending || flagged}
      onClick={() => {
        if (!actingId) return;
        start(async () => {
          const res = await kioskFlagChore(choreId, actingId);
          if (res.ok) {
            setFlagged(true);
            router.refresh();
          }
        });
      }}
      className={cx(
        'flex flex-col items-center justify-center gap-1.5 p-4 rounded-lg',
        'border border-line bg-card transition-colors duration-[120ms]',
        'hover:bg-hover active:bg-sunken disabled:opacity-50',
      )}
    >
      <span className="text-2xl" aria-hidden>{emoji}</span>
      <span className="t-body-sm font-medium text-ink text-center leading-tight">
        {flagged ? 'Flagged' : label}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------- admin-only */

/** Only renders its controls when the acting member is an admin. */
export function KioskSwapRow({
  swapId,
  choreName,
  fromName,
  adminIds,
}: {
  swapId: string;
  choreName: string;
  fromName: string;
  adminIds: string[];
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [resolved, setResolved] = useState<null | boolean>(null);
  const canAnswer = !!actingId && adminIds.includes(actingId);

  if (resolved !== null) {
    return (
      <Card className="p-3.5">
        <p className="t-body-md text-ink-2">{resolved ? `Took ${choreName}.` : 'Declined.'}</p>
      </Card>
    );
  }

  return (
    <Card className="p-3.5">
      <p className="t-body-md text-ink">
        <strong className="font-semibold">{fromName}</strong> wants to swap{' '}
        <strong className="font-semibold">{choreName}</strong>.
      </p>
      <div className="flex gap-2 mt-3">
        <button
          type="button"
          disabled={!canAnswer || pending}
          onClick={() => {
            if (!actingId) return;
            start(async () => {
              const res = await kioskRespondSwap(swapId, actingId, true);
              if (res.ok) { setResolved(true); router.refresh(); }
            });
          }}
          className="px-3 py-1.5 rounded-md bg-blue dark:bg-maize text-white dark:text-ink t-body-sm font-medium disabled:opacity-40"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={!canAnswer || pending}
          onClick={() => {
            if (!actingId) return;
            start(async () => {
              const res = await kioskRespondSwap(swapId, actingId, false);
              if (res.ok) { setResolved(false); router.refresh(); }
            });
          }}
          className="px-3 py-1.5 rounded-md border border-line t-body-sm font-medium disabled:opacity-40"
        >
          Deny
        </button>
        {!canAnswer && (
          <span className="t-body-sm text-ink-muted self-center">Admin only</span>
        )}
      </div>
    </Card>
  );
}

/** Only renders when the acting member is an admin. */
export function KioskMessageDismiss({
  messageId,
  adminIds,
}: {
  messageId: string;
  adminIds: string[];
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dismissed, setDismissed] = useState(false);
  const canDismiss = !!actingId && adminIds.includes(actingId);

  if (dismissed || !canDismiss) return null;

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!actingId) return;
        start(async () => {
          const res = await kioskDismissMessage(messageId, actingId);
          if (res.ok) { setDismissed(true); router.refresh(); }
        });
      }}
      aria-label="Clear this note"
      className="shrink-0 w-6 h-6 grid place-items-center rounded-pill text-ink-muted hover:bg-hover disabled:opacity-50"
    >
      <Icon.Close size={16} />
    </button>
  );
}

/** Only renders when the acting member is an admin. */
export function KioskChoreToggle({
  choreId,
  emoji,
  name,
  adminIds,
}: {
  choreId: string;
  emoji: string;
  name: string;
  adminIds: string[];
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hidden, setHidden] = useState(false);
  const canToggle = !!actingId && adminIds.includes(actingId);

  if (hidden) return null;
  if (!canToggle) return null;

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!actingId) return;
        start(async () => {
          const res = await kioskSetChoreActive(choreId, actingId, false);
          if (res.ok) { setHidden(true); router.refresh(); }
        });
      }}
      className="flex items-center gap-2 px-3 py-1.5 rounded-pill border border-line bg-card t-body-sm text-ink-muted hover:bg-hover disabled:opacity-50"
    >
      <span aria-hidden>{emoji}</span>
      Retire {name}
    </button>
  );
}
