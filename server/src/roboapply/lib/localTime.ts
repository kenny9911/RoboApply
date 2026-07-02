// backend/src/roboapply/lib/localTime.ts
//
// Timezone fan-out helpers. The seeker scheduler ticks at a fixed UTC
// cadence; the RoboApply schedulers run on UTC crons but fan out per
// user-local hour by selecting only missions whose IANA timezone resolves
// to the target user-local hour at the current UTC tick.

/** Given an IANA timezone string + an instant, return the local hour 0..23. */
export function userLocalHour(tz: string, now: Date = new Date()): number {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === 'hour');
    if (!hourPart) return now.getUTCHours();
    const h = parseInt(hourPart.value, 10);
    return Number.isFinite(h) ? h % 24 : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

/** Return the UTC instant corresponding to today's `hour:00` in `tz`. If that
 *  instant has already passed today, returns tomorrow's. */
export function nextUserLocalHour(tz: string, hour: number, now: Date = new Date()): Date {
  try {
    // Cheap algorithm: tick 15-minute intervals forward up to 36h and find
    // the first instant whose local hour == target. Avoids importing a
    // tz database for a small lookup.
    const FIFTEEN_MIN = 15 * 60 * 1000;
    for (let i = 1; i <= 36 * 4; i += 1) {
      const candidate = new Date(now.getTime() + i * FIFTEEN_MIN);
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });
      const parts = fmt.formatToParts(candidate);
      const h = parts.find((p) => p.type === 'hour');
      const m = parts.find((p) => p.type === 'minute');
      if (!h || !m) continue;
      const hh = parseInt(h.value, 10);
      const mm = parseInt(m.value, 10);
      if (hh === hour && mm < 15) return candidate;
    }
  } catch {
    // fallthrough to UTC fallback
  }
  // Fallback: UTC `hour` today or tomorrow.
  const utc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  if (utc.getTime() <= now.getTime()) {
    utc.setUTCDate(utc.getUTCDate() + 1);
  }
  return utc;
}

/** UTC day bucket for a given instant (used as the digest key). */
export function utcDayBucket(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
