'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button, Field, Input } from '@/components/ui';

export function ResetPasswordForm() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <div className="bg-card border border-subtle rounded-lg p-5 text-center shadow-xs">
        <div className="text-3xl mb-2" aria-hidden>✅</div>
        <p className="t-title-md text-ink">Password updated</p>
        <p className="t-body-sm text-ink-muted mt-1">You&rsquo;re signed in with it now.</p>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setPending(true);
        const supabase = createClient();
        const { error } = await supabase.auth.updateUser({ password });
        setPending(false);
        if (error) {
          setError(error.message);
          return;
        }
        setDone(true);
        setTimeout(() => {
          router.push('/home');
          router.refresh();
        }, 1200);
      }}
    >
      <Field label="New password" hint="At least 8 characters.">
        <Input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          autoFocus
        />
      </Field>

      {error && <p className="t-body-sm text-danger">{error}</p>}

      <Button type="submit" size="lg" full disabled={pending}>
        {pending ? 'Saving…' : 'Save password'}
      </Button>
    </form>
  );
}
