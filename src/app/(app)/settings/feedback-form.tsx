'use client';

import { useState, useTransition } from 'react';
import { usePathname } from 'next/navigation';
import { submitFeedback } from '@/lib/feedback-actions';
import { Button, Card, Textarea, cx } from '@/components/ui';

const ISSUES_URL = 'https://github.com/tejasthy/domestic/issues/new';

export function FeedbackForm() {
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [kind, setKind] = useState<'bug' | 'feature'>('bug');
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (sent) {
    const githubUrl = `${ISSUES_URL}?title=${encodeURIComponent(`${kind}: `)}&body=${encodeURIComponent(body)}&labels=${kind}`;
    return (
      <Card className="p-4">
        <p className="t-body-md text-ink">Thanks — we&rsquo;ll take a look.</p>
        <a
          href={githubUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="t-body-sm text-accent font-medium mt-1 inline-block"
        >
          or open this on GitHub instead
        </a>
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-3">
      <div className="flex gap-2">
        {(['bug', 'feature'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            aria-pressed={kind === k}
            className={cx(
              'flex-1 h-9 rounded-md border text-[13px] font-semibold transition-colors duration-[120ms]',
              kind === k
                ? 'border-maize bg-maize/12 text-ink'
                : 'border-subtle bg-card opacity-60 hover:opacity-100 text-ink-2',
            )}
          >
            {k === 'bug' ? 'Report a bug' : 'Request a feature'}
          </button>
        ))}
      </div>

      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder={kind === 'bug' ? 'What happened, and what did you expect?' : "What's missing?"}
        maxLength={4000}
      />

      {error && <p className="t-body-sm text-danger">{error}</p>}

      <Button
        size="md"
        disabled={pending || body.trim().length === 0}
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await submitFeedback({ kind, body, path: pathname });
            if (res.ok) setSent(true);
            else setError(res.error);
          });
        }}
      >
        {pending ? 'Sending…' : 'Send'}
      </Button>
    </Card>
  );
}
