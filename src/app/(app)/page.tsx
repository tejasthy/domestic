import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getSession, getChores, getOpenTurns, getBalances } from '@/lib/data';
import { TurnRow, FlagButton, SwapRequestRow } from '@/components/turn-card';
import { Card, EmptyState, SectionHeader, Initials } from '@/components/ui';
import { formatCents } from '@/lib/money';
import { bucketFor } from '@/lib/rotation';

export const dynamic = 'force-dynamic';

function greeting(name: string, tz: string) {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hour12: false })
      .format(new Date()),
  );
  const part = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  return `${part}, ${name}`;
}

export default async function TodayPage() {
  const session = await getSession();
  if (!session?.me || !session.household) return null;
  const { me, household, members, modules } = session;
  const showChores = modules.includes('chores');
  const showMoney = modules.includes('expenses');

  const supabase = await createClient();
  const [chores, turns, balances, { data: swaps }] = await Promise.all([
    showChores ? getChores() : Promise.resolve([]),
    showChores ? getOpenTurns() : Promise.resolve([]),
    showMoney ? getBalances() : Promise.resolve<Record<string, number>>({}),
    supabase
      .from('chore_swaps')
      .select(`
        id, message,
        requester:profiles!chore_swaps_requested_by_fkey ( full_name ),
        turn:chore_turns!inner ( id, chore:chores ( name ) )
      `)
      .eq('requested_to', me.id)
      .eq('status', 'pending')
      .limit(showChores ? 20 : 0)
      .returns<{ id: string; message: string | null; requester: { full_name: string }; turn: { chore: { name: string } } }[]>(),
  ]);

  const mine = turns.filter((t) => t.assignee_id === me.id);
  const mineNow = mine.filter((t) => ['overdue', 'today', 'anytime'].includes(bucketFor(t.due_at)));
  const mineLater = mine.filter((t) => !mineNow.includes(t));
  const theirs = turns.filter((t) => t.assignee_id !== me.id);

  const onDemand = chores.filter((c) => c.cadence === 'on_demand');
  const myBalance = balances[me.id] ?? 0;

  return (
    <div className="space-y-7 max-w-2xl">
      <header>
        <h1 className="t-display-lg text-ink">
          {greeting(me.full_name.split(' ')[0], household.timezone)}
        </h1>
        <p className="t-body-md text-ink-muted mt-0.5">
          {!showChores
            ? household.name
            : mineNow.length === 0
              ? "You're square with the house."
              : `${mineNow.length} thing${mineNow.length === 1 ? '' : 's'} on you.`}
        </p>
      </header>

      {(swaps ?? []).length > 0 && (
        <section>
          <SectionHeader title="Needs an answer" />
          <div className="space-y-2">
            {(swaps ?? []).map((s) => (
              <SwapRequestRow
                key={s.id}
                swapId={s.id}
                choreName={s.turn.chore.name}
                fromName={s.requester.full_name.split(' ')[0]}
                message={s.message}
              />
            ))}
          </div>
        </section>
      )}

      {showChores && (
      <section>
        <SectionHeader title="You're up" />
        {mineNow.length === 0 ? (
          <Card>
            <EmptyState
              emoji="🎉"
              title="Nothing on you right now"
              hint="The rotation will come back around."
            />
          </Card>
        ) : (
          <div className="space-y-2">
            {mineNow.map((t) => (
              <TurnRow key={t.id} turn={t} mine />
            ))}
          </div>
        )}
      </section>
      )}

      {onDemand.length > 0 && (
        <section>
          <SectionHeader title="Flag something" />
          <div className="grid grid-cols-2 gap-2">
            {onDemand.map((c) => (
              <FlagButton
                key={c.id}
                choreId={c.id}
                emoji={c.emoji}
                label={c.description ?? c.name}
              />
            ))}
          </div>
        </section>
      )}

      {theirs.length > 0 && (
        <section>
          <SectionHeader
            title="Everyone else"
            action={
              <Link href="/chores" className="t-body-sm text-accent font-medium">
                All chores
              </Link>
            }
          />
          <div className="space-y-2">
            {theirs.slice(0, 6).map((t) => (
              <TurnRow key={t.id} turn={t} mine={false} />
            ))}
          </div>
        </section>
      )}

      {mineLater.length > 0 && (
        <section>
          <SectionHeader title="Coming up for you" />
          <div className="space-y-2">
            {mineLater.map((t) => (
              <TurnRow key={t.id} turn={t} mine={false} />
            ))}
          </div>
        </section>
      )}

      {showMoney && (
      <section>
        <SectionHeader
          title="Money"
          action={
            <Link href="/expenses" className="t-body-sm text-accent font-medium">
              Details
            </Link>
          }
        />
        <Card className="p-4">
          <p className="t-label text-ink-muted">Your balance</p>
          <p
            className={`t-display-lg mt-1 ${
              myBalance > 0 ? 'text-success' : myBalance < 0 ? 'text-danger' : 'text-ink'
            }`}
          >
            {myBalance === 0 ? 'Settled' : formatCents(Math.abs(myBalance))}
          </p>
          <p className="t-body-sm text-ink-muted">
            {myBalance > 0
              ? 'The house owes you'
              : myBalance < 0
                ? 'You owe the house'
                : 'Nobody owes anybody'}
          </p>

          <div className="flex flex-wrap gap-3 mt-4 pt-4 border-t border-subtle">
            {members.map((m) => {
              const net = balances[m.id] ?? 0;
              return (
                <div key={m.id} className="flex items-center gap-2">
                  <Initials initials={m.initials} color={m.color} size="sm" />
                  <span
                    className={`t-body-sm font-medium ${
                      net > 0 ? 'text-success' : net < 0 ? 'text-danger' : 'text-ink-muted'
                    }`}
                  >
                    {net === 0 ? '—' : `${net > 0 ? '+' : '−'}${formatCents(Math.abs(net))}`}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      </section>
      )}

      {!showChores && !showMoney && (
        <Card>
          <EmptyState
            emoji="🧰"
            title="Nothing switched on yet"
            hint={
              me.is_admin
                ? 'Pick what this house tracks in Settings → Household.'
                : 'Ask an admin to turn something on in the house settings.'
            }
          />
        </Card>
      )}
    </div>
  );
}
