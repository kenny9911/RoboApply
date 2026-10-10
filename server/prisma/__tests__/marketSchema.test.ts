// @vitest-environment node
//
// MKT-0 (market wave, phase M0): the schema foundation, checked as text.
//
// This test reads the *.prisma files and the files under server/prisma/sql/ as
// plain text. It starts no Prisma engine, opens no database and uses no network.
// It states two things:
//   1. every model, column, default and index the M1 to M5 bundles code against
//      exists exactly as docs/jobright-clone/orch/market-bundles.json lists it;
//   2. the change is additive: the fields and indexes the touched models had
//      before this bundle (FROZEN below, taken from commit 03b140f) are still
//      there with unchanged type text and order, and model AlipayOrder is
//      byte-identical to its text at that commit (MARKET_STRATEGY 5.2 rule A8).
//
// A later schema change that adds a field to one of these models extends the
// expected lists here. A change that removes or retypes one is not additive and
// must not be made to pass by editing FROZEN.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PRISMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA_DIR = join(PRISMA_DIR, 'schema');
const SQL_DIR = join(PRISMA_DIR, 'sql');

/** One dimension for every dense vector column (EMBED_MODEL is requested at this size, MKT-2H). */
const EMBEDDING_DIM = 1024;
const HALFVEC = `Unsupported("halfvec(${EMBEDDING_DIM})")`;

type Field = [name: string, type: string];
interface FrozenModel {
  file: string;
  fields: Field[];
  attributes: string[];
}
interface ParsedModel {
  block: string;
  fields: Field[];
  attributes: string[];
}

const schemaFiles = readdirSync(SCHEMA_DIR)
  .filter((f) => f.endsWith('.prisma'))
  .sort();
const schemaText = (file: string) => readFileSync(join(SCHEMA_DIR, file), 'utf8');
const allSchemaText = schemaFiles.map(schemaText).join('\n');

/** `model X {` … `}` including the closing line, or null. */
function modelBlock(file: string, name: string): string | null {
  return new RegExp(`^model ${name} \\{\\n[\\s\\S]*?^\\}\\n`, 'm').exec(schemaText(file))?.[0] ?? null;
}

/** Fields as [name, 'Type attributes'] and @@ attributes, comments removed, whitespace collapsed. */
function parseModel(file: string, name: string): ParsedModel {
  const block = modelBlock(file, name);
  if (block === null) throw new Error(`model ${name} is not declared in ${file}`);
  const fields: Field[] = [];
  const attributes: string[] = [];
  for (const raw of block.split('\n').slice(1, -2)) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const clean = line.replace(/\s+\/\/.*$/, '').replace(/\s+/g, ' ');
    if (clean.startsWith('@@')) attributes.push(clean);
    else {
      const at = clean.indexOf(' ');
      fields.push([clean.slice(0, at), clean.slice(at + 1)]);
    }
  }
  return { block, fields, attributes };
}

const modelNamesIn = (file: string) => [...schemaText(file).matchAll(/^model (\w+) \{$/gm)].map((m) => m[1]);
const names = (fields: Field[]) => fields.map(([name]) => name);

/** The frozen fields with `added` inserted directly after the field named `after`. */
function withFieldsAfter(frozen: Field[], after: string, added: Field[]): Field[] {
  const at = frozen.findIndex(([name]) => name === after);
  if (at === -1) throw new Error(`no frozen field ${after}`);
  return [...frozen.slice(0, at + 1), ...added, ...frozen.slice(at + 1)];
}

/** Every listed field has a `///` comment on the line above it (what it holds, which requirement writes it). */
function expectDocumented(block: string, fieldNames: string[]) {
  const lines = block.split('\n').map((l) => l.trim());
  for (const name of fieldNames) {
    const at = lines.findIndex((l) => l.startsWith(`${name} `));
    expect(at, name).toBeGreaterThan(0);
    expect(lines[at - 1], `${name} needs a /// comment`).toMatch(/^\/\/\//);
  }
}

// ── What the touched models looked like before MKT-0 (commit 03b140f) ────────

const FROZEN: Record<string, FrozenModel> = {
  RAJob: {
    file: 'ra-jobs.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['externalId', 'String'],
      ['sourceBoard', 'String'],
      ['applyUrl', 'String'],
      ['title', 'String'],
      ['titleNormalized', 'String'],
      ['companyName', 'String'],
      ['companyNameNormalized', 'String'],
      ['companyLogoUrl', 'String?'],
      ['location', 'String?'],
      ['locationCity', 'String?'],
      ['locationCountry', 'String?'],
      ['workType', 'String @default("onsite")'],
      ['employmentType', 'String?'],
      ['salaryMin', 'Int?'],
      ['salaryMax', 'Int?'],
      ['salaryCurrency', 'String? @default("USD")'],
      ['salaryPeriod', 'String? @default("year")'],
      ['description', 'String @db.Text'],
      ['descriptionPlain', 'String @db.Text'],
      ['qualifications', 'String? @db.Text'],
      ['responsibilities', 'String? @db.Text'],
      ['benefits', 'String? @db.Text'],
      ['postedAt', 'DateTime?'],
      ['seedTags', 'Json?'],
      ['archivedAt', 'DateTime?'],
      ['createdAt', 'DateTime @default(now())'],
      ['updatedAt', 'DateTime @updatedAt'],
      ['trackerEntries', 'RATrackerEntry[]'],
      ['resumeVariants', 'RAResumeVariant[] @relation("RAResumeVariantTargetJob")'],
      ['keywordExtraction', 'RAKeywordExtraction?'],
      ['matchScores', 'RAJobMatchScore[]'],
      ['market', 'String @default("intl")'],
      ['visibility', 'String @default("public")'],
      ['ownerUserId', 'String?'],
      ['owner', 'User? @relation("RAJobOwner", fields: [ownerUserId], references: [id], onDelete: Cascade)'],
      ['companyId', 'String?'],
      ['company', 'RACompany? @relation(fields: [companyId], references: [id], onDelete: SetNull)'],
      ['taxonomyIds', 'String[] @default([])'],
      ['primaryTaxonomyId', 'String?'],
      ['seniority', 'String?'],
      ['roleType', 'String?'],
      ['minYears', 'Int?'],
      ['maxYears', 'Int?'],
      ['educationLevel', 'String?'],
      ['skills', 'String[] @default([])'],
      ['skillsDetail', 'Json?'],
      ['workModel', 'String?'],
      ['remoteScope', 'String?'],
      ['locationRegion', 'String?'],
      ['locations', 'Json?'],
      ['geoLat', 'Float?'],
      ['geoLng', 'Float?'],
      ['salarySource', 'String?'],
      ['salaryAnnualMin', 'Int?'],
      ['salaryAnnualMax', 'Int?'],
      ['salaryMonths', 'Int?'],
      ['salaryDisclosed', 'Boolean @default(false)'],
      ['salaryText', 'String?'],
      ['sponsorship', 'String?'],
      ['sponsorshipEvidence', 'String?'],
      ['citizenshipRequired', 'Boolean?'],
      ['clearanceRequired', 'Boolean?'],
      ['employerTags', 'String[] @default([])'],
      ['sourceUrl', 'String?'],
      ['sourceName', 'String?'],
      ['originalSourceName', 'String?'],
      ['originalHost', 'String?'],
      ['atsType', 'String?'],
      ['isAgency', 'Boolean?'],
      ['fromRecruiterBank', 'Boolean @default(false)'],
      ['employerVerified', 'Boolean @default(false)'],
      ['applicantCount', 'Int?'],
      ['applicantCountSource', 'String?'],
      ['applicantCountAt', 'DateTime?'],
      ['postedAtEstimated', 'Boolean @default(false)'],
      ['firstSeenAt', 'DateTime @default(now())'],
      ['lastSeenAt', 'DateTime @default(now())'],
      ['expiresAt', 'DateTime?'],
      ['closedAt', 'DateTime?'],
      ['closeReason', 'String?'],
      ['lastSeenQueryId', 'String?'],
      ['lastSeenRun', 'Int?'],
      ['fraudFlags', 'Json?'],
      ['marketTags', 'Json?'],
      ['dedupeKey', 'String?'],
      ['canonicalJobId', 'String?'],
      ['isCanonical', 'Boolean @default(true)'],
      ['sourcePriority', 'Int @default(50)'],
      ['searchText', 'String @default("")'],
      ['summary', 'String? @db.Text'],
      ['enrichedAt', 'DateTime?'],
      ['enrichVersion', 'Int?'],
      ['enrichModel', 'String?'],
      ['slug', 'String?'],
      ['publicDisplay', 'Boolean @default(false)'],
      ['userStates', 'RAJobUserState[]'],
      ['cnFraudReviews', 'RACnFraudReview[]'],
      ['reviews', 'RAJobReview[]'],
    ],
    attributes: [
      '@@unique([externalId, sourceBoard])',
      '@@index([workType, archivedAt])',
      '@@index([locationCity, archivedAt])',
      '@@index([postedAt(sort: Desc), archivedAt])',
      '@@index([salaryMin(sort: Desc), archivedAt])',
      '@@index([archivedAt])',
      '@@index([market, isCanonical, archivedAt, postedAt(sort: Desc)])',
      '@@index([market, locationCountry, workModel, archivedAt])',
      '@@index([taxonomyIds], type: Gin)',
      '@@index([skills], type: Gin)',
      '@@index([searchText(ops: raw("gin_trgm_ops"))], type: Gin)',
      '@@index([dedupeKey])',
      '@@index([companyId, archivedAt])',
      '@@index([expiresAt])',
      '@@index([enrichedAt])',
      '@@index([ownerUserId])',
      '@@index([salaryCurrency, salaryAnnualMax])',
      '@@index([lastSeenQueryId])',
      '@@index([market, isCanonical, archivedAt, firstSeenAt(sort: Desc)])',
      '@@index([employerTags], type: Gin)',
      '@@index([geoLat, geoLng])',
      '@@index([sourceBoard, externalId(ops: raw("text_pattern_ops"))])',
    ],
  },
  RACareerSiteSource: {
    file: 'ra-jobs.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['market', 'String @default("intl")'],
      ['ats', 'String'],
      ['boardToken', 'String'],
      ['companyName', 'String'],
      ['companyId', 'String?'],
      ['countryCode', 'String?'],
      ['enabled', 'Boolean @default(true)'],
      ['lastSyncedAt', 'DateTime?'],
      ['lastJobCount', 'Int?'],
      ['lastError', 'String?'],
      ['createdBy', 'String?'],
      ['createdAt', 'DateTime @default(now())'],
      ['updatedAt', 'DateTime @updatedAt'],
    ],
    attributes: [
      '@@unique([ats, boardToken])',
      '@@index([market, enabled, lastSyncedAt])',
    ],
  },
  RAJobMatchScore: {
    file: 'ra-match.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['userId', 'String'],
      ['user', 'User @relation(fields: [userId], references: [id], onDelete: Cascade)'],
      ['jobId', 'String'],
      ['job', 'RAJob @relation(fields: [jobId], references: [id], onDelete: Cascade)'],
      ['resumeVariantId', 'String'],
      ['resumeVariant', 'RAResumeVariant @relation(fields: [resumeVariantId], references: [id], onDelete: Cascade)'],
      ['score', 'Int'],
      ['explanation', 'Json'],
      ['resumeContentHashAtScore', 'String'],
      ['modelUsed', 'String'],
      ['tokenCost', 'Decimal? @db.Decimal(10, 6)'],
      ['generatedAt', 'DateTime @default(now())'],
      ['scoreKind', 'String @default("ai")'],
      ['tier', 'String?'],
      ['dimensions', 'Json?'],
      ['promptVersion', 'String?'],
      ['locale', 'String?'],
      ['searchProfileVersion', 'Int?'],
    ],
    attributes: [
      '@@unique([userId, jobId, resumeVariantId])',
      '@@index([userId, score(sort: Desc)])',
      '@@index([jobId, score(sort: Desc)])',
      '@@index([generatedAt])',
      '@@index([userId, tier, generatedAt(sort: Desc)])',
    ],
  },
  RAUserAffinity: {
    file: 'ra-feed.prisma',
    fields: [
      ['userId', 'String @id'],
      ['user', 'User @relation(fields: [userId], references: [id], onDelete: Cascade)'],
      ['taxonomyWeights', 'Json @default("{}")'],
      ['companyWeights', 'Json @default("{}")'],
      ['skillWeights', 'Json @default("{}")'],
      ['updatedAt', 'DateTime @updatedAt'],
    ],
    attributes: [
    ],
  },
  RATailorSession: {
    file: 'ra-resume.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['userId', 'String'],
      ['user', 'User @relation(fields: [userId], references: [id], onDelete: Cascade)'],
      ['baseVariantId', 'String'],
      ['baseVariant', 'RAResumeVariant @relation("TailorBase", fields: [baseVariantId], references: [id], onDelete: Cascade)'],
      ['resultVariantId', 'String?'],
      ['resultVariant', 'RAResumeVariant? @relation("TailorResult", fields: [resultVariantId], references: [id], onDelete: SetNull)'],
      ['jobId', 'String?'],
      ['jdSnapshot', 'Json?'],
      ['mode', 'String @default("guided")'],
      ['sections', 'String[] @default([])'],
      ['customPrompt', 'String?'],
      ['keywordsSelected', 'String[] @default([])'],
      ['scoreBefore', 'Int?'],
      ['scoreAfter', 'Int?'],
      ['claims', 'Json @default("[]")'],
      ['status', 'String @default("draft")'],
      ['baseContentHash', 'String?'],
      ['creditLedgerId', 'String?'],
      ['createdAt', 'DateTime @default(now())'],
      ['updatedAt', 'DateTime @updatedAt'],
    ],
    attributes: [
      '@@index([userId, jobId])',
      '@@index([baseVariantId])',
      '@@index([resultVariantId])',
    ],
  },
  RACreditWindow: {
    file: 'ra-credits.prisma',
    fields: [
      ['userId', 'String'],
      ['user', 'User @relation(fields: [userId], references: [id], onDelete: Cascade)'],
      ['bucket', 'String'],
      ['windowKey', 'String'],
      ['used', 'Int @default(0)'],
      ['reserved', 'Int @default(0)'],
      ['updatedAt', 'DateTime @updatedAt'],
    ],
    attributes: [
      '@@id([userId, bucket, windowKey])',
    ],
  },
  RACreditLedger: {
    file: 'ra-credits.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['userId', 'String'],
      ['user', 'User @relation(fields: [userId], references: [id], onDelete: Cascade)'],
      ['bucket', 'String'],
      ['amount', 'Int'],
      ['status', 'String'],
      ['fromSource', 'String'],
      ['windowKey', 'String?'],
      ['idempotencyKey', 'String @unique'],
      ['refType', 'String?'],
      ['refId', 'String?'],
      ['sku', 'String?'],
      ['createdAt', 'DateTime @default(now())'],
      ['settledAt', 'DateTime?'],
    ],
    attributes: [
      '@@index([userId, bucket, createdAt(sort: Desc)])',
      '@@index([status, createdAt])',
    ],
  },
  RACreditGrant: {
    file: 'ra-credits.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['userId', 'String'],
      ['user', 'User @relation(fields: [userId], references: [id], onDelete: Cascade)'],
      ['bucket', 'String'],
      ['amount', 'Int'],
      ['remaining', 'Int'],
      ['reason', 'String'],
      ['expiresAt', 'DateTime?'],
      ['createdAt', 'DateTime @default(now())'],
    ],
    attributes: [
      '@@index([userId, bucket, expiresAt])',
    ],
  },
  RAEntitlementOverride: {
    file: 'ra-credits.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['userId', 'String'],
      ['user', 'User @relation(fields: [userId], references: [id], onDelete: Cascade)'],
      ['key', 'String'],
      ['value', 'Json'],
      ['reason', 'String'],
      ['adminId', 'String?'],
      ['expiresAt', 'DateTime?'],
      ['createdAt', 'DateTime @default(now())'],
    ],
    attributes: [
      '@@index([userId, key])',
    ],
  },
  RACancelSurvey: {
    file: 'ra-credits.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['userId', 'String'],
      ['user', 'User @relation(fields: [userId], references: [id], onDelete: Cascade)'],
      ['brand', 'String'],
      ['reason', 'String?'],
      ['note', 'String? @db.Text'],
      ['subscriptionId', 'String?'],
      ['createdAt', 'DateTime @default(now())'],
    ],
    attributes: [
      '@@index([brand, createdAt])',
      '@@index([userId])',
    ],
  },
};

/** model AlipayOrder (legacy.prisma) exactly as it was at commit 03b140f. Never edit: rule A8. */
const ALIPAY_ORDER_AT_BASE = [
  "model AlipayOrder {",
  "  id          String    @id @default(cuid())",
  "  userId      String",
  "  outTradeNo  String    @unique",
  "  tier        String // starter, growth, business",
  "  amount      Float // payment amount in CNY",
  "  status      String    @default(\"pending\") // pending, completed, failed, closed",
  "  completedAt DateTime?",
  "  createdAt   DateTime  @default(now())",
  "",
  "  // ── Jobright clone (FND-1b; ARCH §2.2, CN plan §4.1(4), TASK_PLAN.md R-15/R-17) ──",
  "  // The model name is kept for callback compatibility; it now records any",
  "  // CN-rail order (Alipay or WeChat Pay). Existing rows read as Alipay.",
  "  channel         String  @default(\"alipay\") // 'alipay' | 'wechatpay'",
  "  brand           String? // 'roboapply' | 'goapply'; set on every write from now on",
  "  planKey         String? // R-08 plan key, e.g. 'pro_monthly' | 'pro_week_pass'",
  "  // 'subscription' | 'interview_pack' only. Never 'coaching' on the CN rails:",
  "  // the platform must not collect money on a coach's behalf (no 二清).",
  "  purpose         String  @default(\"subscription\")",
  "  amountMinor     Int? // fen; `amount` (Float yuan) stays for legacy readers",
  "  relatedId       String? // reserved",
  "  wxPrepayId      String? // WeChat Pay v3 prepay_id",
  "  wxCodeUrl       String? // WeChat Pay NATIVE code_url (QR)",
  "  wxTransactionId String? // WeChat Pay transaction_id from the notify",
  "  tradeType       String? // WeChat Pay: 'NATIVE' | 'H5' | 'JSAPI'",
  "  // SCHEMA-4 (WP-62): the 用户协议 (CN_LEGAL_DOCS_VERSION) version accepted for",
  "  // this order. Older orders: the `cn_pay_terms_ack` SeekerConsentRecord.",
  "  termsVersion    String?",
  "",
  "  user User @relation(fields: [userId], references: [id], onDelete: Cascade)",
  "",
  "  @@index([userId])",
  "  @@index([outTradeNo])",
  "  @@index([status])",
  "  @@index([channel, status])",
  "}",
  "",
].join('\n');

// ── What MKT-0 adds ─────────────────────────────────────────────────────────

const RAJOB_ADDED: Field[] = [
  ['atsPostingKey', 'String?'],
  ['sponsorshipSource', 'String?'],
  ['locationDistrict', 'String?'],
  ['workShift', 'String?'],
  ['titleMatchScore', 'Float? @db.Real'],
  ['skillIds', 'String[] @default([])'],
  ['searchDoc', 'String? @db.Text'],
  ['searchTsv', 'Unsupported("tsvector")?'],
  ['contentHash', 'String?'],
  ['lang', 'String?'],
  ['requirements', 'Json?'],
  ['embedding', 'RAJobEmbedding?'],
];
const RAJOB_ADDED_INDEXES = [
  '@@index([market, atsPostingKey])',
  '@@index([market, locationCountry, locationDistrict])',
  '@@index([skillIds], type: Gin)',
  // Plain form: `npx prisma validate` accepts a GIN index on the Unsupported column, so no
  // raw operator class is declared and nothing was added to schema-diffs/KNOWN_DRIFT.md.
  '@@index([searchTsv], type: Gin)',
];

const CAREER_SITE_ADDED: Field[] = [
  ['origin', 'String @default("admin")'],
  ['discoveredFrom', 'String?'],
  ['countries', 'String[] @default([])'],
  ['failCount', 'Int @default(0)'],
  ['lastChangeAt', 'DateTime?'],
  ['nextSyncAt', 'DateTime?'],
  ['disabledAt', 'DateTime?'],
];

const NEW_MODELS: Record<string, FrozenModel> = {
  RASponsorRegisterEntry: {
    file: 'ra-jobs.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['source', 'String'],
      ['country', 'String'],
      ['employerNameNormalized', 'String'],
      ['employerName', 'String'],
      ['period', 'String @default("")'],
      ['approvals', 'Int?'],
      ['denials', 'Int?'],
      ['town', 'String?'],
      ['rating', 'String?'],
      ['routes', 'String[] @default([])'],
      ['sourceFile', 'String'],
      ['sourceUrl', 'String'],
      ['asOf', 'DateTime'],
      ['importedAt', 'DateTime @default(now())'],
    ],
    attributes: ['@@unique([source, employerNameNormalized, period])', '@@index([country, employerNameNormalized])'],
  },
  RAJobEmbedding: {
    file: 'ra-retrieval.prisma',
    fields: [
      ['jobId', 'String @id'],
      ['job', 'RAJob @relation(fields: [jobId], references: [id], onDelete: Cascade)'],
      ['market', 'String'],
      ['model', 'String'],
      ['contentHash', 'String'],
      ['embedding', HALFVEC],
      ['embeddedAt', 'DateTime @default(now())'],
    ],
    attributes: ['@@index([market, model])'],
  },
  RAUserEmbedding: {
    file: 'ra-retrieval.prisma',
    fields: [
      ['userId', 'String'],
      ['user', 'User @relation(fields: [userId], references: [id], onDelete: Cascade)'],
      ['market', 'String'],
      ['kind', 'String'],
      ['model', 'String'],
      ['sourceHash', 'String'],
      ['embedding', HALFVEC],
      ['updatedAt', 'DateTime @default(now())'],
    ],
    attributes: ['@@id([userId, market, kind])'],
  },
  RASkill: {
    file: 'ra-skills.prisma',
    fields: [
      ['id', 'String @id'],
      ['kind', 'String @default("hard")'],
      ['labelEn', 'String'],
      ['labelZh', 'String?'],
      ['labelZhHant', 'String?'],
      ['aliases', 'String[] @default([])'],
      ['parentId', 'String?'],
      ['esco', 'String?'],
      ['onet', 'String?'],
      ['status', 'String @default("unreviewed")'],
      ['mentionCount', 'Int @default(0)'],
      ['embedding', `${HALFVEC}?`],
      ['embeddingModel', 'String?'],
      ['createdAt', 'DateTime @default(now())'],
      ['updatedAt', 'DateTime @updatedAt'],
    ],
    attributes: ['@@index([aliases], type: Gin)', '@@index([parentId])', '@@index([status, mentionCount(sort: Desc)])'],
  },
  RABillingRefund: {
    file: 'ra-credits.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['userId', 'String'],
      ['brand', 'String'],
      ['rail', 'String'],
      ['kind', 'String'],
      ['externalRef', 'String'],
      ['chargeId', 'String?'],
      ['paymentIntentId', 'String?'],
      ['invoiceId', 'String?'],
      ['checkoutSessionId', 'String?'],
      ['alipayOrderId', 'String?'],
      ['planKey', 'String?'],
      ['amountMinor', 'Int'],
      ['currency', 'String'],
      ['full', 'Boolean @default(false)'],
      ['entitlementReversed', 'Boolean @default(false)'],
      ['reason', 'String?'],
      ['actor', 'String?'],
      ['note', 'String? @db.Text'],
      ['createdAt', 'DateTime @default(now())'],
    ],
    attributes: [
      '@@unique([rail, externalRef])',
      '@@index([userId, createdAt(sort: Desc)])',
      '@@index([invoiceId])',
      '@@index([alipayOrderId])',
      '@@index([kind, createdAt])',
    ],
  },
  RABillingConsentArchive: {
    file: 'ra-credits.prisma',
    fields: [
      ['id', 'String @id @default(cuid())'],
      ['userId', 'String'],
      ['emailHash', 'String'],
      ['brand', 'String'],
      ['consentType', 'String'],
      ['proseHash', 'String?'],
      ['proseVersion', 'String?'],
      ['consentedAt', 'DateTime'],
      ['subscriptionEndedAt', 'DateTime?'],
      ['stripeCustomerId', 'String?'],
      ['retainUntil', 'DateTime'],
      ['createdAt', 'DateTime @default(now())'],
    ],
    // The unique key is beyond the plan's list (MKT-0 review): one row per acknowledgement, so a
    // repeated or overlapping purge cannot archive it twice (MKT-4A writes with skipDuplicates).
    attributes: ['@@unique([userId, consentType, consentedAt])', '@@index([retainUntil])', '@@index([emailHash])', '@@index([userId])'],
  },
};

function expectNewModel(name: string) {
  const expected = NEW_MODELS[name];
  const model = parseModel(expected.file, name);
  expect(model.fields).toEqual(expected.fields);
  expect(model.attributes).toEqual(expected.attributes);
  return model;
}

/** Each model is declared once, in the file the plan names. */
function expectDeclaredOnlyIn(name: string, file: string) {
  const declaredIn = schemaFiles.filter((f) => modelNamesIn(f).includes(name));
  expect(declaredIn, name).toEqual([file]);
}

// ── Item 1: job index ───────────────────────────────────────────────────────

describe('MKT-0 item 1: RAJob, RACareerSiteSource and the sponsor register (ra-jobs.prisma)', () => {
  const job = parseModel('ra-jobs.prisma', 'RAJob');
  const source = parseModel('ra-jobs.prisma', 'RACareerSiteSource');

  it('RAJob has the twelve new fields, each with its type and default', () => {
    const byName = new Map(job.fields);
    for (const [name, type] of RAJOB_ADDED) expect(byName.get(name), name).toBe(type);
    expect(RAJOB_ADDED).toHaveLength(12);
  });

  it('the new block sits directly above the relation line userStates, under its header comment, and nothing else moved', () => {
    expect(job.fields).toEqual(withFieldsAfter(FROZEN.RAJob.fields, 'publicDisplay', RAJOB_ADDED));
    const order = names(job.fields);
    expect(order[order.indexOf('userStates') - 1]).toBe('embedding');
    expect(job.block).toContain('// ── Market wave (MKT-0; MARKET_STRATEGY 2.3 and 7 item 11). Additive. ──');
    expectDocumented(job.block, names(RAJOB_ADDED));
  });

  it('RAJob keeps every index it had, in order, and gains four after the last one', () => {
    expect(job.attributes).toEqual([...FROZEN.RAJob.attributes, ...RAJOB_ADDED_INDEXES]);
  });

  it('searchTsv is a plain nullable Unsupported column with a declared GIN index, not a generated column', () => {
    expect(new Map(job.fields).get('searchTsv')).toBe('Unsupported("tsvector")?');
    expect(job.attributes).toContain('@@index([searchTsv], type: Gin)');
    expect(allSchemaText).not.toMatch(/dbgenerated/);
    // The only tsvector column of the schema.
    expect(allSchemaText.match(/Unsupported\("tsvector"\)/g)).toHaveLength(1);
  });

  it('the schema warns raw-SQL writers that searchTsv cannot be returned bare', () => {
    // @prisma/adapter-pg throws UnsupportedNativeDataType for the built-in type; a fake-Prisma unit test cannot catch it.
    expect(job.block).toMatch(/Never `SELECT \*`, `SELECT j\.\*` or\s+\/\/ `RETURNING \*`/);
    expect(job.block).toContain('UnsupportedNativeDataType');
    expect(job.block).toContain('"searchTsv"::text');
  });

  it('what already existed was not declared a second time', () => {
    const counts = new Map<string, number>();
    for (const name of names(job.fields)) counts.set(name, (counts.get(name) ?? 0) + 1);
    const duplicates = [...counts].filter(([, count]) => count > 1).map(([name]) => name);
    expect(duplicates).toEqual([]);
    const byName = new Map(job.fields);
    // SR-16b-1 and the columns the item names as present: unchanged, declared once.
    expect(byName.get('lastSeenQueryId')).toBe('String?');
    expect(byName.get('lastSeenRun')).toBe('Int?');
    expect(byName.get('skills')).toBe('String[] @default([])');
    expect(byName.get('sponsorship')).toBe('String?');
    expect(byName.get('sponsorshipEvidence')).toBe('String?');
    expect(byName.get('searchText')).toBe('String @default("")');
    expect(new Map(parseModel('ra-jobs.prisma', 'RAIngestQuery').fields).get('runCount')).toBe('Int @default(0)');
  });

  it('RACareerSiteSource has the seven new fields after lastError and one new index', () => {
    expect(source.fields).toEqual(withFieldsAfter(FROZEN.RACareerSiteSource.fields, 'lastError', CAREER_SITE_ADDED));
    expect(source.attributes).toEqual([...FROZEN.RACareerSiteSource.attributes, '@@index([enabled, nextSyncAt])']);
    expectDocumented(source.block, names(CAREER_SITE_ADDED));
  });

  it('RACareerSiteSource keeps market, countryCode, the unique key and its index exactly as they were', () => {
    const byName = new Map(source.fields);
    expect(byName.get('market')).toBe('String @default("intl")');
    expect(byName.get('countryCode')).toBe('String?');
    expect(source.attributes).toContain('@@unique([ats, boardToken])');
    expect(source.attributes).toContain('@@index([market, enabled, lastSyncedAt])');
  });

  it('RASponsorRegisterEntry exists with its unique (source, employerNameNormalized, period), no relation field, at the end of the file', () => {
    const model = expectNewModel('RASponsorRegisterEntry');
    expect(model.block).not.toContain('@relation');
    expectDeclaredOnlyIn('RASponsorRegisterEntry', 'ra-jobs.prisma');
    expect(modelNamesIn('ra-jobs.prisma').at(-1)).toBe('RASponsorRegisterEntry');
    expect(schemaText('ra-jobs.prisma').endsWith(model.block)).toBe(true);
  });

  it('ra-jobs.prisma declares the models it had plus the sponsor register, and no other', () => {
    expect(modelNamesIn('ra-jobs.prisma')).toEqual([
      'RAJob',
      'RACompany',
      'RAIngestQuery',
      'RAProviderUsage',
      'RAH1bEmployerStat',
      'RACareerSiteSource',
      'RAJobReview',
      'RASponsorRegisterEntry',
    ]);
  });
});

// ── Item 2: fit, affinity, tailoring ────────────────────────────────────────

describe('MKT-0 item 2: four additive columns on RAJobMatchScore, RAUserAffinity and RATailorSession', () => {
  it('RAJobMatchScore gains jobContentHash and rubricVersion after searchProfileVersion; its unique key and indexes are unchanged', () => {
    const model = parseModel('ra-match.prisma', 'RAJobMatchScore');
    const added: Field[] = [
      ['jobContentHash', 'String?'],
      ['rubricVersion', 'String?'],
    ];
    expect(model.fields).toEqual(withFieldsAfter(FROZEN.RAJobMatchScore.fields, 'searchProfileVersion', added));
    expect(model.attributes).toEqual(FROZEN.RAJobMatchScore.attributes);
    expect(model.attributes).toContain('@@unique([userId, jobId, resumeVariantId])');
    expectDocumented(model.block, names(added));
  });

  it('RAUserAffinity gains titleWeights Json @default("{}") after skillWeights', () => {
    const model = parseModel('ra-feed.prisma', 'RAUserAffinity');
    const added: Field[] = [['titleWeights', 'Json @default("{}")']];
    expect(model.fields).toEqual(withFieldsAfter(FROZEN.RAUserAffinity.fields, 'skillWeights', added));
    expect(model.attributes).toEqual(FROZEN.RAUserAffinity.attributes);
    expectDocumented(model.block, names(added));
  });

  it('RATailorSession gains fitSnapshot Json? after scoreAfter', () => {
    const model = parseModel('ra-resume.prisma', 'RATailorSession');
    const added: Field[] = [['fitSnapshot', 'Json?']];
    expect(model.fields).toEqual(withFieldsAfter(FROZEN.RATailorSession.fields, 'scoreAfter', added));
    expect(model.attributes).toEqual(FROZEN.RATailorSession.attributes);
    expectDocumented(model.block, names(added));
  });

  it('every added column is nullable or has a default, so existing rows and writers stay valid', () => {
    const added: Field[] = [
      ...RAJOB_ADDED.filter(([name]) => name !== 'embedding'),
      ...CAREER_SITE_ADDED,
      ['jobContentHash', 'String?'],
      ['rubricVersion', 'String?'],
      ['titleWeights', 'Json @default("{}")'],
      ['fitSnapshot', 'Json?'],
    ];
    for (const [name, type] of added) {
      const optional = /^\S+\?/.test(type) || /^Unsupported\("[^"]+"\)\?/.test(type);
      expect(optional || type.includes('@default('), `${name} ${type}`).toBe(true);
    }
  });
});

// ── Item 3: vector extension, embedding tables, skill vocabulary ────────────

describe('MKT-0 item 3: the vector extension file, RAJobEmbedding, RAUserEmbedding and RASkill', () => {
  it('RAJobEmbedding: jobId primary key, cascade relation to RAJob, market, model, contentHash, halfvec, index (market, model)', () => {
    const model = expectNewModel('RAJobEmbedding');
    expect(new Map(model.fields).get('job')).toContain('onDelete: Cascade');
    expectDeclaredOnlyIn('RAJobEmbedding', 'ra-retrieval.prisma');
  });

  it('RAUserEmbedding: cascade relation to User, composite id (userId, market, kind)', () => {
    const model = expectNewModel('RAUserEmbedding');
    expect(new Map(model.fields).get('user')).toContain('onDelete: Cascade');
    expectDeclaredOnlyIn('RAUserEmbedding', 'ra-retrieval.prisma');
  });

  it('market is a required column with no default on both embedding tables: vectors never cross markets', () => {
    for (const name of ['RAJobEmbedding', 'RAUserEmbedding']) {
      expect(new Map(parseModel('ra-retrieval.prisma', name).fields).get('market'), name).toBe('String');
    }
  });

  it('RASkill: the canonical vocabulary with an optional label vector, GIN on aliases and no relation field', () => {
    const model = expectNewModel('RASkill');
    expect(model.block).not.toContain('@relation');
    expectDeclaredOnlyIn('RASkill', 'ra-skills.prisma');
    expect(modelNamesIn('ra-skills.prisma')).toEqual(['RASkill']);
    expect(modelNamesIn('ra-retrieval.prisma')).toEqual(['RAJobEmbedding', 'RAUserEmbedding']);
  });

  it(`every vector column is halfvec(${EMBEDDING_DIM}): three places, one dimension`, () => {
    const dims = [...allSchemaText.matchAll(/Unsupported\("halfvec\((\d+)\)"\)/g)].map((m) => Number(m[1]));
    expect(dims).toEqual([EMBEDDING_DIM, EMBEDDING_DIM, EMBEDDING_DIM]);
    expect(new Map(parseModel('ra-retrieval.prisma', 'RAJobEmbedding').fields).get('embedding')).toBe(HALFVEC);
    expect(new Map(parseModel('ra-retrieval.prisma', 'RAUserEmbedding').fields).get('embedding')).toBe(HALFVEC);
    expect(new Map(parseModel('ra-skills.prisma', 'RASkill').fields).get('embedding')).toBe(`${HALFVEC}?`);
    // No other spelling of a vector type anywhere in the schema, and the SQL file names the same size.
    expect(allSchemaText.match(/\b(half)?vec(tor)?\(\d+\)/g)).toHaveLength(3);
    const sqlDims = [...readFileSync(join(SQL_DIR, '001_vector.sql'), 'utf8').matchAll(/halfvec\((\d+)\)/g)].map((m) => Number(m[1]));
    expect(sqlDims.length).toBeGreaterThan(0);
    for (const dim of sqlDims) expect(dim).toBe(EMBEDDING_DIM);
  });

  it('the schema has exactly four Unsupported columns: the three vectors and RAJob.searchTsv', () => {
    expect(allSchemaText.match(/Unsupported\("[^"]+"\)/g)?.sort()).toEqual(
      ['Unsupported("halfvec(1024)")', 'Unsupported("halfvec(1024)")', 'Unsupported("halfvec(1024)")', 'Unsupported("tsvector")'].sort(),
    );
  });

  it('model User gains exactly one line: the back-relation raUserEmbeddings', () => {
    const legacy = schemaText('legacy.prisma');
    const mentions = legacy.split('\n').filter((line) => /\bRAUserEmbedding\b/.test(line));
    expect(mentions).toHaveLength(1);
    expect(mentions[0].trim().replace(/\s+\/\/.*$/, '').replace(/\s+/g, ' ')).toBe('raUserEmbeddings RAUserEmbedding[]');
    const user = parseModel('legacy.prisma', 'User');
    expect(new Map(user.fields).get('raUserEmbeddings')).toBe('RAUserEmbedding[]');
    // It sits with the other ra* relations, and no other new model reaches into legacy.prisma.
    const order = names(user.fields);
    expect(order[order.indexOf('raUserEmbeddings') - 1]).toBe('raCancelSurveys');
    expect(order[order.indexOf('raUserEmbeddings') + 1]).toBe('raJobsOwned');
    expect(legacy).not.toMatch(/\b(RAJobEmbedding|RASkill|RASponsorRegisterEntry|RABillingRefund|RABillingConsentArchive)\b/);
  });

  it('001_vector.sql holds exactly one executable statement and creates no table and no index', () => {
    const sql = readFileSync(join(SQL_DIR, '001_vector.sql'), 'utf8');
    const statements = sql
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toEqual(['CREATE EXTENSION IF NOT EXISTS vector']);
    expect(sql).not.toMatch(/create\s+table/i);
    expect(sql).not.toMatch(/create\s+(unique\s+)?index/i);
    // The header says who runs it, when, and why the tables and an HNSW index are not here.
    expect(sql).toMatch(/run ONCE by the owner on each database/);
    expect(sql).toMatch(/BEFORE the db push/);
    expect(sql).toMatch(/declared in the Prisma schema/);
    expect(sql).toMatch(/HNSW/);
  });

  it('000_extensions.sql is untouched', () => {
    const sql = readFileSync(join(SQL_DIR, '000_extensions.sql'), 'utf8');
    expect(sql.trimEnd().endsWith('CREATE EXTENSION IF NOT EXISTS pg_trgm;')).toBe(true);
  });

  it('no file under server/prisma/sql/ mentions GENERATED or tsvector: the text-search column and its index live in the schema', () => {
    const files = readdirSync(SQL_DIR).sort();
    expect(files).toEqual(expect.arrayContaining(['000_extensions.sql', '001_vector.sql', 'README.md']));
    for (const file of files) {
      const text = readFileSync(join(SQL_DIR, file), 'utf8');
      expect(text, file).not.toMatch(/GENERATED/);
      expect(text, file).not.toMatch(/generated\s+(always|by\s+default)/i);
      expect(text, file).not.toMatch(/tsvector/i);
    }
  });
});

// ── Item 4: billing records ─────────────────────────────────────────────────

describe('MKT-0 item 4: RABillingRefund and RABillingConsentArchive; no existing billing table changes', () => {
  it('RABillingRefund: every field, the unique (rail, externalRef) and four indexes', () => {
    const model = expectNewModel('RABillingRefund');
    expect(model.attributes).toContain('@@unique([rail, externalRef])');
    expectDeclaredOnlyIn('RABillingRefund', 'ra-credits.prisma');
  });

  it('RABillingConsentArchive: every field, its three indexes and one row per acknowledgement', () => {
    const model = expectNewModel('RABillingConsentArchive');
    expect(model.attributes).toContain('@@unique([userId, consentType, consentedAt])');
    // The three indexes MKT-4A lists are all still declared.
    for (const index of ['@@index([retainUntil])', '@@index([emailHash])', '@@index([userId])']) expect(model.attributes).toContain(index);
    expectDeclaredOnlyIn('RABillingConsentArchive', 'ra-credits.prisma');
  });

  it('neither model has a relation field: userId is a plain string and no existing model gains a back-relation', () => {
    for (const name of ['RABillingRefund', 'RABillingConsentArchive']) {
      const model = parseModel('ra-credits.prisma', name);
      expect(model.block, name).not.toContain('@relation');
      expect(new Map(model.fields).get('userId'), name).toBe('String');
      for (const [field, type] of model.fields) expect(type, `${name}.${field}`).not.toMatch(/^(User|AlipayOrder|SeekerSubscription)\b/);
    }
    for (const file of schemaFiles.filter((f) => f !== 'ra-credits.prisma')) {
      expect(schemaText(file), file).not.toMatch(/\b(RABillingRefund|RABillingConsentArchive)\b/);
    }
  });

  it('ra-credits.prisma: the two models are appended and the five existing ones are unchanged', () => {
    expect(modelNamesIn('ra-credits.prisma')).toEqual([
      'RACreditWindow',
      'RACreditLedger',
      'RACreditGrant',
      'RAEntitlementOverride',
      'RACancelSurvey',
      'RABillingRefund',
      'RABillingConsentArchive',
    ]);
    for (const name of ['RACreditWindow', 'RACreditLedger', 'RACreditGrant', 'RAEntitlementOverride', 'RACancelSurvey']) {
      const model = parseModel('ra-credits.prisma', name);
      expect(model.fields, name).toEqual(FROZEN[name].fields);
      expect(model.attributes, name).toEqual(FROZEN[name].attributes);
    }
  });

  it('model AlipayOrder is byte-identical to its text at the base commit (rule A8)', () => {
    expect(modelBlock('legacy.prisma', 'AlipayOrder')).toBe(ALIPAY_ORDER_AT_BASE);
  });
});

// ── Across the bundle ───────────────────────────────────────────────────────

describe('MKT-0: nothing that existed before is missing or changed', () => {
  it.each(Object.keys(FROZEN))('%s keeps every field with unchanged type text, and every index', (name) => {
    const frozen = FROZEN[name];
    const model = parseModel(frozen.file, name);
    const byName = new Map(model.fields);
    for (const [field, type] of frozen.fields) expect(byName.get(field), `${name}.${field}`).toBe(type);
    for (const attribute of frozen.attributes) expect(model.attributes, `${name} ${attribute}`).toContain(attribute);
    // Order is kept too: the frozen fields appear in their old sequence.
    const kept = names(model.fields).filter((field) => frozen.fields.some(([f]) => f === field));
    expect(kept).toEqual(names(frozen.fields));
  });

  it('the six new models are declared exactly once across the schema folder', () => {
    for (const [name, expected] of Object.entries(NEW_MODELS)) expectDeclaredOnlyIn(name, expected.file);
  });

  it('the two new area files exist beside the ones the folder had', () => {
    expect(schemaFiles).toEqual(expect.arrayContaining(['_datasource.prisma', 'legacy.prisma', 'ra-jobs.prisma', 'ra-retrieval.prisma', 'ra-skills.prisma']));
  });
});
