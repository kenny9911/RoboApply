// backend/src/roboapply/v2/lib/raLocale.ts
//
// Locale resolution for RoboApply V2 request handlers + schedulers.
//
// The candidate app (Next.js, `roboapply/`) stores the user's chosen UI
// language in a `robo_locale` cookie and echoes it on every API call via the
// `X-Robo-Locale` header (see roboapply/lib/api/client.ts). The backend reads
// that here so every LLM agent can be told to respond in the SAME language
// the user is reading the UI in.
//
// Boundary note: V2 code cannot import `../../engine/lib/seekerLocale.ts`
// (that lives under `roboapply/` non-v2 and is denied by
// scripts/check-roboapply-v2-boundary.mjs). The closed-list normalization is
// therefore intentionally re-implemented here — it is tiny, and the boundary
// rule explicitly favours forking small helpers over crossing the line.

import type { Request } from 'express';
import prisma from '../../../lib/prisma.js';

/**
 * The closed list of locales the backend can produce LLM output in. This is a
 * superset of the locales the UI switcher currently exposes (en / zh / zh-TW /
 * ja) — keeping the others lets a non-default `Accept-Language` still get a
 * native-language response, and matches the i18n surface in
 * `roboapply/lib/i18n.ts` + `frontend/src/i18n/locales/`.
 */
export const RA_LOCALES = [
  'en',
  'zh',
  'zh-TW',
  'ja',
  'es',
  'fr',
  'pt',
  'de',
] as const;

export type RaLocale = (typeof RA_LOCALES)[number];

export const RA_DEFAULT_LOCALE: RaLocale = 'en';

const LOWER_TO_CANONICAL = new Map<string, RaLocale>(
  RA_LOCALES.map((l) => [l.toLowerCase(), l]),
);

/**
 * Normalise a free-form locale / Accept-Language token to one of our
 * supported locales, or null when nothing acceptable matches.
 *
 *   'zh-TW' | 'zh-tw' | 'zh-Hant' | 'zh-HK'  → 'zh-TW'
 *   'zh' | 'zh-CN' | 'zh-Hans'               → 'zh'
 *   'en-US'                                  → 'en'
 *   'pt-BR'                                  → 'pt'
 */
export function normalizeRaLocale(
  input: string | undefined | null,
): RaLocale | null {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase().replace('_', '-');

  // Exact (case-insensitive) match against the closed list.
  const exact = LOWER_TO_CANONICAL.get(lowered);
  if (exact) return exact;

  // Traditional-Chinese variants all collapse to zh-TW.
  if (
    lowered === 'zh-tw' ||
    lowered === 'zh-hant' ||
    lowered === 'zh-hk' ||
    lowered.startsWith('zh-hant')
  ) {
    return 'zh-TW';
  }

  // Any other Chinese variant → Simplified.
  if (lowered.startsWith('zh')) return 'zh';

  // Strip the region subtag (en-US → en, pt-BR → pt, ja-JP → ja, …).
  const base = lowered.split('-')[0];
  return LOWER_TO_CANONICAL.get(base) ?? null;
}

/**
 * Pick the best locale from an `Accept-Language` header by walking its
 * q-ordered list and returning the first token that normalises to a
 * supported locale. Returns null when none match.
 */
function fromAcceptLanguage(header: string | undefined | null): RaLocale | null {
  if (!header) return null;
  // "zh-TW,zh;q=0.9,en;q=0.8" → ["zh-TW", "zh", "en"] (drop the q-weights;
  // they're already in preference order in practice).
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim();
    const norm = normalizeRaLocale(tag);
    if (norm) return norm;
  }
  return null;
}

/**
 * Resolve the active UI locale for an authenticated request. Precedence:
 *   1. `X-Robo-Locale` header (frontend-injected from the robo_locale cookie)
 *   2. `robo_locale` cookie directly (server-side renders / direct API hits)
 *   3. `Accept-Language` header (browser default)
 *   4. 'en'
 *
 * Always returns a canonical supported locale — never throws.
 */
export function getRequestLocale(req: Request): RaLocale {
  const headerLocale = req.get('x-robo-locale');
  const fromHeader = normalizeRaLocale(headerLocale);
  if (fromHeader) return fromHeader;

  // cookie-parser populates req.cookies (see backend/src/index.ts).
  const cookieLocale = (req as { cookies?: Record<string, string> }).cookies?.[
    'robo_locale'
  ];
  const fromCookie = normalizeRaLocale(cookieLocale);
  if (fromCookie) return fromCookie;

  const fromAccept = fromAcceptLanguage(req.get('accept-language'));
  if (fromAccept) return fromAccept;

  return RA_DEFAULT_LOCALE;
}

/**
 * Resolve a user's persisted UI locale from their SeekerProfile row. Used by
 * background schedulers (no `req`) so cron-generated content (weekly insights,
 * refreshed match-score explanations) comes back in the language the user has
 * chosen in the app. Falls back to 'en'.
 */
export async function getUserLocale(userId: string): Promise<RaLocale> {
  try {
    const profile = await prisma.seekerProfile.findUnique({
      where: { userId },
      select: { locale: true },
    });
    return normalizeRaLocale(profile?.locale) ?? RA_DEFAULT_LOCALE;
  } catch {
    return RA_DEFAULT_LOCALE;
  }
}

