// backend/src/roboapply/v2/lib/raResumeAIMessages.ts
//
// Server-side message catalog for the inline resume-AI editor (RAResumeAIService
// → "give me 3 rewrites" / "✦ rewrite this bullet" / "suggest skills").
//
// Why this exists: when the LLM is unconfigured / errors / returns an empty
// parse, RAResumeAIService serves a DETERMINISTIC fallback so the editor never
// 500s. That fallback used to be hardcoded English, so a zh / ja user who hit
// the degraded path saw English rewrites even though they had selected Chinese
// (the reported bug). These strings are produced on the BACKEND and shipped to
// the client pre-rendered inside `ResumeRewriteResponse`, so they cannot be
// localized by the frontend bundles — they must be localized here, keyed by the
// request locale that `getRequestLocale(req)` (lib/raLocale.ts) resolves.
//
// This mirrors the `/queue` catalog pattern in raQueueMessages.ts. The same
// 4-point rule applies: deterministic backend strings live in a catalog; LLM
// output is localized by threading `{ locale }` into the agent call (see
// RAResumeRewriteAgent.getLocaleDirective).
//
// Locale coverage mirrors the frontend: en / zh / zh-TW / ja are fully
// translated (READY_LOCALES in roboapply/lib/localeConfig.ts); es / fr / pt /
// de fall back to English, matching the UI chrome for those locales. To add a
// language: add a block here AND the frontend bundle — see
// memory/project_roboapply_i18n.md.

import { normalizeRaLocale } from './raLocale.js';

// Kept in sync with `RAResumeRewriteAction` in agents/RAResumeRewriteAgent.ts.
// Duplicated locally (not imported) so this catalog stays free of any agent
// coupling — the action set is stable.
type BulletAction =
  | 'improve'
  | 'metrics'
  | 'shorten'
  | 'expand'
  | 'confident'
  | 'junior';

export interface ResumeAIMessages {
  /** Version tags for the 3 summary options (Tight / Numeric / Personality). */
  summaryLabels: [string, string, string];
  /** Generic summary options when the editor has no current summary to seed. */
  summaryFallback: [string, string, string];
  /** Suffixes appended to the user's CURRENT summary (their language preserved)
   *  to produce options 2 + 3. */
  summaryAugment: [string, string];
  /** Synthetic bullet templates when the user gave no bullet text to rewrite. */
  bulletEmpty: Record<BulletAction, string>;
  /** Fragment appended to the user's bullet for the 'metrics' action. */
  bulletMetricsSuffix: string;
  /** Fragment appended to the user's bullet for the 'expand' action. */
  bulletExpandSuffix: string;
  /** Prefix prepended to the user's bullet for the 'junior' action. */
  bulletJuniorPrefix: string;
  /** Generic skill phrases when none can be extracted from the resume. */
  skillsDefault: string[];

  // ── Tailor-diff change labels/details (deriveChanges in RAResumeAIService) ──
  // These back the "Tailor to a job" diff panel's per-change labels/details.
  // `{heading}` / `{n}` placeholders are substituted via format() below.
  /** Label: a whole new section appeared in the tailored resume. {heading} */
  tailorChangeAddSection: string;
  /** Label: a bullet was reworded within a section. {heading} */
  tailorChangeReword: string;
  /** Label: N bullets the JD asks for were surfaced. {n} */
  tailorChangeSurface: string;
  /** Label: N less-relevant lines were trimmed from a section. {n} {heading} */
  tailorChangeTrim: string;
  /** Detail shown under a trim change. */
  tailorChangeTrimDetail: string;
  /** Label: a section was reordered to lead with the strongest match. {heading} */
  tailorChangeReorder: string;
  /** Detail shown under a reorder change. */
  tailorChangeReorderDetail: string;
  /** Synthetic section label for the catch-all fallback change. */
  tailorChangeFallbackSection: string;
  /** Label for the catch-all change when the structural diff found nothing. */
  tailorChangeFallback: string;
  /** Detail for the catch-all change when the agent gave no prose summary. */
  tailorChangeFallbackDetail: string;
}

const en: ResumeAIMessages = {
  summaryLabels: ['Tight', 'Numeric', 'Personality'],
  summaryFallback: [
    'Senior professional with a track record of shipping high-impact work. Looking for a mission-driven team.',
    'Builder with measurable wins across [domain]. Owned [project] end-to-end and moved [metric] from X to Y.',
    'Hands-on operator who turns ambiguity into shipped product — and has the receipts to prove it.',
  ],
  summaryAugment: [
    'Track record backed by concrete metrics.',
    'Comes with strong opinions about what to build next.',
  ],
  bulletEmpty: {
    improve:
      'Owned [project] end-to-end, partnering with [stakeholders] to ship [outcome]. Lifted [metric] from X to Y.',
    metrics:
      '[Action] [project] that [outcome] — measured by [metric, before → after], over [population, n=__].',
    shorten: 'Shipped [project] — [single sharp outcome].',
    expand:
      'Took [project] from [starting point] through [stages]. Partnered with [stakeholders] across [duration]. Result: [outcome with metric].',
    confident: 'I led / I owned / I drove [project] — [outcome with metric].',
    junior:
      'Translated [school/intern work] into a real-world deliverable — [scope, scale, result].',
  },
  bulletMetricsSuffix: ' — measured by [metric, before → after], n=[__].',
  bulletExpandSuffix:
    '. Partnered with [stakeholders] across [duration] to deliver [outcome].',
  bulletJuniorPrefix: 'Translated this work into a concrete deliverable: ',
  skillsDefault: [
    'Cross-functional collaboration',
    'Project ownership',
    'Data-informed decision making',
    'Stakeholder communication',
  ],
  tailorChangeAddSection: 'Add a tailored "{heading}" section',
  tailorChangeReword: 'Reword a bullet in {heading}',
  tailorChangeSurface: 'Surface {n} item(s) the JD asks for',
  tailorChangeTrim: 'Trim {n} less-relevant line(s) from {heading}',
  tailorChangeTrimDetail: 'Removed content that does not strengthen this application.',
  tailorChangeReorder: 'Reorder {heading} to lead with the strongest match',
  tailorChangeReorderDetail: 'Moved the most JD-relevant bullet to the top.',
  tailorChangeFallbackSection: 'Summary',
  tailorChangeFallback: 'Tailored your resume toward this role',
  tailorChangeFallbackDetail:
    'Reframed your strongest experience to match the job description.',
};

const zh: ResumeAIMessages = {
  summaryLabels: ['精炼', '量化', '个性'],
  summaryFallback: [
    '资深专业人士，拥有交付高影响力成果的成功记录。正在寻找一支使命驱动的团队。',
    '注重结果的实干者，在 [领域] 取得可量化的成绩。端到端负责 [项目]，将 [指标] 从 X 提升到 Y。',
    '亲力亲为的执行者，善于把模糊需求转化为已上线的产品——并有实打实的成果为证。',
  ],
  summaryAugment: [
    '成果均有具体数据支撑。',
    '对下一步该做什么有清晰而坚定的判断。',
  ],
  bulletEmpty: {
    improve:
      '端到端负责 [项目]，与 [相关方] 协作交付 [成果]。将 [指标] 从 X 提升到 Y。',
    metrics:
      '[动作][项目]，实现 [成果]——以 [指标，前 → 后] 衡量，覆盖 [范围，n=__]。',
    shorten: '交付 [项目]——[一句话核心成果]。',
    expand:
      '将 [项目] 从 [起点] 推进至 [各阶段]。在 [周期] 内与 [相关方] 协作。结果：[带指标的成果]。',
    confident: '我主导 / 我负责 / 我推动了 [项目]——[带指标的成果]。',
    junior: '把 [校园/实习经历] 转化为实际可交付的成果——[范围、规模、结果]。',
  },
  bulletMetricsSuffix: ' —— 以 [指标，前 → 后] 衡量，n=[__]。',
  bulletExpandSuffix: '。与 [相关方] 在 [周期] 内协作，交付 [成果]。',
  bulletJuniorPrefix: '把这段经历转化为具体的可交付成果：',
  skillsDefault: ['跨职能协作', '项目主导', '数据驱动决策', '利益相关方沟通'],
  tailorChangeAddSection: '新增针对性的"{heading}"板块',
  tailorChangeReword: '改写 {heading} 中的一条要点',
  tailorChangeSurface: '突出 {n} 项 JD 要求的内容',
  tailorChangeTrim: '从 {heading} 精简 {n} 行相关性较低的内容',
  tailorChangeTrimDetail: '已删除无助于本次申请的内容。',
  tailorChangeReorder: '重新排序 {heading}，让最匹配的内容置顶',
  tailorChangeReorderDetail: '已将与 JD 最相关的要点移到最前。',
  tailorChangeFallbackSection: '摘要',
  tailorChangeFallback: '已针对该职位定制你的简历',
  tailorChangeFallbackDetail: '重新组织了你最有力的经历，以匹配职位描述。',
};

const zhTW: ResumeAIMessages = {
  summaryLabels: ['精煉', '量化', '個性'],
  summaryFallback: [
    '資深專業人士，擁有交付高影響力成果的成功記錄。正在尋找一支使命驅動的團隊。',
    '注重成果的實作者，在 [領域] 取得可量化的成績。端到端負責 [專案]，將 [指標] 從 X 提升到 Y。',
    '親力親為的執行者，擅長將模糊需求轉化為已上線的產品——並有扎實的成果佐證。',
  ],
  summaryAugment: [
    '成果皆有具體數據支撐。',
    '對下一步該做什麼有清晰而堅定的判斷。',
  ],
  bulletEmpty: {
    improve:
      '端到端負責 [專案]，與 [相關方] 協作交付 [成果]。將 [指標] 從 X 提升到 Y。',
    metrics:
      '[動作][專案]，實現 [成果]——以 [指標，前 → 後] 衡量，涵蓋 [範圍，n=__]。',
    shorten: '交付 [專案]——[一句話核心成果]。',
    expand:
      '將 [專案] 從 [起點] 推進至 [各階段]。在 [週期] 內與 [相關方] 協作。結果：[帶指標的成果]。',
    confident: '我主導 / 我負責 / 我推動了 [專案]——[帶指標的成果]。',
    junior: '把 [校園/實習經歷] 轉化為實際可交付的成果——[範圍、規模、結果]。',
  },
  bulletMetricsSuffix: ' —— 以 [指標，前 → 後] 衡量，n=[__]。',
  bulletExpandSuffix: '。與 [相關方] 在 [週期] 內協作，交付 [成果]。',
  bulletJuniorPrefix: '把這段經歷轉化為具體的可交付成果：',
  skillsDefault: ['跨職能協作', '專案主導', '數據驅動決策', '利害關係人溝通'],
  tailorChangeAddSection: '新增針對性的「{heading}」區塊',
  tailorChangeReword: '改寫 {heading} 中的一條要點',
  tailorChangeSurface: '突顯 {n} 項 JD 要求的內容',
  tailorChangeTrim: '從 {heading} 精簡 {n} 行相關性較低的內容',
  tailorChangeTrimDetail: '已刪除無助於本次應徵的內容。',
  tailorChangeReorder: '重新排序 {heading}，讓最匹配的內容置頂',
  tailorChangeReorderDetail: '已將與 JD 最相關的要點移到最前。',
  tailorChangeFallbackSection: '摘要',
  tailorChangeFallback: '已針對該職缺客製你的履歷',
  tailorChangeFallbackDetail: '重新組織了你最有力的經歷，以符合職缺描述。',
};

const ja: ResumeAIMessages = {
  summaryLabels: ['簡潔', '数値', '個性'],
  summaryFallback: [
    'ハイインパクトな成果を継続的に出してきたシニア人材。ミッション志向のチームを探しています。',
    '[領域] で測定可能な成果を上げてきた実行型の人材。[プロジェクト] を一貫して担当し、[指標] を X から Y へ改善。',
    '曖昧な課題をリリース可能なプロダクトに変えるハンズオン型の実行者——その実績も具体的に示せます。',
  ],
  summaryAugment: [
    '実績はすべて具体的な数値で裏付けられています。',
    '次に何を作るべきかについて明確な考えを持っています。',
  ],
  bulletEmpty: {
    improve:
      '[プロジェクト] を一貫して担当し、[関係者] と連携して [成果] をリリース。[指標] を X から Y へ改善。',
    metrics:
      '[アクション][プロジェクト]により[成果]を実現——[指標、前 → 後]で測定、[対象、n=__]を対象。',
    shorten: '[プロジェクト] をリリース——[一言で示す成果]。',
    expand:
      '[プロジェクト] を [起点] から [各段階] まで推進。[期間] にわたり [関係者] と連携。結果：[指標を伴う成果]。',
    confident: '[プロジェクト] を主導・推進しました——[指標を伴う成果]。',
    junior: '[学業/インターンでの経験] を実務的な成果に転換——[範囲・規模・結果]。',
  },
  bulletMetricsSuffix: ' —— [指標、前 → 後] で測定、n=[__]。',
  bulletExpandSuffix: '。[期間] にわたり [関係者] と連携し、[成果] を提供。',
  bulletJuniorPrefix: 'この経験を具体的な成果物に転換：',
  skillsDefault: [
    '部門横断のコラボレーション',
    'プロジェクトの主体的推進',
    'データに基づく意思決定',
    'ステークホルダーとのコミュニケーション',
  ],
  tailorChangeAddSection: '「{heading}」セクションを最適化して追加',
  tailorChangeReword: '{heading} の項目を書き直し',
  tailorChangeSurface: '求人票が求める項目を {n} 件追加',
  tailorChangeTrim: '{heading} から関連性の低い行を {n} 行削減',
  tailorChangeTrimDetail: 'この応募を強化しない内容を削除しました。',
  tailorChangeReorder: '{heading} を並べ替え、最も適合する内容を先頭に',
  tailorChangeReorderDetail: '求人票に最も関連する項目を先頭に移動しました。',
  tailorChangeFallbackSection: '要約',
  tailorChangeFallback: 'この職種に合わせて履歴書を最適化しました',
  tailorChangeFallbackDetail:
    '最も強みのある経験を求人内容に合わせて再構成しました。',
};

const CATALOG: Partial<Record<string, ResumeAIMessages>> = {
  en,
  zh,
  'zh-TW': zhTW,
  ja,
  // es / fr / pt / de intentionally absent → English fallback, consistent with
  // the UI chrome for those locales.
};

/**
 * Resolve the resume-AI message block for a request locale, falling back to
 * English for unknown / not-yet-translated locales. Accepts the raw `locale`
 * string threaded down from `getRequestLocale(req)` (or `undefined` for
 * contexts that never resolved one).
 */
export function getResumeAIMessages(locale?: string): ResumeAIMessages {
  const norm = normalizeRaLocale(locale) ?? 'en';
  return CATALOG[norm] ?? en;
}

/**
 * Tiny `{name}` substitution for the tailor-change templates above (`{heading}`,
 * `{n}`). Mirrors `format()` in raQueueMessages.ts — a full ICU formatter would
 * be overkill for single-token interpolation. Unknown placeholders are left
 * verbatim.
 */
export function format(
  template: string,
  params: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (m, key) =>
    key in params ? String(params[key]) : m,
  );
}
