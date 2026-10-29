import { authenticate } from '@/lib/mcp/auth';
import { handleMcp } from '@/lib/mcp/handler';
import { notifyProfiles } from '@/lib/push';

export const dynamic = 'force-dynamic';
// A tool call is a few indexed queries; anything slower is hung, not working.
export const maxDuration = 20;

/**
 * MCP endpoint for Claude, Gemini, Muse and any other client that speaks
 * streamable HTTP. Sign-in is OAuth against Supabase Auth — see lib/mcp/auth.
 */
function handle(request: Request) {
  return handleMcp(request, { authenticate, notify: notifyProfiles });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
