// lib/relativeTime.ts
//
// Locale-aware relative timestamps ("2 days ago" / "just now"). Never hand-roll
// these as `${n}d ago` string builders: that leaks English into every non-en
// locale. `Intl.RelativeTimeFormat` renders the same ladder in the active
// locale, and the formatter cache keeps construction cheap for list views that
// format many rows.

const rtfCache = new Map<string, Intl.RelativeTimeFormat>();

function getRtf(locale: string, style: Intl.RelativeTimeFormatStyle): Intl.RelativeTimeFormat {
  const key = `${locale}:${style}`;
  let fmt = rtfCache.get(key);
  if (!fmt) {
    fmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style });
    rtfCache.set(key, fmt);
  }
  return fmt;
}

/** ISO timestamp → localized "5 min. ago" / "yesterday" / "now". Returns '' for
 *  a missing or unparseable input so each caller picks its own placeholder.
 *
 *  Style stays 'short' by default: 'narrow' abbreviates badly in some locales
 *  (fr renders "-5 min" instead of "il y a 5 min"). */
export function formatRelativeTime(
  iso: string | null | undefined,
  locale: string,
  style: Intl.RelativeTimeFormatStyle = 'short',
): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const fmt = getRtf(locale, style);
  const sec = Math.round((Date.now() - then) / 1000);
  if (Math.abs(sec) < 45) return fmt.format(0, 'second');
  const min = Math.round(sec / 60);
  if (Math.abs(min) < 60) return fmt.format(-min, 'minute');
  const hr = Math.round(min / 60);
  if (Math.abs(hr) < 24) return fmt.format(-hr, 'hour');
  const day = Math.round(hr / 24);
  if (Math.abs(day) < 30) return fmt.format(-day, 'day');
  const mo = Math.round(day / 30);
  if (Math.abs(mo) < 12) return fmt.format(-mo, 'month');
  return fmt.format(-Math.round(mo / 12), 'year');
}
