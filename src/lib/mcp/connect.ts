/** Name the CLI instructions register the connector under. */
export const CONNECTOR_NAME = 'domestic';

/** The address an assistant is pointed at, from the app's own origin. */
export function mcpEndpoint(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/api/mcp`;
}
