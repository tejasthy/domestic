import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { unauthorized, type McpPrincipal } from './auth';
import { buildServer, type McpContext } from './tools';

type Deps = {
  authenticate: (request: Request) => Promise<McpPrincipal | null>;
  notify: McpContext['notify'];
};

/**
 * Stateless streamable HTTP: every POST is one short invocation with its own
 * server and transport, answered as plain JSON. No sessions and no held-open
 * SSE stream, so nothing here bills for time spent idle — and a cold function
 * can serve any request without having seen the one before it.
 */
export async function handleMcp(request: Request, deps: Deps): Promise<Response> {
  if (request.method !== 'POST') {
    // GET would open a long-lived server-push stream, which this server never
    // uses; DELETE ends a session, and there are none. Both are optional in
    // the spec, and clients fall back to POST-only.
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }

  const principal = await deps.authenticate(request);
  if (!principal) return unauthorized(new URL(request.url).origin);

  const server = buildServer({
    supabase: principal.supabase,
    userId: principal.userId,
    notify: deps.notify,
  });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    void transport.close();
    void server.close();
  }
}
