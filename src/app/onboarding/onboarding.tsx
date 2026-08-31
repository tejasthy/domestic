'use client';

import { useEffect, useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createHousehold, joinHousehold, peekInvite } from '@/lib/household-actions';
import { Button, Card, Field, Input, cx } from '@/components/ui';

type ModuleOption = {
  key: string;
  name: string;
  tagline: string;
  emoji: string;
  defaultEnabled: boolean;
};

function initialsFrom(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts.at(-1)![0]).toUpperCase();
}

export function Onboarding({
  suggestedName,
  initialCode,
  modules,
}: {
  suggestedName: string;
  initialCode: string | null;
  modules: ModuleOption[];
}) {
  const router = useRouter();
  // An invite link lands people straight on the join tab.
  const [tab, setTab] = useState<'join' | 'create'>(initialCode ? 'join' : 'create');

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-1 p-1 bg-sunken rounded-lg">
        {(['create', 'join'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            aria-pressed={tab === t}
            className={cx(
              'h-10 rounded-md t-body-md font-semibold transition-colors duration-[120ms]',
              tab === t ? 'bg-card text-ink shadow-xs' : 'text-ink-muted hover:text-ink',
            )}
          >
            {t === 'create' ? 'Start a house' : 'Join a house'}
          </button>
        ))}
      </div>

      {tab === 'create' ? (
        <CreateForm suggestedName={suggestedName} modules={modules} onDone={() => router.push('/')} />
      ) : (
        <JoinForm initialCode={initialCode} onDone={() => router.push('/')} />
      )}
    </div>
  );
}

function CreateForm({
  suggestedName,
  modules,
  onDone,
}: {
  suggestedName: string;
  modules: ModuleOption[];
  onDone: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [fullName, setFullName] = useState(suggestedName);
  const [initials, setInitials] = useState(() => initialsFrom(suggestedName));
  const [enabled, setEnabled] = useState<string[]>(
    modules.filter((m) => m.defaultEnabled).map((m) => m.key),
  );

  // Browsers know the timezone; asking would be a worse experience than
  // detecting it and letting them change it later in settings. Read through
  // useSyncExternalStore so there is no setState-on-mount and no SSR mismatch.
  const timezone = useSyncExternalStore(
    () => () => {},
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Detroit',
    () => 'America/Detroit',
  );

  function toggle(key: string) {
    setEnabled((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await createHousehold({
            name, address, timezone,
            full_name: fullName, initials, modules: enabled,
          });
          if (res.ok) onDone();
          else setError(res.error);
        });
      }}
    >
      <Card className="p-4 space-y-4">
        <Field label="House name" hint="What everyone calls it.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="526 Detroit St."
            required
            autoFocus
          />
        </Field>

        <Field label="Address" hint="Optional.">
          <Input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="526 Detroit St., Ann Arbor, MI"
          />
        </Field>
      </Card>

      <Card className="p-4 grid grid-cols-[1fr_auto] gap-3">
        <Field label="Your name">
          <Input
            value={fullName}
            onChange={(e) => {
              setFullName(e.target.value);
              setInitials(initialsFrom(e.target.value));
            }}
            required
          />
        </Field>
        <Field label="Initials">
          <Input
            value={initials}
            onChange={(e) => setInitials(e.target.value.toUpperCase().slice(0, 3))}
            className="w-20 text-center font-mono"
            maxLength={3}
            required
          />
        </Field>
      </Card>

      <div>
        <span className="t-label text-ink-muted block mb-2">What does your house track?</span>
        <div className="space-y-2">
          {modules.map((m) => {
            const on = enabled.includes(m.key);
            return (
              <button
                key={m.key}
                type="button"
                onClick={() => toggle(m.key)}
                aria-pressed={on}
                className={cx(
                  'w-full flex items-start gap-3 p-3.5 rounded-lg border text-left',
                  'transition-colors duration-[120ms]',
                  on ? 'border-maize bg-maize/12' : 'border-subtle bg-card opacity-70 hover:opacity-100',
                )}
              >
                <span className="text-xl" aria-hidden>{m.emoji}</span>
                <span className="min-w-0 flex-1">
                  <span className="t-title-md text-ink block">{m.name}</span>
                  <span className="t-body-sm text-ink-muted block mt-0.5">{m.tagline}</span>
                </span>
                <span
                  className={cx(
                    'w-5 h-5 rounded-sm border grid place-items-center shrink-0 mt-0.5',
                    on ? 'bg-blue border-blue dark:bg-maize dark:border-maize' : 'border-line',
                  )}
                  aria-hidden
                >
                  {on && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
                         stroke="currentColor" strokeWidth="3.5" strokeLinecap="round"
                         className="text-white dark:text-blue">
                      <path d="m5 12.5 4.5 4.5L19 7.5" />
                    </svg>
                  )}
                </span>
              </button>
            );
          })}
        </div>
        <p className="t-body-sm text-ink-muted mt-2">
          You can change any of this later in settings. Turning something off
          hides it — nothing is deleted.
        </p>
      </div>

      {error && (
        <p className="t-body-sm text-danger bg-danger/10 border border-danger/25 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" full disabled={pending || enabled.length === 0}>
        {pending ? 'Setting up…' : 'Create the house'}
      </Button>
    </form>
  );
}

function JoinForm({
  initialCode,
  onDone,
}: {
  initialCode: string | null;
  onDone: () => void;
}) {
  const [code, setCode] = useState(initialCode ?? '');
  const [checked, setChecked] = useState<{
    code: string;
    result:
      | { valid: true; householdName: string; fullName: string | null; initials: string | null }
      | { valid: false; reason: string };
  } | null>(null);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [initials, setInitials] = useState('');

  const trimmed = code.trim();
  const complete = trimmed.length >= 9;
  // Derived, not stored: a result only counts if it is for the current code.
  const preview = checked?.code === trimmed ? checked.result : null;
  const checking = complete && !preview;

  // Debounced lookup, so people find out they mistyped before filling in the
  // rest of the form.
  useEffect(() => {
    if (!complete || checked?.code === trimmed) return;

    let cancelled = false;
    const id = setTimeout(async () => {
      const result = await peekInvite(trimmed);
      if (cancelled) return;
      setChecked({ code: trimmed, result });
      if (result.valid) {
        if (result.fullName) setFullName((v) => v || result.fullName!);
        if (result.initials) setInitials((v) => v || result.initials!);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [trimmed, complete, checked?.code]);

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const res = await joinHousehold(trimmed, fullName, initials);
          if (res.ok) onDone();
          else setError(res.error);
        });
      }}
    >
      <Card className="p-4 space-y-4">
        <Field label="Invite code" hint="Eight characters, from whoever runs the house.">
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="AB3D-9XKM"
            className="font-mono tracking-[0.2em] text-center text-lg"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            required
            autoFocus={!initialCode}
          />
        </Field>

        {checking && <p className="t-body-sm text-ink-muted">Checking…</p>}

        {preview?.valid === true && (
          <p className="t-body-md text-success">
            Joining <strong className="font-semibold">{preview.householdName}</strong>.
          </p>
        )}
        {preview?.valid === false && (
          <p className="t-body-sm text-danger">{preview.reason}</p>
        )}
      </Card>

      {preview?.valid === true && (
        <Card className="p-4 grid grid-cols-[1fr_auto] gap-3">
          <Field label="Your name">
            <Input
              value={fullName}
              onChange={(e) => {
                setFullName(e.target.value);
                if (!initials) setInitials(initialsFrom(e.target.value));
              }}
              required
            />
          </Field>
          <Field label="Initials">
            <Input
              value={initials}
              onChange={(e) => setInitials(e.target.value.toUpperCase().slice(0, 3))}
              className="w-20 text-center font-mono"
              maxLength={3}
              required
            />
          </Field>
        </Card>
      )}

      {error && (
        <p className="t-body-sm text-danger bg-danger/10 border border-danger/25 rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <Button type="submit" size="lg" full disabled={pending || preview?.valid !== true}>
        {pending ? 'Joining…' : 'Join'}
      </Button>
    </form>
  );
}
