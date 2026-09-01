'use client';

import { useActionState, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendMagicLink } from '@/lib/actions';
import { createClient } from '@/lib/supabase/client';
import { Button, Field, Input, cx } from '@/components/ui';
import { Turnstile, type TurnstileHandle } from '@/components/turnstile';

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.65 3.58 9 3.58z" />
    </svg>
  );
}

/**
 * Magic links need working SMTP. Supabase's built-in sender allows roughly two
 * emails an hour, which looks broken rather than rate-limited, so the email
 * path stays off until someone configures a real sender.
 */
const MAGIC_LINK_ENABLED = process.env.NEXT_PUBLIC_ENABLE_MAGIC_LINK === 'true';
const CAPTCHA_ENABLED = Boolean(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY);

type PasswordMode = 'signin' | 'signup' | 'forgot';

export function LoginForm({ next = '/home' }: { next?: string }) {
  const [magicState, sendMagicLinkAction, magicPending] = useActionState(sendMagicLink, null);
  const [showEmailLink, setShowEmailLink] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const router = useRouter();
  const [mode, setMode] = useState<PasswordMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const [captchaToken, setCaptchaToken] = useState('');
  const turnstileRef = useRef<TurnstileHandle>(null);
  const magicTurnstileRef = useRef<TurnstileHandle>(null);
  const [magicCaptchaToken, setMagicCaptchaToken] = useState('');

  async function signInWithGoogle() {
    setOauthError(null);
    setOauthPending(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    // On success the browser has already navigated away; only failures land here.
    if (error) {
      setOauthError(error.message);
      setOauthPending(false);
    }
  }

  async function submitPasswordForm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (CAPTCHA_ENABLED && !captchaToken) {
      setError('Complete the verification below.');
      return;
    }

    setPending(true);
    const supabase = createClient();

    if (mode === 'forgot') {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
        captchaToken: captchaToken || undefined,
      });
      setPending(false);
      turnstileRef.current?.reset();
      setCaptchaToken('');
      if (error) setError(error.message);
      else setSent(true);
      return;
    }

    if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          captchaToken: captchaToken || undefined,
        },
      });
      setPending(false);
      turnstileRef.current?.reset();
      setCaptchaToken('');
      if (error) {
        setError(error.message);
        return;
      }
      if (data.session) {
        // Email confirmation is off for this project — already signed in.
        router.push(next);
        router.refresh();
      } else {
        setSent(true);
      }
      return;
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
      options: { captchaToken: captchaToken || undefined },
    });
    setPending(false);
    turnstileRef.current?.reset();
    setCaptchaToken('');
    if (error) {
      setError(error.message);
      return;
    }
    router.push(next);
    router.refresh();
  }

  if (sent) {
    return (
      <div className="bg-card border border-subtle rounded-lg p-5 text-center shadow-xs">
        <div className="text-3xl mb-2" aria-hidden>📬</div>
        <p className="t-title-md text-ink">Check your email</p>
        <p className="t-body-sm text-ink-muted mt-1">
          {mode === 'forgot'
            ? 'Tap the link to pick a new password. It expires in an hour.'
            : 'Tap the link to confirm your account, then come back and sign in.'}
        </p>
      </div>
    );
  }

  if (magicState?.ok) {
    return (
      <div className="bg-card border border-subtle rounded-lg p-5 text-center shadow-xs">
        <div className="text-3xl mb-2" aria-hidden>📬</div>
        <p className="t-title-md text-ink">Check your email</p>
        <p className="t-body-sm text-ink-muted mt-1">
          Tap the link on this phone and you&rsquo;re in. It expires in an hour.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={signInWithGoogle}
        disabled={oauthPending}
        className={cx(
          'w-full h-12 inline-flex items-center justify-center gap-3 rounded-md',
          'bg-card text-ink border border-line font-semibold',
          'transition-colors duration-[120ms] hover:bg-hover active:bg-sunken',
          'disabled:opacity-50 disabled:pointer-events-none',
        )}
      >
        <GoogleMark />
        {oauthPending ? 'Redirecting…' : 'Continue with Google'}
      </button>

      {oauthError && <p className="t-body-sm text-danger">{oauthError}</p>}

      <div className="flex items-center gap-3 py-1">
        <span className="h-px flex-1 bg-subtle" />
        <span className="t-caption text-ink-muted">or</span>
        <span className="h-px flex-1 bg-subtle" />
      </div>

      {mode !== 'forgot' && (
        <div className="grid grid-cols-2 gap-1 p-1 bg-sunken rounded-lg">
          {(['signin', 'signup'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                setError(null);
              }}
              aria-pressed={mode === m}
              className={cx(
                'h-9 rounded-md t-body-sm font-semibold transition-colors duration-[120ms]',
                mode === m ? 'bg-card text-ink shadow-xs' : 'text-ink-muted hover:text-ink',
              )}
            >
              {m === 'signin' ? 'Sign in' : 'Create account'}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={submitPasswordForm} className="space-y-3">
        <Field label="Email">
          <Input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            placeholder="you@example.com"
            required
          />
        </Field>

        {mode !== 'forgot' && (
          <Field
            label="Password"
            hint={mode === 'signup' ? 'At least 8 characters.' : undefined}
          >
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              minLength={mode === 'signup' ? 8 : undefined}
              required
            />
          </Field>
        )}

        {CAPTCHA_ENABLED && (
          <Turnstile ref={turnstileRef} onVerify={setCaptchaToken} />
        )}

        {error && <p className="t-body-sm text-danger">{error}</p>}

        <Button type="submit" size="lg" tone="secondary" full disabled={pending}>
          {pending
            ? 'Working…'
            : mode === 'signup'
              ? 'Create account'
              : mode === 'forgot'
                ? 'Send reset link'
                : 'Sign in'}
        </Button>

        {mode === 'signin' && (
          <button
            type="button"
            onClick={() => {
              setMode('forgot');
              setError(null);
            }}
            className="w-full t-body-sm text-ink-muted hover:text-ink py-1 transition-colors"
          >
            Forgot password?
          </button>
        )}
        {mode === 'forgot' && (
          <button
            type="button"
            onClick={() => {
              setMode('signin');
              setError(null);
            }}
            className="w-full t-body-sm text-ink-muted hover:text-ink py-1 transition-colors"
          >
            Back to sign in
          </button>
        )}
      </form>

      {!MAGIC_LINK_ENABLED ? null : !showEmailLink ? (
        <button
          type="button"
          onClick={() => setShowEmailLink(true)}
          className="w-full t-body-sm text-ink-muted hover:text-ink py-2 transition-colors"
        >
          Email me a sign-in link instead
        </button>
      ) : (
        <>
          <div className="flex items-center gap-3 py-1">
            <span className="h-px flex-1 bg-subtle" />
            <span className="t-caption text-ink-muted">or</span>
            <span className="h-px flex-1 bg-subtle" />
          </div>

          <form action={sendMagicLinkAction} className="space-y-3">
            <input type="hidden" name="next" value={next} />
            <Field label="Email">
              <Input
                name="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoCapitalize="none"
                placeholder="you@example.com"
                required
              />
            </Field>

            {CAPTCHA_ENABLED && (
              <>
                <input type="hidden" name="captchaToken" value={magicCaptchaToken} />
                <Turnstile ref={magicTurnstileRef} onVerify={setMagicCaptchaToken} />
              </>
            )}

            {magicState?.ok === false && <p className="t-body-sm text-danger">{magicState.error}</p>}

            <Button type="submit" size="lg" tone="secondary" full disabled={magicPending}>
              {magicPending ? 'Sending…' : 'Email me a link'}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
