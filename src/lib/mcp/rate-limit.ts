import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types';

/**
 * Per-person rate limiting for /api/mcp, counted in Postgres (0040) because
 * Vercel functions share no memory. It exists to stop a runaway assistant loop
 * from burning the house's function and database budget, not to meter fairly,
 * so the numbers are generous for a person chatting and tight for a loop.
 */

export type Bucket = 'read' | 'write' | 'write_day';

export const LIMITS: Record<Bucket, { limit: number; windowSeconds: number }> = {
  read: { limit: 120, windowSeconds: 60 },
  write: { limit: 10, windowSeconds: 60 },
  write_day: { limit: 100, windowSeconds: 86_400 },
};

export type CallKind = 'read' | 'write';

/**
 * Only tool calls are metered. Connecting, listing tools and prompts stay free,
 * so a client that is being limited can still connect and read the error.
 */
export function classifyMessage(message: unknown, writeTools: ReadonlySet<string>): CallKind | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as { method?: unknown; params?: { name?: unknown } };
  if (m.method !== 'tools/call') return null;
  return typeof m.params?.name === 'string' && writeTools.has(m.params.name) ? 'write' : 'read';
}

export type Verdict = { ok: true } | { ok: false; retryAfter: number };

/**
 * Counts one call. A write counts against both the per-minute and per-day
 * buckets. Fails open: if the counter is unreachable — or migration 0040 has
 * not been applied yet, which is a manual step — the call goes through and a
 * warning is logged, rather than locking the house out of its own data.
 */
export async function checkLimit(
  supabase: SupabaseClient<Database>,
  kind: CallKind,
): Promise<Verdict> {
  const buckets: Bucket[] = kind === 'write' ? ['write', 'write_day'] : ['read'];

  const results = await Promise.all(
    buckets.map(async (bucket) => {
      const { data, error } = await supabase.rpc('mcp_rate_check', {
        p_bucket: bucket,
        p_limit: LIMITS[bucket].limit,
        p_window_seconds: LIMITS[bucket].windowSeconds,
      });
      const row = data?.[0];
      if (error || !row) {
        console.warn('[mcp] rate limit unavailable, allowing the call', error?.message);
        return null;
      }
      return row;
    }),
  );

  const refused = results.filter((r): r is NonNullable<typeof r> => r !== null && !r.allowed);
  if (refused.length === 0) return { ok: true };
  return { ok: false, retryAfter: Math.max(...refused.map((r) => r.retry_after)) };
}

/** What the assistant sees: a normal tool error it can read out, not a transport failure. */
export function limitedResponse(id: unknown, retryAfter: number): Response {
  const text =
    `You're going a little fast — Domestic is pausing this connection for ${retryAfter} second` +
    `${retryAfter === 1 ? '' : 's'}. Wait, then try again; nothing was changed by this call.`;
  return Response.json(
    { jsonrpc: '2.0', id: id ?? null, result: { isError: true, content: [{ type: 'text', text }] } },
    { status: 200, headers: { 'Retry-After': String(retryAfter) } },
  );
}
