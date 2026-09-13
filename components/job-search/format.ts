import type { SearchJob } from '../../lib/api/job-search-types';

export function safeJobUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

export function jobDate(value: string | null, locale: string): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value));
}

export function jobSalary(salary: SearchJob['salary'], locale: string): string | null {
  if (!salary || (salary.min === null && salary.max === null)) return null;
  const format = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
  const amount = salary.min !== null && salary.max !== null
    ? salary.min === salary.max ? format(salary.min) : `${format(salary.min)}–${format(salary.max)}`
    : salary.min !== null ? `≥ ${format(salary.min)}` : `≤ ${format(salary.max!)}`;
  return [salary.currency, amount].filter(Boolean).join(' ');
}
