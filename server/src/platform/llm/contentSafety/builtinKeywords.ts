// server/src/platform/llm/contentSafety/builtinKeywords.ts
//
// The built-in, versioned baseline keyword list (WP-24). It is deliberately
// small and is a floor, not the mechanism: production GoApply (CN-1) also
// requires Aliyun Green, and the operator's full list is private (loaded from
// CN_SAFETY_KEYWORDS_URL, see keywordList.ts, and merged with this one).
//
// The text checked is job-search text, and that includes job descriptions and
// resumes for content moderators, police and anti-fraud officers, criminal
// lawyers, compliance and tax staff, HR background checkers and civil-
// explosives engineers. Those texts name illegal content as a category
// ("识别儿童色情", "打击网络赌博平台", "不出租、不出售银行卡", "非法买卖枪支案",
// "核查假学历证书", "乳化炸药配方"). So:
//   - `block` is kept for phrases that read as an offer, a request or
//     instructions (出售冰毒, 提供色情服务, 推广网上赌场, 自制炸弹);
//   - category nouns and crime-name phrasing are `review`: the text passes and
//     the check is logged with an excerpt, so the operator can see how often
//     they occur and promote them in the private list if needed;
//   - words that are ordinary in career text are left out entirely (洗钱 would
//     hit 反洗钱专员, 刷单 a scam warning, 代开发票 a tax-bureau invoice for
//     intern pay).
// keywordList.test.ts holds the regression texts that must stay clean.
//
// Bump BUILTIN_KEYWORD_LIST.version whenever an entry changes: the version is
// written on every event, so a verdict can be traced to the list it used.

import type { KeywordList } from './keywordList.js';

export const BUILTIN_KEYWORD_LIST: KeywordList = {
  version: 'builtin-2026.10.10-r2',
  entries: [
    // Weapons and explosives: offers and instructions block; trade/crime-name phrasing is review.
    { id: 'b-wpn-01', term: '出售枪支', category: 'weapons', action: 'block' },
    { id: 'b-wpn-02', term: '买卖枪支', category: 'weapons', action: 'review' },
    { id: 'b-wpn-03', term: '枪支出售', category: 'weapons', action: 'block' },
    { id: 'b-wpn-04', term: '自制炸药', category: 'weapons', action: 'block' },
    { id: 'b-wpn-05', term: '炸药配方', category: 'weapons', action: 'review' },
    { id: 'b-wpn-06', term: '自制炸弹', category: 'weapons', action: 'block' },
    { id: 'b-wpn-07', term: 'buy firearms illegally', category: 'weapons', action: 'block' },
    { id: 'b-wpn-08', term: 'how to make a pipe bomb', category: 'weapons', action: 'block' },
    // Drug trading
    { id: 'b-drg-01', term: '出售冰毒', category: 'drugs', action: 'block' },
    { id: 'b-drg-02', term: '冰毒出售', category: 'drugs', action: 'block' },
    { id: 'b-drg-03', term: '毒品交易渠道', category: 'drugs', action: 'block' },
    { id: 'b-drg-04', term: '代购毒品', category: 'drugs', action: 'review' },
    { id: 'b-drg-05', term: '出售大麻', category: 'drugs', action: 'block' },
    { id: 'b-drg-06', term: 'buy cocaine online', category: 'drugs', action: 'block' },
    // Gambling sites (illegal in the mainland): promotion blocks; the nouns are review.
    { id: 'b-gmb-01', term: '网络赌博平台', category: 'gambling', action: 'review' },
    { id: 'b-gmb-02', term: '网上赌场', category: 'gambling', action: 'review' },
    { id: 'b-gmb-03', term: '赌博网站代理', category: 'gambling', action: 'review' },
    { id: 'b-gmb-04', term: '推广网上赌场', category: 'gambling', action: 'block' },
    { id: 'b-gmb-05', term: '网上赌场推广', category: 'gambling', action: 'block' },
    // Sexual exploitation: trading and offering services block; the category nouns are review.
    { id: 'b-sex-01', term: '儿童色情', category: 'child_abuse', action: 'review' },
    { id: 'b-sex-02', term: 'child pornography', category: 'child_abuse', action: 'review' },
    { id: 'b-sex-03', term: '招嫖', category: 'sexual_exploitation', action: 'review' },
    { id: 'b-sex-04', term: '援交服务', category: 'sexual_exploitation', action: 'review' },
    { id: 'b-sex-05', term: '色情服务', category: 'sexual_exploitation', action: 'review' },
    { id: 'b-sex-06', term: '出售儿童色情', category: 'child_abuse', action: 'block' },
    { id: 'b-sex-07', term: '购买儿童色情', category: 'child_abuse', action: 'block' },
    { id: 'b-sex-08', term: 'sell child pornography', category: 'child_abuse', action: 'block' },
    { id: 'b-sex-09', term: 'buy child pornography', category: 'child_abuse', action: 'block' },
    { id: 'b-sex-10', term: '提供色情服务', category: 'sexual_exploitation', action: 'block' },
    // Forged documents, invoices, identity and account trading. b-frd-04 (代开发票) was
    // removed: having the tax bureau issue an invoice (税务局代开发票) is legal and common.
    { id: 'b-frd-01', term: '办理假证', category: 'forged_documents', action: 'block' },
    { id: 'b-frd-02', term: '代办假证', category: 'forged_documents', action: 'block' },
    { id: 'b-frd-03', term: '假学历证书', category: 'forged_documents', action: 'review' },
    { id: 'b-frd-05', term: '出售身份证', category: 'identity_trading', action: 'review' },
    { id: 'b-frd-06', term: '买卖银行卡', category: 'identity_trading', action: 'review' },
    { id: 'b-frd-07', term: '出租银行卡', category: 'identity_trading', action: 'review' },
    { id: 'b-frd-08', term: '代开假发票', category: 'forged_documents', action: 'block' },
    { id: 'b-frd-09', term: '出售假发票', category: 'forged_documents', action: 'block' },
    // Terrorism
    { id: 'b-ter-01', term: '恐怖袭击教程', category: 'terrorism', action: 'block' },
    { id: 'b-ter-02', term: '加入圣战组织', category: 'terrorism', action: 'block' },
  ],
};
