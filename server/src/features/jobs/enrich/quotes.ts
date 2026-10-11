// server/src/features/jobs/enrich/quotes.ts
//
// The quote-substring guard (CitationGuard pattern, ARCHITECTURE.md §4.5) and
// the sponsorship negation rule (TASK_PLAN.md H36, PRODUCT F-FILT-02):
//   - every sponsorship / clearance / citizenship / employer-tag claim must
//     carry a quote that is a substring of the posting, or it is dropped;
//   - `not_offered` needs BOTH the model's label and a negation keyword in the
//     quote. A quote with a negation keyword labelled `offered` contradicts
//     itself and becomes `not_stated` (an honest unknown, D3);
//   - a sponsorship quote must also name a work-authorization term, so a
//     quote about something else cannot back a sponsorship badge;
//   - the employer's industry (SM-10) needs a quote that names that industry's
//     topic outside the employer's own name, and that is not about a
//     recruiter's client.
// The work-authorization vocabulary is country-aware (TW-09): H-1B, the UK
// sponsor licence, Canada's LMIA, Taiwan's work permit / Employment Gold Card,
// mainland 工作签证 / 外国人工作许可.
//
// Matching is done on a normalized form (NFKC, lower case, unified quotes and
// dashes, collapsed whitespace), so a quote that differs only in spacing or
// curly quotes still counts; anything else does not.

import { MAX_QUOTE_CHARS, type SponsorshipStatus } from './schema.js';

const CJK = /[㐀-鿿豈-﫿]/;

/** NFKC, lower case, unified quotes/dashes/ellipses, collapsed whitespace. */
export function normalizeForQuote(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′`]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Shortest quote worth citing: 2 CJK characters or 8 Latin characters. */
function longEnough(normalizedQuote: string): boolean {
  return CJK.test(normalizedQuote) ? normalizedQuote.replace(/\s/g, '').length >= 2 : normalizedQuote.length >= 8;
}

/**
 * The quote, trimmed and capped at MAX_QUOTE_CHARS, when it is a substring of
 * `posting`; otherwise null. Surrounding quote marks and a trailing ellipsis
 * the model may add are stripped before the check.
 */
export function verifyQuote(quote: string | null | undefined, posting: string): string | null {
  if (!quote) return null;
  let q = quote.replace(/\s+/g, ' ').trim();
  q = q.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
  q = q.replace(/(\.\.\.|…)$/, '').trim();
  const nq = normalizeForQuote(q);
  if (!nq || !longEnough(nq)) return null;
  if (!normalizeForQuote(posting).includes(nq)) return null;
  return q.length > MAX_QUOTE_CHARS ? q.slice(0, MAX_QUOTE_CHARS).trimEnd() : q;
}

// ── Negation keywords (per language) ────────────────────────────────────

/** English negations, matched as whole words on the normalized quote. */
const EN_NEGATIONS = [
  'not',
  'no',
  'unable',
  'cannot',
  "can't",
  "won't",
  "don't",
  "doesn't",
  "isn't",
  "aren't",
  'never',
  'without',
  'unavailable',
  'ineligible',
  'nor',
];
const EN_NEGATION_RE = new RegExp(`(^|[^a-z'])(${EN_NEGATIONS.join('|')})(?=$|[^a-z'])`);

/** Chinese negations (Simplified and Traditional), matched as substrings. */
const ZH_NEGATIONS = ['不', '无', '無', '没有', '沒有', '未', '恕不', '非'];

/** True when the quote contains a negation keyword (en / zh / zh-TW). */
export function hasNegation(quote: string): boolean {
  const n = normalizeForQuote(quote);
  if (EN_NEGATION_RE.test(n)) return true;
  return ZH_NEGATIONS.some((w) => n.includes(w));
}

// ── Work-authorization vocabulary (TW-09) ───────────────────────────────

const WORK_AUTH_TERMS_LATIN = [
  'sponsor', // sponsor, sponsors, sponsorship, sponsored, sponsor licence/license
  'visa',
  'h-1b',
  'h1b',
  'h1-b',
  'green card',
  'work permit',
  'work authori', // authorization / authorisation / authorized
  'right to work',
  'lmia',
  'skilled worker',
  'gold card',
  'tn status',
  'immigration',
];
const WORK_AUTH_TERMS_CJK = ['签证', '簽證', '工作许可', '工作許可', '就业金卡', '就業金卡', '外国人', '外國人', '居留', '工签', '工簽', '担保', '擔保'];

/** True when the text names a work-authorization or visa-sponsorship concept. */
export function mentionsWorkAuthorization(text: string): boolean {
  const n = normalizeForQuote(text);
  if (WORK_AUTH_TERMS_CJK.some((t) => n.includes(t))) return true;
  return WORK_AUTH_TERMS_LATIN.some((t) => n.includes(t));
}

// ── Sponsorship reconciliation ──────────────────────────────────────────

export interface SponsorshipResult {
  status: SponsorshipStatus;
  /** Verified quote; null unless status is offered / not_offered. */
  quote: string | null;
  /** Why the model's label was changed, for logs and tests. */
  corrected: null | 'quote_not_in_posting' | 'no_work_auth_term' | 'no_negation_keyword' | 'negation_in_offered_quote';
}

/**
 * Apply the quote guard and the negation rule to the model's sponsorship label.
 *   offered      → needs a verified quote that names work authorization and
 *                  has no negation keyword;
 *   not_offered  → needs a verified quote that names work authorization AND a
 *                  negation keyword (both the label and the keyword, H36);
 *   anything else → not_stated.
 */
export function reconcileSponsorship(label: SponsorshipStatus, rawQuote: string | null, posting: string): SponsorshipResult {
  if (label === 'not_stated') return { status: 'not_stated', quote: null, corrected: null };
  const quote = verifyQuote(rawQuote, posting);
  if (!quote) return { status: 'not_stated', quote: null, corrected: 'quote_not_in_posting' };
  if (!mentionsWorkAuthorization(quote)) return { status: 'not_stated', quote: null, corrected: 'no_work_auth_term' };
  const negated = hasNegation(quote);
  if (label === 'not_offered') {
    return negated ? { status: 'not_offered', quote, corrected: null } : { status: 'not_stated', quote: null, corrected: 'no_negation_keyword' };
  }
  return negated ? { status: 'not_stated', quote: null, corrected: 'negation_in_offered_quote' } : { status: 'offered', quote, corrected: null };
}

// ── Citizenship / clearance requirements ────────────────────────────────

export type RequirementField = 'citizenship' | 'clearance';

/**
 * The topic cue a requirement quote must contain. Work authorization alone is
 * not citizenship ("must be authorized to work in the US" says nothing about
 * citizenship), so it does not count.
 */
export const REQUIREMENT_TOPIC_CUES: Record<RequirementField, RegExp> = {
  citizenship: /citizen|公民|国籍|國籍/,
  clearance: /clearance|(?:^|[^a-z])secret(?:$|[^a-z])|ts\/sci|polygraph|政审|政審/,
};

/**
 * Wording that says the requirement does NOT apply ("US citizenship is not
 * required", "no clearance needed", "无需政审"). A quote with it cannot back
 * a `true` value.
 */
const NOT_REQUIRED_RE =
  /\b(?:not|never)\s+(?:be\s+)?(?:required|necessary|needed|a requirement|mandatory)\b|\b(?:does|do|will)\s+not\s+(?:need|require)\b|\b(?:doesn't|don't|won't)\s+(?:need|require)\b|\bno\s+(?:[a-z.]+\s+){0,3}(?:required|needed|necessary)\b|\bregardless of\s+(?:citizenship|nationality)\b|不需要|不需|无需|無需|不要求|不限|不必/;

/** True when the quote is about the requirement's topic. */
export function quoteMatchesRequirementTopic(field: RequirementField, quote: string): boolean {
  return REQUIREMENT_TOPIC_CUES[field].test(normalizeForQuote(quote));
}

/** Why a requirement claim was dropped (logs and tests). */
export type RequirementDrop = 'quote_not_in_posting' | 'off_topic' | 'no_negation_keyword' | 'negated_required_quote';

/**
 * A yes/no requirement (citizenship, clearance) with its quote. Kept only
 * when the quote
 *   - is a substring of the posting,
 *   - names the field's topic (REQUIREMENT_TOPIC_CUES), and
 *   - agrees with the value: `false` needs a negation keyword (mirroring the
 *     sponsorship `not_offered` rule); `true` must not say "not required".
 * Otherwise the signal is unknown (null) — never inferred from absence
 * (ruling C18).
 */
export function reconcileRequirement(
  field: RequirementField,
  signal: { value: boolean | null; quote: string | null } | null,
  posting: string,
): { value: boolean; quote: string } | { value: null; dropped: RequirementDrop } | null {
  if (!signal || signal.value === null) return null;
  const quote = verifyQuote(signal.quote, posting);
  if (!quote) return { value: null, dropped: 'quote_not_in_posting' };
  if (!quoteMatchesRequirementTopic(field, quote)) return { value: null, dropped: 'off_topic' };
  if (signal.value === false && !hasNegation(quote)) return { value: null, dropped: 'no_negation_keyword' };
  if (signal.value === true && NOT_REQUIRED_RE.test(normalizeForQuote(quote))) return { value: null, dropped: 'negated_required_quote' };
  return { value: signal.value, quote };
}

// ── GoApply employer tags ───────────────────────────────────────────────

/** The cue each employer tag's quote must contain (Simplified and Traditional). */
export const EMPLOYER_TAG_TOPIC_CUES: Record<string, RegExp> = {
  soe: /央企|中央企业|中央企業|国企|國企|国有|國有/,
  bianzhi: /编制|編制|事业编|事業編|事业单位|事業單位/,
  hukou: /落户|落戶|户口|戶口/,
  foreign: /外企|外资|外資|外商/,
};

/** A Chinese negation right before the cue ("无编制", "不提供落户", "非国企"). */
const CUE_NEGATION = /(?:不|无|無|没有|沒有|未|非)[^，。；,;.]{0,4}$/;

/**
 * True when `quote` names the tag's topic in a positive way: the cue is there
 * and is not preceded by a negation ("不解决户口" does not back `hukou`).
 */
export function quoteSupportsEmployerTag(tag: string, quote: string): boolean {
  const cue = EMPLOYER_TAG_TOPIC_CUES[tag];
  if (!cue) return false;
  const n = normalizeForQuote(quote);
  const global = new RegExp(cue.source, 'g');
  for (const m of n.matchAll(global)) {
    if (!CUE_NEGATION.test(n.slice(Math.max(0, m.index - 8), m.index))) return true;
  }
  return false;
}

/** The verified quote for an employer tag, or null (not in the posting, off topic or negated). */
export function verifyEmployerTagQuote(tag: string, quote: string | null | undefined, posting: string): string | null {
  const verified = verifyQuote(quote, posting);
  return verified && quoteSupportsEmployerTag(tag, verified) ? verified : null;
}

// ── The employer's industry (SM-10) ─────────────────────────────────────

/**
 * The cue an industry quote must contain, per industry id (the closed list of
 * the industries filter). The list leans to technology, so the cues do too: a
 * bank is not "Fintech" and a hospital is not "Healthtech" unless the posting
 * says so in words like these. A value without its cue is dropped, never
 * replaced by the nearest one (D3). English, Simplified and Traditional.
 */
export const INDUSTRY_TOPIC_CUES: Record<string, RegExp> = {
  Healthtech:
    /\b(?:health ?tech|digital health|e-?health|tele(?:health|medicine)|med ?tech|medical (?:devices?|technology|software|imaging|ai)|health ?care (?:technology|software|platform|data|analytics|ai|it)|health (?:technology|software|platform|data|apps?|information)|electronic health records?|ehr|clinical (?:software|decision support|data))\b|医疗科技|数字医疗|数字健康|互联网医疗|智慧医疗|医疗器械|医疗信息化|医疗ai|醫療科技|數位醫療|數位健康|智慧醫療|醫療器材|醫療資訊/,
  Climate:
    /\b(?:climate|clean ?tech|clean energy|green energy|renewables?|solar|wind (?:power|energy|farms?|turbines?)|carbon|energy storage|battery storage|electric vehicles?|ev charging|net[- ]zero|geothermal|hydrogen)\b|\b(?:decarboni|sustainab)|新能源|光伏|储能|儲能|风电|風電|风能|風能|太阳能|太陽能|碳中和|碳达峰|减碳|減碳|低碳|清洁能源|潔淨能源|再生能源|绿能|綠能|绿色能源|綠色能源|气候|氣候|氢能|氫能|电动汽车|電動車|充电桩|充電樁/,
  Fintech:
    /\b(?:fin ?tech|financial technology|payments?|digital bank(?:ing)?|online bank(?:ing)?|mobile bank(?:ing)?|open banking|neobank|insur ?tech|wealth ?tech|reg ?tech|lending platform|crypto(?:currency|currencies)?|blockchain|stablecoins?|defi|trading platform|digital wallets?|bnpl|buy now,? pay later)\b|金融科技|互联网金融|支付|数字银行|數位銀行|數位金融|区块链|區塊鏈|加密货币|加密貨幣|保险科技|保險科技/,
  Edtech:
    /\b(?:ed ?tech|education(?:al)? technology|online (?:learning|education|courses?|tutoring|school)|e-?learning|learning (?:platform|apps?|management system)|lms|moocs?)\b|在线教育|在線教育|線上教育|教育科技|在线学习|線上學習|网课|在线课程|線上課程|教育平台|智慧教育|数字教育/,
  'Developer tools':
    /\b(?:developer tools?|dev ?tools?|developer (?:platform|experience|productivity|infrastructure)|for (?:software )?(?:developers|engineers|engineering teams)|open[- ]source|api platform|sdks?|ci\/cd|observability|code (?:review|editor|search|hosting)|ide|devops (?:platform|tools?)|infrastructure as code|low[- ]code|no[- ]code)\b|开发者工具|开发者平台|開發者工具|開發者平台|开发工具|開發工具|开源|開源|研发效能|低代码|低代碼/,
  'AI / ML':
    /\b(?:ai|artificial intelligence|machine learning|ml|deep learning|large language models?|llms?|generative|gen ?ai|computer vision|natural language processing|nlp|foundation models?|neural networks?|autonomous (?:driving|vehicles?))\b|人工智能|人工智慧|机器学习|機器學習|深度学习|深度學習|大模型|aigc|生成式|计算机视觉|電腦視覺|自然语言处理|自然語言處理|自动驾驶|自動駕駛|智能驾驶|智慧駕駛/,
  'B2B SaaS':
    /\b(?:saas|software[- ]as[- ]a[- ]service|b2b|to ?b|enterprise software|business software|cloud[- ]based (?:software|platform)|software (?:for|to) (?:businesses|companies|enterprises|teams|organi[sz]ations)|crm|erp|hr software|workflow (?:software|platform|automation))\b|企业服务|企業服務|企业软件|企業軟體|企业级|企業級|软件即服务|軟體即服務|云服务|雲端服務|协同办公|協同辦公/,
  Consumer:
    /\b(?:consumers?|b2c|d2c|dtc|to ?c|direct[- ]to[- ]consumer|cpg|fmcg|lifestyle brand|retail brand)\b|消费|消費|快消|c端|零售品牌|个护|個人護理|美妆|美妝|食品饮料|食品飲料/,
  'E-commerce':
    /\b(?:e-?commerce|ecom|online (?:store|shop|shopping|retail(?:er)?|marketplace)|web ?shop)\b|电商|電商|电子商务|電子商務|网购|網購|网上商城|網路購物/,
  Marketplaces:
    /\b(?:marketplaces?|two[- ]sided|peer[- ]to[- ]peer|gig (?:economy|platform)|sharing economy|on[- ]demand platform|platform (?:that )?connect(?:s|ing)|connect(?:s|ing) (?:buyers|sellers|customers|clients|businesses|travell?ers|drivers|freelancers|patients|students|homeowners|renters|shippers|brands|creators|employers|talent|people))\b|交易平台|撮合|双边平台|雙邊平台|媒合|共享经济|共享經濟|平台经济|平台經濟|二手交易/,
  Logistics:
    /\b(?:logistics|supply chain|freight|shipping|deliver(?:y|ies)|fulfil?lment|trucking|courier|last[- ]mile|3pl|forwarding|carriers?|parcels?|cargo|fleet)\b|\bwarehous|物流|供应链|供應鏈|快递|快遞|货运|貨運|仓储|倉儲|配送|运输|運輸|货代|貨代|航运|航運/,
  Manufacturing:
    /\b(?:factor(?:y|ies)|production (?:plants?|facilit(?:y|ies)|lines?)|industrial|assembly (?:plants?|lines?)|oem|odm|machining|fabrication|foundry)\b|\bmanufactur|制造|製造|工厂|工廠|生产基地|生產基地|代工|生产企业|生產企業/,
  Cybersecurity:
    /\b(?:cyber ?security|cyber|info ?sec|information security|network security|cloud security|application security|security (?:software|platform|company|vendor|products?|solutions?|operations|research)|threat (?:intelligence|detection)|endpoint (?:security|protection)|zero[- ]trust|identity (?:security|and access)|penetration testing|siem|anti[- ]?virus|encryption)\b|\bvulnerabilit|网络安全|網路安全|网安|信息安全|資訊安全|資安|数据安全|數據安全|安全厂商|安全公司|安全产品|安全防护|攻防|零信任/,
  Media:
    /\b(?:media|publisher|journalism|streaming|entertainment|films?|television|tv|music|podcasts?|magazines?|radio|studios?|video (?:platform|content|production)|content (?:platform|studio|company)|advertising)\b|\b(?:news|publish|broadcast)|媒体|媒體|新闻|新聞|出版|影视|影視|传媒|傳媒|广播|廣播|娱乐|娛樂|内容平台|內容平台|视频平台|影音|短视频|短視頻|直播|音乐|音樂|广告|廣告|电视|電視/,
  Gaming: /\b(?:gaming|igaming|games?|video ?games?|e-?sports)\b|游戏|遊戲|电竞|電競|手游|手遊|网游|網遊/,
  Hardware:
    /\b(?:hardware|semiconductors?|chips?|devices?|electronics|sensors?|iot|internet of things|embedded|wearables?|drones?|pcbs?|integrated circuits?|ic design|fabless|silicon|lidar|batter(?:y|ies))\b|\b(?:robot|3d print)|硬件|硬體|半导体|半導體|芯片|晶片|电子产品|电子元器件|电子设备|消费电子|电子制造|电子科技|電子產品|電子零件|電子設備|消費電子|電子製造|電子科技|机器人|機器人|智能设备|智慧裝置|传感器|感測器|集成电路|積體電路|ic设计|ic設計|物联网|物聯網|无人机|無人機|可穿戴|穿戴式/,
  'Bio / Pharma':
    /\b(?:drug (?:discovery|development)|drugs?|therapeutics?|therap(?:y|ies)|clinical[- ]stage|clinical trials?|life sciences?|gene (?:therapy|editing)|vaccines?|oncology|medicines?|biosimilars?|cro|cdmo|diagnostics?)\b|\b(?:bio ?tech|bio ?pharma|pharma|biolog|genom|antibod)|生物|制药|製藥|医药|醫藥|药物|藥物|新药|新藥|药企|藥廠|生技|生醫|基因|疫苗|临床试验|臨床試驗|体外诊断|體外診斷/,
  'Real estate':
    /\b(?:real estate|propert(?:y|ies)|prop ?tech|housing|residential|rentals?|leasing|landlords?|mortgages?|co-?working|apartments?)\b|\b(?:realt|home ?build)|房地产|房地產|地产|地產|物业|物業|不动产|不動產|房产|房產|房屋|租房|租屋|楼盘|樓盤|置业|置業|长租|長租|公寓|房仲/,
  'Legal-tech':
    /\b(?:legal ?tech|law ?tech|legal (?:technology|software|platform|ai|operations|research|documents?|workflows?)|(?:software|technology|platform|tools?|ai) for (?:lawyers|law firms|legal teams|attorneys|legal professionals)|contract (?:lifecycle )?management|contract (?:review|analysis|automation)|clm|e-?discovery|e-?signatures?|practice management|compliance (?:software|platform|automation))\b|法律科技|法务科技|法務科技|智慧法务|智慧法務|电子签约|电子签名|電子簽署|電子簽名|合同管理|合約管理|法律ai|法律大模型|律所管理/,
};

/**
 * Wording of a recruiter's posting for someone else ("Our client is a leading
 * fintech", 代招, 某知名互联网公司): the sentence describes a client, not the
 * employer whose company row the job hangs on.
 */
const CLIENT_POSTING_CUE =
  /\b(?:our|my) client\b(?![- ](?:base|facing|list|portfolio|roster|services|success))|\bon behalf of\b|\b(?:client|customer) of ours\b|客户公司|客戶公司|代招|代客招聘|委托招聘|委託招聘|受[^，。,.]{0,10}(?:委托|委託)|某(?:知名|大型|上市|头部|頭部|著名|外资|外資|国企|國企|央企|互联网|網路|世界500强)/;

/** True when the quote describes a recruiter's client rather than the employer. */
export function quoteSpeaksOfClient(quote: string): boolean {
  return CLIENT_POSTING_CUE.test(normalizeForQuote(quote));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The normalized quote with the employer's name taken out: the full name, or
 * the longest leading part of it the quote uses ("Acme Fintech" for "Acme
 * Fintech Ltd", 阳光光伏 for 阳光光伏科技有限公司). What is left is what the
 * posting says about the employer; the name itself states nothing
 * ("Acme Fintech Ltd" is a name, not a line of business).
 */
export function quoteWithoutCompanyName(quote: string, companyName: string): string {
  const said = normalizeForQuote(quote);
  const name = normalizeForQuote(companyName ?? '');
  if (!name) return said;
  if (CJK.test(name)) {
    const compact = name.replace(/\s/g, '');
    for (let n = compact.length; n >= 2; n--) {
      const part = compact.slice(0, n);
      if (said.includes(part)) return said.split(part).join(' ');
    }
    return said;
  }
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (let n = words.length; n >= 1; n--) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${words.slice(0, n).map(escapeRegExp).join('[^\\p{L}\\p{N}]+')}(?=$|[^\\p{L}\\p{N}])`, 'gu');
    if (re.test(said)) return said.replace(re, '$1 ');
  }
  return said;
}

/** Why an industry claim was dropped (logs and tests). */
export type IndustryDrop = 'quote_not_in_posting' | 'company_name_only' | 'client' | 'off_topic';

/**
 * The employer's industry with its quote. Kept only when the quote
 *   - is a substring of the posting,
 *   - says something besides the employer's own name (3 words, or 4 Chinese
 *     characters),
 *   - does not describe a recruiter's client, and
 *   - names the claimed industry's topic (INDUSTRY_TOPIC_CUES) outside the
 *     employer's name: "某某能源集团是一家中央企业" says the employer is a state
 *     company, not that it is in climate.
 * Otherwise there is no industry: never one inferred from a name (D3).
 */
export function reconcileIndustry(
  claim: { value: string; quote: string } | null | undefined,
  companyName: string,
  posting: string,
): { value: string; quote: string } | { value: null; dropped: IndustryDrop } | null {
  if (!claim) return null;
  const quote = verifyQuote(claim.quote, posting);
  if (!quote) return { value: null, dropped: 'quote_not_in_posting' };
  const beyondName = quoteWithoutCompanyName(quote, companyName);
  const words = beyondName.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const enough = CJK.test(words) ? words.replace(/\s/g, '').length >= 4 : words.split(' ').filter(Boolean).length >= 3;
  if (!enough) return { value: null, dropped: 'company_name_only' };
  if (quoteSpeaksOfClient(quote)) return { value: null, dropped: 'client' };
  const cue = INDUSTRY_TOPIC_CUES[claim.value];
  if (!cue || !cue.test(beyondName)) return { value: null, dropped: 'off_topic' };
  return { value: claim.value, quote };
}
