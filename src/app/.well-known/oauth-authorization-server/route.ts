import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Older MCP clients skip protected-resource metadata and look for the
 * authorization server on the MCP server's own origin. Point them at Supabase,
 * which is the one that actually issues tokens.
 */
export function GET() {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/\/$/, '');
  return NextResponse.redirect(`${base}/.well-known/oauth-authorization-server/auth/v1`, 307);
}
