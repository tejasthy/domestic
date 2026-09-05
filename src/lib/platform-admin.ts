import 'server-only';

/**
 * Route-visibility gate only — NOT the authorization boundary. The real one
 * is the matching Postgres GUC (app.platform_admin_emails, see
 * supabase/migrations/0025_platform_admin_identity.sql): every platform-admin
 * RPC checks is_platform_admin() independently, so even if this check were
 * ever bypassed, the database still refuses. Keep PLATFORM_ADMIN_EMAILS and
 * the GUC in sync — see .env.local.example.
 */
export function isPlatformAdminEmail(email: string | null | undefined): boolean {
  const allow = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return !!email && allow.includes(email.toLowerCase());
}
