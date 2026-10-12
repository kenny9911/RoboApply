// server/src/platform/billing/fxReference.ts
//
// TWD reference line (TASK_PLAN.md R-25; CN_TW_LAUNCH_PLAN.md L-7). Taiwan
// pays in USD; the plan sheet may show "約 NT$X" next to the USD price. The
// rate is entered by an admin with its source and as-of date, stored in
// AppConfig `fx.reference` as `{ TWD: { ratePerUsd, source, asOf, updatedAt,
// updatedBy } }`, and hidden when missing or older than 45 days (D3: no
// number without a source; no stale number).

import type { ExtendedPrismaClient } from '../../lib/prisma.js';

export const FX_REFERENCE_CONFIG_KEY = 'fx.reference';
/** Hide the reference line when the rate is older than this (CN plan L-7). Mirrors the credits contract constant. */
export const FX_REFERENCE_MAX_AGE_DAYS = 45;

export interface FxReference {
  currency: 'TWD';
  /** TWD per 1 USD. */
  ratePerUsd: number;
  source: string;
  /** YYYY-MM-DD */
  asOf: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface PublicFxReference {
  currency: 'TWD';
  ratePerUsd: number;
  source: string;
  asOf: string;
}

export type FxDb = Pick<ExtendedPrismaClient, 'appConfig'>;

function parseStored(raw: string | null | undefined): FxReference | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { TWD?: Partial<FxReference> };
    const t = parsed?.TWD;
    if (!t || typeof t.ratePerUsd !== 'number' || !(t.ratePerUsd > 0)) return null;
    if (typeof t.source !== 'string' || !t.source.trim()) return null;
    if (typeof t.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.asOf)) return null;
    return {
      currency: 'TWD',
      ratePerUsd: t.ratePerUsd,
      source: t.source,
      asOf: t.asOf,
      updatedAt: typeof t.updatedAt === 'string' ? t.updatedAt : null,
      updatedBy: typeof t.updatedBy === 'string' ? t.updatedBy : null,
    };
  } catch {
    return null;
  }
}

export async function readFxReference(db: FxDb): Promise<FxReference | null> {
  const row = await db.appConfig.findUnique({ where: { key: FX_REFERENCE_CONFIG_KEY }, select: { value: true } });
  return parseStored(row?.value);
}

export async function saveFxReference(
  db: FxDb,
  input: { ratePerUsd: number; source: string; asOf: string },
  adminId: string | null,
  now: Date = new Date(),
): Promise<FxReference> {
  const ref: FxReference = {
    currency: 'TWD',
    ratePerUsd: input.ratePerUsd,
    source: input.source.trim(),
    asOf: input.asOf,
    updatedAt: now.toISOString(),
    updatedBy: adminId,
  };
  const value = JSON.stringify({ TWD: ref });
  await db.appConfig.upsert({
    where: { key: FX_REFERENCE_CONFIG_KEY },
    update: { value, updatedBy: adminId },
    create: { key: FX_REFERENCE_CONFIG_KEY, value, updatedBy: adminId },
  });
  return ref;
}

/** Age of the as-of date in whole days (UTC). */
export function fxAgeDays(ref: Pick<FxReference, 'asOf'>, now: Date): number {
  const asOf = Date.parse(`${ref.asOf}T00:00:00.000Z`);
  return Math.floor((now.getTime() - asOf) / 86_400_000);
}

/** Fresh = as-of no older than 45 days and not in the future. */
export function isFxFresh(ref: Pick<FxReference, 'asOf'> | null, now: Date): boolean {
  if (!ref) return false;
  const age = fxAgeDays(ref, now);
  return age >= 0 && age <= FX_REFERENCE_MAX_AGE_DAYS;
}

/** The reference shown to users, or null when missing or stale. */
export function publicFxReference(ref: FxReference | null, now: Date): PublicFxReference | null {
  if (!ref || !isFxFresh(ref, now)) return null;
  return { currency: 'TWD', ratePerUsd: ref.ratePerUsd, source: ref.source, asOf: ref.asOf };
}

/** Whole NT$ for a USD amount in cents (display reference only; billing stays in USD). */
export function twdReferenceWhole(usdMinor: number, ratePerUsd: number): number {
  return Math.round((usdMinor / 100) * ratePerUsd);
}
