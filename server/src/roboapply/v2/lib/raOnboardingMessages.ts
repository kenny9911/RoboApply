// backend/src/roboapply/v2/lib/raOnboardingMessages.ts
//
// Server-side message catalog for the conversational onboarding chat
// (/api/v1/roboapply/v2/onboarding/*).
//
// The onboarding orchestrator derives user-visible strings on the BACKEND
// (the deterministic greeting, fallback turns, suggestion chips, quick-reply
// labels, ingest-row labels/templates, the wrap recap). Those strings ship to
// the client pre-rendered inside the NDJSON stream / JSON responses, so they
// cannot be localized by the frontend bundles — they must be localized here,
// keyed by the request locale that `getRequestLocale(req)` (lib/raLocale.ts)
// resolves.
//
// RULE for future onboarding backend work: any NEW user-visible string
// produced server-side for this flow goes through this catalog (add a key to
// OnboardingMessages + all four ready-locale blocks below). LLM-generated
// content (the streamed chat turns, kickoff prompt/chips, whyMatched) is
// localized differently — pass `{ locale }` into the agent call so the model
// responds in the user's language; the streaming chat agent (which bypasses
// BaseAgent) uses the `chatLanguageDirective` string below, forked from
// LanguageService because `services/LanguageService` is denied by the V2
// boundary (fork-don't-cross, raLocale.ts:11-15 precedent).
//
// Honesty constraints baked into the wrap copy (do not re-add when editing):
//   - NO weekly re-score / ongoing preference-driven feed-matching promises —
//     nothing reads `reScoreWeekly`; the home feed is preference-blind. Say
//     only what is true: saved jobs are in the tracker, surfaced jobs are
//     pre-scored in the feed, preferences are editable in Preferences.
//   - Completion flips `huntActive` + `dailyCap` — the recap DISCLOSES that
//     ("up to {dailyCap} applications a day, change anytime in Preferences").
//
// Locale coverage mirrors the frontend: en / zh / zh-TW / ja are fully
// translated (READY_LOCALES in roboapply/lib/localeConfig.ts); es / fr / pt /
// de fall back to English, matching what the UI chrome shows for those
// locales. To add a language: add a block here AND the frontend bundle — see
// memory/project_roboapply_i18n.md.

import type { RaLocale } from './raLocale.js';
import type {
  IngestRowKind,
  OnboardingTopic,
} from '../types/onboarding.js';

/** Machine ids the quick-reply composer can emit (closed sets + decline). */
export type OnboardingQuickReplyKey =
  | 'remote'
  | 'hybrid'
  | 'onsite'
  | 'full_time'
  | 'contract'
  | 'part_time'
  | 'internship'
  | 'manual'
  | 'balanced'
  | 'aggressive'
  | 'no_preference';

export interface OnboardingMessages {
  /** Assistant message #1. `{headline}` = kickoff candidateHeadline. */
  greetingNew: string;
  /** Welcome-back variant. `{headline}` + `{prefsDigest}` (stored prefs recap). */
  greetingReturning: string;
  /** Kickoff-agent fallback: generic first-person composer pre-fill. */
  genericOpeningPrompt: string;
  /** Kickoff-agent fallback: 4 generic suggestion chips. */
  genericChips: string[];
  /** Chat-agent failure — emitted as a single text-delta; turn not billed. */
  apologyTurn: string;
  /** Recommendation round found zero qualifying jobs. */
  zeroResultsTurn: string;
  relaxChipSalary: string;
  relaxChipLocation: string;
  relaxChipHybrid: string;
  /** Turn-40 cap: wrap message (truthful — see header). */
  turnCapWrap: string;
  /** Wrap recap. `{recap}` = deterministic preference digest; `{dailyCap}` =
   *  the daily application cap being activated (huntActive disclosure). */
  wrapRecap: string;
  /** Salary floor couldn't be applied (unposted salaries / currency mismatch). */
  salaryNotFilterable: string;
  /** Deterministic whyMatched last resort — used when the cached/streamed
   *  scorer prose fails the locale / score-pattern / register guards. */
  whyMatchedFallback: string;
  /** RACareerGoal.targetTitle fallback when no role was captured. */
  defaultTargetTitle: string;
  /** Deterministic "Show me jobs now" chip. */
  showJobsChip: string;
  /** Per-topic next-question chips (deterministic composer). */
  nextTopicChip: Record<OnboardingTopic, string>;
  /** Quick-reply pill labels, keyed by machine id. */
  quickReply: Record<OnboardingQuickReplyKey, string>;
  /** Ingest-row labels. */
  ingestLabel: Record<IngestRowKind, string>;
  /** Experience-row value templates. `{count}` roles, `{years}`, `{role}`. */
  ingestExperienceValue: string;
  ingestExperienceValueNoYears: string;
  /** Single-role variant. `{role}`. */
  ingestExperienceValueSingle: string;
  /** Terminal ingest fallback. `{name}` = variant display name. */
  importedRow: string;
  /** Output-language directive for the streaming chat agent (prose-only
   *  outputs). Forked from LanguageService.getLanguageInstructionFromLocale —
   *  boundary-denied for V2. en/zh/zh-TW/ja only; other locales fall back to
   *  the English directive like every other key. */
  chatLanguageDirective: string;
}

const en: OnboardingMessages = {
  greetingNew:
    "Hi! I read through your resume — {headline}. Let's find your next role: tell me what you're looking for, and I'll start lining up matching jobs.",
  greetingReturning:
    "Welcome back! Last time we set up your preferences — {prefsDigest}. You're {headline}. Tell me what's changed, or just ask me to show you fresh matches.",
  genericOpeningPrompt: "I'm looking for my next role — here's what matters to me:",
  genericChips: [
    'Roles similar to my last job',
    'Show me jobs now',
    "I'm open — surprise me",
    'Help me figure out my salary range',
  ],
  apologyTurn:
    'Sorry — I hit a snag processing that. Mind sending it again?',
  zeroResultsTurn:
    "I couldn't find jobs matching everything you asked for just yet. Want to relax one of these and let me look again?",
  relaxChipSalary: 'Relax the salary floor',
  relaxChipLocation: 'Search nearby locations too',
  relaxChipHybrid: 'Include hybrid roles',
  turnCapWrap:
    "We've covered a lot, so let's wrap up here. Everything you told me is saved: your saved jobs are in the tracker, the roles I surfaced are pre-scored in your feed, and you can edit any preference in Preferences. Ready to head to your matches?",
  wrapRecap:
    "{recap}\n\nYour saved jobs are in the tracker, the roles I surfaced are already scored in your feed, and you can edit everything in Preferences. I'll line up to {dailyCap} strong applications a day — you can change or pause that anytime in Preferences.",
  salaryNotFilterable:
    "Most of these postings don't list salary, so I couldn't apply your floor — I'll flag the ranges whenever they appear.",
  whyMatchedFallback: 'Aligned with your experience and stated preferences.',
  defaultTargetTitle: 'My next role',
  showJobsChip: 'Show me jobs now',
  nextTopicChip: {
    salary: 'Talk salary',
    workMode: 'Remote, hybrid or onsite?',
    industry: 'Pick industries',
    employmentType: 'Full-time or contract?',
    location: 'Set locations',
    seniority: 'Set seniority level',
  },
  quickReply: {
    remote: 'Remote',
    hybrid: 'Hybrid',
    onsite: 'On-site',
    full_time: 'Full-time',
    contract: 'Contract',
    part_time: 'Part-time',
    internship: 'Internship',
    manual: 'Manual — I approve everything',
    balanced: 'Balanced',
    aggressive: 'Aggressive — apply broadly',
    no_preference: 'No preference',
  },
  ingestLabel: {
    identity: 'Identity',
    experience: 'Experience',
    skills: 'Skills',
    education: 'Education',
    links: 'Links',
    summary: 'Summary',
  },
  ingestExperienceValue: '{count} roles · ~{years} yrs · most recently {role}',
  ingestExperienceValueNoYears: '{count} roles · most recently {role}',
  ingestExperienceValueSingle: 'Most recently {role}',
  importedRow: 'Imported {name}',
  chatLanguageDirective:
    'Respond in English at all times, even when the resume or job postings are written in another language. Keep proper nouns (people, companies, schools, products) and technical terms in their original form.',
};

const zh: OnboardingMessages = {
  greetingNew:
    '你好！我看完了你的简历 — {headline}。我们来找你的下一份工作吧：告诉我你想找什么样的职位，我会开始帮你匹配合适的机会。',
  greetingReturning:
    '欢迎回来！上次我们已经设置好了你的求职偏好 — {prefsDigest}。你是{headline}。告诉我有什么变化，或者直接让我给你看最新的匹配职位。',
  genericOpeningPrompt: '我在找下一份工作，以下是对我最重要的几点：',
  genericChips: [
    '和我上一份工作类似的职位',
    '现在就给我看职位',
    '我都可以 — 给我点惊喜',
    '帮我确定合理的薪资范围',
  ],
  apologyTurn: '抱歉 — 刚才处理时出了点问题，能再发一次吗？',
  zeroResultsTurn:
    '暂时没有找到完全符合所有条件的职位。要不要放宽其中一项，让我再找找？',
  relaxChipSalary: '放宽薪资下限',
  relaxChipLocation: '同时搜索附近地区',
  relaxChipHybrid: '包含混合办公职位',
  turnCapWrap:
    '我们聊了很多，就先到这里吧。你告诉我的内容都已保存：收藏的职位在求职追踪里，我推荐过的职位已在你的信息流中评分，所有偏好都可以在偏好设置中修改。准备好去看你的匹配职位了吗？',
  wrapRecap:
    '{recap}\n\n收藏的职位在求职追踪里，我推荐过的职位已在你的信息流中评分，所有偏好都可以在偏好设置中修改。我每天会为你准备最多 {dailyCap} 个高匹配度的申请 — 随时可以在偏好设置中调整或暂停。',
  salaryNotFilterable:
    '这些职位大多没有公开薪资，所以我暂时无法按你的薪资下限筛选 — 一旦出现薪资信息我会标注出来。',
  whyMatchedFallback: '与你的经历和求职偏好相符。',
  defaultTargetTitle: '我的下一份工作',
  showJobsChip: '现在就给我看职位',
  nextTopicChip: {
    salary: '聊聊薪资',
    workMode: '远程、混合还是到岗？',
    industry: '选择行业',
    employmentType: '全职还是合同制？',
    location: '设置工作地点',
    seniority: '设置职级',
  },
  quickReply: {
    remote: '远程',
    hybrid: '混合',
    onsite: '到岗',
    full_time: '全职',
    contract: '合同制',
    part_time: '兼职',
    internship: '实习',
    manual: '手动 — 每个申请我都要确认',
    balanced: '平衡',
    aggressive: '积极 — 广泛投递',
    no_preference: '没有偏好',
  },
  ingestLabel: {
    identity: '基本信息',
    experience: '工作经历',
    skills: '技能',
    education: '教育背景',
    links: '链接',
    summary: '亮点',
  },
  ingestExperienceValue: '{count} 段工作经历 · 约 {years} 年 · 最近任职 {role}',
  ingestExperienceValueNoYears: '{count} 段工作经历 · 最近任职 {role}',
  ingestExperienceValueSingle: '最近任职 {role}',
  importedRow: '已导入 {name}',
  chatLanguageDirective:
    '请始终使用简体中文回复，即使简历或职位内容是其他语言。人名、公司、学校、产品等专有名词及技术术语保留原文。',
};

const zhTW: OnboardingMessages = {
  greetingNew:
    '你好！我看完了你的履歷 — {headline}。我們來找你的下一份工作吧：告訴我你想找什麼樣的職缺，我會開始幫你配對合適的機會。',
  greetingReturning:
    '歡迎回來！上次我們已經設定好了你的求職偏好 — {prefsDigest}。你是{headline}。告訴我有什麼變化，或者直接讓我給你看最新的配對職缺。',
  genericOpeningPrompt: '我在找下一份工作，以下是對我最重要的幾點：',
  genericChips: [
    '和我上一份工作類似的職缺',
    '現在就給我看職缺',
    '我都可以 — 給我點驚喜',
    '幫我確定合理的薪資範圍',
  ],
  apologyTurn: '抱歉 — 剛才處理時出了點問題，能再傳一次嗎？',
  zeroResultsTurn:
    '目前沒有找到完全符合所有條件的職缺。要不要放寬其中一項，讓我再找找？',
  relaxChipSalary: '放寬薪資下限',
  relaxChipLocation: '同時搜尋鄰近地區',
  relaxChipHybrid: '包含混合辦公職缺',
  turnCapWrap:
    '我們聊了很多，就先到這裡吧。你告訴我的內容都已儲存：收藏的職缺在求職追蹤裡，我推薦過的職缺已在你的動態中評分，所有偏好都可以在偏好設定中修改。準備好去看你的配對職缺了嗎？',
  wrapRecap:
    '{recap}\n\n收藏的職缺在求職追蹤裡，我推薦過的職缺已在你的動態中評分，所有偏好都可以在偏好設定中修改。我每天會為你準備最多 {dailyCap} 個高配對度的申請 — 可隨時在偏好設定中調整或暫停。',
  salaryNotFilterable:
    '這些職缺大多沒有公開薪資，所以我暫時無法按你的薪資下限篩選 — 一旦出現薪資資訊我會標註出來。',
  whyMatchedFallback: '與你的經歷和求職偏好相符。',
  defaultTargetTitle: '我的下一份工作',
  showJobsChip: '現在就給我看職缺',
  nextTopicChip: {
    salary: '聊聊薪資',
    workMode: '遠端、混合還是到班？',
    industry: '選擇產業',
    employmentType: '正職還是約聘？',
    location: '設定工作地點',
    seniority: '設定職級',
  },
  quickReply: {
    remote: '遠端',
    hybrid: '混合',
    onsite: '到班',
    full_time: '正職',
    contract: '約聘',
    part_time: '兼職',
    internship: '實習',
    manual: '手動 — 每個申請我都要確認',
    balanced: '平衡',
    aggressive: '積極 — 廣泛投遞',
    no_preference: '沒有偏好',
  },
  ingestLabel: {
    identity: '基本資料',
    experience: '工作經歷',
    skills: '技能',
    education: '學歷',
    links: '連結',
    summary: '亮點',
  },
  ingestExperienceValue: '{count} 段工作經歷 · 約 {years} 年 · 最近任職 {role}',
  ingestExperienceValueNoYears: '{count} 段工作經歷 · 最近任職 {role}',
  ingestExperienceValueSingle: '最近任職 {role}',
  importedRow: '已匯入 {name}',
  chatLanguageDirective:
    '請一律使用繁體中文（台灣用語）回覆，請勿使用簡體字，即使履歷或職缺內容是其他語言也一樣。人名、公司、學校、產品等專有名詞及技術術語保留原文。',
};

const ja: OnboardingMessages = {
  greetingNew:
    'こんにちは！履歴書を拝見しました — {headline}。次のお仕事を一緒に探しましょう。どんな職種をお探しか教えてください。条件に合う求人をご用意します。',
  greetingReturning:
    'おかえりなさい！前回ご希望の条件を設定済みです — {prefsDigest}。{headline}でいらっしゃいますね。変わった点があれば教えてください。そのまま最新のマッチ求人を見ることもできます。',
  genericOpeningPrompt: '次の仕事を探しています。重視しているのは次の点です：',
  genericChips: [
    '前職に近い求人',
    '今すぐ求人を見る',
    '特にこだわりはない — おすすめが見たい',
    '適切な希望年収を一緒に考えたい',
  ],
  apologyTurn:
    '申し訳ありません — 処理中に問題が発生しました。もう一度送っていただけますか？',
  zeroResultsTurn:
    'すべての条件に合う求人はまだ見つかりませんでした。どれか一つ条件を緩めて、もう一度探してみましょうか？',
  relaxChipSalary: '希望年収の下限を緩める',
  relaxChipLocation: '近隣の勤務地も含める',
  relaxChipHybrid: 'ハイブリッド勤務も含める',
  turnCapWrap:
    'たくさんお話しできましたので、ここで一区切りにしましょう。教えていただいた内容はすべて保存済みです。保存した求人はトラッカーに、ご紹介した求人はスコア付きでフィードに表示されます。条件はいつでも設定ページで変更できます。マッチ求人を見に行きましょうか？',
  wrapRecap:
    '{recap}\n\n保存した求人はトラッカーに、ご紹介した求人はスコア付きでフィードに表示されます。条件はいつでも設定ページで変更できます。毎日最大 {dailyCap} 件の有望な応募をご用意します — 設定ページでいつでも変更・停止できます。',
  salaryNotFilterable:
    'これらの求人の多くは給与が非公開のため、ご希望額での絞り込みはできませんでした — 給与情報があり次第お知らせします。',
  whyMatchedFallback: 'あなたの経歴とご希望の条件に合致しています。',
  defaultTargetTitle: '次の仕事',
  showJobsChip: '今すぐ求人を見る',
  nextTopicChip: {
    salary: '給与について話す',
    workMode: 'リモート・ハイブリッド・出社？',
    industry: '業界を選ぶ',
    employmentType: '正社員か契約か？',
    location: '勤務地を設定',
    seniority: 'ポジションレベルを設定',
  },
  quickReply: {
    remote: 'リモート',
    hybrid: 'ハイブリッド',
    onsite: '出社',
    full_time: '正社員',
    contract: '契約',
    part_time: 'パートタイム',
    internship: 'インターン',
    manual: '手動 — すべて自分で承認',
    balanced: 'バランス',
    aggressive: '積極的 — 幅広く応募',
    no_preference: 'こだわりなし',
  },
  ingestLabel: {
    identity: '基本情報',
    experience: '職歴',
    skills: 'スキル',
    education: '学歴',
    links: 'リンク',
    summary: 'ハイライト',
  },
  ingestExperienceValue: '職歴 {count} 件 · 約 {years} 年 · 直近は {role}',
  ingestExperienceValueNoYears: '職歴 {count} 件 · 直近は {role}',
  ingestExperienceValueSingle: '直近は {role}',
  importedRow: '{name} を取り込みました',
  chatLanguageDirective:
    '常に日本語で回答してください。履歴書や求人情報が他の言語であっても同様です。人名・会社名・学校名・製品名などの固有名詞と技術用語は原文のまま残してください。',
};

const CATALOG: Partial<Record<RaLocale, OnboardingMessages>> = {
  en,
  zh,
  'zh-TW': zhTW,
  ja,
  // es / fr / pt / de intentionally absent → English fallback, consistent
  // with the UI chrome for those locales.
};

/** Resolve the message block for a locale, falling back to English. */
export function getMessages(locale: RaLocale): OnboardingMessages {
  return CATALOG[locale] ?? en;
}

/** Tiny `{name}` substitution — same helper shape as raQueueMessages.ts;
 *  re-declared here so the two catalogs stay independently deletable. */
export function format(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    key in params ? String(params[key]) : m,
  );
}
