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
// Locale coverage: ALL of RA_LOCALES (en / zh / zh-TW / ja / ko / es / fr / pt /
// de) are fully translated here. The catalog used to stop after en/zh/zh-TW/ja
// on the premise that the UI chrome was English for the rest — that premise is
// dead (i18n/messages/ ships complete bundles for every locale, and RA_LOCALES
// now carries 'ko'), and leaving a locale out means a user reading a fully
// translated UI gets English resume text back from the degraded path. To add a
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
  /** Sentence terminator for this locale ('.' for Latin scripts, '。' for
   *  zh/ja). The deterministic bullet fallbacks re-terminate the user's own
   *  text; appending an ASCII '.' to a Chinese bullet that already ends in
   *  '。' produced "…。." in the editor. */
  sentenceEnd: string;
  /** Ownership verb the 'confident' fallback substitutes for English hedge
   *  verbs ("helped" / "assisted" / …). The DETECTOR regex is English-only by
   *  design (only English text contains those words), but the REPLACEMENT must
   *  be in the user's language — a mixed-language bullet would otherwise get an
   *  English "led" spliced into Chinese prose. */
  bulletConfidentVerb: string;
  /** Generic skill phrases when none can be extracted from the resume. */
  skillsDefault: string[];

  // ── Tailor-diff change labels/details (deriveChanges in RAResumeAIService) ──
  // These back the "Tailor to a job" diff panel's per-change labels/details.
  // `{heading}` / `{n}` placeholders are substituted via format() below.
  /** Name of the synthetic section holding the lines above the first markdown
   *  heading (name / contact block). Ships to the client in
   *  `RATailorChange.section` and is rendered verbatim by the diff panel. */
  sectionHeaderName: string;
  /** Diff-panel company name when the user tailored against a pasted JD with
   *  no company of its own. */
  tailorTargetPastedJD: string;
  /** Diff-panel role title when the user named no target title. DISPLAY ONLY —
   *  never feed this into the tailor prompt (see tailorDiff). */
  tailorTargetRoleFallback: string;
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
  sentenceEnd: '.',
  bulletConfidentVerb: 'led',
  skillsDefault: [
    'Cross-functional collaboration',
    'Project ownership',
    'Data-informed decision making',
    'Stakeholder communication',
  ],
  sectionHeaderName: 'Header',
  tailorTargetPastedJD: 'Pasted JD',
  tailorTargetRoleFallback: 'Target role',
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
  sentenceEnd: '。',
  bulletConfidentVerb: '主导',
  skillsDefault: ['跨职能协作', '项目主导', '数据驱动决策', '利益相关方沟通'],
  sectionHeaderName: '个人信息',
  tailorTargetPastedJD: '粘贴的职位描述',
  tailorTargetRoleFallback: '目标职位',
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
  sentenceEnd: '。',
  bulletConfidentVerb: '主導',
  skillsDefault: ['跨職能協作', '專案主導', '數據驅動決策', '利害關係人溝通'],
  sectionHeaderName: '個人資料',
  tailorTargetPastedJD: '貼上的職缺描述',
  tailorTargetRoleFallback: '目標職缺',
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
  sentenceEnd: '。',
  bulletConfidentVerb: '主導',
  skillsDefault: [
    '部門横断のコラボレーション',
    'プロジェクトの主体的推進',
    'データに基づく意思決定',
    'ステークホルダーとのコミュニケーション',
  ],
  sectionHeaderName: '基本情報',
  tailorTargetPastedJD: '貼り付けた求人票',
  tailorTargetRoleFallback: '希望職種',
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

const ko: ResumeAIMessages = {
  summaryLabels: ['간결', '수치', '개성'],
  summaryFallback: [
    '높은 임팩트의 성과를 꾸준히 만들어온 시니어 전문가입니다. 미션 중심의 팀을 찾고 있습니다.',
    '[분야]에서 측정 가능한 성과를 낸 실행형 인재입니다. [프로젝트]를 처음부터 끝까지 주도하며 [지표]를 X에서 Y로 개선했습니다.',
    '모호한 과제를 실제로 출시되는 제품으로 바꾸는 실무형 실행가이며, 그 결과를 수치로 증명할 수 있습니다.',
  ],
  summaryAugment: [
    '모든 성과는 구체적인 수치로 뒷받침됩니다.',
    '다음에 무엇을 만들어야 할지에 대한 분명한 관점을 가지고 있습니다.',
  ],
  bulletEmpty: {
    improve:
      '[프로젝트]를 처음부터 끝까지 주도하고 [이해관계자]와 협업해 [성과]를 출시했습니다. [지표]를 X에서 Y로 개선했습니다.',
    metrics:
      '[행동] [프로젝트]로 [성과] 달성 — [지표, 이전 → 이후] 기준, [대상 범위, n=__] 대상.',
    shorten: '[프로젝트] 출시 — [한 줄 핵심 성과].',
    expand:
      '[프로젝트]를 [출발점]에서 [단계]까지 추진했습니다. [기간] 동안 [이해관계자]와 협업했습니다. 결과: [지표를 포함한 성과].',
    confident: '[프로젝트]를 주도하고 책임지며 끝까지 추진했습니다 — [지표를 포함한 성과].',
    junior:
      '[학업/인턴 경험]을 실무 성과물로 전환 — [범위, 규모, 결과].',
  },
  bulletMetricsSuffix: ' — [지표, 이전 → 이후] 기준으로 측정, n=[__].',
  bulletExpandSuffix: '. [기간] 동안 [이해관계자]와 협업해 [성과]를 전달했습니다.',
  bulletJuniorPrefix: '이 경험을 구체적인 성과물로 전환: ',
  sentenceEnd: '.',
  bulletConfidentVerb: '주도',
  skillsDefault: [
    '부서 간 협업',
    '프로젝트 주도',
    '데이터 기반 의사결정',
    '이해관계자 커뮤니케이션',
  ],
  sectionHeaderName: '기본 정보',
  tailorTargetPastedJD: '붙여넣은 채용 공고',
  tailorTargetRoleFallback: '목표 직무',
  tailorChangeAddSection: '맞춤형 "{heading}" 섹션 추가',
  tailorChangeReword: '{heading}의 항목 하나를 재작성',
  tailorChangeSurface: '채용 공고가 요구하는 항목 {n}개 부각',
  tailorChangeTrim: '{heading}에서 관련성이 낮은 {n}줄 정리',
  tailorChangeTrimDetail: '이번 지원에 도움이 되지 않는 내용을 삭제했습니다.',
  // The 을/를 object particle agrees with the FINAL letter of the word it
  // attaches to, and {heading} is an arbitrary section name (often a Latin
  // word like 'Experience'). Interpolating before the particle is therefore
  // never reliably correct — attach it to the fixed noun '섹션' instead.
  tailorChangeReorder: '{heading} 섹션을 재정렬해 가장 적합한 내용을 앞에 배치',
  tailorChangeReorderDetail: '채용 공고와 가장 관련 있는 항목을 맨 위로 옮겼습니다.',
  tailorChangeFallbackSection: '요약',
  tailorChangeFallback: '이 직무에 맞게 이력서를 다듬었습니다',
  tailorChangeFallbackDetail:
    '가장 강점이 되는 경력을 채용 공고에 맞게 재구성했습니다.',
};

const es: ResumeAIMessages = {
  summaryLabels: ['Conciso', 'Numérico', 'Personalidad'],
  summaryFallback: [
    'Profesional sénior con un historial probado de entregar trabajo de alto impacto. En busca de un equipo con una misión clara.',
    'Perfil ejecutor con logros medibles en [ámbito]. Responsable de [proyecto] de principio a fin, elevando [métrica] de X a Y.',
    'Perfil práctico que convierte la ambigüedad en producto entregado, con resultados que lo demuestran.',
  ],
  summaryAugment: [
    'Resultados respaldados por métricas concretas.',
    'Con criterio propio y bien fundamentado sobre qué construir a continuación.',
  ],
  bulletEmpty: {
    improve:
      'Responsable de [proyecto] de principio a fin, en colaboración con [interlocutores] para entregar [resultado]. Elevé [métrica] de X a Y.',
    metrics:
      '[Acción] [proyecto] que logró [resultado] — medido por [métrica, antes → después], sobre [población, n=__].',
    shorten: 'Entregué [proyecto] — [resultado clave en una línea].',
    expand:
      'Llevé [proyecto] desde [punto de partida] hasta [etapas]. Colaboré con [interlocutores] durante [periodo]. Resultado: [resultado con métrica].',
    confident: 'Lideré, asumí e impulsé [proyecto] — [resultado con métrica].',
    junior:
      'Convertí [trabajo académico o de prácticas] en un entregable real — [alcance, escala, resultado].',
  },
  bulletMetricsSuffix: ' — medido por [métrica, antes → después], n=[__].',
  bulletExpandSuffix:
    '. Colaboré con [interlocutores] durante [periodo] para entregar [resultado].',
  bulletJuniorPrefix: 'Convertí este trabajo en un entregable concreto: ',
  sentenceEnd: '.',
  bulletConfidentVerb: 'lideré',
  skillsDefault: [
    'Colaboración interfuncional',
    'Responsabilidad integral de proyectos',
    'Toma de decisiones basada en datos',
    'Comunicación con stakeholders',
  ],
  sectionHeaderName: 'Encabezado',
  tailorTargetPastedJD: 'Oferta pegada',
  tailorTargetRoleFallback: 'Puesto objetivo',
  tailorChangeAddSection: 'Añadir una sección "{heading}" adaptada',
  tailorChangeReword: 'Reescribir un punto de {heading}',
  tailorChangeSurface: 'Destacar {n} elemento(s) que pide la oferta',
  tailorChangeTrim: 'Recortar {n} línea(s) menos relevante(s) de {heading}',
  tailorChangeTrimDetail: 'Se eliminó contenido que no refuerza esta candidatura.',
  tailorChangeReorder: 'Reordenar {heading} para empezar por lo más relevante',
  tailorChangeReorderDetail: 'Se movió arriba el punto más relevante para la oferta.',
  tailorChangeFallbackSection: 'Resumen',
  tailorChangeFallback: 'Hemos adaptado tu CV a este puesto',
  tailorChangeFallbackDetail:
    'Se reformuló tu experiencia más sólida para ajustarla a la descripción del puesto.',
};

const fr: ResumeAIMessages = {
  summaryLabels: ['Concis', 'Chiffré', 'Personnalité'],
  summaryFallback: [
    'Profil senior avec un historique de réalisations à fort impact. À la recherche d’une équipe portée par une mission.',
    'Profil opérationnel aux résultats mesurables en [domaine]. Pilotage de [projet] de bout en bout, avec [indicateur] porté de X à Y.',
    'Profil de terrain qui transforme l’incertitude en produit livré — avec les résultats pour le prouver.',
  ],
  summaryAugment: [
    'Des résultats appuyés par des chiffres concrets.',
    'Un point de vue affirmé sur ce qu’il faut construire ensuite.',
  ],
  bulletEmpty: {
    improve:
      'Piloté [projet] de bout en bout, en collaboration avec [parties prenantes] pour livrer [résultat]. [Indicateur] porté de X à Y.',
    metrics:
      '[Action] [projet] ayant permis [résultat] — mesuré par [indicateur, avant → après], sur [population, n=__].',
    shorten: 'Livré [projet] — [résultat clé en une ligne].',
    expand:
      'Mené [projet] de [point de départ] jusqu’à [étapes]. Collaboré avec [parties prenantes] pendant [durée]. Résultat : [résultat chiffré].',
    confident: 'Dirigé, porté et impulsé [projet] — [résultat chiffré].',
    junior:
      'Transformé [travaux académiques ou de stage] en livrable concret — [périmètre, échelle, résultat].',
  },
  bulletMetricsSuffix: ' — mesuré par [indicateur, avant → après], n=[__].',
  bulletExpandSuffix:
    '. Collaboré avec [parties prenantes] pendant [durée] pour livrer [résultat].',
  bulletJuniorPrefix: 'Transformé ce travail en livrable concret : ',
  sentenceEnd: '.',
  bulletConfidentVerb: 'dirigé',
  skillsDefault: [
    'Collaboration transverse',
    'Pilotage de projet de bout en bout',
    'Décisions fondées sur les données',
    'Communication avec les parties prenantes',
  ],
  sectionHeaderName: 'En-tête',
  tailorTargetPastedJD: 'Offre collée',
  tailorTargetRoleFallback: 'Poste visé',
  tailorChangeAddSection: 'Ajouter une rubrique « {heading} » ciblée',
  // "de {heading}" would need elision ("d’Expérience", "d’Éducation") whenever
  // the section name is vowel-initial — which the common French résumé
  // headings are. The interpolation cannot know, so the placeholder never sits
  // directly after "de": the fixed noun "la rubrique" takes that slot and
  // {heading} moves inside quotes, where it is grammatically inert.
  tailorChangeReword: 'Reformuler un point de la rubrique « {heading} »',
  tailorChangeSurface: 'Mettre en avant {n} élément(s) attendu(s) par l’offre',
  tailorChangeTrim: 'Retirer {n} ligne(s) moins pertinente(s) de la rubrique « {heading} »',
  tailorChangeTrimDetail:
    'Contenu qui ne renforce pas cette candidature supprimé.',
  tailorChangeReorder: 'Réordonner {heading} pour commencer par le plus pertinent',
  tailorChangeReorderDetail:
    'Le point le plus proche de l’offre a été remonté en tête.',
  tailorChangeFallbackSection: 'Résumé',
  tailorChangeFallback: 'Votre CV a été adapté à ce poste',
  tailorChangeFallbackDetail:
    'Vos expériences les plus fortes ont été reformulées pour correspondre à l’offre.',
};

const pt: ResumeAIMessages = {
  summaryLabels: ['Conciso', 'Numérico', 'Personalidade'],
  summaryFallback: [
    'Profissional sênior com histórico consistente de entregas de alto impacto. Em busca de um time movido por propósito.',
    'Perfil executor com resultados mensuráveis em [área]. Responsável por [projeto] de ponta a ponta, elevando [métrica] de X para Y.',
    'Profissional mão na massa que transforma ambiguidade em produto entregue — com resultados para comprovar.',
  ],
  summaryAugment: [
    'Resultados sustentados por métricas concretas.',
    'Com uma opinião clara sobre o que construir a seguir.',
  ],
  bulletEmpty: {
    improve:
      'Responsável por [projeto] de ponta a ponta, em parceria com [stakeholders] para entregar [resultado]. Elevei [métrica] de X para Y.',
    metrics:
      '[Ação] [projeto] que gerou [resultado] — medido por [métrica, antes → depois], em [população, n=__].',
    shorten: 'Entreguei [projeto] — [resultado principal em uma linha].',
    expand:
      'Conduzi [projeto] de [ponto de partida] até [etapas]. Atuei com [stakeholders] ao longo de [período]. Resultado: [resultado com métrica].',
    confident: 'Liderei, assumi e impulsionei [projeto] — [resultado com métrica].',
    junior:
      'Converti [trabalho acadêmico ou de estágio] em uma entrega real — [escopo, escala, resultado].',
  },
  bulletMetricsSuffix: ' — medido por [métrica, antes → depois], n=[__].',
  bulletExpandSuffix:
    '. Atuei com [stakeholders] ao longo de [período] para entregar [resultado].',
  bulletJuniorPrefix: 'Converti este trabalho em uma entrega concreta: ',
  sentenceEnd: '.',
  bulletConfidentVerb: 'liderei',
  skillsDefault: [
    'Colaboração multidisciplinar',
    'Protagonismo em projetos de ponta a ponta',
    'Decisões orientadas por dados',
    'Comunicação com stakeholders',
  ],
  sectionHeaderName: 'Cabeçalho',
  tailorTargetPastedJD: 'Vaga colada',
  tailorTargetRoleFallback: 'Cargo-alvo',
  tailorChangeAddSection: 'Adicionar uma seção "{heading}" direcionada',
  tailorChangeReword: 'Reescrever um item de {heading}',
  tailorChangeSurface: 'Destacar {n} item(ns) exigido(s) pela vaga',
  tailorChangeTrim: 'Remover {n} linha(s) menos relevante(s) de {heading}',
  tailorChangeTrimDetail: 'Removemos conteúdo que não fortalece esta candidatura.',
  tailorChangeReorder: 'Reordenar {heading} para começar pelo mais aderente',
  tailorChangeReorderDetail:
    'O item mais relevante para a vaga foi movido para o topo.',
  tailorChangeFallbackSection: 'Resumo',
  tailorChangeFallback: 'Seu currículo foi adaptado para esta vaga',
  tailorChangeFallbackDetail:
    'Reorganizamos suas experiências mais fortes para combinar com a descrição da vaga.',
};

const de: ResumeAIMessages = {
  summaryLabels: ['Prägnant', 'Zahlen', 'Persönlichkeit'],
  summaryFallback: [
    'Erfahrene Fachkraft mit nachweislicher Erfolgsbilanz bei wirkungsstarken Projekten. Auf der Suche nach einem Team mit klarer Mission.',
    'Umsetzungsstarkes Profil mit messbaren Erfolgen in [Bereich]. [Projekt] end-to-end verantwortet und [Kennzahl] von X auf Y gesteigert.',
    'Praxisorientiertes Profil, das aus unklaren Anforderungen fertige Produkte macht — mit belegbaren Ergebnissen.',
  ],
  summaryAugment: [
    'Ergebnisse durch konkrete Kennzahlen belegt.',
    'Mit einer klaren Haltung dazu, was als Nächstes gebaut werden sollte.',
  ],
  bulletEmpty: {
    // "mit" governs the dative → dative plural "[Beteiligten]", here and in
    // `expand` / `bulletExpandSuffix` below.
    improve:
      '[Projekt] end-to-end verantwortet und gemeinsam mit [Beteiligten] [Ergebnis] geliefert. [Kennzahl] von X auf Y gesteigert.',
    metrics:
      '[Aktion] [Projekt] mit [Ergebnis] — gemessen an [Kennzahl, vorher → nachher], bei [Grundgesamtheit, n=__].',
    shorten: '[Projekt] geliefert — [ein prägnantes Ergebnis].',
    expand:
      '[Projekt] von [Ausgangspunkt] über [Phasen] vorangetrieben. Über [Zeitraum] mit [Beteiligten] zusammengearbeitet. Ergebnis: [Ergebnis mit Kennzahl].',
    confident: '[Projekt] geleitet, verantwortet und vorangetrieben — [Ergebnis mit Kennzahl].',
    junior:
      '[Studien- oder Praktikumsarbeit] in ein praxistaugliches Ergebnis überführt — [Umfang, Größenordnung, Ergebnis].',
  },
  bulletMetricsSuffix: ' — gemessen an [Kennzahl, vorher → nachher], n=[__].',
  bulletExpandSuffix:
    '. Über [Zeitraum] mit [Beteiligten] zusammengearbeitet, um [Ergebnis] zu liefern.',
  bulletJuniorPrefix: 'Diese Arbeit in ein konkretes Ergebnis überführt: ',
  sentenceEnd: '.',
  // Participle, not the finite past "leitete": every other German bullet in
  // this block is participle register ("verantwortet", "geliefert",
  // "vorangetrieben"), and fallbackBulletRewrite splices this token into the
  // MIDDLE of the user's sentence (then upper-cases the sentence's first
  // letter) — a finite verb there breaks the clause.
  bulletConfidentVerb: 'geleitet',
  skillsDefault: [
    'Bereichsübergreifende Zusammenarbeit',
    'Eigenverantwortliche Projektsteuerung',
    'Datenbasierte Entscheidungen',
    'Kommunikation mit Stakeholdern',
  ],
  sectionHeaderName: 'Kopfbereich',
  tailorTargetPastedJD: 'Eingefügte Stellenanzeige',
  tailorTargetRoleFallback: 'Zielposition',
  tailorChangeAddSection: 'Passenden Abschnitt „{heading}“ ergänzen',
  tailorChangeReword: 'Einen Punkt in {heading} umformulieren',
  tailorChangeSurface: '{n} von der Stellenanzeige geforderte(n) Punkt(e) hervorheben',
  tailorChangeTrim: '{n} weniger relevante Zeile(n) aus {heading} entfernen',
  tailorChangeTrimDetail:
    'Inhalte entfernt, die diese Bewerbung nicht stärken.',
  tailorChangeReorder: '{heading} neu sortieren — Passendstes zuerst',
  tailorChangeReorderDetail:
    'Den für die Stelle relevantesten Punkt nach oben verschoben.',
  tailorChangeFallbackSection: 'Kurzprofil',
  tailorChangeFallback: 'Lebenslauf auf diese Stelle zugeschnitten',
  tailorChangeFallbackDetail:
    'Deine stärksten Erfahrungen wurden auf die Stellenbeschreibung hin neu formuliert.',
};

// Every locale in RA_LOCALES has a block — an omission here means a user with a
// fully translated UI reads English resume text on the degraded path.
const CATALOG: Partial<Record<string, ResumeAIMessages>> = {
  en,
  zh,
  'zh-TW': zhTW,
  ja,
  ko,
  es,
  fr,
  pt,
  de,
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
