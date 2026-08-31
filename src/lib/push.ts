import 'server-only';
import webpush from 'web-push';
import { createAdminClient } from '@/lib/supabase/server';

let configured = false;

function ensureConfigured() {
  if (configured) return true;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:noreply@example.com',
    pub,
    priv,
  );
  configured = true;
  return true;
}

export type PushPayload = {
  title: string;
  body: string;
  url?: string;
  tag?: string;
};

/** Respect each roommate's quiet hours in the household's timezone. */
function inQuietHours(
  profile: { quiet_from: number; quiet_to: number },
  timezone: string,
): boolean {
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    }).format(new Date()),
  );
  const { quiet_from: from, quiet_to: to } = profile;
  // Windows wrap midnight (22 -> 8), so the comparison has two shapes.
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * Fan out to every device a person has registered. Subscriptions that come
 * back 404/410 are dead (app deleted, permission revoked) and get pruned —
 * otherwise they accumulate forever and every send logs a failure.
 */
export async function notifyProfiles(
  profileIds: string[],
  payload: PushPayload,
  opts: { ignoreQuietHours?: boolean } = {},
) {
  if (profileIds.length === 0) return { sent: 0, pruned: 0, skipped: 0 };
  if (!ensureConfigured()) {
    console.warn('[push] VAPID keys not configured; skipping send');
    return { sent: 0, pruned: 0, skipped: profileIds.length };
  }

  const admin = createAdminClient();

  const { data: profiles } = await admin
    .from('profiles')
    .select('id, notify_push, quiet_from, quiet_to, household_id')
    .in('id', profileIds)
    .returns<{ id: string; notify_push: boolean; quiet_from: number; quiet_to: number; household_id: string }[]>();

  const householdIds = [...new Set((profiles ?? []).map((p) => p.household_id))];
  const { data: households } = await admin
    .from('households')
    .select('id, timezone')
    .in('id', householdIds)
    .returns<{ id: string; timezone: string }[]>();
  const tzById = Object.fromEntries((households ?? []).map((h) => [h.id, h.timezone]));

  const eligible = (profiles ?? []).filter(
    (p) =>
      p.notify_push &&
      (opts.ignoreQuietHours ||
        !inQuietHours(p, tzById[p.household_id] ?? 'America/Detroit')),
  );
  const skipped = profileIds.length - eligible.length;
  if (eligible.length === 0) return { sent: 0, pruned: 0, skipped };

  const { data: subs } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .in('profile_id', eligible.map((p) => p.id))
    .returns<{ id: string; endpoint: string; p256dh: string; auth: string }[]>();

  const body = JSON.stringify(payload);
  const dead: string[] = [];
  let sent = 0;

  await Promise.all(
    (subs ?? []).map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
        sent += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) dead.push(sub.id);
        else console.error('[push] send failed', status, (err as Error).message);
      }
    }),
  );

  if (dead.length) {
    await admin.from('push_subscriptions').delete().in('id', dead);
  }

  return { sent, pruned: dead.length, skipped };
}
