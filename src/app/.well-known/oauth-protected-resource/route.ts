// Some clients probe the origin root before the path-specific document.
export { GET } from './api/mcp/route';

// Route segment config must be a literal in this file, not a re-export.
export const dynamic = 'force-dynamic';
