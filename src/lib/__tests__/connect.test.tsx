import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectAssistant } from '../../app/(app)/settings/connect-assistant';
import { ConnectedAssistants } from '../../app/(app)/settings/connected-assistants';
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

describe('ConnectedAssistants', () => {
  const assistants = [
    { clientId: '11111111-1111-4111-8111-111111111111', name: 'Claude', connectedOn: 'Oct 29, 2026' },
    { clientId: '22222222-2222-4222-8222-222222222222', name: 'Muse connector', connectedOn: 'Oct 30, 2026' },
  ];

  it('lists each approved assistant with when it connected and a way to cut it off', () => {
    const html = renderToStaticMarkup(<ConnectedAssistants assistants={assistants} />);
    expect(html).toContain('Claude');
    expect(html).toContain('Muse connector');
    expect(html).toContain('Connected Oct 29, 2026');
    expect(html.match(/Disconnect/g)).toHaveLength(2);
  });

  it('shows nothing at all when no assistant is connected', () => {
    expect(renderToStaticMarkup(<ConnectedAssistants assistants={[]} />)).toBe('');
  });

  it('describes the new abilities, so people know what they are approving', () => {
    const html = renderToStaticMarkup(<ConnectAssistant url="https://app.example/api/mcp" />);
    expect(html).toMatch(/add expenses/);
    expect(html).toMatch(/receipt photo/);
  });
});
