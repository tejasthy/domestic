#!/usr/bin/env node
/**
 * Sets the platform-admin email allowlist — who can see /platform-admin
 * (cross-household stats + the feedback inbox). Run once per deployment,
 * and again whenever you change who should have access.
 *
 *   node --env-file=.env.local scripts/set-platform-admin.mjs you@example.com
 *   node --env-file=.env.local scripts/set-platform-admin.mjs a@x.com b@y.com
 *
 * Uses the service role key (server-only, never exposed to the browser) to
 * call a service-role-only RPC — the same shape as this repo's other
 * one-time setup scripts (gen-secrets.mjs, gen-vapid.mjs).
 *
 * Supabase's managed Postgres does not allow `alter database ... set` for
 * custom parameters (confirmed: every role, including the SQL Editor's,
 * gets "permission denied to set parameter"), so this can't be a one-line
 * SQL statement — it has to go through the app's own service-role access.
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first.');
  console.error('Tip: run with  `node --env-file=.env.local scripts/set-platform-admin.mjs you@example.com`');
  process.exit(1);
}

const emails = process.argv.slice(2).map((e) => e.trim()).filter(Boolean);
if (emails.length === 0) {
  console.error('Give at least one email address.');
  console.error('Usage: node --env-file=.env.local scripts/set-platform-admin.mjs you@example.com');
  process.exit(1);
}

const supabase = createClient(url, key);
const { error } = await supabase.rpc('set_platform_admin_emails', { p_emails: emails });

if (error) {
  console.error('Could not set the platform-admin allowlist:', error.message);
  process.exit(1);
}

console.log(`Platform admin${emails.length > 1 ? 's' : ''}: ${emails.join(', ')}`);
console.log('Also set PLATFORM_ADMIN_EMAILS to the same list in your Vercel env vars.');
