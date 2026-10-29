import { Card } from '@/components/ui';
import { CONNECTOR_NAME } from '@/lib/mcp/connect';
import { CopyButton } from './copy-button';

function CodeLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2">
      <code className="t-code text-ink bg-sunken rounded-md px-3 py-2 flex-1 min-w-0 break-all">
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  );
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal pl-5 space-y-1 t-body-sm text-ink-2">{children}</ol>;
}

function Assistant({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <details className="group border-t border-subtle first:border-t-0">
      <summary className="flex items-center justify-between px-4 py-3 cursor-pointer list-none t-title-md text-ink">
        {name}
        <span aria-hidden className="text-ink-muted transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="px-4 pb-4 space-y-3">{children}</div>
    </details>
  );
}

/**
 * How a member connects their own AI assistant. Shown only while the house has
 * the AI assistants module on; every member sees it, not just admins, because
 * each person approves their own connection.
 */
export function ConnectAssistant({ url }: { url: string }) {
  return (
    <div className="space-y-3">
      <Card className="p-4 space-y-3">
        <div>
          <p className="t-title-md text-ink">Connector address</p>
          <p className="t-body-sm text-ink-muted mt-0.5">
            Add this to an AI assistant and it can check who&apos;s up, see the balances, and mark
            chores done as you. You sign in to Domestic and approve each assistant once.
          </p>
        </div>
        <CodeLine text={url} />
        <p className="t-body-sm text-ink-muted">
          Once connected, try: &ldquo;Who&apos;s up for the dishes?&rdquo; or &ldquo;What do I owe
          the house?&rdquo;
        </p>
      </Card>

      <Card>
        <Assistant name="Claude">
          <Steps>
            <li>Open Settings, then Connectors.</li>
            <li>Choose Add custom connector.</li>
            <li>Name it Domestic and paste the address above.</li>
            <li>Select Connect, sign in to Domestic if asked, and approve.</li>
          </Steps>
        </Assistant>

        <Assistant name="Claude Code">
          <CodeLine text={`claude mcp add --transport http ${CONNECTOR_NAME} ${url}`} />
          <p className="t-body-sm text-ink-2">
            Then run <code className="t-code">/mcp</code> inside Claude Code and choose{' '}
            {CONNECTOR_NAME} to sign in.
          </p>
        </Assistant>

        <Assistant name="Muse">
          <p className="t-body-sm text-ink-2">Send Muse this message:</p>
          <CodeLine text={`Add a custom MCP connector: ${url}`} />
          <Steps>
            <li>Muse sets it up and gives you a link to sign in to Domestic.</li>
            <li>Sign in, then approve.</li>
            <li>Ask Muse who&apos;s up for chores to check it works.</li>
          </Steps>
        </Assistant>

        <Assistant name="Gemini">
          <CodeLine text={`gemini mcp add --transport http ${CONNECTOR_NAME} ${url}`} />
          <p className="t-body-sm text-ink-2">
            Then start <code className="t-code">gemini</code> and run{' '}
            <code className="t-code">/mcp auth {CONNECTOR_NAME}</code> to sign in. The Gemini app
            itself only accepts custom connectors on some plans.
          </p>
        </Assistant>

        <Assistant name="Something else">
          <p className="t-body-sm text-ink-2">
            Any assistant that supports remote MCP servers with OAuth sign-in can use the same
            address.
          </p>
        </Assistant>
      </Card>

      <p className="t-body-sm text-ink-muted">
        Approving gives that assistant a sign-in for your account, so connect only ones you trust.
        An admin can switch AI assistants off for the whole house.
      </p>
    </div>
  );
}
