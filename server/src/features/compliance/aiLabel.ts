// server/src/features/compliance/aiLabel.ts
//
// AI-generated content labelling (CN-E-07; TASK_PLAN.md WP-13).
//
//   implicitLabelMetadata(artifact) — machine-readable marks for exported
//     files, the same on both brands:
//       • the GB 45438-2025 implicit-label element set (key `AIGC`: Label,
//         ContentProducer, ProduceID, ReservedCode1, ContentPropagator,
//         PropagateID, ReservedCode2), required on GoApply by the 2025
//         labelling measures. Field names follow the standard's metadata
//         annex; counsel confirms them before launch (CN plan C-9, OPS-C).
//       • the IPTC digital source type, the common machine-readable marker
//         for EU AI Act Art. 50(2) on RoboApply exports (counsel to confirm).
//     Returned as PDF Info keys, DOCX custom properties and an XMP fragment,
//     so the resume/cover-letter exporters (WP-36b, WP-37) write them as-is.
//   explicitFooterLine(locale) — the visible "AI-assisted" line, printed on
//     GoApply exports when `CN_AI_EXPORT_EXPLICIT_LABEL` is on.
//   logAiContentLabel(...) — one RAAiContentLabelLog row per labelled
//     GoApply artifact (purged after 180 days by compliance-daily).
//
// No user text goes into any of this: only ids, the provider and the time.

import crypto from 'node:crypto';
import prisma from '../../lib/prisma.js';
import { getBrand, parseBrandId, type BrandId, type ProductBrand } from '../../platform/brand/registry.js';
import { parseBoolEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import { getCurrentBrandId } from '../../lib/requestContext.js';
import type { ImplicitAiLabel } from './contract.js';

/** IPTC NewsCodes digital source types. */
export const IPTC_TRAINED_ALGORITHMIC = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
export const IPTC_COMPOSITE_ALGORITHMIC = 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia';

/** GB 45438-2025 `Label` values: 1 = AI generated/synthesised content. */
export const GB45438_LABEL_GENERATED = '1';

/** Every key the implicit label writes (tests pin this list). */
export const IMPLICIT_LABEL_KEYS = {
  pdfInfo: ['AIGC', 'AIGenerated', 'DigitalSourceType', 'AIContentID', 'AIProducer', 'AIProvider', 'AIGeneratedAt'],
  docx: ['AIGC', 'AIGenerated', 'DigitalSourceType', 'AIContentID', 'AIProducer', 'AIProvider', 'AIGeneratedAt'],
} as const;

/** A fresh content id: brand prefix + 24 hex chars (no user data). */
export function newAiContentId(brand: BrandId = getCurrentBrandId() ?? 'roboapply'): string {
  return `${brand === 'goapply' ? 'GA' : 'RA'}-${crypto.randomBytes(12).toString('hex')}`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface ImplicitLabelInput {
  contentId: string;
  /** The model vendor that generated the content (e.g. 'deepseek'). */
  provider: string;
  generatedAt?: Date;
  /** Defaults to the request brand. */
  brand?: BrandId | ProductBrand;
  /** True when the user edited the AI output (composite rather than fully generated). */
  userEdited?: boolean;
}

function brandOf(input: ImplicitLabelInput['brand']): ProductBrand {
  if (input && typeof input === 'object') return input;
  return getBrand(parseBrandId(input) ?? getCurrentBrandId() ?? 'roboapply');
}

/** The machine-readable label for an exported artifact (same keys on both brands). */
export function implicitLabelMetadata(input: ImplicitLabelInput): ImplicitAiLabel {
  const brand = brandOf(input.brand);
  const generatedAt = (input.generatedAt ?? new Date()).toISOString();
  const producer = brand.name;
  const sourceType = input.userEdited ? IPTC_COMPOSITE_ALGORITHMIC : IPTC_TRAINED_ALGORITHMIC;
  const aigc = JSON.stringify({
    Label: GB45438_LABEL_GENERATED,
    ContentProducer: producer,
    ProduceID: input.contentId,
    ReservedCode1: '',
    ContentPropagator: producer,
    PropagateID: input.contentId,
    ReservedCode2: '',
  });
  const props: Record<string, string> = {
    AIGC: aigc,
    AIGenerated: 'true',
    DigitalSourceType: sourceType,
    AIContentID: input.contentId,
    AIProducer: producer,
    AIProvider: input.provider,
    AIGeneratedAt: generatedAt,
  };
  const xmp =
    '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:aigc="urn:roboapply:aigc:1.0">' +
    `<Iptc4xmpExt:DigitalSourceType>${xmlEscape(sourceType)}</Iptc4xmpExt:DigitalSourceType>` +
    `<aigc:AIGC>${xmlEscape(aigc)}</aigc:AIGC>` +
    `<aigc:ContentID>${xmlEscape(input.contentId)}</aigc:ContentID>` +
    '</rdf:Description>';
  return {
    aiGenerated: true,
    provider: input.provider,
    producer,
    brand: brand.id,
    contentId: input.contentId,
    generatedAt,
    pdfInfo: { ...props },
    docxCustomProperties: { ...props },
    xmp,
  };
}

const FOOTER_LINES: Record<string, string> = {
  zh: '本文件部分内容由人工智能辅助生成，请核对后使用。',
  'zh-TW': '本文件部分內容由人工智慧輔助生成，請核對後使用。',
  en: 'Parts of this document were generated with AI assistance. Check it before you use it.',
};

/** The visible AI label line for an exported document (English for locales without a version). */
export function explicitFooterLine(locale: string | null | undefined): string {
  return FOOTER_LINES[locale ?? 'en'] ?? FOOTER_LINES.en!;
}

/** GoApply exports print the visible line only when ops turned it on (CN plan C-9). */
export function explicitLabelEnabled(brand: BrandId | ProductBrand, env: EnvSource = process.env): boolean {
  const b = typeof brand === 'string' ? getBrand(brand) : brand;
  return b.market === 'cn' && parseBoolEnv(env.CN_AI_EXPORT_EXPLICIT_LABEL);
}

export type AiLabelDb = Pick<typeof prisma, 'rAAiContentLabelLog'>;

export interface LogAiContentLabelInput {
  userId: string | null;
  contentId: string;
  /** Artifact type ('resume' | 'cover_letter' | 'assistant_message' | 'practice_report' | …). */
  kind: string;
  provider: string;
  artifactId?: string | null;
  /** Defaults to explicit when the visible line is on, else implicit only. */
  labelMode?: 'explicit' | 'implicit_only';
  brand?: BrandId;
}

/**
 * Write the label log row for a GoApply artifact. RoboApply has no such duty,
 * so it writes nothing and returns false.
 */
export async function logAiContentLabel(
  input: LogAiContentLabelInput,
  deps: { db?: AiLabelDb; env?: EnvSource } = {},
): Promise<boolean> {
  const brandId = input.brand ?? getCurrentBrandId() ?? 'roboapply';
  const brand = getBrand(brandId);
  if (brand.market !== 'cn') return false;
  const db = deps.db ?? prisma;
  await db.rAAiContentLabelLog.create({
    data: {
      brand: brand.id,
      userId: input.userId,
      artifactType: input.kind,
      artifactId: input.artifactId ?? null,
      labelMode: input.labelMode ?? (explicitLabelEnabled(brand, deps.env) ? 'explicit' : 'implicit_only'),
      contentId: input.contentId,
    },
  });
  return true;
}
