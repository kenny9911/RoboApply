// server/src/features/compliance/legalDocs.ts
//
// Legal documents served by GET /api/v1/public/legal/:doc (the web page
// app/legal/[doc] reads the same files itself). Source: counsel-supplied
// markdown in content/legal/<market>/<file>.md with a small front matter:
//
//   ---
//   title: Privacy notice
//   status: draft            # 'draft' until counsel approves the text
//   updated: 2026-10-10
//   ---
//
// Publication rule (TASK_PLAN.md WP-13; CN plan WP-COMPLY; D5 parity,
// GOAPPLY_PARITY_PLAN.md §3.6), the same for both brands:
//   published = LEGAL_DOCS_VERSION is set for the brand (a brand-own value:
//               GoApply reads CN_LEGAL_DOCS_VERSION, never RoboApply's) AND the
//               file is not `status: draft`.
//   Unpublished documents are served with a DRAFT banner, in every
//   environment. GoApply no longer answers 404 for a draft in production: a
//   visitor can read the document that applies to them, marked as a draft.
//
// Placeholders (`{{name}}`) are filled from configuration; an unset value
// renders "Not listed" / "未披露" — never an invented fact. The processing
// facts, the AI endpoint lists and the data-source attributions are rendered
// from the code that enforces them (disclosures.ts), never typed into a file.
//
// `publishedLegalDocVersion(brand, doc)` is what another area records when a
// user accepts a document (billing-cn: the 用户协议 before a WeChat Pay order):
// the version of a PUBLISHED document, null while it is a draft.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import { HttpError } from '../../platform/http.js';
import { resolveLegalDocSlug, type LegalDoc, type LegalDocResponse } from './contract.js';
import { gohireParseForIntl } from './consents.js';
import type { DisclosuresResponse } from './contract.js';
import { buildDisclosures } from './disclosures.js';
import { aiPlaceSentence, offshoreProcessorsSentence } from './processingStatement.js';
import { retentionScheduleMarkdown } from './retention.js';

export interface FrontMatter {
  title?: string;
  status?: string;
  updated?: string;
  [key: string]: string | undefined;
}

/** Split `---\nkey: value\n---\nbody`. Files without front matter return `{}`. */
export function parseFrontMatter(source: string): { meta: FrontMatter; body: string } {
  const text = source.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: FrontMatter = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^['"]|['"]$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

/** Replace `{{key}}`; unknown keys stay visible as `{{key}}` so a reviewer spots them. */
export function fillPlaceholders(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, key: string) => (key in values ? values[key]! : all));
}

function contentRoots(env: EnvSource): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const roots = [
    env.LEGAL_CONTENT_DIR,
    path.join(process.cwd(), 'content/legal'),
    path.join(process.cwd(), '..', 'content/legal'),
    path.resolve(here, '../../../../content/legal'),
    path.resolve(here, '../../../../../content/legal'),
  ];
  return roots.filter((r): r is string => Boolean(r));
}

export function readLegalSource(market: 'intl' | 'cn', file: string, env: EnvSource = process.env): string | null {
  if (!/^[a-z0-9-]+$/.test(file)) return null;
  for (const root of contentRoots(env)) {
    const p = path.join(root, market, `${file}.md`);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

export function legalDocsVersion(brand: ProductBrand, env: EnvSource = process.env): string | null {
  return brandEnv(brand, 'LEGAL_DOCS_VERSION', env) ?? null;
}

function mdTable(header: [string, string, string], rows: string[][], empty: string): string {
  if (rows.length === 0) return empty;
  return [`| ${header.join(' | ')} |`, '| --- | --- | --- |', ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

const PII_KIND_LABELS: Record<string, { en: string; zh: string }> = {
  email: { en: 'email addresses', zh: '邮箱地址' },
  phone: { en: 'phone numbers', zh: '电话号码' },
  address: { en: 'street addresses', zh: '详细地址' },
  prc_id: { en: 'mainland China ID numbers', zh: '居民身份证号码' },
  tw_id: { en: 'Taiwan ID numbers', zh: '台湾身份证号码' },
  us_ssn: { en: 'US Social Security numbers', zh: '美国社会安全号码' },
  gov_id: { en: 'other government ID numbers', zh: '其他证件号码' },
  health: { en: 'health details', zh: '健康信息' },
  known_value: { en: 'identifiers you entered in your profile', zh: '你在个人资料中填写的标识信息' },
};

/** {{processing_facts}}: one line per fact of `residencySummary(brand)`. */
export function processingFactsMarkdown(f: DisclosuresResponse['processing'], zh: boolean): string {
  const lines: string[] = [];
  if (zh) {
    lines.push(`- 本服务的运行地点：${f.region === 'cn-mainland' ? '中国大陆境内' : '中国大陆境外'}。`);
    lines.push(
      f.originalFiles === 'kept'
        ? '- 你上传的简历文件：保存在我们自己的文件存储中。'
        : f.originalFiles === 'not_kept'
          ? '- 你上传的简历文件：只在内存中读取，不保存原文件。'
          : '- 你上传的简历文件：当前部署未开放文件上传。',
    );
    lines.push(
      f.resumeParsing === 'gohire_mainland' && f.resumeParser
        ? `- 简历读取：由位于中国大陆服务器上的 ${f.resumeParser} 解析服务完成。`
        : // 'local' says only that no outside parser is called; AI providers may still read the resume.
          '- 简历读取：不会发送给单独的简历解析服务。由 AI 读取时（包括扫描页和图片），简历内容会发送给 AI 模型服务方。',
    );
    if (f.redactedBeforeStorage.length) lines.push(`- 保存前从简历文字中移除：${f.redactedBeforeStorage.map((k) => PII_KIND_LABELS[k]?.zh ?? k).join('、')}。`);
    if (f.imagesDiscarded) lines.push('- 简历中的照片和图片：不保存。');
  } else {
    lines.push(`- Where this service runs: ${f.region === 'cn-mainland' ? 'in mainland China' : 'outside mainland China'}.`);
    lines.push(
      f.originalFiles === 'kept'
        ? '- Resume files you upload: kept in our own file storage.'
        : f.originalFiles === 'not_kept'
          ? '- Resume files you upload: read in memory only; the original file is not kept.'
          : '- Resume files you upload: file upload is off on this deployment.',
    );
    lines.push(
      f.resumeParsing === 'gohire_mainland' && f.resumeParser
        ? `- Reading your resume: done by the ${f.resumeParser} parsing service on servers in mainland China.`
        : '- Reading your resume: it is not sent to a separate resume-parsing service. When AI reads it, including scanned pages and images, it goes to an AI model provider.',
    );
    if (f.redactedBeforeStorage.length) lines.push(`- Removed from the resume text before it is stored: ${f.redactedBeforeStorage.map((k) => PII_KIND_LABELS[k]?.en ?? k).join(', ')}.`);
    if (f.imagesDiscarded) lines.push('- Photos and images in a resume: not stored.');
  }
  return lines.join('\n');
}

/** {{llm_endpoints}}: the routing policy's own provider and host lists. */
export function llmEndpointsMarkdown(f: DisclosuresResponse['llmEndpoints'], zh: boolean): string {
  const providers = f.providers.map((p) => `${p.provider} (${p.host})`).join(zh ? '、' : ', ');
  const hosts = f.mainlandHosts.join(zh ? '、' : ', ');
  if (f.rule === 'open') {
    // GoApply by default: no host is allowed or refused by rule. The models in use are the models table.
    return zh
      ? `- AI 请求会发送到“AI 模型”表中列出的模型服务，其中可能包括中国大陆境外的服务。可用的提供方及其默认地址：${providers || '未披露'}。`
      : `- AI requests go to the model services in the AI models table, which can include services outside mainland China. Providers we can use and the address each uses by default: ${providers || 'Not listed'}.`;
  }
  if (zh) {
    return f.rule === 'mainland_only'
      ? [`- 只使用中国大陆境内的模型服务。可用的提供方及其默认地址：${providers || '未披露'}。`, `- 允许的模型服务地址（含其子域名）：${hosts}。`].join('\n')
      : [
          `- 带有用户数据的请求不会发送到中国大陆境内的模型服务。可用的提供方及其默认地址：${providers || '未披露'}。`,
          `- 不会使用的地址（含其子域名）：${hosts}。`,
          ...(f.excludedUpstreams.length ? [`- 通过 OpenRouter 调用时排除的上游：${f.excludedUpstreams.join('、')}。`] : []),
        ].join('\n');
  }
  return f.rule === 'mainland_only'
    ? [`- Only model services in mainland China are used. Providers and the address each uses by default: ${providers || 'Not listed'}.`, `- Allowed model addresses (and their subdomains): ${hosts}.`].join('\n')
    : [
        `- A request that carries your data is never sent to a model service in mainland China. Providers we can use and the address each uses by default: ${providers || 'Not listed'}.`,
        `- Addresses that are never used (and their subdomains): ${hosts}.`,
        ...(f.excludedUpstreams.length ? [`- Upstream providers excluded when a request goes through OpenRouter: ${f.excludedUpstreams.join(', ')}.`] : []),
      ].join('\n');
}

const ATTRIBUTION_PURPOSE: Record<string, { en: string; zh: string }> = {
  job_locations: { en: 'City names and map positions for job locations', zh: '职位地点的城市名称和位置' },
  role_categories: { en: 'Job role categories', zh: '职位类别' },
  agency_marking: { en: 'Marking posts from staffing and recruitment firms', zh: '标记人力资源和猎头公司发布的职位' },
};

/** {{data_attributions}}: datasets whose licence requires attribution. */
export function dataAttributionsMarkdown(items: DisclosuresResponse['dataAttributions'], zh: boolean): string {
  if (items.length === 0) return zh ? '目前没有需要署名的第三方数据集。' : 'No third-party dataset that requires attribution is in use.';
  const head = zh ? '| 数据集 | 发布方 | 用途 | 许可 | 数据日期 |' : '| Dataset | Publisher | Used for | Licence | Copy dated |';
  return [
    head,
    '| --- | --- | --- | --- | --- |',
    ...items.map((a) => `| ${a.url ? `[${a.name}](${a.url})` : a.name} | ${a.publisher} | ${ATTRIBUTION_PURPOSE[a.purpose]?.[zh ? 'zh' : 'en'] ?? a.purpose} | ${a.license} | ${a.asOf} |`),
  ].join('\n');
}

/**
 * {{offshore_notice}} (GoApply privacy notice): what the cross-border consent
 * says, in the document's language, or the mainland statement when nothing
 * leaves the mainland on this deployment.
 */
export function crossBorderNoticeMarkdown(brand: ProductBrand, applies: boolean, env: EnvSource = process.env): string {
  if (!applies) return '你的个人信息在中国大陆境内处理和存储。';
  return (
    '你的个人信息会由中国大陆境外的服务处理或存储。' +
    offshoreProcessorsSentence(brand, env, 'zh') +
    aiPlaceSentence(brand, env, 'zh') +
    '只有在你单独同意后才会这样处理；撤回该同意会关闭并删除你的账号。'
  );
}

/** Values for every placeholder the skeletons use. */
export function legalPlaceholderValues(brand: ProductBrand, env: EnvSource = process.env): Record<string, string> {
  const zh = brand.market === 'cn';
  const missing = zh ? '未披露' : 'Not listed';
  const d = buildDisclosures(brand, env);
  const models = mdTable(
    zh ? ['模型', '提供方', '备案号'] : ['Model', 'Vendor', 'Processing country'],
    d.models.map((m) => [m.model, m.vendor, zh ? (m.filingNo ?? missing) : (m.region ?? missing)]),
    zh ? '尚未配置 AI 模型；AI 功能不可用。' : 'No AI model is configured; AI features are off.',
  );
  const processors = mdTable(
    zh ? ['处理方', '用途', '国家/地区'] : ['Processor', 'Purpose', 'Country'],
    d.processors.map((p) => [p.name, p.purpose, [p.country, p.region].filter(Boolean).join(' / ') || missing]),
    missing,
  );
  return {
    brand: brand.name,
    entity_name: brandEnv(brand, 'LEGAL_ENTITY_NAME', env) ?? missing,
    postal_address: brandEnv(brand, 'LEGAL_POSTAL_ADDRESS', env) ?? missing,
    support_email: brandEnv(brand, 'SUPPORT_EMAIL', env) ?? brand.email.replyTo,
    complaint_email: (zh ? env.CN_COMPLAINT_EMAIL?.trim() : undefined) || missing,
    complaint_phone: (zh ? env.CN_COMPLAINT_PHONE?.trim() : undefined) || missing,
    version: legalDocsVersion(brand, env) ?? (zh ? '草稿' : 'Draft'),
    retention_schedule: retentionScheduleMarkdown(zh ? 'zh' : 'en', env),
    ai_models: models,
    processors,
    processing_facts: processingFactsMarkdown(d.processing, zh),
    llm_endpoints: llmEndpointsMarkdown(d.llmEndpoints, zh),
    data_attributions: dataAttributionsMarkdown(d.dataAttributions, zh),
    // Who collects GoApply payments (CN_PAYMENT_COLLECTING_ENTITY); named in the 用户协议.
    collecting_entity: brandEnv(brand, 'PAYMENT_COLLECTING_ENTITY', env) ?? missing,
    // Where NDA / copyright complaints about shared interview questions go
    // (TAKEDOWN_CONTACT / CN_TAKEDOWN_CONTACT); the support address until ops sets one.
    takedown_contact: brandEnv(brand, 'TAKEDOWN_CONTACT', env) ?? brandEnv(brand, 'SUPPORT_EMAIL', env) ?? brand.email.replyTo,
    minimum_age: '16',
    // GoApply: stated only when personal information really leaves the
    // mainland on this deployment, with the processors and the AI destination
    // of the stack in use (the sentences of the consent itself). No country or
    // processor is typed here.
    offshore_notice: zh ? crossBorderNoticeMarkdown(brand, d.offshore, env) : '',
    gohire_parse_notice:
      !zh && gohireParseForIntl(env)
        ? 'Only if you agree when you upload: your resume is read by the GoHire parsing service, which runs on servers in mainland China.'
        : '',
  };
}

/**
 * The publication state of one document file for a brand — the single rule
 * `loadLegalDoc` and `publishedLegalDocVersion` share (and app/legal/legalSource.ts
 * mirrors for the page):
 *   version   = the brand's LEGAL_DOCS_VERSION (GoApply: CN_LEGAL_DOCS_VERSION; brand-own, never shared)
 *   published = that version is set AND the file is not `status: draft`
 */
function publicationOf(brand: ProductBrand, meta: FrontMatter, env: EnvSource): { version: string | null; draft: boolean } {
  const version = legalDocsVersion(brand, env);
  const draft = !version || (meta.status ?? 'draft').trim().toLowerCase() === 'draft';
  return { version, draft };
}

/**
 * The version of a legal document a user can be asked to accept: its version
 * when the document is published, `null` while it is a draft (front matter
 * `status: draft`, or no version set), does not exist for the brand's market,
 * or the slug is unknown. Aliases resolve as on /legal (`user-agreement` →
 * the GoApply 用户协议). Callers must not record an acceptance, or take a
 * payment that depends on one, when this returns null.
 */
export function publishedLegalDocVersion(brand: ProductBrand, doc: string, env: EnvSource = process.env): string | null {
  let resolved = resolveLegalDocSlug(brand.market, doc);
  if (resolved && 'redirect' in resolved) resolved = resolveLegalDocSlug(brand.market, resolved.redirect);
  if (!resolved || 'redirect' in resolved) return null;
  const source = readLegalSource(brand.market, resolved.file, env);
  if (!source) return null;
  const { version, draft } = publicationOf(brand, parseFrontMatter(source).meta, env);
  return draft ? null : version;
}

export interface LoadLegalDocOptions {
  env?: EnvSource;
  locale?: string;
}

/** Load and fill a document for a brand, applying the publication rule. */
export function loadLegalDoc(brand: ProductBrand, slug: string, opts: LoadLegalDocOptions = {}): LegalDocResponse {
  const env = opts.env ?? process.env;
  const resolved = resolveLegalDocSlug(brand.market, slug);
  if (!resolved) throw new HttpError('not_found');
  if ('redirect' in resolved) return loadLegalDoc(brand, resolved.redirect, opts);
  const source = readLegalSource(brand.market, resolved.file, env);
  if (!source) throw new HttpError('not_found');
  const { meta, body } = parseFrontMatter(source);
  // A draft is served with `draft: true` (the page shows the DRAFT banner) on both brands.
  const { version, draft } = publicationOf(brand, meta, env);
  return {
    doc: resolved.doc as LegalDoc,
    locale: brand.market === 'cn' ? 'zh' : 'en',
    version,
    draft,
    markdown: fillPlaceholders(body, legalPlaceholderValues(brand, env)),
    updatedAt: meta.updated ?? null,
  };
}
