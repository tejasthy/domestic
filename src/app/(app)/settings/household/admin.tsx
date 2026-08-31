'use client';

import { useState, useTransition } from 'react';
import {
  clearAiConfig, createInvite, createKioskDevice, removeMember,
  revokeInvite, setAiConfig, setCrossComplete, setHouseholdLocation,
  setMemberAdmin, setModule,
} from '@/lib/household-actions';
import { Button, Card, Field, Initials, Input, Pill, Select, cx } from '@/components/ui';
import { Icon } from '@/components/brand';
import { formatInTimeZone } from '@/lib/timezone';

/* ------------------------------------------------------------------ sharing */

/** Web Share on a phone, clipboard everywhere else, with a visible result. */
function useShare() {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function share(text: string, title: string) {
    try {
      if (navigator.share) {
        await navigator.share({ title, text });
        setState('idle');
        return;
      }
      await navigator.clipboard.writeText(text);
      setState('copied');
      setTimeout(() => setState('idle'), 2000);
    } catch (err) {
      // A cancelled share sheet rejects too; that is not a failure worth showing.
      if ((err as Error)?.name === 'AbortError') return;
      setState('failed');
      setTimeout(() => setState('idle'), 2500);
    }
  }

  return { state, share };
}

function inviteMessage(householdName: string, code: string, origin: string) {
  return [
    `You're invited to join ${householdName} on Domestic — we use it to keep track of the house.`,
    '',
    `${origin}/onboarding?code=${code}`,
    '',
    `If you're already signed in, the code is ${code}.`,
  ].join('\n');
}

/* ------------------------------------------------------------------ members */

export function MemberRow({
  id, name, initials, color, isAdmin, isSelf, adminCount,
}: {
  id: string;
  name: string;
  initials: string;
  color: string;
  isAdmin: boolean;
  isSelf: boolean;
  adminCount: number;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  // Never let the last admin drop themselves and lock the house out.
  const lastAdmin = isAdmin && adminCount <= 1;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <Initials initials={initials} color={color} size="md" />
        <div className="min-w-0 flex-1">
          <p className="t-body-md text-ink truncate">
            {name} {isSelf && <span className="text-ink-muted">(you)</span>}
          </p>
          {isAdmin && <Pill tone="accent">admin</Pill>}
        </div>

        {!isSelf && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              tone="ghost"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await setMemberAdmin(id, !isAdmin);
                  if (!res.ok) setError(res.error);
                })
              }
            >
              {isAdmin ? 'Make member' : 'Make admin'}
            </Button>
            {confirming ? (
              <Button
                size="sm"
                tone="danger"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await removeMember(id);
                    if (!res.ok) setError(res.error);
                    setConfirming(false);
                  })
                }
              >
                Really remove
              </Button>
            ) : (
              <Button size="sm" tone="ghost" onClick={() => setConfirming(true)}>
                Remove
              </Button>
            )}
          </div>
        )}

        {isSelf && lastAdmin && (
          <span className="t-caption text-ink-muted">only admin</span>
        )}
      </div>

      {confirming && (
        <p className="t-body-sm text-ink-muted mt-2">
          {name} keeps their completed chores and past expenses; they just come
          off the rotation and lose access.
        </p>
      )}
      {error && <p className="t-body-sm text-danger mt-2">{error}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ invites */

export function NewInvite({ householdName }: { householdName: string }) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ code: string } | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [expiresDays, setExpiresDays] = useState(14);

  const { state: shareState, share } = useShare();

  if (created) {
    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    const message = inviteMessage(householdName, created.code, origin);

    return (
      <Card className="p-4">
        <p className="t-label text-ink-muted">Invite ready</p>
        <p className="t-code-lg text-ink tracking-[0.2em] mt-2">{created.code}</p>

        <pre className="mt-3 p-3 rounded-md bg-sunken text-ink-2 t-body-sm whitespace-pre-wrap break-words font-sans">
          {message}
        </pre>

        <div className="flex gap-2 mt-3">
          <Button size="md" onClick={() => share(message, `Join ${householdName}`)}>
            {shareState === 'copied' ? 'Copied' : shareState === 'failed' ? 'Copy failed' : 'Share'}
          </Button>
          <Button
            size="md"
            tone="secondary"
            onClick={() => {
              setCreated(null);
              setName('');
              setEmail('');
            }}
          >
            Make another
          </Button>
        </div>

        <p className="t-body-sm text-ink-muted mt-3">
          Single use, expires in {expiresDays} days. They&rsquo;ll sign in with
          Google or an email link first, then land in the house.
        </p>
      </Card>
    );
  }

  if (!open) {
    return (
      <Button size="lg" full onClick={() => setOpen(true)}>
        <Icon.Plus size={18} />
        Create an invite
      </Button>
    );
  }

  return (
    <Card className="p-4 space-y-4">
      <Field label="Their name" hint="Optional — prefills their profile.">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jamie Rivers" />
      </Field>

      <Field
        label="Lock to an email"
        hint="Optional. If set, only that address can use the code."
      >
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          inputMode="email"
          autoCapitalize="none"
          placeholder="jamie@example.com"
        />
      </Field>

      <Field label="Expires">
        <Select
          value={String(expiresDays)}
          onChange={(e) => setExpiresDays(Number(e.target.value))}
        >
          <option value="1">In a day</option>
          <option value="7">In a week</option>
          <option value="14">In two weeks</option>
          <option value="90">In three months</option>
        </Select>
      </Field>

      {error && <p className="t-body-sm text-danger">{error}</p>}

      <div className="flex gap-2">
        <Button
          size="md"
          disabled={pending}
          onClick={() => {
            setError(null);
            start(async () => {
              const res = await createInvite({
                full_name: name,
                email,
                expires_days: expiresDays,
              });
              if (res.ok && res.invite) setCreated({ code: res.invite.code });
              else if (!res.ok) setError(res.error);
            });
          }}
        >
          {pending ? 'Creating…' : 'Create invite'}
        </Button>
        <Button size="md" tone="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

export function InviteList({
  householdName,
  invites,
  timeZone,
}: {
  householdName: string;
  invites: {
    id: string;
    code: string;
    email: string | null;
    fullName: string | null;
    expiresAt: string | null;
    usedCount: number;
    maxUses: number;
  }[];
  timeZone: string;
}) {
  return (
    <Card className="divide-y divide-[var(--border-subtle)]">
      {invites.map((inv) => (
        <InviteRow key={inv.id} householdName={householdName} timeZone={timeZone} {...inv} />
      ))}
    </Card>
  );
}

function InviteRow({
  householdName, id, code, email, fullName, expiresAt, timeZone,
}: {
  householdName: string;
  id: string;
  code: string;
  email: string | null;
  fullName: string | null;
  expiresAt: string | null;
  timeZone: string;
}) {
  const [pending, start] = useTransition();
  const [revoked, setRevoked] = useState(false);
  const { state, share } = useShare();

  if (revoked) {
    return <div className="px-4 py-3 t-body-sm text-ink-muted">Revoked {code}.</div>;
  }

  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="t-code text-ink tracking-[0.15em]">{code}</p>
        <p className="t-body-sm text-ink-muted truncate">
          {fullName ?? email ?? 'Anyone with the link'}
          {expiresAt &&
            ` · expires ${formatInTimeZone(expiresAt, timeZone, { month: 'short', day: 'numeric' })}`}
        </p>
      </div>
      <Button
        size="sm"
        tone="secondary"
        onClick={() =>
          share(
            inviteMessage(
              householdName,
              code,
              typeof window === 'undefined' ? '' : window.location.origin,
            ),
            `Join ${householdName}`,
          )
        }
      >
        {state === 'copied' ? 'Copied' : 'Share'}
      </Button>
      <Button
        size="sm"
        tone="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await revokeInvite(id);
            if (res.ok) setRevoked(true);
          })
        }
      >
        Revoke
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ modules */

export function ModuleToggles({
  modules,
  enabled,
}: {
  modules: { key: string; name: string; tagline: string; emoji: string }[];
  enabled: string[];
}) {
  const [pending, start] = useTransition();
  const [local, setLocal] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <Card className="divide-y divide-[var(--border-subtle)]">
        {modules.map((m) => {
          const on = local.includes(m.key);
          return (
            <button
              key={m.key}
              type="button"
              role="switch"
              aria-checked={on}
              disabled={pending}
              onClick={() => {
                setError(null);
                setLocal((prev) =>
                  on ? prev.filter((k) => k !== m.key) : [...prev, m.key],
                );
                start(async () => {
                  const res = await setModule(m.key, !on);
                  if (!res.ok) {
                    setLocal(enabled);
                    setError(res.error);
                  }
                });
              }}
              className="w-full flex items-start gap-3 px-4 py-3.5 text-left hover:bg-hover transition-colors duration-[120ms]"
            >
              <span className="text-xl" aria-hidden>{m.emoji}</span>
              <span className="min-w-0 flex-1">
                <span className="t-title-md text-ink block">{m.name}</span>
                <span className="t-body-sm text-ink-muted block mt-0.5">{m.tagline}</span>
              </span>
              <span
                className={cx(
                  'w-11 h-6 rounded-pill shrink-0 mt-0.5 relative transition-colors duration-[180ms]',
                  on ? 'bg-blue dark:bg-maize' : 'bg-line',
                )}
                aria-hidden
              >
                <span
                  className={cx(
                    'absolute top-0.5 w-5 h-5 rounded-pill bg-white shadow-xs',
                    'transition-[left] duration-[180ms]',
                    on ? 'left-[22px]' : 'left-0.5',
                  )}
                />
              </span>
            </button>
          );
        })}
      </Card>
      {error && <p className="t-body-sm text-danger mt-2">{error}</p>}
      <p className="t-body-sm text-ink-muted mt-2">
        Turning something off hides it for everyone. Nothing is deleted — switch
        it back on and your history is exactly where you left it.
      </p>
    </>
  );
}

/* --------------------------------------------------------------- permissions */

export function CrossCompleteToggle({ enabled }: { enabled: boolean }) {
  const [pending, start] = useTransition();
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={pending}
        onClick={() => {
          setError(null);
          const next = !on;
          setOn(next);
          start(async () => {
            const res = await setCrossComplete(next);
            if (!res.ok) {
              setOn(!next);
              setError(res.error);
            }
          });
        }}
        className="w-full flex items-start gap-3 px-4 py-3.5 text-left rounded-lg border border-line bg-card hover:bg-hover transition-colors duration-[120ms]"
      >
        <span className="min-w-0 flex-1">
          <span className="t-title-md text-ink block">Anyone can complete anyone&rsquo;s chores</span>
          <span className="t-body-sm text-ink-muted block mt-0.5">
            Off means only the person a turn is assigned to can mark it done.
          </span>
        </span>
        <span
          className={cx(
            'w-11 h-6 rounded-pill shrink-0 mt-0.5 relative transition-colors duration-[180ms]',
            on ? 'bg-blue dark:bg-maize' : 'bg-line',
          )}
          aria-hidden
        >
          <span
            className={cx(
              'absolute top-0.5 w-5 h-5 rounded-pill bg-white shadow-xs',
              'transition-[left] duration-[180ms]',
              on ? 'left-[22px]' : 'left-0.5',
            )}
          />
        </span>
      </button>
      {error && <p className="t-body-sm text-danger mt-2">{error}</p>}
    </>
  );
}

/* -------------------------------------------------------------------- kiosk */

export function LocationSetting({ label }: { label: string | null }) {
  const [pending, start] = useTransition();
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(label);
  const [error, setError] = useState<string | null>(null);

  return (
    <Card className="p-4 space-y-3">
      {current && <p className="t-body-md text-ink">{current}</p>}
      <Field label={current ? 'Change it' : 'City'} hint="Used for the kiosk weather widget.">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ann Arbor, MI"
        />
      </Field>
      {error && <p className="t-body-sm text-danger">{error}</p>}
      <Button
        size="md"
        disabled={pending || !query.trim()}
        onClick={() => {
          setError(null);
          start(async () => {
            const res = await setHouseholdLocation(query);
            if (res.ok) {
              setCurrent(res.label ?? current);
              setQuery('');
            } else {
              setError(res.error);
            }
          });
        }}
      >
        {pending ? 'Saving…' : 'Save'}
      </Button>
    </Card>
  );
}

export function KioskDevices({
  devices,
  timeZone,
}: {
  devices: { id: string; name: string; lastSeenAt: string | null }[];
  timeZone: string;
}) {
  const [pending, start] = useTransition();
  const [name, setName] = useState('Kitchen iPad');
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { state, share } = useShare();

  return (
    <>
      {devices.length > 0 && (
        <Card className="divide-y divide-[var(--border-subtle)] mb-3">
          {devices.map((d) => (
            <div key={d.id} className="flex items-center gap-3 px-4 py-3">
              <span className="t-body-md text-ink flex-1">{d.name}</span>
              <span className="t-body-sm text-ink-muted">
                {d.lastSeenAt
                  ? `seen ${formatInTimeZone(d.lastSeenAt, timeZone, { month: 'short', day: 'numeric' })}`
                  : 'never paired'}
              </span>
            </div>
          ))}
        </Card>
      )}

      {pairUrl ? (
        <Card className="p-4">
          <p className="t-label text-ink-muted">Open this once on the tablet</p>
          <pre className="mt-2 p-3 rounded-md bg-sunken text-ink-2 t-body-sm whitespace-pre-wrap break-all font-mono">
            {pairUrl}
          </pre>
          <div className="flex gap-2 mt-3">
            <Button size="md" onClick={() => share(pairUrl, 'Pair the wall display')}>
              {state === 'copied' ? 'Copied' : 'Share'}
            </Button>
            <Button size="md" tone="ghost" onClick={() => setPairUrl(null)}>
              Done
            </Button>
          </div>
          <p className="t-body-sm text-danger mt-3">
            This link is shown once and never again — only its hash is stored.
            Anyone who opens it sees your house&rsquo;s board, so don&rsquo;t
            post it anywhere.
          </p>
        </Card>
      ) : (
        <Card className="p-4 space-y-3">
          <Field label="Device name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {error && <p className="t-body-sm text-danger">{error}</p>}
          <Button
            size="md"
            disabled={pending}
            onClick={() => {
              setError(null);
              start(async () => {
                const res = await createKioskDevice(name);
                if (res.ok && res.token) {
                  setPairUrl(
                    `${window.location.origin}/kiosk/pair?token=${encodeURIComponent(res.token)}`,
                  );
                } else if (!res.ok) setError(res.error);
              });
            }}
          >
            {pending ? 'Pairing…' : 'Pair a display'}
          </Button>
        </Card>
      )}
    </>
  );
}

/* ------------------------------------------------------------ ai config */

const AI_PROVIDERS: Record<string, string> = {
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

export function AiConfig({
  summary,
  timeZone,
}: {
  summary: { provider: string; updatedAt: string } | null;
  timeZone: string;
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<'anthropic' | 'gemini'>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  if (summary && !editing) {
    return (
      <Card className="p-4 space-y-3">
        <div>
          <p className="t-body-md text-ink">
            {AI_PROVIDERS[summary.provider] ?? summary.provider} — configured
          </p>
          <p className="t-body-sm text-ink-muted">
            Updated{' '}
            {formatInTimeZone(summary.updatedAt, timeZone, { month: 'short', day: 'numeric' })}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="md"
            tone="secondary"
            onClick={() => {
              setError(null);
              setEditing(true);
            }}
          >
            Replace key
          </Button>
          {confirming ? (
            <Button
              size="md"
              tone="danger"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await clearAiConfig();
                  if (!res.ok) setError(res.error);
                  setConfirming(false);
                })
              }
            >
              Really remove
            </Button>
          ) : (
            <Button size="md" tone="ghost" onClick={() => setConfirming(true)}>
              Remove
            </Button>
          )}
        </div>
        {error && <p className="t-body-sm text-danger mt-2">{error}</p>}
      </Card>
    );
  }

  return (
    <Card className="p-4 space-y-4">
      <Field label="Provider">
        <Select
          value={provider}
          onChange={(e) => setProvider(e.target.value as 'anthropic' | 'gemini')}
        >
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="gemini">Google (Gemini)</option>
        </Select>
      </Field>

      <Field label="API key" hint="Encrypted at rest. Once saved, it can never be shown again.">
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          autoComplete="off"
        />
      </Field>

      {error && <p className="t-body-sm text-danger">{error}</p>}

      <div className="flex gap-2">
        <Button
          size="md"
          disabled={pending}
          onClick={() => {
            setError(null);
            start(async () => {
              const res = await setAiConfig(provider, apiKey);
              if (res.ok) {
                setApiKey('');
                setEditing(false);
              } else {
                setError(res.error);
              }
            });
          }}
        >
          {pending ? 'Saving…' : 'Save'}
        </Button>
        {summary && (
          <Button size="md" tone="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </div>
    </Card>
  );
}
