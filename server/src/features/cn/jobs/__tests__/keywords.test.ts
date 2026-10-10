// @vitest-environment node
// WP-41 acceptance: fraud fixtures (招转培, 培训贷, 先交钱, MLM, gambling,
// telecom lures). Anonymized postings written for these tests.

import { describe, expect, it } from 'vitest';
import { detectCnFraudSignals, hasGrayCues } from '../fraud/keywords.js';
import { MAX_QUOTE_CHARS as ENRICH_MAX_QUOTE } from '../../../jobs/enrich/index.js';
import { MAX_QUOTE_CHARS, quoteInText } from '../text.js';

const rules = (text: string) => detectCnFraudSignals(text).map((s) => s.rule);

const FIXTURES: Array<[string, string, string]> = [
  ['training_to_hire', '招聘Java开发实习生。入职前需参加4个月岗前培训，招转培模式，结业后推荐就业。', '招转培'],
  ['training_to_hire', '零基础可学，先培训后上岗，培训合格后安排工作。', '先培训后上岗'],
  ['training_loan', '学费可办理分期，培训费用可申请贷款，入职后每月还款。', '培训费用可申请贷款'],
  ['training_loan', '无需担心费用，平台提供培训贷，学完包就业。', '培训贷'],
  ['upfront_fee', '入职需缴纳押金500元，三个月后退还。', '押金'],
  ['upfront_fee', '面试通过后先交钱办理工牌和服装。', '先交钱'],
  ['upfront_fee', '报名费200元，资料费另计。', '报名费'],
  // A perk in another clause of the same sentence does not cancel the fee (review finding).
  ['upfront_fee', '公司免费提供住宿，入职需交押金300元。', '押金'],
  ['upfront_fee', '提供交通费补贴，上岗前需缴纳服装费200元。', '服装费'],
  ['upfront_fee', '入职需缴纳500元保证金，公司报销路费。', '保证金'],
  ['upfront_fee', '免费培训，需交押金300元。', '押金'],
  ['mlm', '诚招合伙人，发展下线即可获得团队收益，躺赚。', '发展下线'],
  ['mlm', '加盟费3980元，拉朋友加入可返佣，三级分销模式。', '三级分销'],
  ['gambling', '东南亚菠菜平台招聘客服，高薪日结。', '菠菜'],
  ['gambling', '招聘棋牌代理推广专员，佣金丰厚。', '棋牌代理'],
  ['telecom_lure', '在家手机兼职刷单，一单一结，日赚300+。', '刷单'],
  ['telecom_lure', '高价收购银行卡和手机卡，可长期合作。', '收购银行卡'],
  ['telecom_lure', '柬埔寨公司招聘业务员，包机票包吃住，月入3万。', '柬埔寨'],
];

describe('detectCnFraudSignals: fixtures', () => {
  it.each(FIXTURES)('%s: %s', (rule, posting, cue) => {
    const signals = detectCnFraudSignals(posting);
    const hit = signals.find((s) => s.rule === rule);
    expect(hit, `${rule} not flagged`).toBeTruthy();
    // The evidence is a verbatim sentence of the posting that holds the cue.
    expect(quoteInText(hit!.quote, posting)).toBe(true);
    expect(hit!.quote).toContain(cue);
  });
});

describe('detectCnFraudSignals: reassurances and ordinary jobs do not flag', () => {
  const CLEAN = [
    '本公司招聘不收取任何费用，无需押金。',
    '公司提供免费岗前培训，培训期间带薪。',
    '入职体检费用由公司承担。',
    '我们非招转培，也不涉及培训贷，请放心投递。',
    '岗位职责：负责反洗钱合规审查。任职要求：无不良嗜好，不赌博。',
    '负责团队管理，团队提成按季度发放。',
    '负责手机性能跑分测试与功耗分析。',
    '公司为员工缴纳五险一金，提供年度体检。',
    '培训费报销，每年1万元学习补贴。',
    '2027届校园招聘：软件工程师，base北京。',
  ];
  it.each(CLEAN)('%s', (posting) => {
    expect(rules(posting)).toEqual([]);
  });

  it('a negation far from the fee does not clear it', () => {
    expect(rules('工作不累，环境好。入职交押金300元。')).toContain('upfront_fee');
  });

  it('one flag per rule, from the first supporting sentence', () => {
    const s = detectCnFraudSignals('需交押金100元。另需报名费50元。');
    expect(s.filter((x) => x.rule === 'upfront_fee')).toHaveLength(1);
    expect(s[0]!.quote).toContain('押金');
  });

  it('empty text → no signals', () => {
    expect(detectCnFraudSignals('  ')).toEqual([]);
  });

  it('long sentences are cut to the quote cap around the match', () => {
    const long = `${'负责日常运营工作并配合团队完成各项任务'.repeat(20)}，入职需缴纳押金800元${'并完成相关手续办理'.repeat(10)}`;
    const [hit] = detectCnFraudSignals(long);
    expect(hit!.rule).toBe('upfront_fee');
    expect(hit!.quote.length).toBeLessThanOrEqual(MAX_QUOTE_CHARS);
    expect(hit!.quote).toContain('押金');
  });
});

describe('hasGrayCues', () => {
  it('fee, recruit-others and overseas wording asks for the LLM pass', () => {
    expect(hasGrayCues('宝妈兼职，轻松日结')).toBe(true);
    expect(hasGrayCues('入职后可申请分期付款购买设备。')).toBe(true);
    expect(hasGrayCues('邀请好友加入团队可获奖励。')).toBe(true);
    expect(hasGrayCues('海外项目，包签证。')).toBe(true);
  });

  it('ordinary mainland postings do not (带薪培训, 提成, 代理, 任务)', () => {
    expect(hasGrayCues('负责后端服务开发，熟悉Go语言。')).toBe(false);
    expect(hasGrayCues('提供带薪培训，销售提成另计。')).toBe(false);
    expect(hasGrayCues('负责区域代理商管理，完成季度任务指标，佣金按合同。')).toBe(false);
  });
});

it('quote cap stays equal to WP-17', () => {
  expect(MAX_QUOTE_CHARS).toBe(ENRICH_MAX_QUOTE);
});
