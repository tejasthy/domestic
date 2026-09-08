'use client';

import { useEffect } from 'react';
import { Logo } from '@/components/brand';

/**
 * The kiosk is an unattended wall display running as a standalone iOS Home
 * Screen web app — an uncaught error otherwise falls through to the OS's own
 * "This page couldn't load" screen, which nobody in the house will walk over
 * to dismiss. Self-heal instead: retry on a short timer until the transient
 * failure clears.
 */
export default function KioskError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    const id = setTimeout(retry, 5000);
    return () => clearTimeout(id);
    // `retry`'s identity is stable for the life of the error boundary, so it
    // never re-triggers this effect. Depend on `error` instead — a fresh
    // crash is a new Error instance, which re-arms the timer for the next
    // attempt. Without this, a single failed retry leaves the display stuck
    // forever with no timer left running.
    //
    // Must be `retry`, not `reset`: the crash happens inside KioskPage's own
    // Server Component data fetch, and `reset()` only clears the error state
    // and re-renders the same (still-failed) tree without re-fetching — it
    // can't recover from a Server Component error. `retry()` actually
    // re-fetches the segment, which is what "retries on its own" requires.
  }, [error, retry]);

  return (
    <main className="min-h-dvh grid place-items-center bg-page px-8 text-center">
      <div>
        <Logo size={64} className="mx-auto" />
        <h1 className="t-title-lg text-ink mt-4">One sec…</h1>
        <p className="t-body-md text-ink-muted mt-2 max-w-sm">
          Reconnecting — this display retries on its own.
        </p>
      </div>
    </main>
  );
}
