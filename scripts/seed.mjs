#!/usr/bin/env node
/**
 * Seeds Domestic from the paper chart.
 *
 *   node scripts/seed.mjs
 *
 * Idempotent: re-running updates the chores and rotations in place rather than
 * duplicating them, so you can tweak scripts/roommates.json and re-run.
 */

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
  console.error('Tip: run with  `node --env-file=.env.local scripts/seed.mjs`');
  process.exit(1);
}

const config = JSON.parse(readFileSync(new URL('./roommates.json', import.meta.url), 'utf8'));

const missing = config.roommates.filter((r) => !r.email.trim());
if (missing.length) {
  console.error('These roommates have no email in scripts/roommates.json:');
  for (const r of missing) console.error(`  - ${r.full_name}`);
  console.error('\nMagic-link sign-in needs a real address for each of them.');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

/* ---------------------------------------------------------------- household */

let { data: household } = await db
  .from('households')
  .select('*')
  .eq('name', config.household.name)
  .maybeSingle();

if (!household) {
  const { data, error } = await db
    .from('households')
    .insert(config.household)
    .select()
    .single();
  if (error) throw error;
  household = data;
  console.log(`Created household ${household.name}`);
} else {
  console.log(`Household ${household.name} already exists`);
}

/* ------------------------------------------------------------------ people */

const profiles = {};

// Invites go in first. The handle_new_user trigger reads them, so whoever signs
// in with an invited address lands in the household with the right name,
// initials and color — whether they used Google or an email link.
//
// Replace rather than upsert: as of 0004 an invite is a row with its own id and
// a shareable code, and `email` is only an optional restriction — so it carries
// no unique constraint to conflict on.
const emails = config.roommates.map((p) => p.email.toLowerCase());
const { error: clearErr } = await db
  .from('household_invites')
  .delete()
  .eq('household_id', household.id)
  .in('email', emails);

if (clearErr) {
  if (/does not exist/i.test(clearErr.message)) {
    console.error('\nhousehold_invites is missing — run migrations 0003 through 0007 first.');
    process.exit(1);
  }
  throw clearErr;
}

const { error: inviteErr } = await db.from('household_invites').insert(
  config.roommates.map((person, i) => ({
    email: person.email.toLowerCase(),
    household_id: household.id,
    full_name: person.full_name,
    initials: person.initials,
    color: person.color,
    // The first person listed runs the house.
    is_admin: i === 0,
    max_uses: 1,
  })),
);
if (inviteErr) throw inviteErr;
console.log(`Invited ${config.roommates.length} roommates`);

// Everything this household runs. Matches src/lib/modules.ts.
const { error: moduleErr } = await db.from('household_modules').upsert(
  ['chores', 'expenses', 'kiosk'].map((module) => ({
    household_id: household.id,
    module,
    enabled: true,
  })),
  { onConflict: 'household_id,module' },
);
if (moduleErr) throw moduleErr;

for (const person of config.roommates) {
  // createUser is idempotent-ish: it 422s on a duplicate email, which we treat
  // as "already invited" and look up instead.
  const { data: created, error } = await db.auth.admin.createUser({
    email: person.email,
    email_confirm: true,
    user_metadata: {
      full_name: person.full_name,
      initials: person.initials,
      household_id: household.id,
    },
  });

  let userId = created?.user?.id;

  if (error) {
    if (!/already|exists|registered/i.test(error.message)) throw error;
    const { data: list } = await db.auth.admin.listUsers({ perPage: 200 });
    userId = list.users.find((u) => u.email?.toLowerCase() === person.email.toLowerCase())?.id;
    if (!userId) throw new Error(`Could not resolve existing user ${person.email}`);
  }

  // The handle_new_user trigger creates the row; this keeps it in sync when
  // names, colors, or household membership change between runs.
  const { error: upsertErr } = await db.from('profiles').upsert({
    id: userId,
    household_id: household.id,
    full_name: person.full_name,
    initials: person.initials,
    email: person.email,
    color: person.color,
  });
  if (upsertErr) throw upsertErr;

  profiles[person.initials] = userId;
  console.log(`  ${person.initials}  ${person.full_name.padEnd(20)} ${person.email}`);
}

/* ------------------------------------------------------------------ chores */

// Straight off the sheet. `rotation` preserves the phase each column starts on:
// the household-task rows begin with AB, the numbered queues begin with NA.
const CHORES = [
  {
    name: 'Floors',
    emoji: '🧹',
    description: 'Sweep and mop the common areas',
    cadence: 'scheduled',
    days_of_week: [0, 5], // Sunday and Friday
    interval_weeks: 1,
    due_hour: 20,
    sort_order: 1,
    rotation: ['AB', 'BK', 'TT', 'NA'],
  },
  {
    name: 'Microwave',
    emoji: '🍲',
    description: 'Wipe out the microwave',
    cadence: 'scheduled',
    days_of_week: [6], // Saturday
    interval_weeks: 2, // biweekly, on weekends
    due_hour: 20,
    sort_order: 2,
    rotation: ['AB', 'BK', 'TT', 'NA'],
  },
  {
    name: 'Trash to curb',
    emoji: '🗑️',
    description: 'Bins out Sunday night — pickup is Monday',
    cadence: 'scheduled',
    days_of_week: [0], // Sunday
    interval_weeks: 1,
    due_hour: 19,
    sort_order: 3,
    rotation: ['NA', 'AB', 'BK', 'TT'],
  },
  {
    name: 'Dishes',
    emoji: '🍽️',
    description: 'Run and unload a load',
    cadence: 'on_demand',
    queue_depth: 4,
    sort_order: 4,
    rotation: ['NA', 'AB', 'BK', 'TT'],
  },
  {
    name: 'Trash when full',
    emoji: '🚮',
    description: 'Swap the kitchen bag',
    cadence: 'on_demand',
    queue_depth: 4,
    sort_order: 5,
    rotation: ['NA', 'AB', 'BK', 'TT'],
  },
];

for (const spec of CHORES) {
  const { rotation, ...fields } = spec;

  let { data: chore } = await db
    .from('chores')
    .select('*')
    .eq('household_id', household.id)
    .eq('name', spec.name)
    .maybeSingle();

  if (chore) {
    const { data, error } = await db
      .from('chores')
      .update(fields)
      .eq('id', chore.id)
      .select()
      .single();
    if (error) throw error;
    chore = data;
  } else {
    const { data, error } = await db
      .from('chores')
      .insert({ ...fields, household_id: household.id })
      .select()
      .single();
    if (error) throw error;
    chore = data;
  }

  // Replace the rotation wholesale — positions are a total order, and merging
  // two partial orders is how you end up with two people on position 2.
  await db.from('chore_rotation').delete().eq('chore_id', chore.id);
  const { error: rotErr } = await db.from('chore_rotation').insert(
    rotation.map((initials, position) => ({
      chore_id: chore.id,
      profile_id: profiles[initials],
      position,
    })),
  );
  if (rotErr) throw rotErr;

  // Fill the board so there is something to look at on first load.
  if (spec.cadence === 'scheduled') {
    const { data: made, error } = await db.rpc('materialize_schedule', { p_chore: chore.id });
    if (error) throw error;
    console.log(`  ${spec.emoji} ${spec.name.padEnd(16)} ${rotation.join(' › ')}  (+${made} scheduled)`);
  } else {
    const { data: made, error } = await db.rpc('top_up_queue', { p_chore: chore.id });
    if (error) throw error;
    console.log(`  ${spec.emoji} ${spec.name.padEnd(16)} ${rotation.join(' › ')}  (+${made} queued)`);
  }
}

console.log('\nDone. Everyone can sign in at /login — Google or an email link.');
console.log('Add anyone else from Settings → Household → Invite someone.');
