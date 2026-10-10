// server/src/features/cn/jobs/fraud/keywords.ts — the deterministic half of
// GoApply's anti-fraud classifier (CN-E-08, PRODUCT F-TRUST-04 cn).
//
// Six rules, each resting on one verbatim sentence of the posting:
//   training_to_hire  招转培: "hiring" that turns into a paid training course
//   training_loan     培训贷: the course is paid with a loan or instalments
//   upfront_fee       先交钱: deposits, registration / uniform / placement fees
//   mlm               传销 / 拉人头 / 发展下线 / multi-level commission
//   gambling          博彩 / 菠菜 / 网赌 / 棋牌代理
//   telecom_lure      刷单, 跑分, renting out bank or phone cards, overseas
//                     "high pay, flights paid" lures (缅甸 / 柬埔寨 …)
// A reassurance does not flag: a short window before the match with 无 / 不 /
// 免 / 非 / 绝不 / 拒绝 … ("无需押金", "绝不收取任何费用", "非招转培"), or, for
// fees, a sentence that puts the cost on the employer ("费用由公司承担",
// "公司全额报销") in the same clause as the fee. Negations and the employer-pays
// check never reach across a comma, so "公司免费提供住宿，入职需交押金" flags.
// No LLM here; the cheap CN LLM pass (llm.ts) only runs on postings with
// fee, recruit-others or overseas wording and no keyword flag (`hasGrayCues`).

import { quoteAround, splitSentences, type Sentence } from '../text.js';
import type { CnFraudRule } from '../contract.js';

export interface CnFraudSignal {
  rule: Exclude<CnFraudRule, 'blacklisted_employer' | 'other'>;
  /** The posting sentence the flag rests on (verbatim, ≤ MAX_QUOTE_CHARS). */
  quote: string;
}

interface RuleSpec {
  rule: CnFraudSignal['rule'];
  patterns: RegExp[];
  /** Fee-type rules: an employer-pays sentence clears the match. */
  feeLike: boolean;
}

/** Characters before a match that may hold a multi-character negation ("绝不收取任何押金"). */
const NEGATION_WINDOW = 8;
const NEGATION = /(无需|无须|不需|不用|不收|不会|不是|不存在|不涉及|没有|绝不|绝无|拒绝|杜绝|严禁|谨防|警惕|防范|免收|免费|反对|打击)/u;
/** Single-character negations count only right before the match ("无押金", "免押金", "非招转培", "不赌博"). */
const NEGATION_CHAR_WINDOW = 2;
const NEGATION_CHAR = /[无不免非零反]/u;
const EMPLOYER_PAYS =
  /(公司|企业|单位|我司|雇主)(全额|全部)?(承担|报销|支付|负责|出资|买单|补贴)|由(公司|企业|单位|我司)(承担|报销|支付|负责)|(全额|免费)报销|免费提供|报销[^。；;]{0,4}费|费用?[^。；;]{0,2}(报销|补贴)/u;

const RULES: RuleSpec[] = [
  {
    rule: 'training_to_hire',
    feeLike: false,
    patterns: [
      /招转培/u,
      /先(培训|学习|参加培训)[^。，,；;]{0,6}(后|再)(上岗|就业|入职|推荐|安排|分配)/u,
      /培训(合格|结业|结束|期满|完成)[^。；;]{0,8}(推荐|安排|包|保证|分配)(就业|工作|上岗|入职)/u,
      /(包|保)(就业|分配|推荐工作)[^。；;]{0,10}(培训|学费|课程)|(培训|学费|课程)[^。；;]{0,10}(包|保)(就业|分配)/u,
      /(学员|学徒)[^。；;]{0,10}(推荐就业|就业保障|安排就业)/u,
      /零基础[^。；;]{0,12}(培训|学习|课程)[^。；;]{0,12}(就业|上岗|入职|高薪)/u,
    ],
  },
  {
    rule: 'training_loan',
    feeLike: true,
    patterns: [
      /培训贷|学费贷|课程贷|教育分期|助学分期/u,
      /(培训|学习|课程)(费用?|学费)[^。；;]{0,12}(分期|贷款|借贷|网贷|信用贷|花呗|白条)/u,
      /(分期|贷款|网贷|借贷)[^。；;]{0,12}(支付|缴纳|交|付)[^。；;]{0,4}(培训|学|课程)/u,
      /(办理|申请|开通)(分期|贷款)[^。；;]{0,12}(培训|学费|课程|入职)/u,
    ],
  },
  {
    rule: 'upfront_fee',
    feeLike: true,
    patterns: [
      /先交(钱|费|押金|定金|保证金)/u,
      /(押金|保证金|报名费|入职费|服装费|工装费|资料费|建档费|中介费|介绍费|上岗费|会员费|培训费|办卡费|入会费|门槛费)/u,
      /(需|须|要)(先)?(缴纳|交纳|缴|支付|交)[^。，,；;]{0,8}(元|块|费)/u,
    ],
  },
  {
    rule: 'mlm',
    feeLike: false,
    patterns: [
      /传销|拉人头|发展下线/u,
      /(下线|层级)(提成|返利|返佣|计酬|分红)/u,
      /(多层级|多级|三级)(分销|返利|返佣|提成)/u,
      /(拉|介绍|邀请)(朋友|亲友|好友|熟人|亲戚)[^。；;]{0,8}(加入|入会|入伙|投资|购买)/u,
      /(加盟费|入门费|入会费)[^。；;]{0,12}(返利|返佣|提成|回本)/u,
    ],
  },
  {
    rule: 'gambling',
    feeLike: false,
    patterns: [
      /博彩|菠菜|网赌|赌场|百家乐|赌博|六合彩|时时彩/u,
      /(棋牌|彩票|(?<![a-z])bc)[^。；;]{0,4}(代理|推广|平台)/u,
      /(真人|电子)(娱乐|视讯)平台/u,
    ],
  },
  {
    rule: 'telecom_lure',
    feeLike: false,
    patterns: [
      /刷单|刷信誉|刷好评|刷流水/u,
      /跑分(平台|赚钱|兼职|日结|佣金|返佣)/u,
      /点赞(员|兼职|赚钱|返佣|任务)/u,
      /(出租|出借|出售|收购|租用|借用)(你的)?(银行卡|手机卡|电话卡|电话号|微信号|支付宝|对公账户|身份证)/u,
      /(缅甸|柬埔寨|老挝|妙瓦底|西港|kk园区|东南亚)[^。；;]{0,24}(高薪|包机票|报销机票|月入|月薪[0-9一二三四五六七八九十]+万|包吃住)/u,
      /(手机|在家|网络)(兼职|打字|任务)[^。；;]{0,12}(日结|日赚|日入|一单一结)/u,
    ],
  },
];

/**
 * Gray-zone wording: fee, recruit-others and overseas cues worth the cheap LLM
 * pass when no keyword rule fired. Ordinary words most mainland postings use
 * (带薪培训, 提成, 兼职, 代理, 任务) are deliberately not cues.
 */
const GRAY_CUES =
  /(学费|收费|押金|交钱|缴纳|垫付|贷款|分期|返利|返佣|下线|拉人|邀请好友|推荐好友|躺赚|日赚|月入过万|日结|境外|海外|出国|包机票|包签证|缅甸|柬埔寨|老挝|迪拜)/u;

/** Comma-level clause breaks: a negation never reaches across one. */
const COMMA = /[,，]/u;
/** Clause breaks for the employer-pays check (an enumeration comma separates a perk from a fee too). */
const CLAUSE_BREAK = /[,，、]/u;

/** [start, end) of the clause of `text` around `index`, split on `breaks`. */
function clauseAround(text: string, index: number, breaks: RegExp): [number, number] {
  let start = index;
  while (start > 0 && !breaks.test(text[start - 1]!)) start -= 1;
  let end = index;
  while (end < text.length && !breaks.test(text[end]!)) end += 1;
  return [start, end];
}

function negated(sentence: Sentence, index: number, feeLike: boolean): boolean {
  const [commaStart] = clauseAround(sentence.norm, index, COMMA);
  if (NEGATION.test(sentence.norm.slice(Math.max(commaStart, index - NEGATION_WINDOW), index))) return true;
  if (NEGATION_CHAR.test(sentence.norm.slice(Math.max(commaStart, index - NEGATION_CHAR_WINDOW), index))) return true;
  if (!feeLike) return false;
  // Only the clause that names the fee: "公司免费提供住宿，入职需交押金" still flags.
  const [start, end] = clauseAround(sentence.norm, index, CLAUSE_BREAK);
  return EMPLOYER_PAYS.test(sentence.norm.slice(start, end));
}

function firstMatch(sentences: Sentence[], spec: RuleSpec): string | null {
  for (const sentence of sentences) {
    for (const re of spec.patterns) {
      const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = global.exec(sentence.norm))) {
        if (!negated(sentence, m.index, spec.feeLike)) return quoteAround(sentence, m.index);
        if (m[0].length === 0) global.lastIndex += 1;
      }
    }
  }
  return null;
}

/** Keyword signals in a posting (at most one per rule, the first sentence that supports it). */
export function detectCnFraudSignals(text: string): CnFraudSignal[] {
  if (!text.trim()) return [];
  const sentences = splitSentences(text);
  const out: CnFraudSignal[] = [];
  for (const spec of RULES) {
    const quote = firstMatch(sentences, spec);
    if (quote) out.push({ rule: spec.rule, quote });
  }
  return out;
}

/** True when the posting uses wording the cheap LLM pass should look at. */
export function hasGrayCues(text: string): boolean {
  return GRAY_CUES.test(text.normalize('NFKC'));
}
