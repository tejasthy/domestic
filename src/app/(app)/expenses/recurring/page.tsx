import Link from 'next/link';
import { getRecurringExpenses, requireModule } from '@/lib/data';
import { Card, EmptyState, LinkButton, Pill } from '@/components/ui';
import { Icon } from '@/components/brand';
import { formatCents } from '@/lib/money';
import type { RecurringExpense } from '@/lib/types';

export const dynamic = 'force-dynamic';

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Human description of a recurring expense's schedule. Not meant to cover
 * every combination the data model allows — just the four presets the form
 * offers. */
function cadenceLabel(re: RecurringExpense): string {
  if (re.cadence === 'weekly') {
    return re.interval_weeks <= 1 ? 'Weekly' : `Every ${re.interval_weeks} weeks`;
  }
  const day = re.day_of_month ? ` on the ${ordinal(re.day_of_month)}` : '';
  if (re.interval_months >= 3) return `Quarterly${day}`;
  if (re.interval_months <= 1) return `Monthly${day}`;
  return `Every ${re.interval_months} months${day}`;
}

export default async function RecurringExpensesPage() {
  const session = await requireModule('expenses');
  const { me, members } = session;
  const byId = new Map(members.map((m) => [m.id, m]));

  const recurring = await getRecurringExpenses();

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <Link href="/expenses" className="t-body-sm text-accent font-medium">
          ← Money
        </Link>
      </div>

      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="t-display-lg text-ink">Recurring</h1>
          <p className="t-body-md text-ink-muted mt-0.5">
            Rent, subscriptions, anything that posts itself.
          </p>
        </div>
        {me.is_admin && (
          <LinkButton href="/expenses/recurring/new" size="md">
            <Icon.Plus size={18} />
            Add
          </LinkButton>
        )}
      </header>

      {recurring.length === 0 ? (
        <Card>
          <EmptyState
            emoji="🔁"
            title="Nothing set up yet"
            hint="Rent, streaming, anything on a schedule can post itself here."
          />
        </Card>
      ) : (
        <Card className="divide-y divide-[var(--border-subtle)]">
          {recurring.map((re) => {
            const payer = byId.get(re.paid_by);
            const nextDate = new Date(re.next_run_on + 'T12:00:00').toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            });
            return (
              <div key={re.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="t-body-md text-ink truncate">{re.description}</p>
                    {!re.is_active && <Pill tone="neutral">paused</Pill>}
                  </div>
                  <p className="t-body-sm text-ink-muted">
                    {formatCents(re.amount_cents)} · {cadenceLabel(re)}
                    {payer && ` · ${payer.id === me.id ? 'you' : payer.full_name.split(' ')[0]} pays`}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="t-body-sm text-ink-muted">Next {nextDate}</p>
                  {me.is_admin && (
                    <Link
                      href={`/expenses/recurring/${re.id}`}
                      className="t-body-sm text-accent font-medium"
                    >
                      Edit
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
