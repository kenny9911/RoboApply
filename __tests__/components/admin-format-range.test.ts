import { afterEach, describe, expect, it, vi } from 'vitest';
import { fmtNativeAmount } from '../../components/v3/admin/format';
import { resolveRange } from '../../components/v3/admin/controls';

const spaces = (value: string) => value.replace(/\s/g, ' ');

describe('admin transaction amounts', () => {
  it('preserves the payment currency and amount when the viewer locale changes', () => {
    expect(spaces(fmtNativeAmount(1900, 'cny', 'zh'))).toBe('CNY 19.00');
    expect(spaces(fmtNativeAmount(1900, 'CNY', 'en'))).toBe('CNY 19.00');
    expect(spaces(fmtNativeAmount(1900, 'USD', 'zh'))).toBe('USD 19.00');
  });

  it('uses the currency minor-unit scale instead of always dividing by 100', () => {
    expect(spaces(fmtNativeAmount(1900, 'JPY', 'en'))).toBe('JPY 1,900');
    expect(spaces(fmtNativeAmount(1234, 'KWD', 'en'))).toBe('KWD 1.234');
    expect(spaces(fmtNativeAmount(123456, 'EUR', 'de'))).toBe('1.234,56 EUR');
  });

  it('distinguishes a real zero payment from missing or invalid payment data', () => {
    expect(spaces(fmtNativeAmount(0, 'CNY', 'en'))).toBe('CNY 0.00');
    expect(fmtNativeAmount(null, 'CNY', 'en')).toBe('—');
    expect(fmtNativeAmount(undefined, 'CNY', 'en')).toBe('—');
    expect(fmtNativeAmount(Number.NaN, 'CNY', 'en')).toBe('—');
    expect(fmtNativeAmount(Number.POSITIVE_INFINITY, 'CNY', 'en')).toBe('—');
    expect(fmtNativeAmount(1900, null, 'en')).toBe('—');
    expect(fmtNativeAmount(1900, 'invalid', 'en')).toBe('—');
  });
});

describe('admin calendar ranges', () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ['today', 9, 9],
    ['7d', 9, 3],
    ['30d', 8, 10],
  ] as const)('includes exactly the selected calendar days for %s', (preset, month, day) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 14, 30));

    const range = resolveRange({ preset });

    expect(range.from).toBe(new Date(2026, month, day).toISOString());
    expect(range.to).toBe(new Date(2026, 9, 10).toISOString());
    expect(range.tz).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it('includes the entire custom end date with an exclusive next-day boundary', () => {
    const range = resolveRange({ preset: 'custom', from: '2026-09-29', to: '2026-10-09' });

    expect(range.from).toBe(new Date(2026, 8, 29).toISOString());
    expect(range.to).toBe(new Date(2026, 9, 10).toISOString());
    expect(new Date(2026, 9, 9, 23, 59, 59).getTime()).toBeLessThan(Date.parse(range.to));
  });

  it('resolves a single selected day by calendar boundaries across daylight saving changes', () => {
    const range = resolveRange({ preset: 'custom', from: '2026-03-08', to: '2026-03-08' });

    expect(range.from).toBe(new Date(2026, 2, 8).toISOString());
    expect(range.to).toBe(new Date(2026, 2, 9).toISOString());
  });
});
