'use client';

import { useState, useTransition } from 'react';
import { Button, Card } from '@/components/ui';
import { disconnectAssistant } from './assistant-actions';

export type ConnectedAssistant = { clientId: string; name: string; connectedOn: string };

function Row({ assistant }: { assistant: ConnectedAssistant }) {
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function disconnect() {
    setError(null);
    start(async () => {
      const result = await disconnectAssistant(assistant.clientId);
      if (!result.ok) setError(result.error);
      setConfirming(false);
    });
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="t-body-md text-ink truncate">{assistant.name}</p>
          <p className="t-body-sm text-ink-muted">Connected {assistant.connectedOn}</p>
        </div>
        {!confirming && (
          <Button type="button" size="sm" tone="secondary" onClick={() => setConfirming(true)}>
            Disconnect
          </Button>
        )}
      </div>

      {confirming && (
        <div className="mt-3">
          <p className="t-body-sm text-ink-2">
            {assistant.name} will lose access to your account straight away. You can connect it
            again later.
          </p>
          <div className="flex gap-2 mt-2">
            <Button type="button" size="sm" tone="danger" onClick={disconnect} disabled={pending}>
              {pending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
            <Button type="button" size="sm" tone="ghost" onClick={() => setConfirming(false)} disabled={pending}>
              Keep
            </Button>
          </div>
        </div>
      )}

      {error && <p className="t-body-sm text-danger mt-2">{error}</p>}
    </div>
  );
}

/**
 * Every assistant this person has approved, each with its own off switch —
 * the only way to cut one off without switching AI assistants off for the whole house.
 */
export function ConnectedAssistants({ assistants }: { assistants: ConnectedAssistant[] }) {
  if (assistants.length === 0) return null;
  return (
    <div>
      <p className="t-label text-ink-muted mb-2">Connected to your account</p>
      <Card className="divide-y divide-[var(--border-subtle)]">
        {assistants.map((a) => (
          <Row key={a.clientId} assistant={a} />
        ))}
      </Card>
    </div>
  );
}
