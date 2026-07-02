import { logger } from './LoggerService.js';
import { llmService } from './llm/LLMService.js';
import { withLLMRetry } from './llm/withRetry.js';
import type { ParsedResume } from '../types/index.js';

const LOW_SIGNAL_SUMMARY_PATTERNS = [
  /给我一个支点/i,
  /撬起整个地球/i,
  /give me a place to stand/i,
  /i can move the earth/i,
  /move the earth/i,
  /座右铭/i,
  /人生格言/i,
  /motto/i,
  /hard[\s-]?working/i,
  /fast learner/i,
  /self[-\s]?motivated/i,
  /team player/i,
  /responsible for/i,
  /积极乐观/i,
  /责任心强/i,
  /学习能力强/i,
  /沟通能力强/i,
];

function collectSummaryEvidenceTokens(parsed: ParsedResume): string[] {
  const values = [
    ...(parsed.experience || []).flatMap((exp) => [exp.role, exp.company]),
    ...(parsed.education || []).flatMap((edu) => [edu.institution, edu.degree, edu.field]),
    ...(Array.isArray(parsed.skills)
      ? parsed.skills
      : parsed.skills
        ? Object.values(parsed.skills).flat().filter(Boolean)
        : []),
  ];

  return [...new Set(
    values
      .filter((value): value is string => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length >= 2 && value.length <= 40),
  )].slice(0, 20);
}

export function isResumeSummaryLowSignal(summary: string | null | undefined, parsed: ParsedResume): boolean {
  if (!summary || !summary.trim()) {
    return true;
  }

  const normalized = summary.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  const lines = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const evidenceTokens = collectSummaryEvidenceTokens(parsed);
  const hasEvidenceToken = evidenceTokens.some((token) => normalized.toLowerCase().includes(token.toLowerCase()));
  const technicalSignals = (
    lower.match(/\b(test|testing|qa|automation|selenium|appium|python|java|javascript|typescript|react|node|sql|linux|docker|jira|aws|gcp|kubernetes|finance|bank|securities)\b|测试|自动化|工程师|开发|证券|资管|银行|电商|平台/gi)
    || []
  ).length;
  const genericSignalHits = [
    /本人/i,
    /自我评价/i,
    /工作认真/i,
    /勤奋/i,
    /负责/i,
    /上进/i,
    /抗压/i,
    /detail-oriented/i,
    /quick learner/i,
    /excellent communication/i,
    /strong sense of responsibility/i,
  ].filter((pattern) => pattern.test(normalized)).length;

  if (LOW_SIGNAL_SUMMARY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  if (lines.length <= 2 && normalized.length <= 80 && !hasEvidenceToken && technicalSignals === 0) {
    return true;
  }

  if (genericSignalHits >= 2 && !hasEvidenceToken && technicalSignals === 0) {
    return true;
  }

  // Personality-only paragraphs are unacceptable as an AI summary — they look
  // "helpful" at a glance (well-formed sentences, > 30 chars) but carry no
  // sellable signal for a recruiter pitch. Examples from 0421 bug report:
  //   周正阳: "性格开朗外向，善于快速融入集体…有较强的钻研能力和创新性…"
  //   朱宁波: "视频拍摄、剪辑 生日：1994.01.03 身高：176cm 学历：本科 住址：北京市顺义区"
  // Both have 0 evidence tokens AND 0 technical signals. Treat as low-signal
  // regardless of length so the LLM branch kicks in.
  if (!hasEvidenceToken && technicalSignals === 0) {
    return true;
  }

  // Dense personality keyword count: 3+ personality adjectives with no
  // concrete work-history anchor is also low-signal even when it sneaks
  // past the technicalSignals heuristic via an incidental keyword.
  const personalityTerms = [
    /开朗/, /外向/, /有耐心/, /善于沟通/, /善于与[^，。]+沟通/,
    /有想法/, /责任感强/, /责任心强/, /团队合作/, /抗压能力/, /自信/, /乐观/,
    /好学/, /快速学习/, /沟通能力强/, /沟通协调/, /积极主动/,
  ];
  const personalityHits = personalityTerms.filter((p) => p.test(normalized)).length;
  if (personalityHits >= 3 && !hasEvidenceToken) {
    return true;
  }

  // "Labelled enumeration" of objective facts — e.g. "13年工作经验 | 求职意向：渠道销售 |
  // 期望薪资：15-24K | 期望城市：北京" — this is the raw career-objective
  // line candidates write at the top of their CV, not a recruiter pitch.
  // Characterised by: 2+ pipe/colon-delimited label:value pairs and very
  // few full sentences.
  const labelledFactPairs = (normalized.match(/[|｜][^|｜]*[:：]/g) || []).length;
  const startsWithYearsOrIntent = /^(\d+\s*年工作经验|求职意向|期望薪资|expected salary|target role)/i.test(normalized);
  if ((labelledFactPairs >= 2 || startsWithYearsOrIntent) && personalityHits === 0 && technicalSignals <= 1) {
    return true;
  }

  return false;
}

export function buildFallbackSummaryHighlight(parsed: ParsedResume): { summary: string; highlight: string } {
  const parts: string[] = [];

  if (parsed.experience && Array.isArray(parsed.experience) && parsed.experience.length > 0) {
    const latest = parsed.experience[0];
    const role = (latest.role as string) || '';
    const company = (latest.company as string) || '';
    if (role && company) {
      parts.push(`${role} at ${company}`);
    } else if (role) {
      parts.push(role);
    }
  }

  const skills = Array.isArray(parsed.skills)
    ? parsed.skills
    : parsed.skills
      ? Object.values(parsed.skills).flat().filter(Boolean) as string[]
      : [];
  if (skills.length > 0) {
    parts.push(`Skilled in ${skills.slice(0, 5).join(', ')}`);
  }

  if (parsed.education && Array.isArray(parsed.education) && parsed.education.length > 0) {
    const edu = parsed.education[0];
    const eduParts = [edu.degree, edu.field, edu.institution].filter(Boolean);
    if (eduParts.length > 0) {
      parts.push(eduParts.join(' — '));
    }
  }

  const summary = parts.join('. ').trim() || '';
  const highlight = (parts[0] || '').substring(0, 60) || '';

  return { summary, highlight };
}

export async function generateResumeSummaryHighlight(
  parsed: ParsedResume,
  requestId?: string,
): Promise<{ summary: string; highlight: string }> {
  const existingSummary = parsed.summary?.trim();
  if (existingSummary && existingSummary.length > 30 && !isResumeSummaryLowSignal(existingSummary, parsed)) {
    const highlight = existingSummary.length <= 80
      ? existingSummary
      : existingSummary.replace(/[。.!！？?]\s*$/, '').substring(0, 80) + '...';
    return { summary: existingSummary, highlight };
  }

  const parts: string[] = [];
  parts.push(`Name: ${parsed.name || 'Unknown'}`);
  if (parsed.experience && Array.isArray(parsed.experience) && parsed.experience.length > 0) {
    parts.push('Experience:');
    for (const exp of parsed.experience.slice(0, 5)) {
      const desc = exp.description ? ` — ${String(exp.description).substring(0, 120)}` : '';
      parts.push(`- ${exp.role || ''} at ${exp.company || ''} (${exp.duration || exp.startDate || ''})${desc}`);
    }
  }
  if (parsed.education && Array.isArray(parsed.education) && parsed.education.length > 0) {
    parts.push('Education:');
    for (const edu of parsed.education.slice(0, 3)) {
      const eduParts = [edu.degree, edu.field, edu.institution].filter(Boolean).join(' ');
      const gpa = (edu as any).gpa ? ` (GPA: ${(edu as any).gpa})` : '';
      const achievements = Array.isArray((edu as any).achievements) && (edu as any).achievements.length > 0
        ? ` [${(edu as any).achievements.join(', ')}]` : '';
      parts.push(`- ${eduParts}${gpa}${achievements}`);
    }
  }
  const skills = Array.isArray(parsed.skills)
    ? parsed.skills
    : parsed.skills
      ? Object.values(parsed.skills).flat().filter(Boolean)
      : [];
  if (skills.length > 0) {
    parts.push(`Skills: ${skills.slice(0, 20).join(', ')}`);
  }

  const prompt = `You are a senior recruiter writing an executive summary of a candidate for a client pitch. Based on this resume data, generate TWO things:
1. An executive summary (3-4 sentences, ~80-120 words) that a recruiter can use to pitch this candidate to a hiring manager. Highlight: notable skills and technical depth, relevant experience and achievements, education (only if prestigious or highly relevant), and what makes this candidate stand out. Write in the SAME LANGUAGE as the candidate's name and experience (if Chinese name/companies, write in Chinese; if English, write in English). Focus on what's impressive and sellable — skip generic filler.
2. A one-line highlight (under 60 characters) — the single most compelling selling point of this candidate.

Resume data:
${parts.join('\n')}

Respond ONLY with JSON (no markdown):
{"summary": "...", "highlight": "..."}`;

  try {
    const response = await withLLMRetry(
      () => llmService.chat([{ role: 'user', content: prompt }], { requestId }),
      { label: 'resumeSummary', requestId },
    );

    const text = response.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      const summary = typeof result.summary === 'string' ? result.summary.trim() : '';
      if (summary && !isResumeSummaryLowSignal(summary, parsed)) {
        return {
          summary,
          highlight: typeof result.highlight === 'string' ? result.highlight.trim() : '',
        };
      }
    }
  } catch (err) {
    logger.error('RESUME', 'Failed to generate summary/highlight', {
      error: err instanceof Error ? err.message : String(err),
    }, requestId);
  }

  return buildFallbackSummaryHighlight(parsed);
}
