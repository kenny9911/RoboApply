// backend/src/roboapply/lib/cacheKey.ts
//
// Cover-letter cache key. Per arch §6 + §12:
//   sha256(`${resumeId}|${jobId}|${intentVersion}|${toneOverrideHash ?? '-'}`)
//
// intentVersion is included in the key so a mission-edit that bumps the
// version naturally produces a new cache key (the matcher refuses to
// select jobs whose cached letter was generated against a stale
// intentVersion). The toneOverrideHash slot keeps Premium+ users in their
// own cache buckets so a different tone-steering string doesn't pollute
// the canonical letter for the same (resume, job).

import { createHash } from 'node:crypto';

export function buildCoverLetterCacheKey(opts: {
  resumeId: string;
  jobId: string;
  intentVersion: number;
  toneOverride?: string | null;
}): string {
  const tone = (opts.toneOverride ?? '').trim();
  const toneHash = tone.length === 0
    ? '-'
    : createHash('sha256').update(tone).digest('hex').slice(0, 16);
  const raw = `${opts.resumeId}|${opts.jobId}|${opts.intentVersion}|${toneHash}`;
  return createHash('sha256').update(raw).digest('hex');
}

export function buildIntentParseCacheKey(opts: {
  intentText: string;
  locale: string;
}): string {
  const raw = `${opts.locale}|${opts.intentText.trim()}`;
  return createHash('sha256').update(raw).digest('hex');
}
