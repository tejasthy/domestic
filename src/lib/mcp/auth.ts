import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types';

/**
 * Authentication for /api/mcp.
 *
 * Supabase Auth is the OAuth 2.1 authorization server (Authentication → OAuth
 * Server). It issues each assistant an ordinary user access token, so this side
 * only has to verify one and then act *as that user* — through a client that
 * carries the token, never the service role. RLS stays the security boundary
 * and `auth.uid()` is the real person, which is why `complete_turn` works here
 * unchanged.
 */

export type McpPrincipal = {
  userId: string;
  /** The OAuth client the person approved, when Supabase put it in the token. */
  clientId: string | null;
  /** Scoped to the caller's token: RLS applies exactly as it does in the app. */
  supabase: SupabaseClient<Database>;
};

export function bearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? '');
  return match ? match[1] : null;
}

/** RFC 9728 location of this resource's metadata. */
export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/api/mcp`;
}

/**
 * What an MCP client fetches after a 401 to learn which authorization server
 * to send the person to. It points at Supabase, so discovery, registration,
 * token issue and refresh never touch this deployment.
 */
export function protectedResourceMetadata(origin: string, supabaseUrl: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [`${supabaseUrl.replace(/\/$/, '')}/auth/v1`],
    bearer_methods_supported: ['header'],
    resource_name: 'Domestic',
  };
}

export function unauthorized(origin: string): Response {
  return Response.json(
    { error: 'unauthorized', error_description: 'Sign in to Domestic to use this connector.' },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(origin)}"`,
        'Cache-Control': 'no-store',
      },
    },
  );
}

export async function authenticate(request: Request): Promise<McpPrincipal | null> {
  const token = bearerToken(request.headers.get('authorization'));
  if (!token) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

  // Verifies signature and expiry (against the project's JWKS, or the Auth
  // server when the project still signs with a shared secret).
  const verifier = createClient<Database>(url, anonKey, options);
  const { data, error } = await verifier.auth.getClaims(token);
  const claims = data?.claims;
  if (error || !claims) return null;

  // The anon key is itself a JWT; only a signed-in person's token has a `sub`
  // and the `authenticated` role.
  if (!claims.sub || claims.role !== 'authenticated') return null;

  const supabase = createClient<Database>(url, anonKey, {
    ...options,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  return {
    userId: claims.sub,
    clientId: typeof claims.client_id === 'string' ? claims.client_id : null,
    supabase,
  };
}
