// components/features/pay/format.ts — pure helpers of the pay check (/pay).
//
//   payCheckHref(ask)          the page's own link for a title and place (the job page's
//                              "See what postings pay for this title" uses payCheckHrefForJob)
//   formatMoney(n, cur, loc)   a yearly figure in its own currency, Intl.NumberFormat per locale
//   regionName(code, loc)      a country's name in the reader's language (Intl.DisplayNames)
//   rangeBar(p25, mid, p75)    where the band and the median sit on the bar, in percent
//
// No figure is ever made up here: the page passes only the server's numbers.

/** The page's path. */
export const PAY_PATH = '/pay';
/** What the server reads at most (contract PAY_CHECK_TITLE_MAX / PAY_CHECK_LOCATION_MAX). */
export const PAY_TITLE_MAX = 120;
export const PAY_LOCATION_MAX = 120;
/** The location word for remote posts (the server reads it in any case). */
export const REMOTE_LOCATION = 'remote';

/** `/pay?title=…&location=…` (the location left out when empty). Pure. */
export function payCheckHref(ask: { title: string; location?: string | null }): string {
  const params = new URLSearchParams();
  const title = ask.title.trim().slice(0, PAY_TITLE_MAX);
  if (title) params.set('title', title);
  const location = ask.location?.trim().slice(0, PAY_LOCATION_MAX);
  if (location) params.set('location', location);
  const qs = params.toString();
  return qs ? `${PAY_PATH}?${qs}` : PAY_PATH;
}

/**
 * The pay check for a job's title, where the job is: remote posts for a
 * remote job, else the job's own location (none when it states none). Pure.
 */
export function payCheckHrefForJob(job: { title: string; location?: string | null; workModel?: string | null }): string {
  return payCheckHref({ title: job.title, location: job.workModel === 'remote' ? REMOTE_LOCATION : (job.location ?? null) });
}

/** True for the remote word as the page and the job link send it. Pure. */
export function isRemoteLocation(location: string | null | undefined): boolean {
  return (location ?? '').trim().toLowerCase() === REMOTE_LOCATION;
}

/** A whole amount in its currency, in the reader's locale. Pure. */
export function formatMoney(amount: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount).toLocaleString(locale)}`;
  }
}

/** A country's name in the reader's language, or the code itself when the runtime has no name for it. Pure. */
export function regionName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export interface RangeBarGeometry {
  /** Left edge of the 25th–75th band, percent of the bar. */
  start: number;
  /** Right edge of the band. */
  end: number;
  /** The median's mark. */
  median: number;
}

const clampPct = (n: number) => Math.min(100, Math.max(0, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Where the band (25th to 75th percentile) and the median sit on the bar. The
 * bar is drawn around the band with room on both sides (half the band's width,
 * at least a tenth of the median), so the picture shows the spread without
 * claiming where the lowest or highest post is. Pure.
 */
export function rangeBar(p25: number, median: number, p75: number): RangeBarGeometry {
  const lo = Math.min(p25, median, p75);
  const hi = Math.max(p25, median, p75);
  const pad = Math.max((hi - lo) / 2, Math.abs(median) / 10, 1);
  const from = Math.max(0, lo - pad);
  const to = hi + pad;
  const at = (v: number) => round1(clampPct(((v - from) / (to - from)) * 100));
  return { start: at(lo), end: at(hi), median: at(median) };
}
