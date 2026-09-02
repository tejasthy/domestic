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
export default function KioskError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    const id = setTimeout(reset, 5000);
    return () => clearTimeout(id);
  }, [reset]);

  return (
    <main className="min-h-dvh grid place-items-center bg-page px-8 text-center">
      <div>
        <Logo size={64} />
        <h1 className="t-title-lg text-ink mt-4">One sec…</h1>
        <p className="t-body-md text-ink-muted mt-2 max-w-sm">
          Reconnecting — this display retries on its own.
        </p>
      </div>
    </main>
  );
}
