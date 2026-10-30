import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A chainable stand-in for the Supabase query builder: every filter returns
 * itself, and awaiting it (or calling .single()) yields the table's fixture.
 * Filters are recorded rather than applied, so a test can assert the query was
 * built correctly while the fixture stands in for the database's answer.
 */
type Filter = { method: string; args: unknown[] };
/** A table's rows, or a function of the filters applied to that one query. */
type Rows = unknown[] | ((filters: Filter[]) => unknown[]);

export function fakeSupabase(fixtures: {
  tables?: Record<string, Rows>;
  rpc?: Record<string, unknown>;
}) {
  const calls: {
    rpc: [string, unknown][];
    filters: { table: string; method: string; args: unknown[] }[];
  } = { rpc: [], filters: [] };

  const builder = (table: string, source: Rows) => {
    const mine: Filter[] = [];
    const rows = () => (typeof source === 'function' ? source(mine) : source);
    const b: Record<string, unknown> = {};
    for (const method of [
      'select', 'eq', 'or', 'order', 'limit', 'returns', 'is', 'gte', 'lte', 'lt', 'gt', 'ilike', 'not',
      'insert', 'update', 'delete', 'in',
    ]) {
      b[method] = (...args: unknown[]) => {
        calls.filters.push({ table, method, args });
        mine.push({ method, args });
        return b;
      };
    }
    b.single = () => Promise.resolve({ data: rows()[0] ?? null, error: null });
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
    return b;
  };

  const client = {
    from: (table: string) => builder(table, fixtures.tables?.[table] ?? []),
    rpc: (name: string, args: unknown) => {
      calls.rpc.push([name, args]);
      // The rate limiter runs on every tool call; unless a test says otherwise, it allows.
      const out = name in (fixtures.rpc ?? {})
        ? fixtures.rpc?.[name]
        : name === 'mcp_rate_check' ? [{ allowed: true, retry_after: 0 }] : undefined;
      const result =
        out instanceof Error
          ? { data: null, error: { message: out.message } }
          : { data: out ?? null, error: null };
      return Object.assign(Promise.resolve(result), {
        single: () => Promise.resolve(result),
      });
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}
