import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectAssistant } from '../../app/(app)/settings/connect-assistant';
import { mcpEndpoint } from '../mcp/connect';

describe('mcpEndpoint', () => {
  it('appends the MCP path to the app origin', () => {
    expect(mcpEndpoint('https://domestic-detroit.vercel.app')).toBe(
      'https://domestic-detroit.vercel.app/api/mcp',
    );
  });

  it('tolerates a trailing slash on the configured origin', () => {
    expect(mcpEndpoint('https://app.example/')).toBe('https://app.example/api/mcp');
    expect(mcpEndpoint('https://app.example//')).toBe('https://app.example/api/mcp');
  });
});

describe('ConnectAssistant', () => {
  const url = 'https://app.example/api/mcp';
  const html = renderToStaticMarkup(<ConnectAssistant url={url} />);

  it('shows the address and the ready-to-paste commands', () => {
    expect(html).toContain(url);
    expect(html).toContain(`claude mcp add --transport http domestic ${url}`);
    expect(html).toContain(`gemini mcp add --transport http domestic ${url}`);
    // Muse is set up by chatting to it, not through a settings screen.
    expect(html).toContain(`Add a custom MCP connector: ${url}`);
  });

  it('covers each assistant the connector was built for', () => {
    for (const name of ['Claude', 'Claude Code', 'Muse', 'Gemini']) {
      expect(html).toContain(name);
    }
  });

  it('says plainly that approving hands over a sign-in', () => {
    expect(html).toMatch(/sign-in for your account/);
  });
});
