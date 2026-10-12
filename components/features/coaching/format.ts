'use client';

// components/features/coaching/format.ts — display helpers for coach data.
// Prices are the coach's own (minor units on the wire); a missing price is
// "not listed", never 0.

import { useCallback } from 'react';
import { useLocale } from 'next-intl';

/** Digits after the decimal point for a currency (USD 2, JPY 0, …). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Minor units → major units (4000 USD cents → 40). */
export function toMajor(amountMinor: number, currency: string): number {
  return amountMinor / 10 ** currencyDigits(currency);
}

/** Major units typed by staff → minor units (40.5 USD → 4050). Null for empty/invalid. */
export function toMinor(major: string, currency: string): number | null {
  const v = major.trim();
  if (!v) return null;
  const n = Number(v.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 10 ** currencyDigits(currency));
}

export function formatMoney(amountMinor: number, currency: string, locale: string): string {
  const major = toMajor(amountMinor, currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: Number.isInteger(major) ? 0 : 2 }).format(major);
  } catch {
    return `${major} ${currency}`;
  }
}

/** A language code in the reader's language ("zh-TW" → "Chinese (Taiwan)"); the code itself as fallback. */
export function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function useLanguageName(): (code: string) => string {
  const locale = useLocale();
  return useCallback((code: string) => languageName(code, locale), [locale]);
}

export function useMoney(): (amountMinor: number, currency: string) => string {
  const locale = useLocale();
  return useCallback((amountMinor: number, currency: string) => formatMoney(amountMinor, currency, locale), [locale]);
}

/** Initials for a photo-less avatar (first letters of up to two words; CJK names keep the first character). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return Array.from(words[0]!)[0]!.toUpperCase();
  return (Array.from(words[0]!)[0]! + Array.from(words[words.length - 1]!)[0]!).toUpperCase();
}

/** "a, b , c" → ['a','b','c'] (trimmed, empty dropped, de-duplicated). */
export function splitList(value: string): string[] {
  return [...new Set(value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean))];
}
