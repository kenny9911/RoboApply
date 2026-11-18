/**
 * Timezone-aware day/week/hour bucketing helpers for stats endpoints.
 *
 * All timestamps are stored as UTC instants (`timestamp without time zone`
 * holding UTC wall time). Historically every stats endpoint bucketed by UTC
 * day, which misaligns "daily" charts for any viewer outside UTC (a UTC+8
 * recruiter's day starts at 8am on the chart). Endpoints now accept an
 * optional `?tz=<IANA name>` query param — the browser sends
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` — and bucket on the
 * viewer's local calendar instead. No `tz` (or an invalid one) falls back to
 * UTC, preserving the old behaviour byte-for-byte.
 *
 * Bucket keys stay plain calendar strings (`YYYY-MM-DD`), NOT instants — the
 * frontend renders them with `timeZone: 'UTC'` pinned (formatDayBucketLabel)
 * precisely because they are dates, not points in time.
 */

/** Validate an IANA timezone name; anything unusable degrades to 'UTC'. */
export function resolveTimeZone(raw?: string | null): string {
  const tz = (raw ?? '').trim();
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return 'UTC';
  }
}

/** `YYYY-MM-DD` calendar date of an instant in the given timezone. */
export function formatDateKey(date: Date, timeZone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD natively.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * SQL expression converting a UTC `timestamp without time zone` column to
 * local wall time for `date_trunc` / `to_char` / `DATE()` bucketing.
 * The double conversion is required: the first `AT TIME ZONE 'UTC'` tags the
 * naive stored value as UTC (→ timestamptz), the second renders it as wall
 * time in the target zone (→ timestamp).
 *
 * `tzParam` is the `$n` placeholder the caller binds the (already
 * resolveTimeZone-validated) zone name to.
 */
export function sqlLocalTime(column: string, tzParam: string): string {
  return `((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${tzParam})`;
}
