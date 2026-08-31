'use client';

import { useState, useTransition } from 'react';
import { postKioskMessage } from '@/lib/actions';
import { Button, Card, Input } from '@/components/ui';

/** A short note that shows up on the wall display for a couple of days. */
export function KioskNote() {
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
    </Card>
  );
}
