import { NextResponse, type NextRequest } from 'next/server';
import { createAdminClient } from '@/lib/supabase/server';
import { notifyProfiles } from '@/lib/push';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authorized(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization');
  return header === `Bearer ${secret}`;
}

/**
 * Runs a few times a day (see vercel.json). Three jobs:
 *   1. keep scheduled turns materialized out to each chore's lookahead
 *   2. keep on-demand queues topped up
 *   3. nudge whoever has something due today, once, respecting quiet hours
 */
export async function GET(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const report = { materialized: 0, queued: 0, notified: 0, missed: 0, recurringPosted: 0 };

  const { data: chores } = await admin
    .from('chores')
    .select('id, cadence, name, emoji, household_id')
    .eq('is_active', true)
    .returns<{ id: string; cadence: 'scheduled' | 'on_demand'; name: string; emoji: string; household_id: string }[]>();

  for (const chore of chores ?? []) {
    if (chore.cadence === 'scheduled') {
      const { data } = await admin.rpc('materialize_schedule', { p_chore: chore.id });
      report.materialized += Number(data ?? 0);
    } else {
      const { data } = await admin.rpc('top_up_queue', { p_chore: chore.id });
      report.queued += Number(data ?? 0);
    }
  }

  // Rent, subscriptions, etc — post straight to the ledger, then notify
  // participants exactly like addExpense does for a one-off expense. The
  // plpgsql side stays limited to the atomic insert + activity_log entry;
  // web-push only exists here in TypeScript.
  const { data: posted } = await admin.rpc('post_due_recurring_expenses');
  report.recurringPosted = posted?.length ?? 0;

  for (const expense of posted ?? []) {
    const [{ data: splits }, { data: payer }] = await Promise.all([
      admin
        .from('expense_splits')
        .select('profile_id, owed_cents')
        .eq('expense_id', expense.id)
        .returns<{ profile_id: string; owed_cents: number }[]>(),
      admin
        .from('profiles')
        .select('full_name')
        .eq('id', expense.paid_by)
        .single<{ full_name: string }>(),
    ]);

    await Promise.all(
      (splits ?? [])
        .filter((s) => s.profile_id !== expense.paid_by)
        .map((s) =>
          notifyProfiles([s.profile_id], {
            title: `${expense.description} — $${(expense.amount_cents / 100).toFixed(2)}`,
            body: `${payer?.full_name ?? 'Someone'} paid. Your share is $${(s.owed_cents / 100).toFixed(2)}.`,
            url: '/expenses',
            tag: `expense-${expense.id}`,
          }),
        ),
    );
  }

  // Anything scheduled that is more than a week past due is not getting done —
  // mark it missed so it stops shouting and starts counting against the tally.
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const { data: stale } = await admin
    .from('chore_turns')
    .update({ status: 'missed' })
    .eq('status', 'pending')
    .not('due_at', 'is', null)
    .lt('due_at', weekAgo.toISOString())
    .select('id');
  report.missed = stale?.length ?? 0;

  // Due today (or overdue, or waiting in an on-demand queue that got flagged).
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const { data: due } = await admin
    .from('chore_turns')
    .select('id, assignee_id, due_at, chore:chores ( name, emoji )')
    .eq('status', 'pending')
    .not('due_at', 'is', null)
    .lte('due_at', endOfDay.toISOString())
    .returns<{ id: string; assignee_id: string; due_at: string; chore: { name: string; emoji: string } }[]>();

  // One notification per person, listing everything — four separate buzzes for
  // four chores is how people turn notifications off.
  const byPerson = new Map<string, typeof due>();
  for (const turn of due ?? []) {
    const list = byPerson.get(turn.assignee_id) ?? [];
    list.push(turn);
    byPerson.set(turn.assignee_id, list);
  }

  for (const [profileId, turns] of byPerson) {
    if (!turns?.length) continue;
    const names = turns.map((t) => `${t.chore.emoji} ${t.chore.name}`).join(', ');
    const result = await notifyProfiles([profileId], {
      title: turns.length === 1 ? "You're up" : `${turns.length} chores on you`,
      body: names,
      url: '/',
      tag: 'daily-digest',
    });
    report.notified += result.sent;
  }

  return NextResponse.json({ ok: true, ...report });
}
