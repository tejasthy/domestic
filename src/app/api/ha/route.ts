import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createAdminClient } from '@/lib/supabase/server';
import { loadKiosk, resolveDeviceToken } from '@/lib/kiosk';
import { notifyProfiles } from '@/lib/push';
import { bucketFor } from '@/lib/rotation';

export const dynamic = 'force-dynamic';

/**
 * Home Assistant bridge.
 *
 * GET  -> a flat JSON snapshot for HA `rest` sensors. Home Assistant then
 *         exposes those sensors to HomeKit through its HomeKit Bridge, which
 *         is the only route to HomeKit that exists — Apple has no cloud API.
 * POST -> lets an HA automation or a HomeKit scene complete or flag a chore
 *         ("Hey Siri, the dishwasher is full").
 */

/**
 * Resolves the bearer token to the household that issued it. An admin creates
 * one under Settings → Household. There is no global token: a shared env var
 * cannot say *which* house it speaks for, which is fine for one household and
 * wrong for any other.
 */
async function householdFor(request: NextRequest): Promise<string | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  return resolveDeviceToken(header.slice(7).trim(), 'home_assistant');
}

export async function GET(request: NextRequest) {
  const householdId = await householdFor(request);
  if (!householdId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await loadKiosk(householdId);
  if (!data) return NextResponse.json({ error: 'No household' }, { status: 404 });

  // Don't publish sensors for components this house doesn't run.
  const hasChores = data.modules.includes('chores');
  const hasMoney = data.modules.includes('expenses');

  const byId = new Map(data.members.map((m) => [m.id, m]));
  const tz = data.household.timezone;
  const overdue = data.upNext.filter((t) => bucketFor(t.due_at, tz) === 'overdue');
  const today = data.upNext.filter((t) => bucketFor(t.due_at, tz) === 'today');

  return NextResponse.json({
    household: data.household.name,
    generated_at: new Date().toISOString(),
    modules: data.modules,

    // Scalars first — HA `rest` sensors bind to one value each.
    open_count: hasChores ? data.upNext.length : 0,
    overdue_count: hasChores ? overdue.length : 0,
    due_today_count: hasChores ? today.length : 0,

    chores: (hasChores ? data.upNext : []).map((t) => ({
      id: t.chore_id,
      name: t.chore.name,
      slug: t.chore.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
      emoji: t.chore.emoji,
      cadence: t.chore.cadence,
      turn_id: t.id,
      assignee: t.assignee.full_name,
      assignee_initials: t.assignee.initials,
      due_at: t.due_at,
      state: bucketFor(t.due_at, tz),
    })),

    people: data.members.map((m) => ({
      name: m.full_name,
      initials: m.initials,
      open_chores: hasChores
        ? data.upNext.filter((t) => t.assignee_id === m.id).length
        : 0,
      balance_dollars: hasMoney ? (data.balances[m.id] ?? 0) / 100 : 0,
    })),

    recent: data.activity.slice(0, 5).map((a) => ({
      summary: a.summary,
      at: a.created_at,
      actor: a.actor_id ? byId.get(a.actor_id)?.full_name ?? null : null,
    })),
  });
}

const Command = z.union([
  z.object({ action: z.literal('complete'), turn_id: z.string().uuid() }),
  z.object({ action: z.literal('flag'), chore: z.string().min(1) }),
]);

export async function POST(request: NextRequest) {
  const householdId = await householdFor(request);
  if (!householdId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const parsed = Command.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Send {action:"complete",turn_id} or {action:"flag",chore}' },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  if (parsed.data.action === 'complete') {
    const { data: turn } = await admin
      .from('chore_turns')
      .select('id, chore_id, household_id, assignee_id, status')
      .eq('id', parsed.data.turn_id)
      .eq('household_id', householdId)
      .single<{ id: string; chore_id: string; household_id: string; assignee_id: string; status: string }>();

    if (!turn) return NextResponse.json({ error: 'No such turn' }, { status: 404 });
    if (turn.status === 'done') return NextResponse.json({ ok: true, already: true });

    // complete_turn() keys off auth.uid(), which is null here — so the bridge
    // does the same work explicitly and credits the assignee.
    await admin
      .from('chore_turns')
      .update({
        status: 'done',
        completed_at: new Date().toISOString(),
        completed_by: turn.assignee_id,
      })
      .eq('id', turn.id);

    const { data: chore } = await admin
      .from('chores')
      .select('name, emoji, cadence')
      .eq('id', turn.chore_id)
      .single<{ name: string; emoji: string; cadence: 'scheduled' | 'on_demand' }>();

    if (chore?.cadence === 'on_demand') {
      await admin.rpc('top_up_queue', { p_chore: turn.chore_id });
    } else {
      await admin.rpc('materialize_schedule', { p_chore: turn.chore_id });
    }

    const { data: who } = await admin
      .from('profiles').select('full_name').eq('id', turn.assignee_id)
      .single<{ full_name: string }>();

    await admin.from('activity_log').insert({
      household_id: turn.household_id,
      actor_id: turn.assignee_id,
      verb: 'completed_chore',
      summary: `${who?.full_name ?? 'Someone'} did ${chore?.name ?? 'a chore'} (via Home Assistant)`,
      metadata: { chore_id: turn.chore_id, turn_id: turn.id, source: 'home_assistant' },
    });

    return NextResponse.json({ ok: true });
  }

  // flag: match on id, exact name, or slug so an HA script can say "dishes"
  const wanted = parsed.data.chore;
  const needle = wanted.toLowerCase();
  const { data: chores } = await admin
    .from('chores')
    .select('id, name, emoji, household_id')
    .eq('household_id', householdId)
    .eq('is_active', true)
    .returns<{ id: string; name: string; emoji: string; household_id: string }[]>();

  const chore = (chores ?? []).find(
    (c) =>
      c.id === wanted ||
      c.name.toLowerCase() === needle ||
      c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') === needle,
  );
  if (!chore) return NextResponse.json({ error: 'No such chore' }, { status: 404 });

  await admin.rpc('top_up_queue', { p_chore: chore.id });

  const { data: next } = await admin
    .from('chore_turns')
    .select('id, assignee_id')
    .eq('chore_id', chore.id)
    .eq('status', 'pending')
    .order('turn_number')
    .limit(1)
    .single<{ id: string; assignee_id: string }>();

  if (next) {
    await admin.from('chore_turns')
      .update({ due_at: new Date().toISOString() })
      .eq('id', next.id).is('due_at', null);

    await notifyProfiles([next.assignee_id], {
      title: `${chore.emoji} ${chore.name} — you're up`,
      body: 'Flagged from Home Assistant.',
      url: '/home',
      tag: `chore-${chore.id}`,
    });
  }

  await admin.from('activity_log').insert({
    household_id: chore.household_id,
    actor_id: null,
    verb: 'flagged_chore',
    summary: `${chore.name} flagged via Home Assistant`,
    metadata: { chore_id: chore.id, source: 'home_assistant' },
  });

  return NextResponse.json({ ok: true, turn_id: next?.id ?? null });
}
