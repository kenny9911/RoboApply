// app/legal/legalSource.ts — server-side loader for /legal/[doc] (Node runtime only).
//
// Reads content/legal/<market>/<file>.md, fills the inline placeholders from
// this deployment's env and applies the publication rule shared with the API
// (server/src/features/compliance/legalDocs.ts):
//   published = <brand> LEGAL_DOCS_VERSION is set (GoApply: CN_LEGAL_DOCS_VERSION,
//               no fallback across brands) AND the file is not `status: draft`.
//   Unpublished → rendered with a DRAFT banner, except on production GoApply,
//   where the page is a 404.
// Block placeholders ({{retention_schedule}}, {{ai_models}}, {{processors}},
// {{processing_facts}}, {{llm_endpoints}}, {{data_attributions}}) are left in
// place; the page renders them as live tables and lists.
//
// Deployment note: the files must ship with the server bundle
// (`outputFileTracingIncludes` for /legal/[doc] — requested from INT).

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { BrandId } from '../../lib/brand/registry.generated';
import { LEGAL_BLOCKS, legalDocsFor, resolveLegalDocSlug, type LegalDocSlug, type LegalMarket } from '../../components/features/compliance/legalCatalog';

export type EnvSource = Record<string, string | undefined>;

export interface LegalBrandInfo {
  id: BrandId;
  market: LegalMarket;
  name: string;
  replyTo: string;
}

export interface LoadedLegalDoc {
  doc: LegalDocSlug;
  title: string;
  body: string;
  draft: boolean;
  version: string | null;
  updated: string | null;
  /** Language the file is written in. */
  lang: 'en' | 'zh';
}

export type LegalLoadResult = { kind: 'doc'; doc: LoadedLegalDoc } | { kind: 'redirect'; to: LegalDocSlug } | { kind: 'not_found' };

/** `CN_` + name for GoApply, the bare name for RoboApply (R-03); blank = unset. */
export function brandEnvValue(brand: Pick<LegalBrandInfo, 'market'>, name: string, env: EnvSource): string | null {
  const v = env[brand.market === 'cn' ? `CN_${name}` : name];
  const t = v?.trim();
  return t ? t : null;
}

export function parseFrontMatter(source: string): { meta: Record<string, string>; body: string } {
  const text = source.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!] = kv[2]!.replace(/^['"]|['"]$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function isOffshore(env: EnvSource): boolean {
  return (env.DEPLOY_REGION ?? '').trim().toLowerCase() !== 'cn-mainland';
}

function gohireParseForIntl(env: EnvSource): boolean {
  return (env.GOHIRE_PARSE_BRANDS ?? 'goapply')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .includes('roboapply');
}

/** Inline placeholder values (block placeholders are rendered by the page). */
export function inlineValues(brand: LegalBrandInfo, env: EnvSource): Record<string, string> {
  const zh = brand.market === 'cn';
  const missing = zh ? '未披露' : 'Not listed';
  return {
    brand: brand.name,
    entity_name: brandEnvValue(brand, 'LEGAL_ENTITY_NAME', env) ?? missing,
    postal_address: brandEnvValue(brand, 'LEGAL_POSTAL_ADDRESS', env) ?? missing,
    support_email: brandEnvValue(brand, 'SUPPORT_EMAIL', env) ?? brand.replyTo,
    complaint_email: (zh ? env.CN_COMPLAINT_EMAIL?.trim() : '') || missing,
    complaint_phone: (zh ? env.CN_COMPLAINT_PHONE?.trim() : '') || missing,
    version: brandEnvValue(brand, 'LEGAL_DOCS_VERSION', env) ?? (zh ? '草稿' : 'Draft'),
    // Who collects GoApply payments (CN_PAYMENT_COLLECTING_ENTITY), named in the 用户协议.
    collecting_entity: brandEnvValue(brand, 'PAYMENT_COLLECTING_ENTITY', env) ?? missing,
    // NDA / copyright complaints about shared questions; the support address until ops sets one.
    takedown_contact: brandEnvValue(brand, 'TAKEDOWN_CONTACT', env) ?? brandEnvValue(brand, 'SUPPORT_EMAIL', env) ?? brand.replyTo,
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

const BLOCK = new Set<string>(LEGAL_BLOCKS);

export function fillInline(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, key: string) => (BLOCK.has(key) ? all : key in values ? values[key]! : all));
}

function contentRoots(env: EnvSource): string[] {
  return [env.LEGAL_CONTENT_DIR, path.join(process.cwd(), 'content/legal')].filter((r): r is string => Boolean(r));
}

export function readSource(market: LegalMarket, file: string, env: EnvSource): string | null {
  if (!/^[a-z0-9-]+$/.test(file)) return null;
  for (const root of contentRoots(env)) {
    const p = path.join(root, market, `${file}.md`);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

export function loadLegalDocForPage(brand: LegalBrandInfo, slug: string, env: EnvSource = process.env): LegalLoadResult {
  const resolved = resolveLegalDocSlug(brand.market, slug);
  if (!resolved) return { kind: 'not_found' };
  if ('redirect' in resolved) return { kind: 'redirect', to: resolved.redirect };
  const source = readSource(brand.market, resolved.file, env);
  if (!source) return { kind: 'not_found' };
  const { meta, body } = parseFrontMatter(source);
  const version = brandEnvValue(brand, 'LEGAL_DOCS_VERSION', env);
  const draft = !version || (meta.status ?? 'draft') === 'draft';
  if (draft && brand.market === 'cn' && env.NODE_ENV === 'production') return { kind: 'not_found' };
  // Drop the first H1: the page renders the title itself.
  const withoutH1 = body.replace(/^\s*#\s+[^\n]+\n/, '');
  return {
    kind: 'doc',
    doc: {
      doc: resolved.doc,
      title: meta.title ?? resolved.doc,
      body: fillInline(withoutH1, inlineValues(brand, env)),
      draft,
      version,
      updated: meta.updated ?? null,
      lang: brand.market === 'cn' ? 'zh' : 'en',
    },
  };
}

/**
 * The documents the /legal index can link to for a brand: every document of
 * its footer list that loads under the publication rule (so production GoApply
 * lists nothing until its documents are published).
 */
export function listLegalDocsForPage(brand: LegalBrandInfo, locale: string | null, env: EnvSource = process.env): LoadedLegalDoc[] {
  const out: LoadedLegalDoc[] = [];
  for (const slug of legalDocsFor(brand.market, locale)) {
    const r = loadLegalDocForPage(brand, slug, env);
    if (r.kind === 'doc') out.push(r.doc);
  }
  return out;
}
