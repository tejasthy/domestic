'use client';

import { createContext, useContext, useEffect, useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  kioskCompleteTurn, kioskFlagChore, kioskRespondSwap, kioskSetChoreActive, kioskDismissMessage,
  kioskUndoTurn,
} from '@/lib/kiosk-actions';
import { Card, Initials, cx } from '@/components/ui';
import { Icon } from '@/components/brand';
import type { Weather } from '@/lib/weather';

/**
 * Ticks on an interval, subscription-style. The snapshot is a bucketed integer
 * rather than a Date so it stays referentially stable between ticks, and the
 * server snapshot is null — the wall clock is the one value guaranteed to
 * differ between server and client.
 */
function useTick(intervalMs: number): number | null {
  return useSyncExternalStore(
    (onChange) => {
      const id = setInterval(onChange, intervalMs);
      return () => clearInterval(id);
    },
    () => Math.floor(Date.now() / intervalMs),
    () => null,
  );
}

export function KioskClock({ timezone }: { timezone: string }) {
  const tick = useTick(15_000);
  if (tick === null) return <div className="h-16" />;

  const now = new Date(tick * 15_000);

  return (
    <div className="text-right">
      <p className="t-display-lg text-ink leading-none tabular-nums">
        {now.toLocaleTimeString('en-US', {
          timeZone: timezone,
          hour: 'numeric',
          minute: '2-digit',
        })}
      </p>
      <p className="t-body-md text-ink-muted mt-1">
        {now.toLocaleDateString('en-US', {
          timeZone: timezone,
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        })}
      </p>
    </div>
  );
}

/** Keeps the wall display current without anyone touching it. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);

  return null;
}

/* ------------------------------------------------------------- acting as */

/**
 * Who's standing at the kiosk right now. Tap-to-select, no PIN — the kiosk
 * lives inside the house, same trust model as a paper chart on the fridge.
 * Pure client state: it resets on the next auto-refresh, and nothing about it
 * ever touches the server until an action is actually taken.
 */
type ActingAsState = {
  actingId: string | null;
  setActingId: (id: string | null) => void;
};

const ActingAsContext = createContext<ActingAsState | null>(null);

function useActingAs() {
  const ctx = useContext(ActingAsContext);
  if (!ctx) throw new Error('useActingAs must be used inside ActingAsProvider');
  return ctx;
}

export function ActingAsProvider({ children }: { children: React.ReactNode }) {
  const [actingId, setActingId] = useState<string | null>(null);
  return (
    <ActingAsContext.Provider value={{ actingId, setActingId }}>
      {children}
    </ActingAsContext.Provider>
  );
}

type KioskMember = { id: string; full_name: string; initials: string; color: string };

export function ActingAsBar({ members }: { members: KioskMember[] }) {
  const { actingId, setActingId } = useActingAs();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="t-label text-ink-muted mr-1">Acting as</span>
      {members.map((m) => {
        const selected = m.id === actingId;
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => setActingId(selected ? null : m.id)}
            className={cx(
              'flex items-center gap-2 pl-1.5 pr-3 py-1.5 rounded-pill border transition-colors duration-[120ms]',
              selected
                ? 'border-accent bg-accent/10'
                : 'border-line bg-card hover:bg-hover',
            )}
          >
            <Initials initials={m.initials} color={m.color} size="sm" />
            <span className="t-body-sm font-medium text-ink">{m.full_name.split(' ')[0]}</span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- completing */

export function KioskTurnCard({
  turnId,
  choreName,
  className,
  children,
}: {
  turnId: string;
  choreName: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const disabled = !actingId || pending || done;

  if (done) {
    return (
      <Card className={cx('p-5 opacity-60 grid place-items-center', className)}>
        <span className="w-10 h-10 grid place-items-center rounded-pill bg-success/15 text-success">
          <Icon.Check size={22} />
        </span>
      </Card>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        if (!actingId) return;
        start(async () => {
          const res = await kioskCompleteTurn(turnId, actingId);
          if (res.ok) {
            setDone(true);
            router.refresh();
          }
        });
      }}
      aria-label={
        actingId ? `Mark ${choreName} done` : `Tap your name above first to mark ${choreName} done`
      }
      className={cx(
        'text-left w-full transition-opacity duration-[120ms]',
        !actingId && 'opacity-50',
        pending && 'opacity-70',
      )}
    >
      <Card className={className}>{children}</Card>
    </button>
  );
}

/**
 * "Dishwasher's full" — flags an on-demand chore from the kiosk. `flagged`
 * comes from the server (is there already a pending, due'd turn for this
 * chore?) rather than local state, so the button resets on its own once that
 * turn is completed and a fresh unflagged one is queued behind it — local
 * state would otherwise stay stuck on "Flagged" forever since the chore's key
 * never changes across a refresh.
 */
export function KioskFlagButton({
  choreId,
  emoji,
  label,
  flagged,
}: {
  choreId: string;
  emoji: string;
  label: string;
  flagged: boolean;
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={!actingId || pending || flagged}
      onClick={() => {
        if (!actingId) return;
        start(async () => {
          const res = await kioskFlagChore(choreId, actingId);
          if (res.ok) router.refresh();
        });
      }}
      className={cx(
        'flex flex-col items-center justify-center gap-1.5 p-4 rounded-lg',
        'border border-line bg-card transition-colors duration-[120ms]',
        'hover:bg-hover active:bg-sunken disabled:opacity-50',
      )}
    >
      <span className="text-2xl" aria-hidden>{emoji}</span>
      <span className="t-body-sm font-medium text-ink text-center leading-tight">
        {pending ? 'Flagging…' : flagged ? 'Flagged' : label}
      </span>
    </button>
  );
}

/* ------------------------------------------------------------- admin-only */

/** Only renders its controls when the acting member is an admin. */
export function KioskSwapRow({
  swapId,
  choreName,
  fromName,
  adminIds,
}: {
  swapId: string;
  choreName: string;
  fromName: string;
  adminIds: string[];
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [resolved, setResolved] = useState<null | boolean>(null);
  const canAnswer = !!actingId && adminIds.includes(actingId);

  if (resolved !== null) {
    return (
      <Card className="p-3.5">
        <p className="t-body-md text-ink-2">{resolved ? `Took ${choreName}.` : 'Declined.'}</p>
      </Card>
    );
  }

  return (
    <Card className="p-3.5">
      <p className="t-body-md text-ink">
        <strong className="font-semibold">{fromName}</strong> wants to swap{' '}
        <strong className="font-semibold">{choreName}</strong>.
      </p>
      <div className="flex gap-2 mt-3">
        <button
          type="button"
          disabled={!canAnswer || pending}
          onClick={() => {
            if (!actingId) return;
            start(async () => {
              const res = await kioskRespondSwap(swapId, actingId, true);
              if (res.ok) { setResolved(true); router.refresh(); }
            });
          }}
          className="px-3 py-1.5 rounded-md bg-blue dark:bg-maize text-white dark:text-ink t-body-sm font-medium disabled:opacity-40"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={!canAnswer || pending}
          onClick={() => {
            if (!actingId) return;
            start(async () => {
              const res = await kioskRespondSwap(swapId, actingId, false);
              if (res.ok) { setResolved(false); router.refresh(); }
            });
          }}
          className="px-3 py-1.5 rounded-md border border-line t-body-sm font-medium disabled:opacity-40"
        >
          Deny
        </button>
        {!canAnswer && (
          <span className="t-body-sm text-ink-muted self-center">Admin only</span>
        )}
      </div>
    </Card>
  );
}

/** Only renders when the acting member is an admin. */
export function KioskMessageDismiss({
  messageId,
  adminIds,
}: {
  messageId: string;
  adminIds: string[];
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dismissed, setDismissed] = useState(false);
  const canDismiss = !!actingId && adminIds.includes(actingId);

  if (dismissed || !canDismiss) return null;

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!actingId) return;
        start(async () => {
          const res = await kioskDismissMessage(messageId, actingId);
          if (res.ok) { setDismissed(true); router.refresh(); }
        });
      }}
      aria-label="Clear this note"
      className="shrink-0 w-6 h-6 grid place-items-center rounded-pill text-ink-muted hover:bg-hover disabled:opacity-50"
    >
      <Icon.Close size={16} />
    </button>
  );
}

/** Only renders when the acting member is an admin. */
export function KioskChoreToggle({
  choreId,
  emoji,
  name,
  adminIds,
}: {
  choreId: string;
  emoji: string;
  name: string;
  adminIds: string[];
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [hidden, setHidden] = useState(false);
  const canToggle = !!actingId && adminIds.includes(actingId);

  if (hidden) return null;
  if (!canToggle) return null;

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!actingId) return;
        start(async () => {
          const res = await kioskSetChoreActive(choreId, actingId, false);
          if (res.ok) { setHidden(true); router.refresh(); }
        });
      }}
      className="flex items-center gap-2 px-3 py-1.5 rounded-pill border border-line bg-card t-body-sm text-ink-muted hover:bg-hover disabled:opacity-50"
    >
      <span aria-hidden>{emoji}</span>
      Retire {name}
    </button>
  );
}

/* ---------------------------------------------------------------- lately */

/**
 * One row of the kiosk's "Lately" feed. `undoable` is computed server-side
 * from whether the referenced turn is still sitting in the state this entry
 * describes (see kiosk.ts's turnStatus map) — mirrors the Activity page's
 * ActivityRow, but acts through the kiosk's "acting as" profile instead of a
 * session, so it needs actingId and only enables once someone's tapped in.
 */
export function KioskActivityRow({
  turnId,
  summary,
  timeLabel,
  actor,
  undoable,
}: {
  turnId: string | null;
  summary: string;
  timeLabel: string;
  actor: { initials: string; color: string } | null;
  undoable: boolean;
}) {
  const { actingId } = useActingAs();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [undone, setUndone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      {actor ? (
        <Initials initials={actor.initials} color={actor.color} size="sm" />
      ) : (
        <span className="w-6" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className={cx('t-body-md leading-snug', undone ? 'text-ink-muted' : 'text-ink')}>
          {undone ? 'Back on the board.' : summary}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <p className="t-caption text-ink-muted">{timeLabel}</p>
          {error && <p className="t-caption text-danger">{error}</p>}
        </div>
      </div>
      {undoable && !undone && turnId && (
        <button
          type="button"
          disabled={!actingId || pending}
          onClick={() => {
            if (!actingId) return;
            setError(null);
            start(async () => {
              const res = await kioskUndoTurn(turnId, actingId);
              if (res.ok) { setUndone(true); router.refresh(); }
              else setError(res.error);
            });
          }}
          aria-label={
            actingId ? `Undo: ${summary}` : `Tap your name above first to undo: ${summary}`
          }
          className="t-body-sm font-medium text-accent shrink-0 disabled:opacity-50"
        >
          Undo
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- weather */

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function compassLabel(degrees: number): string {
  return COMPASS[Math.round(degrees / 22.5) % 16];
}

function uvLabel(uvIndex: number): string {
  if (uvIndex >= 11) return 'Extreme';
  if (uvIndex >= 8) return 'Very high';
  if (uvIndex >= 6) return 'High';
  if (uvIndex >= 3) return 'Moderate';
  return 'Low';
}

/** Tap the header's weather readout to open a full dashboard — hourly and
 * 7-day forecasts plus everything getWeather() fetches but the collapsed
 * header has no room for. Purely local UI state; nothing here touches the
 * server. */
export function KioskWeather({ weather }: { weather: Weather }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label="Show detailed weather"
        className="text-right rounded-lg -m-2 p-2 transition-colors duration-[120ms] hover:bg-hover active:bg-sunken"
      >
        <p className="t-display-lg text-ink leading-none">
          <span aria-hidden>{weather.emoji}</span> {weather.tempF}°
        </p>
        <p className="t-body-md text-ink-muted mt-1">{weather.label}</p>
      </button>

      {open && <KioskWeatherModal weather={weather} onClose={() => setOpen(false)} />}
    </>
  );
}

function KioskWeatherModal({ weather, onClose }: { weather: Weather; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const dayLows = weather.daily.map((d) => d.lowF);
  const dayHighs = weather.daily.map((d) => d.highF);
  const weekMin = dayLows.length ? Math.min(...dayLows) : 0;
  const weekMax = dayHighs.length ? Math.max(...dayHighs) : 1;
  const weekSpan = Math.max(1, weekMax - weekMin);

  return (
    <div
      className="fixed inset-0 z-[60] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <Card
        className="w-full max-w-md max-h-[85vh] overflow-y-auto p-5 shadow-lg text-left"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Detailed weather"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="t-display-lg text-ink leading-none">
              <span aria-hidden>{weather.emoji}</span> {weather.tempF}°
            </p>
            <p className="t-body-md text-ink-muted mt-1">
              {weather.label} · H:{weather.highF}° L:{weather.lowF}°
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detailed weather"
            className="w-8 h-8 grid place-items-center rounded-pill text-ink-muted hover:bg-hover shrink-0"
          >
            <Icon.Close size={18} />
          </button>
        </div>

        {weather.hourly.length > 0 && (
          <div className="mt-5 pt-4 border-t border-line">
            <p className="t-label text-ink-muted mb-3">Hourly forecast</p>
            <div className="flex gap-4 overflow-x-auto pb-1 -mx-1 px-1">
              {weather.hourly.map((h, i) => (
                <div key={i} className="flex flex-col items-center gap-1.5 shrink-0 w-12">
                  <p className="t-caption text-ink-muted">{h.hourLabel}</p>
                  <span className="text-xl" aria-hidden>{h.emoji}</span>
                  <p className="t-caption text-accent h-4">{h.precipChance > 0 ? `${h.precipChance}%` : ''}</p>
                  <p className="t-body-sm font-medium text-ink tabular-nums">{h.tempF}°</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {weather.daily.length > 0 && (
          <div className="mt-5 pt-4 border-t border-line">
            <p className="t-label text-ink-muted mb-2">7-day forecast</p>
            <div className="divide-y divide-[var(--border-subtle)]">
              {weather.daily.map((d, i) => {
                const leftPct = ((d.lowF - weekMin) / weekSpan) * 100;
                const widthPct = ((d.highF - d.lowF) / weekSpan) * 100;
                return (
                  <div key={i} className="flex items-center gap-3 py-2.5">
                    <p className="t-body-sm font-medium text-ink w-10 shrink-0">{d.weekday}</p>
                    <span className="text-lg w-6 text-center shrink-0" aria-hidden>{d.emoji}</span>
                    <p className="t-caption text-accent w-9 shrink-0 text-right">
                      {d.precipChance > 0 ? `${d.precipChance}%` : ''}
                    </p>
                    <p className="t-body-sm text-ink-muted w-7 shrink-0 text-right tabular-nums">{d.lowF}°</p>
                    <div className="flex-1 h-1 rounded-pill bg-sunken relative">
                      <div
                        className="absolute inset-y-0 rounded-pill bg-accent"
                        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      />
                    </div>
                    <p className="t-body-sm font-medium text-ink w-7 shrink-0 text-right tabular-nums">{d.highF}°</p>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-line grid grid-cols-2 gap-3">
          <WeatherTile icon={<Icon.Sun size={16} />} label="UV index" value={`${weather.uvIndex} · ${uvLabel(weather.uvIndex)}`} />
          <WeatherTile icon={<span aria-hidden>💧</span>} label="Humidity" value={`${weather.humidity}%`} />
          <WeatherTile
            icon={<span aria-hidden>💨</span>}
            label="Wind"
            value={`${weather.windMph} mph ${compassLabel(weather.windDirection)}`}
          />
          <WeatherTile icon={<span aria-hidden>🌡️</span>} label="Feels like" value={`${weather.feelsLikeF}°`} />
          <WeatherTile icon={<Icon.Sun size={16} />} label="Sunrise" value={weather.sunrise} />
          <WeatherTile icon={<Icon.Moon size={16} />} label="Sunset" value={weather.sunset} />
        </div>
      </Card>
    </div>
  );
}

function WeatherTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-sunken p-3">
      <p className="t-caption text-ink-muted flex items-center gap-1.5">
        {icon} {label}
      </p>
      <p className="t-title-md text-ink mt-1 tabular-nums">{value}</p>
    </div>
  );
}
