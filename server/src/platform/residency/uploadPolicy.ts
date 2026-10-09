// server/src/platform/residency/uploadPolicy.ts
//
// What happens to a resume upload, per brand and deployment
// (TASK_PLAN.md WP-15 "CN-0 storage rule", ruling H6, PRODUCT_PLAN.md G-resume).
//
//   RoboApply           → original file kept (S3_* bucket, local disk in dev);
//                         text stored as parsed.
//   GoApply, CN-0       → no original file and no image/photo is ever kept:
//   (offshore)            the file is parsed in memory, and the parsed text and
//                         fields are redacted (government ID numbers, health
//                         details) BEFORE anything is stored.
//   GoApply, CN-1/CN-2  → original file kept only in the CN bucket (`CN_S3_*`);
//   (cn-mainland)         without it the upload fails closed with
//                         `503 storage_unavailable` — never the intl bucket.
//
// `applyResumeUploadPolicy` is the one function an upload path calls between
// parsing and storing; `assertResumeUploadStorage` is the one it calls before
// accepting the file.

import { brandEnv, type EnvSource } from '../brand/brandEnv.js';
import { getBrand, type BrandId, type ProductBrand } from '../brand/registry.js';
import {
  CN0_STORAGE_PII_KINDS,
  redactDeep,
  redactPii,
  type PiiCounts,
  type PiiKind,
  type RedactionMarkerLocale,
} from '../pii/redact.js';
import { residencyStage, type ResidencyStage } from './deployRegion.js';

/** HTTP 503 `storage_unavailable` (the `platform/http.ts` envelope maps `status`/`code`). */
export class StorageUnavailableError extends Error {
  readonly code = 'storage_unavailable' as const;
  readonly status = 503 as const;
  readonly brand: BrandId;
  constructor(brand: BrandId, message = 'File storage is not available right now. Please try again later.') {
    super(message);
    this.name = 'StorageUnavailableError';
    this.brand = brand;
  }
}

export type OriginalFileRule = 'store' | 'discard' | 'unavailable';

export interface ResumeUploadPolicy {
  brand: BrandId;
  stage: ResidencyStage;
  /** store: keep the original; discard: never keep it; unavailable: refuse the upload (503). */
  originals: OriginalFileRule;
  /** Kinds redacted from parsed text and fields before storage (empty = none). */
  redactKinds: readonly PiiKind[];
  /** Drop images and photos (embedded or uploaded) instead of storing them. */
  dropImages: boolean;
  /** Marker language for redactions. */
  markerLocale: RedactionMarkerLocale;
}

/** The four `CN_S3_*` values GoApply needs before it may keep any file (no fallback to `S3_*`). */
export const CN_STORAGE_ENV = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

/** True when the brand's own bucket is fully configured (`S3_*` for RoboApply, `CN_S3_*` for GoApply). */
export function brandStorageConfigured(brand: BrandId | ProductBrand, env: EnvSource = process.env): boolean {
  const b = typeof brand === 'string' ? getBrand(brand) : brand;
  if (b.market === 'cn') return CN_STORAGE_ENV.every((name) => Boolean(brandEnv(b, name, env)));
  return Boolean(brandEnv(b, 'S3_BUCKET', env));
}

export function resumeUploadPolicy(brand: BrandId | ProductBrand, env: EnvSource = process.env): ResumeUploadPolicy {
  const b = typeof brand === 'string' ? getBrand(brand) : brand;
  const stage = residencyStage(b, env);
  if (stage === 'intl') {
    return { brand: b.id, stage, originals: 'store', redactKinds: [], dropImages: false, markerLocale: 'en' };
  }
  if (stage === 'cn0') {
    return {
      brand: b.id,
      stage,
      originals: 'discard',
      redactKinds: CN0_STORAGE_PII_KINDS,
      dropImages: true,
      markerLocale: 'zh',
    };
  }
  return {
    brand: b.id,
    stage,
    originals: brandStorageConfigured(b, env) ? 'store' : 'unavailable',
    redactKinds: [],
    dropImages: false,
    markerLocale: 'zh',
  };
}

/** Throws `StorageUnavailableError` (503) when the brand may not accept an upload here. */
export function assertResumeUploadStorage(brand: BrandId | ProductBrand, env: EnvSource = process.env): ResumeUploadPolicy {
  const policy = resumeUploadPolicy(brand, env);
  if (policy.originals === 'unavailable') throw new StorageUnavailableError(policy.brand);
  return policy;
}

/** Whether the original upload bytes may be written anywhere. */
export function mayStoreOriginal(brand: BrandId | ProductBrand, env: EnvSource = process.env): boolean {
  return resumeUploadPolicy(brand, env).originals === 'store';
}

const IMAGE_MIME = /^image\//i;
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i;

export function isImageUpload(mimeType: string | null | undefined, fileName?: string | null): boolean {
  return IMAGE_MIME.test(mimeType ?? '') || IMAGE_EXT.test(fileName ?? '');
}

/** Field names that carry a photo / image reference in parsed resume data. */
const PHOTO_KEYS = new Set(['photo', 'photourl', 'avatar', 'avatarurl', 'headshot', 'image', 'imageurl', 'picture', 'portrait', '照片', '头像', '頭像', '证件照', '證件照']);

function dropPhotoFields<T>(value: T): { value: T; dropped: number } {
  let dropped = 0;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) {
        if (PHOTO_KEYS.has(k.trim().toLowerCase())) {
          dropped += 1;
          continue;
        }
        out[k] = walk(inner);
      }
      return out;
    }
    if (typeof v === 'string' && /^data:image\//i.test(v.trim())) {
      dropped += 1;
      return '';
    }
    return v;
  };
  return { value: walk(value) as T, dropped };
}

export interface ResumeUploadContent<P = unknown> {
  rawText: string;
  markdown?: string;
  parsed?: P;
  summary?: string;
  highlight?: string;
}

export interface AppliedResumeUploadPolicy<P = unknown> extends ResumeUploadContent<P> {
  policy: ResumeUploadPolicy;
  /** Redactions made across every field. */
  redactions: PiiCounts | null;
  /** Photo/image fields removed from `parsed`. */
  imagesDropped: number;
  /** Whether the caller may keep the original bytes. */
  storeOriginal: boolean;
}

/**
 * Apply the brand's storage rule to parsed upload content. Returns copies;
 * the input is not mutated. For RoboApply (and GoApply on the mainland stack)
 * the content comes back unchanged.
 */
export function applyResumeUploadPolicy<P>(
  brand: BrandId | ProductBrand,
  content: ResumeUploadContent<P>,
  env: EnvSource = process.env,
): AppliedResumeUploadPolicy<P> {
  const policy = resumeUploadPolicy(brand, env);
  const storeOriginal = policy.originals === 'store';
  if (!policy.redactKinds.length && !policy.dropImages) {
    return { ...content, policy, redactions: null, imagesDropped: 0, storeOriginal };
  }
  const opts = { kinds: policy.redactKinds, markerLocale: policy.markerLocale };
  const counts: PiiCounts = { email: 0, phone: 0, address: 0, prc_id: 0, tw_id: 0, us_ssn: 0, gov_id: 0, health: 0, known_value: 0 };
  const add = (c: PiiCounts) => {
    for (const k of Object.keys(c) as PiiKind[]) counts[k] += c[k];
  };
  const text = (s: string | undefined): string | undefined => {
    if (typeof s !== 'string') return s;
    const r = redactPii(s, opts);
    add(r.counts);
    return r.text;
  };

  let parsed = content.parsed;
  let imagesDropped = 0;
  if (parsed !== undefined) {
    if (policy.dropImages) {
      const d = dropPhotoFields(parsed);
      parsed = d.value;
      imagesDropped = d.dropped;
    }
    if (policy.redactKinds.length) {
      const r = redactDeep(parsed, opts);
      parsed = r.value;
      add(r.counts);
    }
  }

  return {
    rawText: text(content.rawText) ?? '',
    markdown: text(content.markdown),
    summary: text(content.summary),
    highlight: text(content.highlight),
    parsed,
    policy,
    redactions: counts,
    imagesDropped,
    storeOriginal,
  };
}
