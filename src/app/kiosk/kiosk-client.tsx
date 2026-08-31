'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';

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
