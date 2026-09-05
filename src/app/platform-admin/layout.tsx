import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isPlatformAdminEmail } from '@/lib/platform-admin';

/**
 * Route-visibility gate only. A signed-out visitor is sent to log in; a
 * signed-in visitor whose email isn't allow-listed gets a plain 404 — not a
 * 403 — so hitting this URL doesn't confirm the route means anything, same
 * convention as requireModule() in src/lib/data.ts. The actual authorization
 * boundary is the matching Postgres GUC every platform-admin RPC checks
 * independently (supabase/migrations/0025_platform_admin_identity.sql).
 */
export default async function PlatformAdminLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');
  if (!isPlatformAdminEmail(user.email)) notFound();

  return <div className="min-h-dvh bg-page px-6 py-10">{children}</div>;
}
