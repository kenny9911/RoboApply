// @vitest-environment node
//
// Legal documents on disk, the export and purge workers, and compliance-daily.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getBrand } from '../../platform/brand/registry.js';
import { createBudget, type CronContext } from '../../platform/queue/index.js';
import { createFakePrisma } from '../../test/fakePrisma.js';
import { LEGAL_DOC_FILES } from './contract.js';
import { createComplianceDaily, reconcilePiRequests, type ComplianceCronDb } from './cron.js';
import {
  buildUserDataExport,
  handleDataExport,
  readExportForOwner,
  registerExportSection,
  sweepExpiredExports,
  type ExportDb,
  type ExportStore,
} from './dataExport.js';
import { fillPlaceholders, loadLegalDoc, parseFrontMatter, publishedLegalDocVersion, readLegalSource } from './legalDocs.js';
import * as complianceIndex from './index.js';
import { createEmailTranslator, resetEmailI18nCache } from '../../platform/email/i18n.js';
import { getEmailTemplate } from '../../platform/email/templates/registry.js';
import { COMPLIANCE_EMAIL_KEYS, DATA_EXPORT_READY_TEMPLATE } from './emails.js';
import { defaultAccountCloser, handleAccountPurge, pendingPurgeNote } from './purge.js';
import { workers } from './workers.js';

const goapply = getBrand('goapply');
const roboapply = getBrand('roboapply');

/** Files WP-13 owns (referral-terms → WP-60, coaching → WP-72). */
const OWNED = {
  intl: ['terms', 'privacy', 'cookies', 'refunds', 'subscription-terms', 'ai-disclosure', 'tw-pdpa-notice'],
  cn: ['user-agreement', 'privacy', 'pi-collection-list', 'third-party-sharing', 'ai-content-labels', 'complaints'],
} as const;

describe('legal documents', () => {
  it('every owned skeleton exists, is marked draft and has a title', () => {
    for (const market of ['intl', 'cn'] as const) {
      for (const file of OWNED[market]) {
        const src = readLegalSource(market, file);
        expect(src, `${market}/${file}`).toBeTruthy();
        const { meta, body } = parseFrontMatter(src!);
        expect(meta.status).toBe('draft');
        expect(meta.title).toBeTruthy();
        expect(body).toMatch(/DRAFT/);
        expect(Object.values(LEGAL_DOC_FILES[market])).toContain(file);
      }
    }
  });

  it('every placeholder is filled; unset values say so instead of inventing', () => {
    for (const [brand, market] of [[roboapply, 'intl'], [goapply, 'cn']] as const) {
      for (const [doc, file] of Object.entries(LEGAL_DOC_FILES[market])) {
        if (!(OWNED[market] as readonly string[]).includes(file!)) continue;
        const out = loadLegalDoc(brand, doc, { env: { NODE_ENV: 'test' } });
        expect(out.markdown, `${market}/${doc}`).not.toMatch(/\{\{|%BRAND%/);
        expect(out.draft).toBe(true);
      }
    }
    expect(loadLegalDoc(goapply, 'privacy', { env: {} }).markdown).toContain('未披露');
    expect(loadLegalDoc(roboapply, 'privacy', { env: {} }).markdown).toContain('Not listed');
    expect(loadLegalDoc(roboapply, 'privacy', { env: { LEGAL_ENTITY_NAME: 'Example Ltd' } }).markdown).toContain('Example Ltd');
  });

  it('privacy notices publish the retention schedule and minimum age; the GoApply notice states cross-border processing from the stack in use', () => {
    const intl = loadLegalDoc(roboapply, 'privacy', { env: {} }).markdown;
    expect(intl).toContain('| Assistant conversations | 12 months |');
    expect(intl).toContain('16 or older');
    expect(intl).toContain('connected-on date');
    const offshore = { DEPLOY_REGION: '', DATABASE_URL: 'postgresql://u:p@ep-quiet.us-west-2.aws.neon.tech/db', LLM_PROVIDER: 'openrouter', LLM_MODEL: 'openai/gpt-5' };
    const cn = loadLegalDoc(goapply, 'privacy', { env: offshore }).markdown;
    expect(cn).toContain('| 求职助手对话 | 12 个月 |');
    // The processors and the AI destination come from configuration: the sentences of the consent itself.
    expect(cn).toContain(
      '你的个人信息会由中国大陆境外的服务处理或存储。境外处理方：数据库 Neon（美国，us-west-2）、AI 模型 openai（美国）。AI 请求会发送到这些 AI 服务：openai（美国）。只有在你单独同意后才会这样处理；撤回该同意会关闭并删除你的账号。',
    );
    // No country is typed in by hand any more, and nothing unconfigured is named.
    expect(cn).not.toContain('处理地区为美国');
    expect(cn).not.toContain('内测');
    expect(cn).not.toContain('境内处理和存储');
    expect(loadLegalDoc(goapply, 'privacy', { env: { DEPLOY_REGION: '' } }).markdown).toContain('你的个人信息会由中国大陆境外的服务处理或存储。境外处理方的清单见“法律信息”页面。');
    // A mainland deployment on the shared stack sends data abroad too, so it says so (not "stays in the mainland").
    const mainlandShared = loadLegalDoc(goapply, 'privacy', { env: { ...offshore, DEPLOY_REGION: 'cn-mainland', DATABASE_URL: 'postgresql://u:p@10.0.0.12:5432/db' } }).markdown;
    expect(mainlandShared).toContain('你的个人信息会由中国大陆境外的服务处理或存储。境外处理方：AI 模型 openai（美国）。');
    expect(mainlandShared).not.toContain('境内处理和存储');
    // Only a mainland deployment with a complete stack of its own says the data stays in the mainland.
    const own = {
      DEPLOY_REGION: 'cn-mainland',
      CN_LLM_PROVIDER: 'deepseek',
      CN_LLM_MODEL: 'deepseek-chat',
      CN_LIVEKIT_URL: 'wss://rtc.goapply.example.cn',
      CN_INTERVIEW_ENGINE_STT_MODEL: 'dashscope/paraformer',
      CN_INTERVIEW_ENGINE_TTS_MODEL: 'dashscope/cosyvoice',
      CN_S3_BUCKET: 'cn',
      CN_S3_ENDPOINT: 'https://oss-cn-shanghai.aliyuncs.com',
      CN_VAPID_PUBLIC_KEY: 'pub',
      CN_EMAIL_TRANSPORT: 'aliyun_dm',
    };
    expect(loadLegalDoc(goapply, 'privacy', { env: own }).markdown).toContain('你的个人信息在中国大陆境内处理和存储。');
  });

  it('GoApply legal documents are served by the same rule as RoboApply: a draft is served, marked as a draft, in production too (D5; G112)', () => {
    for (const doc of ['terms', 'privacy', 'coaching', 'pi-collection-list', 'third-party-sharing', 'ai-content-labels', 'complaints']) {
      const out = loadLegalDoc(goapply, doc, { env: { NODE_ENV: 'production' } });
      expect(out, doc).toMatchObject({ doc, draft: true, version: null, locale: 'zh' });
      expect(out.markdown.length, doc).toBeGreaterThan(50);
      expect(out.markdown, doc).not.toMatch(/\{\{/);
    }
    // version set but the file is still a draft skeleton → served, still a draft, with the version shown
    expect(loadLegalDoc(goapply, 'privacy', { env: { NODE_ENV: 'production', CN_LEGAL_DOCS_VERSION: '2026-11' } })).toMatchObject({ draft: true, version: '2026-11' });
    // RoboApply production: served, marked draft (unchanged)
    expect(loadLegalDoc(roboapply, 'terms', { env: { NODE_ENV: 'production' } }).draft).toBe(true);
    // the intl version var never applies to GoApply (the documents version is a brand-own value)
    expect(loadLegalDoc(roboapply, 'terms', { env: { LEGAL_DOCS_VERSION: 'v1' } }).version).toBe('v1');
    expect(loadLegalDoc(goapply, 'terms', { env: { LEGAL_DOCS_VERSION: 'v1' } }).version).toBeNull();
    // An unknown document is still a 404 on both brands.
    for (const brand of [goapply, roboapply]) {
      expect(() => loadLegalDoc(brand, 'no-such-doc', { env: { NODE_ENV: 'production' } })).toThrow(expect.objectContaining({ code: 'not_found' }));
    }
  });

  it('front matter and placeholder helpers', () => {
    expect(parseFrontMatter('---\ntitle: "X"\nstatus: approved\n---\n# Body')).toEqual({ meta: { title: 'X', status: 'approved' }, body: '# Body' });
    expect(parseFrontMatter('# No meta')).toEqual({ meta: {}, body: '# No meta' });
    expect(fillPlaceholders('{{a}} {{ b }} {{c}}', { a: '1', b: '2' })).toBe('1 2 {{c}}');
  });
});

describe('publishedLegalDocVersion (WP-93; billing-cn records it with cn_pay_terms_ack)', () => {
  // A content directory with one published and one draft document per market.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'legal-docs-'));
  const write = (market: string, file: string, status: string | null) => {
    mkdirSync(path.join(dir, market), { recursive: true });
    const front = status === null ? '' : `---\ntitle: T\nstatus: ${status}\nupdated: 2026-11-01\n---\n`;
    writeFileSync(path.join(dir, market, `${file}.md`), `${front}# T\n\nBody {{version}}\n`);
  };
  write('cn', 'user-agreement', 'published');
  write('cn', 'privacy', 'draft');
  write('cn', 'complaints', null); // no front matter = draft
  write('intl', 'terms', 'published');
  write('intl', 'privacy', 'draft');
  write('intl', 'refunds', 'Draft');
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const env = (extra: Record<string, string> = {}) => ({ LEGAL_CONTENT_DIR: dir, ...extra });

  it('is exported from the compliance index', () => {
    expect(complianceIndex.publishedLegalDocVersion).toBe(publishedLegalDocVersion);
  });

  it('GoApply: a published 用户协议 answers its version; a draft answers null', () => {
    const e = env({ CN_LEGAL_DOCS_VERSION: '2026-11.v1' });
    expect(publishedLegalDocVersion(goapply, 'terms', e)).toBe('2026-11.v1');
    expect(publishedLegalDocVersion(goapply, 'user-agreement', e)).toBe('2026-11.v1'); // alias of terms
    expect(publishedLegalDocVersion(goapply, 'agreement', e)).toBe('2026-11.v1');
    expect(publishedLegalDocVersion(goapply, 'privacy', e)).toBeNull();
    expect(publishedLegalDocVersion(goapply, 'complaints', e)).toBeNull();
  });

  it('RoboApply: a published document answers its version; a draft answers null', () => {
    const e = env({ LEGAL_DOCS_VERSION: 'v7' });
    expect(publishedLegalDocVersion(roboapply, 'terms', e)).toBe('v7');
    expect(publishedLegalDocVersion(roboapply, 'privacy', e)).toBeNull();
    expect(publishedLegalDocVersion(roboapply, 'refunds', e)).toBeNull(); // "Draft" in any case
  });

  it('no version set, the other brand\'s version, an unknown or foreign document: null', () => {
    expect(publishedLegalDocVersion(goapply, 'terms', env())).toBeNull();
    expect(publishedLegalDocVersion(roboapply, 'terms', env())).toBeNull();
    // R-03: no fallback from CN_X to X or back.
    expect(publishedLegalDocVersion(goapply, 'terms', env({ LEGAL_DOCS_VERSION: 'v7' }))).toBeNull();
    expect(publishedLegalDocVersion(roboapply, 'terms', env({ CN_LEGAL_DOCS_VERSION: 'v1' }))).toBeNull();
    const both = env({ LEGAL_DOCS_VERSION: 'v7', CN_LEGAL_DOCS_VERSION: 'cn3' });
    expect(publishedLegalDocVersion(goapply, 'terms', both)).toBe('cn3');
    expect(publishedLegalDocVersion(roboapply, 'terms', both)).toBe('v7');
    expect(publishedLegalDocVersion(goapply, 'cookies', both)).toBeNull(); // not a GoApply document
    expect(publishedLegalDocVersion(roboapply, 'pi-collection-list', both)).toBeNull();
    expect(publishedLegalDocVersion(goapply, 'no-such-doc', both)).toBeNull();
    expect(publishedLegalDocVersion(goapply, '../../package', both)).toBeNull();
  });

  it('agrees with what loadLegalDoc serves', () => {
    const e = env({ LEGAL_DOCS_VERSION: 'v7', CN_LEGAL_DOCS_VERSION: 'cn3' });
    for (const [brand, docs] of [[goapply, ['terms', 'privacy', 'complaints']], [roboapply, ['terms', 'privacy', 'refunds']]] as const) {
      for (const doc of docs) {
        const served = loadLegalDoc(brand, doc, { env: e });
        expect(publishedLegalDocVersion(brand, doc, e), `${brand.id}/${doc}`).toBe(served.draft ? null : served.version);
      }
    }
  });

  it('every document that ships today is still a draft, so nothing can be accepted yet', () => {
    const e = { LEGAL_DOCS_VERSION: 'v1', CN_LEGAL_DOCS_VERSION: 'v1' };
    for (const [brand, market] of [[roboapply, 'intl'], [goapply, 'cn']] as const) {
      for (const doc of Object.keys(LEGAL_DOC_FILES[market])) {
        expect(publishedLegalDocVersion(brand, doc, e), `${market}/${doc}`).toBeNull();
      }
    }
  });
});

describe('legal drafts (WP-93 content; every changed document stays a draft)', () => {
  const intl = (doc: string, env: Record<string, string> = {}) => loadLegalDoc(roboapply, doc, { env }).markdown;
  const cn = (doc: string, env: Record<string, string> = {}) => loadLegalDoc(goapply, doc, { env }).markdown;

  it('the privacy and cookie notices name the analytics cookies, the 13-month limit and the unlinked counts', () => {
    for (const text of [intl('privacy'), intl('cookies')]) {
      expect(text).toContain('`ra_anon`');
      expect(text).toContain('`ra_analytics_consent`');
      expect(text).toMatch(/13 months/);
      expect(text).toMatch(/each visit stands alone/);
      expect(text).toContain('`ra_tool_visitor`');
      expect(text).toMatch(/24 hours/);
      expect(text).toMatch(/strictly necessary|cannot be turned off/);
      expect(text).toContain('Privacy choices');
    }
    const zh = cn('privacy');
    for (const s of ['`ra_anon`', '13 个月', '`ra_tool_visitor`', '24 小时', '必要 Cookie']) expect(zh).toContain(s);
  });

  it('the GoApply notice describes no analytics choice: GoApply never asks, never sets that cookie, and always sets ra_anon', () => {
    // lib/analytics isAnalyticsConsentRequired('cn', …) is false for every country
    // (asserted next to the web components, compliance.test.tsx).
    const zh = cn('privacy');
    expect(zh).not.toContain('ra_analytics_consent');
    expect(zh).not.toMatch(/不允许统计分析|是否允许统计分析|每次访问相互独立/);
    expect(zh).toMatch(/`ra_anon`[^\n]*首次访问时设置/);
    expect(zh).toMatch(/产品使用事件的收集已列入《个人信息收集清单》/);
    // The list it points to carries the row, marked as required.
    expect(cn('pi-collection-list')).toMatch(/\| 产品使用事件 \|[^\n]*`ra_anon`/);
  });

  it("GoApply's 个人信息收集清单 lists event collection", () => {
    const list = cn('pi-collection-list');
    expect(list).toMatch(/\| 产品使用事件 \|[^\n]*`ra_anon`[^\n]*13 个月/);
    expect(list).toContain('`ra_tool_visitor`');
    expect(list).toMatch(/\| 登录设备 \|[^\n]*90 天/);
  });

  it('the LinkedIn connections import is described as third-party data: what is kept and what is discarded', () => {
    const text = intl('privacy');
    expect(text).toMatch(/information about other people/);
    expect(text).toMatch(/Kept, for each person: name, company, position and connected-on date/);
    expect(text).toMatch(/Discarded when the file is read: the email address and profile link columns/);
    expect(text).toMatch(/The file itself is not kept/);
    expect(text).toMatch(/We never contact these people/);
  });

  it('the terms carry a takedown contact for shared questions (TAKEDOWN_CONTACT, else the support address)', () => {
    expect(intl('terms')).toMatch(/breaks a confidentiality agreement or your copyright, write to support@roboapply\.io/);
    expect(intl('terms', { TAKEDOWN_CONTACT: 'takedown@example.test' })).toContain('write to takedown@example.test');
    expect(intl('terms', { SUPPORT_EMAIL: 'help@example.test' })).toContain('write to help@example.test');
    expect(intl('terms')).toMatch(/Counsel: takedown contact and procedure/);
    // GoApply reads its own variable (no fallback across brands).
    expect(cn('terms', { TAKEDOWN_CONTACT: 'takedown@example.test' })).not.toContain('takedown@example.test');
    expect(cn('terms', { CN_TAKEDOWN_CONTACT: 'jubao@example.cn' })).toContain('请发送邮件至 jubao@example.cn');
  });

  it('the GoApply 用户协议 names the collecting entity and says passes do not renew and there are no deposits', () => {
    const named = cn('terms', { CN_PAYMENT_COLLECTING_ENTITY: '示例（上海）科技有限公司' });
    expect(named).toContain('收款主体：示例（上海）科技有限公司');
    expect(cn('terms')).toContain('收款主体：未披露'); // never invented
    expect(cn('terms', { PAYMENT_COLLECTING_ENTITY: 'Intl Co' })).toContain('收款主体：未披露');
    for (const s of ['一次性通行证', '不会自动续费', '不会自动扣款', '不收取押金', '预存款']) expect(named).toContain(s);
  });

  it('processing facts, AI endpoints and data sources are filled from the server, never typed into a file', () => {
    for (const [market, files] of [['intl', ['privacy', 'terms']], ['cn', ['privacy', 'third-party-sharing', 'user-agreement']]] as const) {
      for (const file of files) {
        const raw = readLegalSource(market, file)!;
        expect(raw, `${market}/${file}`).toMatch(/\{\{(processing_facts|llm_endpoints|data_attributions)\}\}/);
        // No AI host or dataset is written in the source file itself.
        for (const literal of ['api.openai.com', 'openrouter.ai', 'api.deepseek.com', 'dashscope.aliyuncs.com', 'O*NET']) expect(raw).not.toContain(literal);
      }
    }
    const privacy = intl('privacy');
    expect(privacy).toContain('never sent to a model service in mainland China');
    expect(privacy).toContain('api.deepseek.com'); // the refused hosts, from the policy list
    expect(privacy).toContain('openrouter (openrouter.ai)');
    expect(privacy).toContain('Where this service runs: outside mainland China');
    expect(intl('terms')).toMatch(/\| \[O\*NET-SOC 2019[^\n]*CC BY 4\.0/);
    // GoApply by default (rule open): requests go to the configured models, which can be abroad; no "mainland only" claim.
    const zh = cn('privacy');
    expect(zh).toContain('AI 请求会发送到“AI 模型”表中列出的模型服务，其中可能包括中国大陆境外的服务');
    expect(zh).not.toContain('只使用中国大陆境内的模型服务');
    expect(zh).toContain('deepseek (api.deepseek.com)');
    expect(zh).toContain('openrouter (openrouter.ai)');
    expect(zh).toContain('本服务的运行地点：中国大陆境外');
    // Files are kept, as on RoboApply; the no-original rule is the opt-in CN_STORAGE_MODE=discard.
    expect(zh).toContain('保存在我们自己的文件存储中');
    expect(zh).not.toContain('只在内存中读取，不保存原文件');
    expect(cn('privacy', { CN_STORAGE_MODE: 'discard' })).toContain('只在内存中读取，不保存原文件');
    expect(cn('privacy', { DEPLOY_REGION: 'cn-mainland' })).toContain('本服务的运行地点：中国大陆境内');
    // Behind the domestic-only wall, and only then, it says mainland only and lists the domestic providers alone.
    const walled = cn('privacy', { CN_LLM_DOMESTIC_ONLY: 'true' });
    expect(walled).toContain('只使用中国大陆境内的模型服务');
    expect(walled).toContain('deepseek (api.deepseek.com)');
    expect(walled).not.toContain('openrouter');
  });

  it('the GoApply processor list adds Aliyun Content Moderation (mainland) when it is configured', () => {
    const env = { CN_CONTENT_SAFETY_PROVIDER: 'aliyun_green', ALIYUN_GREEN_ACCESS_KEY_ID: 'ak', ALIYUN_GREEN_ACCESS_KEY_SECRET: 'sk' };
    expect(cn('third-party-sharing', env)).toMatch(/\| Aliyun Content Moderation \| content_safety \| CN \|/);
    expect(cn('third-party-sharing')).not.toContain('Aliyun Content Moderation');
    expect(cn('third-party-sharing')).toContain('内容安全审核');
  });

  it('no document names a brand in its source; all are still drafts', () => {
    for (const market of ['intl', 'cn'] as const) {
      for (const file of OWNED[market]) {
        const raw = readLegalSource(market, file)!;
        expect(raw, `${market}/${file}`).not.toMatch(/RoboApply|GoApply/);
        expect(parseFrontMatter(raw).meta.status).toBe('draft');
      }
    }
  });
});

// ── Data export ────────────────────────────────────────────────────────────

function memStore(): ExportStore & { files: Map<string, Buffer> } {
  const files = new Map<string, Buffer>();
  return {
    files,
    async save({ userId, buffer }) {
      const key = `data-exports/${userId}/${files.size}`;
      files.set(key, buffer);
      return { provider: 'mem', key };
    },
    async read(ref) {
      return files.get(ref.key)!;
    },
    async remove(ref) {
      return files.delete(ref.key);
    },
  };
}

describe('data export worker', () => {
  const now = new Date('2026-10-10T08:00:00.000Z');

  it('builds the file without secrets, marks the request done and enqueues the email', async () => {
    const db = createFakePrisma({
      seed: {
        user: [{ id: 'u1', email: 'a@example.test', name: 'A', brand: 'roboapply', passwordHash: 'SECRET', createdAt: now }],
        rAPersonalInfoRequest: [{ id: 'r1', brand: 'roboapply', userId: 'u1', kind: 'copy', status: 'open', dueAt: now, createdAt: now, closedAt: null, detail: {} }],
      },
    });
    const store = memStore();
    const enqueue = vi.fn(async () => ({ id: 'e1', kind: 'email.send', status: 'queued' as const, dedupeKey: null, created: true }));
    await handleDataExport({ payload: { requestId: 'r1' } }, { db: db as unknown as ExportDb, store, now: () => now, enqueue });
    const req = db.$rows('rAPersonalInfoRequest')[0]!;
    expect(req).toMatchObject({ status: 'done', closedAt: now });
    expect((req.detail as { export: { expiresAt: string } }).export.expiresAt).toBe('2026-10-17T08:00:00.000Z');
    const text = [...store.files.values()][0]!.toString('utf8');
    expect(text).toContain('a@example.test');
    expect(text).not.toContain('SECRET');
    expect(enqueue).toHaveBeenCalledWith('email.send', { template: 'compliance.data_export_ready', userId: 'u1', params: { days: 7 } }, expect.objectContaining({ dedupeKey: 'compliance.export.email:r1' }));

    const file = await readExportForOwner('u1', 'r1', { db: db as unknown as ExportDb, store, now: () => now });
    expect(file.fileName).toBe('data-export-2026-10-10.json');
    await expect(readExportForOwner('u2', 'r1', { db: db as unknown as ExportDb, store })).rejects.toMatchObject({ code: 'not_found' });

    // the sweep deletes it after 7 days
    const later = () => new Date('2026-10-18T00:00:00.000Z');
    expect(await sweepExpiredExports({ db: db as unknown as ExportDb, store, now: later, brand: 'roboapply' })).toBe(1);
    expect(store.files.size).toBe(0);
    expect(await sweepExpiredExports({ db: db as unknown as ExportDb, store, now: later, brand: 'roboapply' })).toBe(0);
  });

  it('storage not configured → request stays open with a note, item dead', async () => {
    const db = createFakePrisma({
      seed: { rAPersonalInfoRequest: [{ id: 'r1', brand: 'roboapply', userId: 'u1', kind: 'copy', status: 'open', dueAt: now, createdAt: now, closedAt: null, detail: {} }] },
    });
    const store: ExportStore = { save: async () => null, read: async () => Buffer.from(''), remove: async () => true };
    await expect(handleDataExport({ payload: { requestId: 'r1' } }, { db: db as unknown as ExportDb, store, now: () => now, enqueue: vi.fn() })).rejects.toMatchObject({
      name: 'PermanentWorkError',
    });
    expect(db.$rows('rAPersonalInfoRequest')[0]).toMatchObject({ status: 'open', detail: { handlingNotes: [expect.objectContaining({ note: 'storage_unavailable' })] } });
  });

  it('a failing section is reported, not dropped silently; sections are extensible', async () => {
    registerExportSection('zz_test_section', async () => {
      throw new Error('table missing');
    });
    const out = await buildUserDataExport('u1', createFakePrisma() as unknown as ExportDb, now);
    expect(out.sectionsUnavailable).toContain('zz_test_section');
  });

  it('covers every user-created data set, without storage keys or session internals', async () => {
    const db = createFakePrisma({
      seed: {
        user: [{ id: 'u1', email: 'a@example.test', brand: 'roboapply' }],
        rACoverLetter: [{ id: 'cl1', userId: 'u1', title: 'Letter', bodyMarkdown: 'Dear team', creditLedgerId: 'L1' }],
        rASavedSearch: [{ id: 's1', userId: 'u1', name: 'Remote PM', query: { q: 'pm' } }],
        rAAnswerBankItem: [{ id: 'q1', userId: 'u1', questionKey: 'notice', questionText: 'Notice period?', answer: '2 weeks', source: 'user', locale: 'en' }],
        rAAgentQueueItem: [{ id: 'aq1', userId: 'u1', jobId: 'j1', state: 'picked', weekKey: '2026-W41', addedVia: 'feed' }],
        rAContact: [{ id: 'ct1', ownerUserId: 'u1', fullName: 'Pat Lee', title: 'Engineer', companyNameNormalized: 'acme', source: 'linkedin_csv' }],
        rAContactImport: [{ id: 'ci1', userId: 'u1', kind: 'linkedin_csv', fileName: 'Connections.csv', rowCount: 3, importedCount: 3 }],
        interviewSession: [{ id: 'is1', userId: 'u1', role: 'PM', transcriptText: 'Tell me about…', recordingKey: 'r2/secret-key', roomName: 'room-1', overall: 70 }],
      },
    });
    const out = await buildUserDataExport('u1', db as unknown as ExportDb, now);
    for (const name of ['coverLetters', 'savedSearches', 'answerBank', 'readyToApplyQueue', 'contacts', 'contactImports', 'practiceInterviews']) {
      expect(out[name], name).toHaveLength(1);
    }
    // (a section registered by the test above fails on purpose)
    expect(((out.sectionsUnavailable as string[] | undefined) ?? []).filter((n) => n !== 'zz_test_section')).toEqual([]);
    const text = JSON.stringify(out);
    expect(text).toContain('Dear team');
    expect(text).toContain('Pat Lee');
    expect(text).toContain('Tell me about');
    expect(text).not.toContain('r2/secret-key');
    expect(text).not.toContain('room-1');
  });

  it('registers both workers', () => {
    expect(workers.map((w) => w.kind).sort()).toEqual(['compliance.export', 'compliance.purge']);
  });
});

describe('account purge worker (withdrawn cross-border consent)', () => {
  const now = new Date('2026-10-10T08:00:00.000Z');
  const seed = () =>
    createFakePrisma({
      seed: { rAPersonalInfoRequest: [{ id: 'r1', brand: 'goapply', userId: 'u1', kind: 'withdraw_consent', status: 'in_progress', dueAt: now, createdAt: now, closedAt: null, detail: {} }] },
    });

  it('closes the account and, with the purge seam, deletes it and closes the request', async () => {
    const db = seed();
    const closer = { close: vi.fn(async () => {}), purgeNow: vi.fn(async () => true) };
    expect(await handleAccountPurge({ payload: { userId: 'u1', piRequestId: 'r1' } }, { db: db as never, closer, now: () => now })).toEqual({ purged: true });
    expect(closer.close).toHaveBeenCalledWith('u1');
    expect(db.$rows('rAPersonalInfoRequest')[0]).toMatchObject({ status: 'done', closedAt: now });
  });

  it('without the seam: closed now, request stays in progress with the expected sweep date and a manual-action note', async () => {
    const db = createFakePrisma({
      seed: {
        rAPersonalInfoRequest: [
          // Filed Monday 12 Oct: 15 working days → Monday 2 Nov.
          { id: 'r1', brand: 'goapply', userId: 'u1', kind: 'withdraw_consent', status: 'in_progress', dueAt: new Date('2026-11-02T08:00:00.000Z'), createdAt: now, closedAt: null, detail: {} },
        ],
      },
    });
    const closer = { close: vi.fn(async () => {}), purgeNow: vi.fn(async () => false) };
    expect(await handleAccountPurge({ payload: { userId: 'u1', piRequestId: 'r1' } }, { db: db as never, closer, now: () => now, env: {} })).toEqual({ purged: false });
    const row = db.$rows('rAPersonalInfoRequest')[0]! as { status: string; detail: { handlingNotes: Array<{ by: string; note: string }> } };
    expect(row.status).toBe('in_progress');
    expect(row.detail.handlingNotes).toEqual([
      expect.objectContaining({
        by: 'system',
        note: 'account closed; the account-purge sweep deletes it on or after 2026-11-09 (30 days after closing), which is after this request\'s due date 2026-11-02: delete the account by hand before 2026-11-02',
      }),
    ]);
    await expect(handleAccountPurge({ payload: {} }, { db: db as never, closer })).rejects.toMatchObject({ name: 'PermanentWorkError' });
  });

  it('the note follows ACCOUNT_PURGE_RETENTION_DAYS and only asks for manual action when the sweep is late', () => {
    const closed = new Date('2026-10-12T00:00:00.000Z');
    const due = new Date('2026-11-02T00:00:00.000Z');
    expect(pendingPurgeNote(closed, due, { ACCOUNT_PURGE_RETENTION_DAYS: '7' })).toBe(
      'account closed; the account-purge sweep deletes it on or after 2026-10-19 (7 days after closing)',
    );
    expect(pendingPurgeNote(closed, due, {})).toContain('delete the account by hand before 2026-11-02');
  });

  it('default closer: purges at once when WP-10 exports purgeAccountNow, reports false while it does not', async () => {
    const purgeAccountNow = vi.fn(async () => ({ blocked: false }));
    vi.doMock('../../roboapply/services/SeekerAccountPurgeService.js', () => ({ purgeAccountNow }));
    expect(await defaultAccountCloser.purgeNow('u1')).toBe(true);
    expect(purgeAccountNow).toHaveBeenCalledWith('u1');
    purgeAccountNow.mockResolvedValueOnce({ blocked: true });
    expect(await defaultAccountCloser.purgeNow('u1')).toBe(false);
    // Today's module: no such export (an ESM namespace yields undefined for it).
    vi.resetModules();
    vi.doMock('../../roboapply/services/SeekerAccountPurgeService.js', () => ({ purgeAccountNow: undefined, runAccountPurgeSweep: vi.fn() }));
    expect(await defaultAccountCloser.purgeNow('u1')).toBe(false);
    vi.doUnmock('../../roboapply/services/SeekerAccountPurgeService.js');
  });

  it('with the seam, the worker closes the request as done (end to end through the default closer)', async () => {
    vi.resetModules();
    vi.doMock('../../roboapply/services/SeekerAccountPurgeService.js', () => ({ purgeAccountNow: vi.fn(async () => true) }));
    const db = seed();
    const closer = { close: vi.fn(async () => {}), purgeNow: defaultAccountCloser.purgeNow };
    expect(await handleAccountPurge({ payload: { userId: 'u1', piRequestId: 'r1' } }, { db: db as never, closer, now: () => now })).toEqual({ purged: true });
    expect(db.$rows('rAPersonalInfoRequest')[0]).toMatchObject({ status: 'done', closedAt: now });
    vi.doUnmock('../../roboapply/services/SeekerAccountPurgeService.js');
  });
});

describe('export-ready email', () => {
  it('every key has a string in the brand\'s default language (no raw keys) and the email links to Settings → Privacy, never to the file', () => {
    resetEmailI18nCache();
    const template = getEmailTemplate(DATA_EXPORT_READY_TEMPLATE)!;
    // RoboApply's default is English; GoApply's is Simplified Chinese (translated by WP-92).
    const keepsFor = { [roboapply.id]: '7 days', [goapply.id]: '7 天' };
    for (const brand of [roboapply, goapply]) {
      const t = createEmailTranslator(brand, brand.defaultLocale);
      for (const key of COMPLIANCE_EMAIL_KEYS) expect(t(key, { days: 7 })).not.toContain('compliance.');
      const body = template.render({ brand, t, params: { days: 7 }, origin: 'https://example.test' });
      expect(body.subject).toContain(brand.name);
      expect(body.bodyText).toContain(keepsFor[brand.id]);
      expect(body.bodyText).toContain('https://example.test/settings#privacy');
      expect(body.bodyHtml.match(/href="[^"]*"/g)).toEqual(['href="https://example.test/settings#privacy"']);
    }
  });
});

describe('compliance-daily', () => {
  const now = new Date('2026-10-10T05:00:00.000Z');
  const ctx = (brand = goapply): CronContext => ({ name: 'compliance-daily', brand, budget: createBudget(240_000), now });

  it('idle run: no work, fast', async () => {
    const db = createFakePrisma();
    const task = createComplianceDaily({ db: db as unknown as ComplianceCronDb, sweepExports: async () => 0 });
    const t0 = Date.now();
    const res = await task(ctx());
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res).toMatchObject({ skipped: 'no_work', processed: 0, piRequests: { closed: 0, open: 0, overdue: 0 } });
  });

  it('closes requests whose account is gone and counts overdue ones (brand-scoped)', async () => {
    const db = createFakePrisma({
      seed: {
        rAPersonalInfoRequest: [
          { id: 'a', brand: 'goapply', userId: null, kind: 'withdraw_consent', status: 'in_progress', dueAt: new Date('2026-11-01'), closedAt: null },
          { id: 'b', brand: 'goapply', userId: 'u2', kind: 'access', status: 'open', dueAt: new Date('2026-10-01'), closedAt: null },
          { id: 'c', brand: 'roboapply', userId: null, kind: 'deletion', status: 'open', dueAt: new Date('2026-10-01'), closedAt: null },
        ],
      },
    });
    expect(await reconcilePiRequests(db as never, 'goapply', now)).toEqual({ closed: 1, open: 1, overdue: 1 });
    expect(db.$rows('rAPersonalInfoRequest').find((r) => r.id === 'a')).toMatchObject({ status: 'done', closedAt: now });
    expect(db.$rows('rAPersonalInfoRequest').find((r) => r.id === 'c')).toMatchObject({ status: 'open' });
  });
});
