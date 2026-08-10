/**
 * What an agent's output IS, which decides how the strict output-language
 * directive has to be phrased:
 *
 *   - 'analysis' — the agent writes ABOUT the user's documents (match scores,
 *     insights, evaluations). The resume/JD are inputs; the output is commentary.
 *   - 'content'  — the agent AUTHORS the artifact (resume bullets, summaries,
 *     skills, cover letters, interview questions). The document text IS the
 *     output, so the directive must say so explicitly.
 *
 * See `LanguageService.getStrictOutputLanguageDirective`.
 */
export type OutputLanguageScope = 'analysis' | 'content';

/**
 * Language detection service that analyzes text to determine the primary language
 * Used to instruct LLMs to respond in the same language as the job description
 */
export class LanguageService {
  // Common character ranges for language detection
  private readonly CHINESE_REGEX = /[\u4e00-\u9fff]/g;
  private readonly JAPANESE_REGEX = /[\u3040-\u309f\u30a0-\u30ff]/g;
  private readonly KOREAN_REGEX = /[\uac00-\ud7af\u1100-\u11ff]/g;
  private readonly ARABIC_REGEX = /[\u0600-\u06ff]/g;
  private readonly CYRILLIC_REGEX = /[\u0400-\u04ff]/g;
  private readonly THAI_REGEX = /[\u0e00-\u0e7f]/g;

  // Common words for language detection
  private readonly LANGUAGE_PATTERNS: Record<string, RegExp[]> = {
    English: [
      /\b(the|and|is|are|for|with|this|that|have|will|from|they|been|would|could|should|about|which|their|there|other|after|first|also|into|only|over|such|make|like|just|than|some|very|when|come|made|find|here|many|where|those|being|between|must|through|while|before|since|each|both|during|under)\b/gi,
      /\b(requirements?|responsibilities?|qualifications?|experience|skills?|team|company|work|position|role)\b/gi,
    ],
    Chinese: [
      /[\u4e00-\u9fff]{2,}/g,
      /(要求|职责|任职|工作|岗位|负责|公司|团队|经验|技能|能力|熟悉|了解|精通|优先)/g,
    ],
    Japanese: [
      /[\u3040-\u309f\u30a0-\u30ff]+/g,
      /(仕事|経験|スキル|必須|歓迎|業務|会社)/g,
    ],
    Korean: [
      /[\uac00-\ud7af]+/g,
      /(경험|업무|회사|자격|우대|필수)/g,
    ],
    German: [
      /\b(und|der|die|das|ist|sind|für|mit|sie|werden|haben|oder|bei|als|auch|nach|noch|nur|durch|über|vor|diese|einer|kann|muss|Jahr|Jahren)\b/gi,
      /\b(Anforderungen|Aufgaben|Qualifikationen|Erfahrung|Kenntnisse)\b/gi,
    ],
    French: [
      /\b(le|la|les|de|du|des|et|est|sont|pour|avec|vous|nous|dans|sur|par|une|qui|que|aux|cette|son|ses|mais|plus|tout|sans|entre)\b/gi,
      /\b(expérience|compétences|requis|missions|profil|entreprise)\b/gi,
    ],
    Spanish: [
      /\b(el|la|los|las|de|del|en|que|es|son|para|con|por|una|como|más|pero|sus|este|está|han|sin|sobre|todo|entre|desde|hasta)\b/gi,
      /\b(experiencia|requisitos|responsabilidades|habilidades|empresa)\b/gi,
    ],
    Portuguese: [
      /\b(de|que|é|são|para|com|em|uma|os|das|dos|por|mais|como|seu|sua|está|tem|mas|aos|nas|nos|essa|esse|isso)\b/gi,
      /\b(experiência|requisitos|responsabilidades|habilidades|empresa)\b/gi,
    ],
    Russian: [
      /[\u0400-\u04ff]+/g,
      /(опыт|требования|обязанности|навыки|компания)/gi,
    ],
    Arabic: [
      /[\u0600-\u06ff]+/g,
    ],
  };

  private readonly LANGUAGE_INSTRUCTIONS: Record<string, string> = {
    Chinese: '请使用简体中文回复。',
    'Traditional Chinese': '請使用繁體中文（台灣用語）回覆，請勿使用簡體字。',
    Japanese: '日本語で回答してください。',
    Korean: '한국어로 답변해 주세요.',
    German: 'Bitte antworten Sie auf Deutsch.',
    French: 'Veuillez répondre en français.',
    Spanish: 'Por favor responda en español.',
    Portuguese: 'Por favor, responda em português.',
    Russian: 'Пожалуйста, отвечайте на русском языке.',
    Arabic: 'الرجاء الرد باللغة العربية.',
    Thai: 'กรุณาตอบเป็นภาษาไทย',
    English: 'Please respond in English.',
  };

  private readonly LOCALE_LANGUAGE_MAP: Record<string, string> = {
    en: 'English',
    'en-us': 'English',
    'en-gb': 'English',
    zh: 'Chinese',
    'zh-cn': 'Chinese',
    'zh-hans': 'Chinese',
    'zh-tw': 'Traditional Chinese',
    'zh-hant': 'Traditional Chinese',
    'zh-hk': 'Traditional Chinese',
    ja: 'Japanese',
    ko: 'Korean',
    de: 'German',
    fr: 'French',
    es: 'Spanish',
    pt: 'Portuguese',
    'pt-br': 'Portuguese',
    'pt-pt': 'Portuguese',
    ru: 'Russian',
    ar: 'Arabic',
    th: 'Thai',
  };

  /**
   * Detect the primary language of the given text
   * @param text The text to analyze (typically JD content)
   * @returns The detected language name
   */
  detectLanguage(text: string): string {
    if (!text || text.trim().length === 0) {
      return 'English'; // Default
    }

    const scores: Record<string, number> = {};

    // Check for non-Latin scripts first (they're more distinctive)
    const chineseMatches = text.match(this.CHINESE_REGEX);
    if (chineseMatches && chineseMatches.length > 10) {
      scores['Chinese'] = (scores['Chinese'] || 0) + chineseMatches.length * 2;
    }

    const japaneseMatches = text.match(this.JAPANESE_REGEX);
    if (japaneseMatches && japaneseMatches.length > 5) {
      scores['Japanese'] = (scores['Japanese'] || 0) + japaneseMatches.length * 2;
    }

    const koreanMatches = text.match(this.KOREAN_REGEX);
    if (koreanMatches && koreanMatches.length > 5) {
      scores['Korean'] = (scores['Korean'] || 0) + koreanMatches.length * 2;
    }

    const cyrillicMatches = text.match(this.CYRILLIC_REGEX);
    if (cyrillicMatches && cyrillicMatches.length > 10) {
      scores['Russian'] = (scores['Russian'] || 0) + cyrillicMatches.length * 2;
    }

    const arabicMatches = text.match(this.ARABIC_REGEX);
    if (arabicMatches && arabicMatches.length > 10) {
      scores['Arabic'] = (scores['Arabic'] || 0) + arabicMatches.length * 2;
    }

    const thaiMatches = text.match(this.THAI_REGEX);
    if (thaiMatches && thaiMatches.length > 10) {
      scores['Thai'] = (scores['Thai'] || 0) + thaiMatches.length * 2;
    }

    // Check for language-specific word patterns
    for (const [language, patterns] of Object.entries(this.LANGUAGE_PATTERNS)) {
      for (const pattern of patterns) {
        const matches = text.match(pattern);
        if (matches) {
          scores[language] = (scores[language] || 0) + matches.length;
        }
      }
    }

    // Find the language with the highest score
    let maxScore = 0;
    let detectedLanguage = 'English';

    for (const [language, score] of Object.entries(scores)) {
      if (score > maxScore) {
        maxScore = score;
        detectedLanguage = language;
      }
    }

    return detectedLanguage;
  }

  private normalizeLocale(locale: string): string {
    return locale.trim().toLowerCase().replace('_', '-');
  }

  getLanguageFromLocale(locale: string): string | null {
    if (!locale || locale.trim().length === 0) {
      return null;
    }

    const normalized = this.normalizeLocale(locale);
    if (this.LOCALE_LANGUAGE_MAP[normalized]) {
      return this.LOCALE_LANGUAGE_MAP[normalized];
    }

    const base = normalized.split('-')[0];
    return this.LOCALE_LANGUAGE_MAP[base] || null;
  }

  getLanguageInstructionForLanguage(language: string): string {
    return this.LANGUAGE_INSTRUCTIONS[language] || `Please respond in ${language}.`;
  }

  /**
   * Get language instruction for LLM prompt
   * @param jdContent The job description content
   * @returns A string instruction for the LLM to respond in the detected language
   */
  getLanguageInstruction(jdContent: string): string {
    const language = this.detectLanguage(jdContent);
    return this.getLanguageInstructionForLanguage(language);
  }

  getLanguageInstructionFromLocale(locale: string): string | null {
    const language = this.getLanguageFromLocale(locale);
    if (!language) {
      return null;
    }

    return this.getLanguageInstructionForLanguage(language);
  }

  /**
   * Strong output-language directive for agents whose system prompts carry
   * their own language guidance (e.g. ResumeMatchAgent / MatchAgent's
   * "respond in the dominant language of the JD + resume"). The one-line
   * LANGUAGE_INSTRUCTIONS hint loses to those in-body directives often
   * enough that a Chinese-UI user sees English match output for an English
   * resume. This block states the user-selected language as the
   * highest-priority rule, while protecting schema enum values (grades,
   * verdicts, severities) that downstream code branches on, plus proper
   * nouns and technical terms.
   *
   * `scope` picks which "what counts as output" clause is used:
   *
   *   - 'analysis' (default) — the agent WRITES ABOUT the user's documents
   *     (match scoring, insights, evaluations). Its output is commentary, and
   *     the resume/JD are inputs.
   *
   *   - 'content' — the agent AUTHORS the artifact itself (resume bullets and
   *     summaries, skill phrases, cover letters, outreach copy, interview
   *     questions). The 'analysis' clause silently fails here: it enumerates
   *     commentary field names and calls the resume an *input*, so a model can
   *     satisfy it while still writing the rewritten bullet in English. That is
   *     the exact production failure this split fixes — a zh user's Chinese
   *     bullet came back rewritten in English from RAResumeRewriteAgent with
   *     the 'analysis' directive present and correct in the system prompt.
   *
   * Only the "what counts as output" clause differs. Enum preservation and the
   * proper-noun rule apply to BOTH scopes — 'content' agents carry schema
   * tokens too, and a translated one is silently dropped downstream.
   *
   * Both scopes carry the "English in this prompt is not a signal" clause:
   * these prompts are authored in English and often name English words
   * outright (`Lead with ownership verbs (Led / Owned / Drove)`, `No hedging
   * ("helped", "assisted")`). Cheap/fast models read that lexical guidance —
   * which sits in the user message, closer to the output than the system
   * prompt — as "write English".
   *
   * Returns null for unrecognized locales — callers should fall back to
   * `getLanguageInstructionFromLocale` / auto-detection.
   */
  getStrictOutputLanguageDirective(
    locale: string,
    scope: OutputLanguageScope = 'analysis',
  ): string | null {
    const language = this.getLanguageFromLocale(locale);
    if (!language) {
      return null;
    }
    const nativeHint = this.getLanguageInstructionForLanguage(language);

    const scopeClause =
      scope === 'content'
        ? [
            `Write EVERY human-readable string in your output in ${language}. This INCLUDES THE DOCUMENT TEXT YOU PRODUCE, not just commentary about it: rewritten resume bullets, professional summaries, skill phrases, headlines, cover-letter and outreach copy, interview questions, and coaching tips.`,
            `You are AUTHORING in ${language}. When the source bullet, resume, or job description is written in another language, you still write the result in ${language} — do NOT mirror the input's language, and do NOT translate into English.`,
          ]
        : [
            `Write EVERY human-readable string in your output in ${language} — summaries, top reasons, evidence sentences, gap analyses, assessments, recommendations, counter-perspectives, and interview questions — even when the resume, job description, or other inputs are written in a different language.`,
          ];

    // Enum preservation is NOT scope-specific — it is orthogonal to whether the
    // agent authors or comments. 'content' agents carry schema tokens too:
    // RAOnboardingResumeSeedAgent emits `industriesTarget` from a closed list,
    // RACareerInsightAgent emits `action`, and several emit a two-valued
    // `coachTip.kind`. Downstream code drops values it cannot match, so a
    // translated enum is SILENT DATA LOSS, not a cosmetic slip. Both scopes get
    // this clause; only the wording of what "counts as output" differs above.
    const schemaClause = [
      'Schema-constrained enum values must stay EXACTLY as the output schema specifies — same words, same letter-casing, never translated. This includes (non-exhaustive): grades ("A+"), verdicts ("Strong Match"), recommendations ("Strongly Recommend"), severities ("Dealbreaker" and lowercase "dealbreaker"), confidence ("High" / "high"), proficiency ("Expert", "Advanced"), relevance and priority levels ("High|Medium|Low", "Critical|High|Medium|Low"), yes/no fields ("Yes", "No", "Partially"), and any value this prompt tells you to pick from a fixed list of options. Any value the schema writes as a pipe-separated choice is an enum. Only free-text narrative fields are translated.',
      'JSON keys and any other schema-defined token stay EXACTLY as this prompt specifies — never translated.',
    ];

    return [
      '# OUTPUT LANGUAGE (USER-SELECTED — HIGHEST PRIORITY)',
      `The user's selected interface language is ${language}. ${nativeHint}`,
      ...scopeClause,
      `This prompt and its examples are written in English for authoring convenience ONLY — that is NOT a signal about your output language. Any style rule that names specific English words (verbs to lead with, words to avoid, sample phrasings) is an ILLUSTRATION of the intent: apply the equivalent idiom in ${language}, never the English words themselves. This does NOT extend to values you are told to pick from a fixed list — see the schema rule below.`,
      'Keep proper nouns (people, companies, schools, products) and technical terms (e.g. Python, Kubernetes, RAG) in their original form.',
      ...schemaClause,
      'This directive OVERRIDES any other language instruction elsewhere in this prompt, EXCEPT the schema rule above — a fixed-list value is never translated, whatever else this prompt says.',
    ].join('\n');
  }
}

export const languageService = new LanguageService();
