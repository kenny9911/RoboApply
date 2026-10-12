// server/src/interview-engine/skills/markets.ts
//
// MARKET NORMS — how interviews run in a job market: the usual rounds, the
// opening and closing rituals, the register, and what local interviewers
// listen for. A Japanese 最終面接, a mainland 项目深挖 and a UK competency panel
// differ before any company or role does. One playbook per market, resolved
// from the job's country first, then the brand's market, then the session
// language (resolveMarketNorms).
//
// Same three directive slots as the other skills (blueprint → question design,
// voice → the live interviewer, evaluation → grading). Every playbook keeps
// the engine's guardrail: a question that is common locally but touches a
// protected trait (age, family plans, marital status, origin…) is never asked.

export type InterviewMarketKey =
  | 'us'
  | 'uk'
  | 'de'
  | 'fr'
  | 'es'
  | 'br'
  | 'cn'
  | 'tw'
  | 'jp'
  | 'kr'
  | 'in'
  | 'sea';

export interface MarketNormPlaybook {
  key: InterviewMarketKey;
  labelEn: string;
  /** One line for the skill index. */
  summary: string;
  /** ISO 3166-1 alpha-2 codes this playbook covers. */
  countries: readonly string[];
  blueprintDirective: string;
  voiceDirective: string;
  evaluationLens: string;
}

const PROTECTED_NOTE =
  'Never ask about age, family plans, marital status, health, religion or origin, even where such questions are still heard locally.';

export const MARKET_NORMS: Record<InterviewMarketKey, MarketNormPlaybook> = {
  us: {
    key: 'us',
    labelEn: 'United States and Canada',
    summary: 'Recruiter screen, hiring manager, then a loop; "tell me about yourself", behavioral answers with numbers, time for the candidate’s questions.',
    countries: ['US', 'CA'],
    blueprintDirective:
      'Open with "tell me about yourself" or a resume walk-through, use behavioral questions that expect quantified impact for the core, and leave a few minutes for the candidate’s questions. A recruiter-style round may ask for a researched salary range.',
    voiceDirective: `Be friendly and direct, use first names and show light enthusiasm. Expect concise answers with numbers and say so when an answer runs long. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward concise, quantified, first-person stories and clear ownership; penalize rambling, "we" without "I", and missing results.',
  },
  uk: {
    key: 'uk',
    labelEn: 'United Kingdom, Ireland, Australia and New Zealand',
    summary: 'Competency- or strengths-based questions, polite but probing, often a panel; public employers follow published frameworks.',
    countries: ['GB', 'IE', 'AU', 'NZ'],
    blueprintDirective:
      'Map questions to the competencies or strengths the job names (communication, delivery, leadership, working together) and expect a specific example for each; include one strengths-based and one motivation question.',
    voiceDirective: `Be polite, measured and slightly understated; probe with "and what was your part in that?" rather than open challenge. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward specific evidence for each competency and honest reflection; penalize generic claims and overstatement.',
  },
  de: {
    key: 'de',
    labelEn: 'Germany, Austria and Switzerland',
    summary: 'Structured and detail-oriented: a CV walk-through with transitions explained, subject-matter depth, notice period and salary expectations asked directly.',
    countries: ['DE', 'AT', 'CH', 'LI', 'LU'],
    blueprintDirective:
      'Start with a structured walk-through of the CV (Lebenslauf) including transitions and gaps, then subject-matter depth (Fachfragen), one task or case from the job, and practical questions on notice period (Kündigungsfrist) and salary expectation (Gehaltsvorstellung).',
    voiceDirective: `Be formal and matter-of-fact; in German use the polite Sie. Value precision and facts over enthusiasm, and follow up on details. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward precision, substantiated claims, structure and realistic self-assessment; penalize vagueness, exaggeration and missing detail.',
  },
  fr: {
    key: 'fr',
    labelEn: 'French-speaking markets',
    summary: 'Formal register, a coherent career story (parcours), motivation, argumentation and situational questions (mises en situation).',
    countries: ['FR', 'BE', 'MC', 'SN', 'CI', 'MA', 'TN'],
    blueprintDirective:
      'Cover the career path told as a coherent story (parcours), motivation for the company and the role, one situational question (mise en situation) from the job, strengths and areas to improve, and salary expectations (prétentions salariales).',
    voiceDirective: `Be formal and courteous; in French use vous. Appreciate well-argued, structured answers and ask "why" to test the reasoning. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward a coherent narrative, structured argumentation and specific motivation; penalize unexplained career moves and superficial motivation.',
  },
  es: {
    key: 'es',
    labelEn: 'Spain and Spanish-speaking Latin America',
    summary: 'Competency interviews in a personal, conversational tone; motivation, teamwork and adaptability matter; group dynamics in graduate programmes.',
    countries: ['ES', 'MX', 'AR', 'CO', 'CL', 'PE', 'EC', 'UY', 'PY', 'BO', 'VE', 'CR', 'PA', 'GT', 'DO', 'SV', 'HN', 'NI', 'PR'],
    blueprintDirective:
      'Open with a short rapport-building exchange and the candidate’s trajectory, then competency questions on teamwork, adaptability and results, one situational question from the job, and motivation for the company; salary expectations may be discussed.',
    voiceDirective: `Be warm and personable while staying professional; match the company’s register (usted or tú) and keep rapport before probing. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward specific examples, adaptability, collaboration and genuine motivation; penalize generic answers and weak links between experience and the role.',
  },
  br: {
    key: 'br',
    labelEn: 'Brazil and Portugal',
    summary: 'Friendly, relationship-oriented interviews; competency questions, business cases for corporate roles, group dynamics for trainee programmes.',
    countries: ['BR', 'PT', 'AO', 'MZ'],
    blueprintDirective:
      'Start with the candidate’s trajectory, then competency questions with concrete results, one case or situational question from the job, motivation for the company, and salary expectation (pretensão salarial).',
    voiceDirective: `Be friendly and relationship-oriented while professional; build rapport first, then probe for concrete results. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward concrete results, collaboration, initiative and clear motivation; penalize vague answers and limited self-awareness.',
  },
  cn: {
    key: 'cn',
    labelEn: 'Mainland China',
    summary: 'Several rounds (一面, 二面, sometimes a cross-team 交叉面) and an HR round; self-introduction, deep project dives, fundamentals and live coding for tech roles, a reverse-question close.',
    countries: ['CN'],
    blueprintDirective:
      'Open with a one-to-two-minute self-introduction (自我介绍); dig into one or two resume projects (项目深挖: background, the candidate’s role, the hardest problem, the result and its data); for technical roles add fundamentals questions and a live coding problem (手撕代码), for business roles a case or scenario; close with the candidate’s questions (反问环节). An HR round covers motivation, career plan, stability and expected salary (期望薪资).',
    voiceDirective: `Be professional and efficient; ask for concrete data and the candidate’s own contribution, press on the hardest problem (难点) and how it was solved, and keep a steady pace. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward a crisp self-introduction, quantified project results, a clear personal contribution, solid fundamentals and composure under follow-up; penalize vague project descriptions, contributions inflated beyond the role and memorized answers without understanding.',
  },
  tw: {
    key: 'tw',
    labelEn: 'Taiwan',
    summary: 'A self-introduction, a supervisor interview on skills and past work, an HR interview on motivation and salary; English may be tested at multinationals.',
    countries: ['TW'],
    blueprintDirective:
      'Open with a self-introduction (自我介紹); cover the work most relevant to the job with concrete results; include professional or technical fundamentals for engineering roles; HR topics are motivation, reasons for leaving, expected salary (期望待遇) and readiness for shifts or overtime where the job needs it; add English questions when the role is multinational.',
    voiceDirective: `Be polite, modest and professional; ask follow-ups on concrete contributions and what the candidate learned, and allow time to think. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward clear, concrete achievements stated modestly, stability, team orientation and solid fundamentals; penalize exaggeration and unclear motivation.',
  },
  jp: {
    key: 'jp',
    labelEn: 'Japan',
    summary: 'Formal and polite, several rounds ending with an executive final (最終面接); self-introduction, motivation for this company, student or career highlights, reverse questions.',
    countries: ['JP'],
    blueprintDirective:
      'Open with 自己紹介 and a 志望動機 specific to the company; for new graduates ask what they focused on as students (ガクチカ) and team experiences; for mid-career candidates ask the reason for changing jobs (転職理由), concrete achievements and how they would contribute; close with 逆質問 (the candidate’s questions).',
    voiceDirective: `Use polite, formal Japanese (です・ます and appropriate keigo) when the session is in Japanese; keep a calm, respectful tone, listen fully, and probe gently but persistently for the reason behind each action (なぜ). ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward sincere motivation tied to this company, logical consistency, humility with concrete results and team orientation; penalize generic motivation, inconsistent answers and self-centered framing.',
  },
  kr: {
    key: 'kr',
    labelEn: 'Korea',
    summary: 'Job interview (직무면접), personality interview (인성면접), presentation or discussion rounds and an executive round; a one-minute self-introduction is standard.',
    countries: ['KR'],
    blueprintDirective:
      'Open with a one-minute self-introduction (1분 자기소개); cover job knowledge with concrete experience, a values block (teamwork, conflict, failure), and optionally a short presentation topic; close by inviting final remarks (마지막으로 하고 싶은 말).',
    voiceDirective: `Be formal and polite (존댓말 when the session is in Korean); ask direct follow-ups on motivation and fit with the company. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward a crisp self-introduction, job-relevant experience with results, organizational fit and composure; penalize vague motivation and answers that ignore the company.',
  },
  in: {
    key: 'in',
    labelEn: 'India',
    summary: 'Technical rounds (often several), a managerial round and an HR round covering notice period, current and expected CTC and relocation.',
    countries: ['IN', 'LK', 'BD', 'NP', 'PK'],
    blueprintDirective:
      'Cover a resume walk-through, technical depth with problem solving or coding for technical roles, a managerial block on ownership and stakeholders, and HR topics (notice period, current and expected CTC, relocation).',
    voiceDirective: `Be professional and fairly direct; probe fundamentals and project specifics. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward strong fundamentals, clear project ownership and communication; penalize rote answers.',
  },
  sea: {
    key: 'sea',
    labelEn: 'Singapore, Hong Kong and Southeast Asia',
    summary: 'Multinational-style competency and technical rounds, usually in English, with regional scope, stability and expected salary discussed.',
    countries: ['SG', 'HK', 'MO', 'MY', 'TH', 'VN', 'PH', 'ID'],
    blueprintDirective:
      'Combine a resume walk-through, competency questions with measurable results, role-specific technical or case questions, regional or cross-cultural collaboration, and expected salary and notice period.',
    voiceDirective: `Be professional and efficient, in a neutral international register; ask for measurable results and regional experience. ${PROTECTED_NOTE}`,
    evaluationLens:
      'Reward measurable results, cross-cultural collaboration and clear communication; penalize vague claims.',
  },
};

export const INTERVIEW_MARKET_KEYS = Object.keys(MARKET_NORMS) as InterviewMarketKey[];

const BY_COUNTRY = new Map<string, InterviewMarketKey>();
for (const playbook of Object.values(MARKET_NORMS)) {
  for (const country of playbook.countries) BY_COUNTRY.set(country, playbook.key);
}

/** The session language's usual market, when nothing more specific is known. */
const BY_LANGUAGE: Record<string, InterviewMarketKey> = {
  en: 'us',
  zh: 'cn',
  'zh-TW': 'tw',
  ja: 'jp',
  ko: 'kr',
  es: 'es',
  fr: 'fr',
  pt: 'br',
  de: 'de',
};

export function getMarketNorms(key: string | null | undefined): MarketNormPlaybook | null {
  return key && Object.prototype.hasOwnProperty.call(MARKET_NORMS, key) ? MARKET_NORMS[key as InterviewMarketKey] : null;
}

/** The market of an ISO country code, or null when no playbook covers it. */
export function marketForCountry(country: string | null | undefined): InterviewMarketKey | null {
  const code = (country ?? '').trim().toUpperCase();
  return code ? BY_COUNTRY.get(code) ?? null : null;
}

/**
 * The playbook for a practice: the job's country wins (a Tokyo posting runs
 * like a Japanese interview whatever the UI language), then the brand's
 * market (GoApply → mainland China), then the session language.
 */
export function resolveMarketNorms(input: {
  country?: string | null;
  brandMarket?: string | null;
  language?: string | null;
}): MarketNormPlaybook {
  const fromCountry = marketForCountry(input.country);
  if (fromCountry) return MARKET_NORMS[fromCountry];
  if (input.brandMarket === 'cn') return MARKET_NORMS.cn;
  const language = (input.language ?? '').trim();
  const key = BY_LANGUAGE[language] ?? BY_LANGUAGE[language.split('-')[0]] ?? 'us';
  return MARKET_NORMS[key];
}
