'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { geocodeLocation, geocodeHouseAddress } from '@/lib/weather';
import type { ActionResult } from '@/lib/actions';
import type { HouseholdInvite } from '@/lib/types';

/** Postgres exceptions arrive with a `message` that is already user-facing. */
function fail(error: { message: string } | null, fallback: string): ActionResult {
  return { ok: false, error: error?.message ?? fallback };
}

/* --------------------------------------------------------------- onboarding */

const NewHousehold = z.object({
  name: z.string().min(1, 'Give the house a name.').max(80),
  address: z.string().max(200).optional(),
  timezone: z.string().min(1),
  full_name: z.string().min(1, 'What should everyone call you?').max(80),
  initials: z.string().min(1).max(3),
  modules: z.array(z.string()).min(1, 'Pick at least one thing to track.'),
  /** Honest, minimal "join source" — captured only at household creation,
   * from an optional `?ref=` onboarding query param. No IP/user-agent
   * tracking anywhere in this app. */
  signup_source: z.string().max(40).regex(/^[a-z0-9_-]+$/).optional(),
});

export async function createHousehold(
  input: z.input<typeof NewHousehold>,
): Promise<ActionResult & { householdId?: string }> {
  const parsed = NewHousehold.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('create_household', {
    p_name: parsed.data.name,
    p_address: parsed.data.address || null,
    p_timezone: parsed.data.timezone,
    p_full_name: parsed.data.full_name,
    p_initials: parsed.data.initials.toUpperCase(),
    p_modules: parsed.data.modules,
    p_signup_source: parsed.data.signup_source || null,
  });

  if (error) return fail(error, 'Could not create the household.');
  revalidatePath('/', 'layout');
  return { ok: true, householdId: data as unknown as string };
}

export async function peekInvite(code: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('peek_invite', { p_code: code });
  if (error) return { valid: false as const, reason: error.message };

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) return { valid: false as const, reason: 'That code does not exist.' };

  return row.valid
    ? {
        valid: true as const,
        householdName: row.household_name!,
        fullName: row.full_name,
        initials: row.initials,
      }
    : { valid: false as const, reason: row.reason ?? 'That invite cannot be used.' };
}

export async function joinHousehold(
  code: string,
  fullName?: string,
  initials?: string,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('redeem_invite', {
    p_code: code,
    p_full_name: fullName || null,
    p_initials: initials ? initials.toUpperCase() : null,
  });
  if (error) return fail(error, 'Could not join that household.');
  revalidatePath('/', 'layout');
  return { ok: true };
}

/* -------------------------------------------------------------- admin: people */

export async function createInvite(input: {
  email?: string;
  full_name?: string;
  initials?: string;
  color?: string;
  expires_days?: number;
  max_uses?: number;
}): Promise<ActionResult & { invite?: HouseholdInvite }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('create_invite', {
    p_email: input.email?.trim() || null,
    p_full_name: input.full_name?.trim() || null,
    p_initials: input.initials?.trim().toUpperCase() || null,
    p_color: input.color || '#64748b',
    // Postgres `interval` accepts this literal directly.
    p_expires_in: `${Math.max(1, input.expires_days ?? 14)} days`,
    p_max_uses: Math.max(1, input.max_uses ?? 1),
  });

  if (error) return fail(error, 'Could not create the invite.');
  revalidatePath('/settings/household');
  return { ok: true, invite: data as unknown as HouseholdInvite };
}

export async function revokeInvite(inviteId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('revoke_invite', { p_invite: inviteId });
  if (error) return fail(error, 'Could not revoke that invite.');
  revalidatePath('/settings/household');
  return { ok: true };
}

export async function removeMember(profileId: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('remove_member', { p_profile: profileId });
  if (error) return fail(error, 'Could not remove them.');
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function setMemberAdmin(
  profileId: string,
  isAdmin: boolean,
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_member_admin', {
    p_profile: profileId,
    p_is_admin: isAdmin,
  });
  if (error) return fail(error, 'Could not change that role.');
  revalidatePath('/settings/household');
  return { ok: true };
}

/* ------------------------------------------------------------- admin: modules */

export async function setModule(module: string, enabled: boolean): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_module', {
    p_module: module,
    p_enabled: enabled,
  });
  if (error) return fail(error, 'Could not change that.');
  revalidatePath('/', 'layout');
  return { ok: true };
}

/* -------------------------------------------------------- admin: permissions */

export async function setCrossComplete(enabled: boolean): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_cross_complete', { p_enabled: enabled });
  if (error) return fail(error, 'Could not change that.');
  revalidatePath('/', 'layout');
  return { ok: true };
}

/* ------------------------------------------------------- admin: get ahead/defer */

export type GetAheadSettingsInput = {
  enabled: boolean;
  getAhead: { maxPer30d: number };
  defer: { maxPer30d: number; maxChain: number };
};

export async function setGetAheadSettings(input: GetAheadSettingsInput): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('set_module', {
    p_module: 'get_ahead',
    p_enabled: input.enabled,
    p_settings: {
      get_ahead: { max_per_30d: input.getAhead.maxPer30d },
      defer: { max_per_30d: input.defer.maxPer30d, max_chain: input.defer.maxChain },
    },
  });
  if (error) return fail(error, 'Could not save those limits.');
  revalidatePath('/settings/household');
  return { ok: true };
}

/* ------------------------------------------------------------- admin: geofence */

export async function setGeofence(enabled: boolean, radiusMeters?: number): Promise<ActionResult> {
  const supabase = await createClient();

  // The geofence centers on the house's own address, not the kiosk's
  // optional weather-location override, so an admin doesn't have to
  // configure that override just to turn this on. Geocode the address here
  // so set_geofence has fresh coordinates to persist — only needed the first
  // time it's turned on. Falls back to the kiosk override's coordinates for
  // a household with no address on file, since that's the only location it
  // has.
  let lat: number | null = null;
  let lon: number | null = null;
  if (enabled) {
    const { data: hh } = await supabase
      .from('households')
      .select('address, house_latitude, house_longitude, latitude, longitude')
      .single();
    if (hh?.house_latitude == null || hh?.house_longitude == null) {
      if (hh?.address) {
        const place = await geocodeHouseAddress(hh.address);
        if (!place) {
          return { ok: false, error: "Couldn't locate the house address on file — double-check it's correct." };
        }
        lat = place.lat;
        lon = place.lon;
      } else if (hh?.latitude != null && hh?.longitude != null) {
        lat = hh.latitude;
        lon = hh.longitude;
      } else {
        return { ok: false, error: 'Set a house address, or a location above, first.' };
      }
    }
  }

  const { error } = await supabase.rpc('set_geofence', {
    p_enabled: enabled,
    p_radius_meters: radiusMeters ?? null,
    p_lat: lat,
    p_lon: lon,
  });
  if (error) return fail(error, 'Could not change that.');
  revalidatePath('/settings/household');
  revalidatePath('/', 'layout');
  return { ok: true };
}

/* -------------------------------------------------------------- admin: weather */

export async function setHouseholdLocation(query: string): Promise<ActionResult & { label?: string }> {
  const place = await geocodeLocation(query);
  if (!place) return { ok: false, error: "Couldn't find that place — try a city and state." };

  const supabase = await createClient();
  const { error } = await supabase.rpc('set_household_location', {
    p_label: place.label,
    p_lat: place.lat,
    p_lon: place.lon,
  });
  if (error) return fail(error, 'Could not save that location.');
  revalidatePath('/settings/household');
  revalidatePath('/kiosk');
  return { ok: true, label: place.label };
}

/* --------------------------------------------------------------- admin: kiosk */

export async function createKioskDevice(
  name: string,
): Promise<ActionResult & { token?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('create_kiosk_device', { p_name: name });
  if (error) return fail(error, 'Could not pair a kiosk.');
  revalidatePath('/settings/household');
  // Shown once — only the hash is stored, so it cannot be retrieved later.
  return { ok: true, token: data as unknown as string };
}

/* ---------------------------------------------------------- admin: AI key */

export async function getAiConfigSummary(): Promise<{ provider: string; updatedAt: string } | null> {
  const supabase = await createClient();
  const { data } = await supabase.rpc('get_ai_config_summary');
  const row = Array.isArray(data) ? data[0] : null;
  return row ? { provider: row.provider, updatedAt: row.updated_at } : null;
}

export async function setAiConfig(provider: 'anthropic' | 'gemini', apiKey: string): Promise<ActionResult> {
  const secret = process.env.AI_CONFIG_ENCRYPTION_KEY;
  if (!secret) return { ok: false, error: 'AI_CONFIG_ENCRYPTION_KEY is not set on the server.' };

  const supabase = await createClient();
  const { error } = await supabase.rpc('set_ai_config', {
    p_provider: provider,
    p_api_key: apiKey,
    p_secret: secret,
  });
  if (error) return fail(error, 'Could not save that key.');
  revalidatePath('/settings/household');
  return { ok: true };
}

export async function clearAiConfig(): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('clear_ai_config');
  if (error) return fail(error, 'Could not remove that key.');
  revalidatePath('/settings/household');
  return { ok: true };
}
