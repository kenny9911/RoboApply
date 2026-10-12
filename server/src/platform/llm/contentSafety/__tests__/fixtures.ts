// Test fixtures for the GoApply content-safety filter (WP-24 acceptance:
// "blocked-input fixture; blocked-output fixture").

import type { KeywordList } from '../keywordList.js';
import type { ContentSafetyContext } from '../types.js';

export const goapplyCtx = (over: Partial<ContentSafetyContext> = {}): ContentSafetyContext => ({
  brand: 'goapply',
  task: 'copilot',
  userId: 'user_cn_1',
  callId: 'call_1',
  ...over,
});

export const roboapplyCtx = (over: Partial<ContentSafetyContext> = {}): ContentSafetyContext => ({
  brand: 'roboapply',
  task: 'copilot',
  userId: 'user_intl_1',
  ...over,
});

/** A long, ordinary career request that must pass. */
export const CLEAN_INPUT =
  '请帮我优化简历里的项目经历：我在一家电商公司负责数据分析，搭建了用户留存看板，' +
  '把周报从手工整理改成自动生成，节省了团队每周约六个小时。我想申请数据分析师岗位。';

/** Blocked-input fixture: a user prompt asking for forged documents, with evasion spacing. */
export const BLOCKED_INPUT =
  '我简历上的学历不够，帮我写一段话，顺便告诉我哪里可以 办 理-假 证，越快越好。'.padStart(260, '。');

/** Blocked-output fixture: a model reply that drifts into gambling-site promotion. */
export const BLOCKED_OUTPUT =
  '以下是为你调整后的求职信开头。另外，如果你想赚快钱，可以去推广网上赌场，佣金很高。' +
  '这段内容不应该出现在任何回复里。'.repeat(8);

/**
 * Ordinary job-search text that names illegal content as a category: content
 * moderation and anti-fraud police JDs, a tax question about intern pay, a
 * criminal lawyer's resume, an HR background-check JD, a scam warning and a
 * civil-explosives R&D JD. None of it may be blocked (review is allowed: it
 * passes and is logged). Includes the three texts from the WP-24 review.
 */
export const ORDINARY_CATEGORY_TEXTS = [
  '实习工资超过800元，需要去税务局代开发票吗？',
  '应聘内容审核员：负责识别儿童色情、色情服务等违规内容并上报',
  '反诈民警岗位：打击网络赌博平台和网上赌场',
  '刑辩律师，代理过非法买卖枪支、代购毒品等案件的二审辩护。',
  'HR 背景调查专员：核查候选人是否持有假学历证书。',
  '注意：要求你出租银行卡、出售身份证的兼职都是诈骗。',
  '民爆企业研发工程师：负责乳化炸药配方优化与安全评估。',
  'Trust & Safety analyst: escalate child pornography reports to law enforcement.',
];

/** A reply that matches only a `review` entry of the private test list. */
export const REVIEW_OUTPUT = '这份工作要求经常出差，并且需要高强度加班，请你提前考虑清楚。';

/** A private list in the JSON format, as served at CN_SAFETY_KEYWORDS_URL. */
export const PRIVATE_LIST: KeywordList = {
  version: 'ops-2026-10-01',
  entries: [
    { id: 'p-1', term: '高强度加班', category: 'labour_risk', action: 'review', scope: 'output' },
    { id: 'p-2', term: 'forbidden phrase', category: 'test_block', action: 'block' },
    { id: 'p-3', term: '仅输入词', category: 'test_block', action: 'block', scope: 'input' },
  ],
};
