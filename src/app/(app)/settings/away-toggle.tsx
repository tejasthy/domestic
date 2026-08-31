'use client';

import { useState, useTransition } from 'react';
import { setAway, clearAway } from '@/lib/actions';
import { Button, Card, Field, Input } from '@/components/ui';
import type { MemberAway } from '@/lib/types';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function AwayToggle({ away }: { away: MemberAway }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [until, setUntil] = useState('');

  function turnOn() {
    setError(null);
    start(async () => {
      const res = await setAway(until ? new Date(until).toISOString() : undefined);
      if (!res.ok) setError(res.error);
      else setPicking(false);
    });
  }

  function turnOff() {
    setError(null);
    start(async () => {
      const res = await clearAway();
      if (!res.ok) setError(res.error);
    });
  }

  const title = away
    ? away.until
      ? `Away until ${formatDate(away.until)}`
      : 'Away'
    : "You're around";
  const body = away
    ? "You're skipped in the rotation until you're back."
    : "Mark yourself away and you'll be skipped in the rotation.";

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className="w-9 h-9 grid place-items-center rounded-pill bg-sunken text-lg shrink-0" aria-hidden>
          🧳
        </span>
        <div className="min-w-0 flex-1">
          <p className="t-title-md text-ink">{title}</p>
          <p className="t-body-sm text-ink-muted mt-0.5">{body}</p>
          {error && <p className="t-body-sm text-danger mt-1">{error}</p>}

          {!away && !picking && (
            <Button size="sm" tone="secondary" className="mt-3" disabled={pending} onClick={() => setPicking(true)}>
              Mark away
            </Button>
          )}

          {!away && picking && (
            <div className="mt-3 space-y-3">
              <Field label="Back on (optional)">
                <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button size="sm" disabled={pending} onClick={turnOn}>
                  Mark away
                </Button>
                <Button size="sm" tone="ghost" disabled={pending} onClick={() => setPicking(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {away && (
            <Button size="sm" className="mt-3" disabled={pending} onClick={turnOff}>
              I&apos;m back
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
