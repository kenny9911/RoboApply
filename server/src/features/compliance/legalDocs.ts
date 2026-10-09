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
// Publication rule (TASK_PLAN.md WP-13; CN plan WP-COMPLY):
//   published = LEGAL_DOCS_VERSION is set for the brand (GoApply reads
//               CN_LEGAL_DOCS_VERSION, R-03) AND the file is not `status: draft`.
//   Unpublished documents render with a DRAFT banner — except on production
//   GoApply, where they are not served at all (404 legal_doc_not_published).
//
// Placeholders (`{{name}}`) are filled from configuration; an unset value
// renders "Not listed" / "未披露" — never an invented fact.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProductBrand } from '../../platform/brand/registry.js';
import { brandEnv, type EnvSource } from '../../platform/brand/brandEnv.js';
import { HttpError } from '../../platform/http.js';
import { COMPLIANCE_ERROR_CODES, resolveLegalDocSlug, type LegalDoc, type LegalDocResponse } from './contract.js';
import { gohireParseForIntl, isOffshore } from './consents.js';
import { buildDisclosures } from './disclosures.js';
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
    minimum_age: '16',
    offshore_notice: zh
      ? isOffshore(env)
        ? '当前内测阶段，你的个人信息在中国大陆境外处理和存储，处理地区为美国。只有在你单独同意后才会这样处理；撤回该同意会关闭并删除你的账户。'
        : '你的个人信息在中国大陆境内处理和存储。'
      : '',
    gohire_parse_notice:
      !zh && gohireParseForIntl(env)
        ? 'Only if you agree when you upload: your resume is read by the GoHire parsing service, which runs on servers in mainland China.'
        : '',
  };
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
  const version = legalDocsVersion(brand, env);
  const draft = !version || (meta.status ?? 'draft') === 'draft';
  if (draft && brand.market === 'cn' && env.NODE_ENV === 'production') {
    throw new HttpError('not_found', 'This document is not published yet.', { reason: COMPLIANCE_ERROR_CODES.docNotPublished });
  }
  return {
    doc: resolved.doc as LegalDoc,
    locale: brand.market === 'cn' ? 'zh' : 'en',
    version,
    draft,
    markdown: fillPlaceholders(body, legalPlaceholderValues(brand, env)),
    updatedAt: meta.updated ?? null,
  };
}
