import { kioskHousehold, loadKiosk } from '@/lib/kiosk';
import { Logo } from '@/components/brand';
import { Card, Initials, Pill, cx } from '@/components/ui';
import { formatCents } from '@/lib/money';
import { bucketFor, describeCadence } from '@/lib/rotation';
import { KioskClock, AutoRefresh } from './kiosk-client';

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

  const { household, members, upNext, balances, activity, modules } = data;
  const showChores = modules.includes('chores');
  const showMoney = modules.includes('expenses');
  const byId = new Map(members.map((m) => [m.id, m]));

  const urgent = upNext.filter((t) =>
    ['overdue', 'today', 'anytime'].includes(bucketFor(t.due_at)),
  );
  const later = upNext.filter((t) => !urgent.includes(t));

  return (
    <main className="kiosk min-h-dvh bg-page p-8 select-none">
      <AutoRefresh seconds={45} />

      <header className="flex items-end justify-between mb-8">
        <div className="flex items-center gap-4">
          <Logo size={52} />
          <div>
            <h1 className="t-display-lg uppercase tracking-[0.12em] text-ink leading-none">
              Domestic
            </h1>
            <p className="t-body-md text-ink-muted mt-1">{household.name}</p>
          </div>
        </div>
        <KioskClock timezone={household.timezone} />
      </header>

      <div className="grid grid-cols-3 gap-6">
        {/* Who's up — the whole point of the wall display */}
        <section className={showChores ? 'col-span-2' : 'hidden'}>
          <h2 className="t-label text-ink-muted mb-3">Up now</h2>
          <div className="grid grid-cols-2 gap-4">
            {urgent.map((t) => {
              const bucket = bucketFor(t.due_at);
              return (
                <Card key={t.id} className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-5xl" aria-hidden>{t.chore.emoji}</span>
                    <Pill
                      tone={
                        bucket === 'overdue' ? 'danger'
                        : bucket === 'today' ? 'warning'
                        : 'neutral'
                      }
                    >
                      {bucket === 'overdue' ? 'Overdue'
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
                </Card>
              );
            })}

            {urgent.length === 0 && (
              <Card className="col-span-2 p-10 text-center">
                <p className="text-6xl mb-3" aria-hidden>✨</p>
                <p className="t-title-lg text-ink">The house is caught up</p>
              </Card>
            )}
          </div>

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
                        ? new Date(t.due_at).toLocaleDateString('en-US', {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                          })
                        : '—'}
                    </span>
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
                return (
                  <div key={a.id} className="flex items-start gap-3 px-4 py-3">
                    {actor ? (
                      <Initials initials={actor.initials} color={actor.color} size="sm" />
                    ) : (
                      <span className="w-6" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="t-body-md text-ink leading-snug">{a.summary}</p>
                      <p className="t-caption text-ink-muted mt-0.5">
                        {new Date(a.created_at).toLocaleTimeString('en-US', {
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                  </div>
                );
              })}
            </Card>
          </div>
        </section>
      </div>
    </main>
  );
}
