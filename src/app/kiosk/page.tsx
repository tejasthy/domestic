import { cookies } from 'next/headers';
import { kioskHousehold, loadKiosk, UNDOABLE_STATUS } from '@/lib/kiosk';
import { getWeather, geocodeHouseAddress } from '@/lib/weather';
import { Logo } from '@/components/brand';
import { Card, Initials, Pill, cx } from '@/components/ui';
import { ThemeToggle } from '@/components/theme-toggle';
import { THEME_COOKIE, parseThemeCookie } from '@/lib/theme';
import { formatCents } from '@/lib/money';
import { bucketFor, describeCadence } from '@/lib/rotation';
import { formatInTimeZone } from '@/lib/timezone';
import {
  KioskClock, AutoRefresh, ActingAsProvider, ActingAsBar,
  KioskTurnCard, KioskFlagButton, KioskSwapRow, KioskChoreToggle, KioskMessageDismiss,
  KioskActivityRow, KioskWeather,
} from './kiosk-client';

export const dynamic = 'force-dynamic';

export default async function KioskPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  const householdId = await kioskHousehold();

  if (!householdId) {
    return (
      <main className="min-h-dvh grid place-items-center bg-page px-8 text-center">
        <div>
          <Logo size={64} />
          <h1 className="t-title-lg text-ink mt-4">Kiosk not paired</h1>
          <p className="t-body-md text-ink-muted mt-2 max-w-sm">
            {error === 'bad_token'
              ? "That pairing link isn't valid — it may have been revoked. Generate a new one."
              : 'An admin can pair this display under Settings → Household → Wall display.'}
          </p>
        </div>
      </main>
    );
  }

  const data = await loadKiosk(householdId);
  if (!data) {
    return (
      <main className="min-h-dvh grid place-items-center bg-page">
        <p className="t-title-lg text-ink-muted">No household set up yet.</p>
      </main>
    );
  }

  const { household, members, chores, upNext, balances, activity, turnStatus, modules, swaps, messages } = data;
  const showChores = modules.includes('chores');
  const showMoney = modules.includes('expenses');
  const byId = new Map(members.map((m) => [m.id, m]));
  const adminIds = members.filter((m) => m.is_admin).map((m) => m.id);
  const flaggable = chores.filter((c) => c.cadence === 'on_demand' || c.cadence === 'standing');
  const upNextByChore = new Map(upNext.map((t) => [t.chore_id, t]));

  // An explicit Wall display location always wins; otherwise fall back to
  // geocoding the house's own address so weather works without a separate
  // admin step for the common case of "the weather where the house is."
  const weatherLocation =
    household.latitude != null && household.longitude != null
      ? { lat: household.latitude, lon: household.longitude }
      : household.address
        ? await geocodeHouseAddress(household.address)
        : null;
  const weather = weatherLocation ? await getWeather(weatherLocation.lat, weatherLocation.lon) : null;

  const theme = parseThemeCookie((await cookies()).get(THEME_COOKIE)?.value);

  // An on-demand chore's queued-but-unflagged turn (due_at null, bucket
  // 'anytime') is just holding a place in line, not yet needing doing — same
  // rule the main dashboard uses for "You're up". It only belongs in "Up now"
  // once someone flags it, which is what the kiosk's own Flag buttons do.
  // Standing chores have no due date at all and are always "up" for whoever
  // currently holds them.
  const urgent = upNext.filter((t) =>
    t.chore.cadence === 'standing' || ['overdue', 'today'].includes(bucketFor(t.due_at, household.timezone)),
  );
  const later = upNext.filter((t) => !urgent.includes(t));

  return (
    <ActingAsProvider>
      <main className="kiosk min-h-dvh bg-page p-8 select-none">
        <AutoRefresh seconds={5} />

        <header className="flex items-end justify-between mb-4">
          <div className="flex items-center gap-4">
            <Logo size={52} />
            <div>
              <h1 className="t-display-lg uppercase tracking-[0.12em] text-ink leading-none">
                Domestic
              </h1>
              <p className="t-body-md text-ink-muted mt-1">{household.name}</p>
            </div>
          </div>
          <div className="flex items-center gap-6">
            <ThemeToggle current={theme} compact />
            {weather && <KioskWeather weather={weather} />}
            <KioskClock timezone={household.timezone} />
          </div>
        </header>

        {messages.length > 0 && (
          <Card className="p-3.5 mb-6 divide-y divide-[var(--border-subtle)]">
            {messages.map((m) => {
              const author = m.author_id ? byId.get(m.author_id) : null;
              return (
                <div key={m.id} className="flex items-start gap-2 py-1.5 first:pt-0 last:pb-0">
                  <p className="t-body-md text-ink flex-1 min-w-0">
                    {author && <span className="font-semibold">{author.full_name.split(' ')[0]}: </span>}
                    {m.body}
                  </p>
                  <KioskMessageDismiss messageId={m.id} adminIds={adminIds} />
                </div>
              );
            })}
          </Card>
        )}

        <div className="mb-6">
          <ActingAsBar members={members} />
        </div>

        <div className="grid grid-cols-3 gap-6">
          {/* Who's up — the whole point of the wall display */}
          <section className={showChores ? 'col-span-2' : 'hidden'}>
            <h2 className="t-label text-ink-muted mb-3">Up now</h2>
            <div className="grid grid-cols-2 gap-4">
              {urgent.map((t) => {
                const standing = t.chore.cadence === 'standing';
                const flagged = standing && t.flagged_at != null;
                const bucket = bucketFor(t.due_at, household.timezone);
                return (
                  <KioskTurnCard
                    key={t.id}
                    turnId={t.id}
                    choreName={t.chore.name}
                    className={cx('p-5', flagged && 'ring-2 ring-maize bg-maize/[0.06]')}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-5xl" aria-hidden>{t.chore.emoji}</span>
                      <Pill
                        tone={
                          flagged ? 'accent'
                          : standing ? 'accent'
                          : bucket === 'overdue' ? 'danger'
                          : bucket === 'today' ? 'warning'
                          : 'neutral'
                        }
                      >
                        {flagged ? 'Flagged'
                          : standing ? 'Your turn'
                          : bucket === 'overdue' ? 'Overdue'
                          : bucket === 'today' ? 'Today'
                          : 'Whenever'}
                      </Pill>
                    </div>
                    <p className="t-title-lg text-ink mt-3">{t.chore.name}</p>
                    <div className="flex items-center gap-3 mt-4">
                      <Initials
                        initials={t.assignee.initials}
                        color={t.assignee.color}
                        size="lg"
                      />
                      <span className="t-title-md text-ink">
                        {t.assignee.full_name.split(' ')[0]}
                      </span>
                    </div>
                  </KioskTurnCard>
                );
              })}

              {urgent.length === 0 && (
                <Card className="col-span-2 p-10 text-center">
                  <p className="text-6xl mb-3" aria-hidden>✨</p>
                  <p className="t-title-lg text-ink">The house is caught up</p>
                </Card>
              )}
            </div>

            {flaggable.length > 0 && (
              <>
                <h2 className="t-label text-ink-muted mt-8 mb-3">Flag something</h2>
                <div className="grid grid-cols-3 gap-3">
                  {flaggable.map((c) => (
                    <KioskFlagButton
                      key={c.id}
                      choreId={c.id}
                      emoji={c.emoji}
                      label={c.name}
                      flagged={
                        c.cadence === 'standing'
                          ? upNextByChore.get(c.id)?.flagged_at != null
                          : upNextByChore.get(c.id)?.due_at != null
                      }
                    />
                  ))}
                </div>
              </>
            )}

            {swaps.length > 0 && (
              <>
                <h2 className="t-label text-ink-muted mt-8 mb-3">Swap requests</h2>
                <div className="space-y-2">
                  {swaps.map((s) => (
                    <KioskSwapRow
                      key={s.id}
                      swapId={s.id}
                      choreName={s.chore_name}
                      fromName={s.requester_name.split(' ')[0]}
                      adminIds={adminIds}
                    />
                  ))}
                </div>
              </>
            )}

            {later.length > 0 && (
              <>
                <h2 className="t-label text-ink-muted mt-8 mb-3">Coming up</h2>
                <Card className="divide-y divide-[var(--border-subtle)]">
                  {later.map((t) => (
                    <div key={t.id} className="flex items-center gap-4 px-5 py-3.5">
                      <span className="text-3xl w-10 text-center" aria-hidden>
                        {t.chore.emoji}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="t-body-lg text-ink">{t.chore.name}</p>
                        <p className="t-body-md text-ink-muted">
                          {describeCadence(t.chore)}
                        </p>
                      </div>
                      <Initials
                        initials={t.assignee.initials}
                        color={t.assignee.color}
                        size="md"
                      />
                      <span className="t-body-md text-ink-muted w-28 text-right">
                        {t.due_at
                          ? formatInTimeZone(t.due_at, household.timezone, {
                              weekday: 'short',
                              month: 'short',
                              day: 'numeric',
                            })
                          : '—'}
                      </span>
                      <KioskChoreToggle
                        choreId={t.chore_id}
                        emoji={t.chore.emoji}
                        name={t.chore.name}
                        adminIds={adminIds}
                      />
                    </div>
                  ))}
                </Card>
              </>
            )}
          </section>

          {/* Money + feed */}
          <section className={cx('space-y-6', showChores ? '' : 'col-span-3')}>
            <div className={showMoney ? '' : 'hidden'}>
              <h2 className="t-label text-ink-muted mb-3">Balances</h2>
              <Card className="divide-y divide-[var(--border-subtle)]">
                {members.map((m) => {
                  const net = balances[m.id] ?? 0;
                  return (
                    <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                      <Initials initials={m.initials} color={m.color} size="md" />
                      <span className="t-body-lg text-ink flex-1 min-w-0 truncate">
                        {m.full_name.split(' ')[0]}
                      </span>
                      <span
                        className={`t-body-lg font-semibold tabular-nums ${
                          net > 0 ? 'text-success' : net < 0 ? 'text-danger' : 'text-ink-muted'
                        }`}
                      >
                        {net === 0
                          ? '—'
                          : `${net > 0 ? '+' : '−'}${formatCents(Math.abs(net))}`}
                      </span>
                    </div>
                  );
                })}
              </Card>
            </div>

            <div>
              <h2 className="t-label text-ink-muted mb-3">Lately</h2>
              <Card className="divide-y divide-[var(--border-subtle)]">
                {activity.length === 0 && (
                  <p className="px-4 py-5 t-body-md text-ink-muted">Nothing yet.</p>
                )}
                {activity.map((a) => {
                  const actor = a.actor_id ? byId.get(a.actor_id) : null;
                  const turnId = typeof a.metadata.turn_id === 'string' ? a.metadata.turn_id : null;
                  const undoable =
                    turnId !== null && turnStatus[turnId] === UNDOABLE_STATUS[a.verb];
                  return (
                    <KioskActivityRow
                      key={a.id}
                      turnId={turnId}
                      summary={a.summary}
                      undoable={undoable}
                      actor={actor ? { initials: actor.initials, color: actor.color } : null}
                      timeLabel={formatInTimeZone(a.created_at, household.timezone, {
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    />
                  );
                })}
              </Card>
            </div>
          </section>
        </div>
      </main>
    </ActingAsProvider>
  );
}
