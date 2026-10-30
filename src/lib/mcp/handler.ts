import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { unauthorized, type McpPrincipal } from './auth';
import { WRITE_TOOLS } from './common';
import { checkLimit, classifyMessage, limitedResponse } from './rate-limit';
import { buildServer, type McpContext } from './tools';

type Deps = {
  authenticate: (request: Request) => Promise<McpPrincipal | null>;
  notify: McpContext['notify'];
};

/** A JSON-RPC body, or null if it is not JSON at all (the transport then answers the error itself). */
async function readMessage(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.clone().text());
  } catch {
    return null;
  }
}

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

  const message = await readMessage(request);

  // Batching was dropped from the protocol, and one request must not smuggle in
  // many metered calls. Anything but a lone message that makes tool calls is refused.
  if (Array.isArray(message)) {
    if (message.some((m) => classifyMessage(m, WRITE_TOOLS) !== null)) {
      return Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Send one tool call per request.' } },
        { status: 400 },
      );
    }
  } else {
    const kind = classifyMessage(message, WRITE_TOOLS);
    if (kind) {
      const verdict = await checkLimit(principal.supabase, kind);
      if (!verdict.ok) {
        return limitedResponse((message as { id?: unknown }).id, verdict.retryAfter);
      }
    }
  }

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
