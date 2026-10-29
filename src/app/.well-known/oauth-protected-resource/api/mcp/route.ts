import { NextResponse, type NextRequest } from 'next/server';
import { protectedResourceMetadata } from '@/lib/mcp/auth';

export const dynamic = 'force-dynamic';

/** RFC 9728 metadata for /api/mcp — the URL named in its 401 challenge. */
export function GET(request: NextRequest) {
  return NextResponse.json(
    protectedResourceMetadata(request.nextUrl.origin, process.env.NEXT_PUBLIC_SUPABASE_URL!),
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
