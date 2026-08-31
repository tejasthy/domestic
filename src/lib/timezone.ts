/**
 * A `timestamptz` value (created_at, due_at, completed_at, expires_at,
 * last_seen_at, updated_at, ...) formatted for the household viewing it — the
 * server process's own zone (UTC in production) has nothing to do with where
 * the house actually is.
 */
export function formatInTimeZone(
  value: string | Date,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Date(value).toLocaleString('en-US', { timeZone, ...options });
}

/**
 * A plain `date` column (spent_on, settled_on, next_run_on) — a calendar day
 * with no time component, so it has no timezone of its own. Format it as UTC
 * midnight rather than routing it through the household's zone, which could
 * shift the day near midnight.
 */
export function formatCalendarDate(
  value: string,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Date(`${value}T00:00:00Z`).toLocaleString('en-US', { timeZone: 'UTC', ...options });
}
