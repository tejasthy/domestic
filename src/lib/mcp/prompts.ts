import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * Canned workflows a client can offer as shortcuts (Claude shows them as slash
 * commands), and one read-only resource. Both are only instructions or data the
 * assistant already could have fetched with tools, so they add no new power and
 * no cost: a prompt is a few lines of text, answered without touching the database.
 */

const user = (text: string) => ({
  messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }],
});

export function registerPrompts(server: McpServer, house: () => Promise<CallToolResult>) {
  server.registerPrompt(
    'weekly_digest',
    {
      title: 'Weekly house digest',
      description: 'A short roundup of the past week: chores, spending, and who owes whom.',
    },
    () =>
      user(
        'Give me a short digest of how the house did this past week. Call get_household for today’s date, ' +
          'then chore_history and list_expenses with since set to 7 days ago, list_chores for what is open ' +
          'now, and get_balances. Cover who did which chores, anything overdue, what was spent in total and ' +
          'on what, and who owes whom. Keep it under 150 words and do not record or change anything.',
      ),
  );

  server.registerPrompt(
    'settle_up',
    {
      title: 'Work out who should pay whom',
      description: 'The fewest payments that clear everyone’s balance.',
    },
    () =>
      user(
        'Work out how the house can settle up. Call get_balances and read its settle_up transfers. List who ' +
          'should pay whom and how much, in dollars. Do not log payments or send nudges unless I then ask you to.',
      ),
  );

  server.registerPrompt(
    'chore_fairness',
    {
      title: 'Who is carrying the chores',
      description: 'Compare how many chores each person did over a window.',
      argsSchema: { days: z.string().optional().describe('How many days back (default 30)') },
    },
    ({ days }) =>
      user(
        `Compare how many chores each person did over the last ${Number(days) > 0 ? Number(days) : 30} days. ` +
          'Call get_household for today’s date, then chore_stats with since set to that many days ago. ' +
          'Say who did the most and the least, and anyone who missed turns. Note that this is a window, not ' +
          'a lifetime ranking.',
      ),
  );

  server.registerPrompt(
    'add_receipt',
    {
      title: 'Itemize a receipt',
      description: 'Read a receipt photo and record it line by line, with a preview first.',
    },
    () =>
      user(
        'I am going to share a photo of a receipt. Read every line carefully: each item with its price, then ' +
          'tax, tip, fees and any discounts, and the grand total printed at the bottom. Ask me who each ' +
          'personal item belongs to if it is not obvious; shared items go to everyone. Then call ' +
          'add_itemized_expense WITHOUT confirm so I can see the breakdown. Only record it after I agree.',
      ),
  );

  server.registerResource(
    'house_summary',
    'domestic://house',
    {
      title: 'The house',
      description: 'Who lives here, who is away, which parts of Domestic are on, and the house’s date.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const result = await house();
      const first = result.content[0];
      const text = first && first.type === 'text' ? first.text : 'Unavailable.';
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text }] };
    },
  );
}
