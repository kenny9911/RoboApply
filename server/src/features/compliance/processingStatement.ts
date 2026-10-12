// server/src/features/compliance/processingStatement.ts
//
// The sentences of the consent prose that state WHO processes personal
// information outside mainland China and WHERE AI requests go — built from
// the same functions the legal disclosures render (`configuredProcessors`,
// `llmEndpointFacts`), so the consent a user ticks and the /legal tables can
// never name different processors, regions or AI destinations (D3).
//
//   offshoreProcessors(brand, env)             the /legal processor rows in a known country other than mainland China
//   unplacedProcessors(brand, env)             the /legal processor rows whose country is not known
//   offshoreProcessorsSentence(brand, env, l)  "境外处理方：数据库 Neon（美国，us-west-2）、…。"
//   aiPlaceSentence(brand, env, l)             where AI requests go, by the routing rule in force:
//                                              mainland only / never the mainland / the AI services configured
//
// Nothing here is typed in by hand except the words for a purpose and a
// country code. This is a signed consent text, so it states only what the
// configuration establishes:
//   - "outside mainland China" is said only of a processor whose country is
//     known and is not CN;
//   - a processor whose country we do not know is named in its own sentence
//     ("country not listed", the words of the /legal table) — disclosed, but
//     not asserted to be offshore;
//   - a mainland processor (country CN) is in neither;
//   - where the AI routing rule is "mainland only" (GoApply behind the
//     domestic-only wall), no AI model row is listed at all: the router
//     refuses every non-mainland endpoint, and the AI sentence says exactly
//     that. A configured model whose vendor has no known country is therefore
//     not an offshore processor there;
//   - where the rule is "open" (GoApply by default, D5: the shared model stack
//     is its fallback) nothing is refused by rule, so the AI model rows are
//     listed like any other processor and the AI sentence NAMES the AI
//     services requests go to, with each one's country. It never says they
//     stay in the mainland.
// With nothing to name the sentence points at the Legal information page.

import type { ProductBrand } from '../../platform/brand/registry.js';
import type { EnvSource } from '../../platform/brand/brandEnv.js';
import type { DisclosuresResponse, ProcessorPurpose } from './contract.js';
import { configuredModels, configuredProcessors, llmEndpointRule } from './disclosures.js';

export type StatementLocale = 'zh' | 'en';
type Processor = DisclosuresResponse['processors'][number];

/** Same words as the /legal processor table (`legal.processors.<purpose>`). */
const PURPOSE_WORDS: Readonly<Record<ProcessorPurpose, Record<StatementLocale, string>>> = {
  database: { zh: '数据库', en: 'database' },
  hosting: { zh: '网站托管', en: 'website hosting' },
  email: { zh: '邮件发送', en: 'email delivery' },
  voice: { zh: '语音练习', en: 'voice practice' },
  speech: { zh: '语音识别与合成', en: 'speech recognition and voice' },
  payments: { zh: '支付', en: 'payments' },
  ai_models: { zh: 'AI 模型', en: 'AI models' },
  storage: { zh: '文件存储', en: 'file storage' },
  content_safety: { zh: '内容安全审核', en: 'content safety checks' },
  push: { zh: '推送通知', en: 'push notifications' },
};

/** Names for the country codes the disclosures can produce (VENDOR_COUNTRY, AWS_REGION_COUNTRY). Any other code is shown as the code. */
const COUNTRY_WORDS: Readonly<Record<string, Record<StatementLocale, string>>> = {
  US: { zh: '美国', en: 'United States' },
  CA: { zh: '加拿大', en: 'Canada' },
  BR: { zh: '巴西', en: 'Brazil' },
  DE: { zh: '德国', en: 'Germany' },
  IE: { zh: '爱尔兰', en: 'Ireland' },
  GB: { zh: '英国', en: 'United Kingdom' },
  FR: { zh: '法国', en: 'France' },
  SE: { zh: '瑞典', en: 'Sweden' },
  SG: { zh: '新加坡', en: 'Singapore' },
  AU: { zh: '澳大利亚', en: 'Australia' },
  JP: { zh: '日本', en: 'Japan' },
  KR: { zh: '韩国', en: 'South Korea' },
  IN: { zh: '印度', en: 'India' },
  CN: { zh: '中国大陆', en: 'mainland China' },
};

export function statementLocale(locale: string | null | undefined): StatementLocale {
  return locale === 'zh' ? 'zh' : 'en';
}

/** The /legal processor rows the cross-border consent may speak about: every row, minus AI models where AI is mainland-only by routing. */
function consentRows(brand: ProductBrand, env: EnvSource): Processor[] {
  const aiMainlandOnly = llmEndpointRule(brand, env) === 'mainland_only';
  return configuredProcessors(brand, env).filter((p) => !(aiMainlandOnly && p.purpose === 'ai_models'));
}

/** The configured processors in a known country other than mainland China — the only ones the consent calls "outside mainland China". */
export function offshoreProcessors(brand: ProductBrand, env: EnvSource = process.env): Processor[] {
  return consentRows(brand, env).filter((p) => p.country !== null && p.country !== 'CN');
}

/** The configured processors whose country the configuration does not establish (the /legal table shows "Not listed"). */
export function unplacedProcessors(brand: ProductBrand, env: EnvSource = process.env): Processor[] {
  return consentRows(brand, env).filter((p) => p.country === null);
}

function placeOf(p: Processor, l: StatementLocale): string | null {
  const country = p.country ? (COUNTRY_WORDS[p.country]?.[l] ?? p.country) : null;
  if (country && p.region) return `${country}${l === 'zh' ? '，' : ', '}${p.region}`;
  return country ?? p.region ?? null;
}

/**
 * One processor as the consent names it: purpose, name, and the country and
 * region the /legal row shows. A row with no known country carries no country
 * words (the sentence it stands in says so).
 */
export function describeProcessor(p: Processor, locale: string | null | undefined): string {
  const l = statementLocale(locale);
  const purpose = PURPOSE_WORDS[p.purpose][l];
  const place = placeOf(p, l);
  if (l === 'zh') return place ? `${purpose} ${p.name}（${place}）` : `${purpose} ${p.name}`;
  return place ? `${p.name} (${purpose}, ${place})` : `${p.name} (${purpose})`;
}

/**
 * The sentences of the cross-border consent that name the processors: the
 * offshore ones, then — separately — the ones whose country is not listed.
 * Ends with a full stop and, in English, a trailing space, so the prose can
 * continue after it.
 */
export function offshoreProcessorsSentence(brand: ProductBrand, env: EnvSource = process.env, locale?: string | null): string {
  const l = statementLocale(locale);
  const offshore = offshoreProcessors(brand, env).map((p) => describeProcessor(p, l));
  const unplaced = unplacedProcessors(brand, env).map((p) => describeProcessor(p, l));
  if (offshore.length === 0 && unplaced.length === 0) {
    return l === 'zh' ? '境外处理方的清单见“法律信息”页面。' : 'The processors are listed on the Legal information page. ';
  }
  const parts: string[] = [];
  if (offshore.length) parts.push(l === 'zh' ? `境外处理方：${offshore.join('、')}。` : `Processors outside mainland China: ${offshore.join('; ')}. `);
  if (unplaced.length) parts.push(l === 'zh' ? `以下处理方的所在国家/地区未披露：${unplaced.join('、')}。` : `Processors whose country is not listed: ${unplaced.join('; ')}. `);
  return parts.join('');
}

/**
 * Where AI requests go, from the routing rule in force (`llmEndpointRule`,
 * the rule the /legal page prints):
 *   mainland_only  only AI services in mainland China (the wall refuses the rest);
 *   no_mainland    never an AI service in mainland China (RoboApply);
 *   open           the AI services configured for the brand, each named with
 *                  its country (the vendors of the /legal models table). With
 *                  no model configured it says requests may leave the mainland
 *                  and points at the Legal information page.
 */
export function aiPlaceSentence(brand: ProductBrand, env: EnvSource = process.env, locale?: string | null): string {
  const l = statementLocale(locale);
  const rule = llmEndpointRule(brand, env);
  if (rule === 'mainland_only') {
    return l === 'zh' ? 'AI 请求只发送到中国大陆境内的 AI 服务。' : 'AI requests are sent only to AI services in mainland China. ';
  }
  if (rule === 'open') {
    const vendors: string[] = [];
    const seen = new Set<string>();
    for (const m of configuredModels(brand, env)) {
      if (seen.has(m.vendor)) continue;
      seen.add(m.vendor);
      const country = m.region ? (COUNTRY_WORDS[m.region]?.[l] ?? m.region) : l === 'zh' ? '所在国家/地区未披露' : 'country not listed';
      vendors.push(l === 'zh' ? `${m.vendor}（${country}）` : `${m.vendor} (${country})`);
    }
    if (vendors.length === 0) {
      return l === 'zh'
        ? 'AI 请求可能发送到中国大陆境外的 AI 服务，具体服务见“法律信息”页面。'
        : 'AI requests may be sent to AI services outside mainland China. The Legal information page lists them. ';
    }
    return l === 'zh' ? `AI 请求会发送到这些 AI 服务：${vendors.join('、')}。` : `AI requests are sent to these AI services: ${vendors.join('; ')}. `;
  }
  return l === 'zh'
    ? '带有你的数据的 AI 请求不会发送到中国大陆境内的 AI 服务。'
    : 'A request that carries your data is never sent to an AI service in mainland China. ';
}
