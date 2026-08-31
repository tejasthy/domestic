'use client';

import { useState, useTransition } from 'react';
import { deleteKioskMessage, postKioskMessage } from '@/lib/actions';
import { Button, Card, Input } from '@/components/ui';
import { Icon } from '@/components/brand';
import { formatInTimeZone } from '@/lib/timezone';

type LiveMessage = { id: string; body: string; createdAt: string; authorName: string | null };

/** A short note that shows up on the wall display for a couple of days. */
export function KioskNote({
  messages,
  timeZone,
}: {
  messages: LiveMessage[];
  timeZone: string;
}) {
  const [pending, start] = useTransition();
  const [body, setBody] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="p-4 space-y-3">
      <Input
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setSent(false);
        }}
        placeholder="Trash goes out Thursday…"
        maxLength={280}
      />
      {error && <p className="t-body-sm text-danger">{error}</p>}
      <Button
        size="md"
        disabled={pending || !body.trim()}
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await postKioskMessage(body);
            if (res.ok) {
              setBody('');
              setSent(true);
            } else {
              setError(res.error);
            }
          });
        }}
      >
        {pending ? 'Posting…' : sent ? 'Posted' : 'Post to kiosk'}
      </Button>

      {messages.length > 0 && (
        <div className="pt-3 border-t border-subtle space-y-2">
          {messages.map((m) => (
            <LiveMessageRow key={m.id} message={m} timeZone={timeZone} />
          ))}
        </div>
      )}
    </Card>
  );
}

function LiveMessageRow({ message, timeZone }: { message: LiveMessage; timeZone: string }) {
  const [pending, start] = useTransition();
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (removed) return null;

  return (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <p className="t-body-sm text-ink">{message.body}</p>
        <p className="t-caption text-ink-muted mt-0.5">
          {message.authorName && `${message.authorName} · `}
          {formatInTimeZone(message.createdAt, timeZone, { month: 'short', day: 'numeric' })}
        </p>
        {error && <p className="t-caption text-danger mt-0.5">{error}</p>}
      </div>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await deleteKioskMessage(message.id);
            if (res.ok) setRemoved(true);
            else setError(res.error);
          });
        }}
        aria-label="Clear this note"
        className="shrink-0 w-6 h-6 grid place-items-center rounded-pill text-ink-muted hover:bg-hover disabled:opacity-50"
      >
        <Icon.Close size={14} />
      </button>
    </div>
  );
}
