import Link from 'next/link';
import { getExpenses, getBalances, getSettlements, requireModule } from '@/lib/data';
import { Card, SectionHeader, Initials, LinkButton, EmptyState, Pill } from '@/components/ui';
import { Icon } from '@/components/brand';
import { formatCents, simplifyDebts } from '@/lib/money';
import { formatCalendarDate } from '@/lib/timezone';
import { SettleUpButton } from './settle-up';
import { ExpenseRowActions } from './expense-row-actions';
import { SettlementRowActions } from './settlement-row-actions';

export const dynamic = 'force-dynamic';

export default async function ExpensesPage() {
  const session = await requireModule('expenses');
  const { me, members } = session;

  const [expenses, balances, settlements] = await Promise.all([
    getExpenses(),
    getBalances(),
    getSettlements(8),
  ]);

  const byId = new Map(members.map((m) => [m.id, m]));
  const transfers = simplifyDebts(balances);
  const myTransfers = transfers.filter((t) => t.from === me.id || t.to === me.id);
  const myBalance = balances[me.id] ?? 0;

  return (
    <div className="space-y-7 max-w-2xl">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="t-display-lg text-ink">Money</h1>
          <p className="t-body-md text-ink-muted mt-0.5">
            Shared costs for the house.
          </p>
          <Link href="/expenses/recurring" className="t-body-sm text-accent font-medium mt-1 inline-block">
            Manage recurring →
          </Link>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <LinkButton href="/expenses/pay" size="md" tone="secondary">
            <Icon.Swap size={18} />
            Record payment
          </LinkButton>
          <LinkButton href="/expenses/new" size="md">
            <Icon.Plus size={18} />
            Add
          </LinkButton>
        </div>
      </header>

      {/* Balance board */}
      <Card className="p-4">
        <p className="t-label text-ink-muted">Your balance</p>
        <p
          className={`t-display-xl mt-1 ${
            myBalance > 0 ? 'text-success' : myBalance < 0 ? 'text-danger' : 'text-ink'
          }`}
        >
          {myBalance === 0 ? 'Settled' : formatCents(Math.abs(myBalance))}
        </p>
        <p className="t-body-md text-ink-muted">
          {myBalance > 0
            ? 'you are owed'
            : myBalance < 0
              ? 'you owe'
              : 'all square'}
        </p>

        <div className="mt-4 pt-4 border-t border-subtle grid grid-cols-2 gap-3">
          {members.map((m) => {
            const net = balances[m.id] ?? 0;
            return (
              <div key={m.id} className="flex items-center gap-2.5 min-w-0">
                <Initials initials={m.initials} color={m.color} size="md" />
                <div className="min-w-0">
                  <p className="t-body-sm text-ink truncate">
                    {m.full_name.split(' ')[0]}
                  </p>
                  <p
                    className={`t-body-sm font-semibold tabular-nums ${
                      net > 0 ? 'text-success' : net < 0 ? 'text-danger' : 'text-ink-muted'
                    }`}
                  >
                    {net === 0 ? 'settled' : `${net > 0 ? '+' : '−'}${formatCents(Math.abs(net))}`}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Settle up — the fewest transfers that clear everyone */}
      {transfers.length > 0 && (
        <section>
          <SectionHeader title={`Settle up · ${transfers.length} transfer${transfers.length === 1 ? '' : 's'}`} />
          <div className="space-y-2">
            {transfers.map((t, i) => {
              const from = byId.get(t.from);
              const to = byId.get(t.to);
              if (!from || !to) return null;
              const involvesMe = t.from === me.id || t.to === me.id;
              return (
                <Card key={i} className={`p-3.5 ${involvesMe ? 'border-maize' : ''}`}>
                  <div className="flex items-center gap-3">
                    <Initials initials={from.initials} color={from.color} size="md" />
                    <span className="text-ink-muted" aria-hidden>→</span>
                    <Initials initials={to.initials} color={to.color} size="md" />
                    <div className="min-w-0 flex-1">
                      <p className="t-body-md text-ink">
                        {t.from === me.id ? 'You pay' : `${from.full_name.split(' ')[0]} pays`}{' '}
                        {t.to === me.id ? 'you' : to.full_name.split(' ')[0]}
                      </p>
                      <p className="t-title-md text-ink font-semibold tabular-nums">
                        {formatCents(t.cents)}
                      </p>
                    </div>
                    {involvesMe && (
                      <SettleUpButton
                        fromId={t.from}
                        toId={t.to}
                        amount={(t.cents / 100).toFixed(2)}
                      />
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
          {myTransfers.length === 0 && (
            <p className="t-body-sm text-ink-muted mt-2">
              None of these involve you.
            </p>
          )}
        </section>
      )}

      {/* Ledger */}
      <section>
        <SectionHeader title="Expenses" />
        {expenses.length === 0 ? (
          <Card>
            <EmptyState
              emoji="🧾"
              title="Nothing logged yet"
              hint="Snap a receipt and it fills itself in."
            />
          </Card>
        ) : (
          <Card className="divide-y divide-[var(--border-subtle)]">
            {expenses.map((e) => {
              const myShare = e.splits.find((s) => s.profile_id === me.id)?.owed_cents ?? 0;
              const iPaid = e.paid_by === me.id;
              const itemCount = e.items.length;

              const summary = (
                <div className="flex items-center gap-3 px-4 py-3">
                  <Initials
                    initials={e.payer.initials}
                    color={e.payer.color}
                    size="md"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="t-body-md text-ink truncate">{e.description}</p>
                    <p className="t-body-sm text-ink-muted">
                      {iPaid ? 'You' : e.payer.full_name.split(' ')[0]} paid{' '}
                      {formatCents(e.amount_cents)} ·{' '}
                      {formatCalendarDate(e.spent_on, { month: 'short', day: 'numeric' })}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p
                      className={`t-body-md font-semibold tabular-nums ${
                        iPaid ? 'text-success' : myShare > 0 ? 'text-danger' : 'text-ink-muted'
                      }`}
                    >
                      {iPaid
                        ? `+${formatCents(e.amount_cents - myShare)}`
                        : myShare > 0
                          ? `−${formatCents(myShare)}`
                          : '—'}
                    </p>
                    <div className="flex items-center gap-1 justify-end mt-0.5">
                      {itemCount > 0 && (
                        <Pill tone="accent">{itemCount} item{itemCount === 1 ? '' : 's'}</Pill>
                      )}
                      {e.receipt_url && <Pill tone="neutral">receipt</Pill>}
                    </div>
                  </div>
                </div>
              );

              if (itemCount === 0) {
                return (
                  <div key={e.id}>
                    {summary}
                    <div className="px-4 pb-3 -mt-1">
                      <ExpenseRowActions expenseId={e.id} />
                    </div>
                  </div>
                );
              }

              return (
                <details key={e.id}>
                  <summary className="block cursor-pointer list-none [&::-webkit-details-marker]:hidden marker:hidden">
                    {summary}
                  </summary>
                  <div className="px-4 pb-3 pl-[4.25rem] -mt-1 space-y-1.5">
                    {e.items.map((item) => (
                      <div key={item.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                        <span className="t-body-sm text-ink-muted min-w-0 break-words">
                          {item.name}
                          {item.kind !== 'item' && ` · ${item.kind}`}
                        </span>
                        <span className="t-body-sm text-ink-2 tabular-nums min-w-0 text-right break-words">
                          {formatCents(item.amount_cents)}
                          {' — '}
                          {item.item_splits
                            .map((s) => {
                              const p = byId.get(s.profile_id);
                              const who = p ? (p.id === me.id ? 'You' : p.full_name.split(' ')[0]) : '?';
                              return `${who} ${formatCents(s.owed_cents)}`;
                            })
                            .join(', ')}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="px-4 pb-3 pl-[4.25rem] -mt-1">
                    <ExpenseRowActions expenseId={e.id} />
                  </div>
                </details>
              );
            })}
          </Card>
        )}
      </section>

      {settlements.length > 0 && (
        <section>
          <SectionHeader title="Payments" />
          <Card className="divide-y divide-[var(--border-subtle)]">
            {settlements.map((s) => {
              const from = byId.get(s.from_profile);
              const to = byId.get(s.to_profile);
              return (
                <div key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="t-body-md text-ink truncate">
                      {from?.full_name.split(' ')[0]} → {to?.full_name.split(' ')[0]}
                    </p>
                    {s.note && (
                      <p className="t-body-sm text-ink-muted truncate">{s.note}</p>
                    )}
                  </div>
                  <span className="t-body-md text-ink font-semibold tabular-nums shrink-0">
                    {formatCents(s.amount_cents)}
                  </span>
                  <span className="t-body-sm text-ink-muted w-14 text-right shrink-0">
                    {formatCalendarDate(s.settled_on, { month: 'short', day: 'numeric' })}
                  </span>
                  <SettlementRowActions settlementId={s.id} />
                </div>
              );
            })}
          </Card>
        </section>
      )}
    </div>
  );
}
