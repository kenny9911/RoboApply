// server/src/features/jobs/normalize/workModel.ts
//
// Work model (remote / hybrid / onsite) — set ONLY when the provider or the
// posting states it (ARCH §4.4; the existing "unknown, never onsite" rule).
// Order of trust: the provider's explicit field, then the location text, then
// the title, then a short list of unambiguous description sentences. When two
// statements at the same level disagree, the answer is null.
//
// Titles carry domain words ("Hybrid Cloud Architect", "Remote Sensing
// Scientist", 混合云架构师, 远程医疗产品经理), so a title counts only when a
// separate segment of it — in brackets or after " - " / " | " / "," — is a
// work-model word, optionally followed by a place: "Engineer (Remote)",
// "Engineer – Hybrid", "Engineer | Remote - US", "Java开发（可远程）".

import { parseLocation } from '../geo/index.js';
import type { FieldSource, WorkModel } from './types.js';
import type { Sourced } from './level.js';

/** Provider work-arrangement labels → work model (null for unknown labels and for the legacy 'unknown'). */
export function workModelFromProvider(raw: string | null | undefined): WorkModel | null {
  if (!raw) return null;
  const s = raw.normalize('NFKC').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (!s || s === 'unknown') return null;
  if (s === 'telecommute' || s.startsWith('remote') || s === 'fully remote' || s === 'wfh' || /远程|遠端|遠距/.test(s)) return 'remote';
  if (s.startsWith('hybrid') || /混合/.test(s)) return 'hybrid';
  if (s === 'on site' || s === 'onsite' || s === 'in office' || s === 'in person' || s === 'office' || /现场|駐點|坐班/.test(s)) return 'onsite';
  return null;
}

// The role (not the company or team) must be the subject: "We are a
// remote-first company" or "our fully remote team in Europe" says nothing
// about where this job is done.
const DESC_REMOTE = [
  /\b(?:this|the) (?:is an? |role is |position is |job is )?(?:fully |100% )?remote (?:role|position|job|opportunity)\b/i,
  /\b(?:this|the) (?:role|position|job|opportunity) is (?:a )?(?:fully |100% )?remote\b/i,
  /\b(?:is|as) an? (?:fully|100%) remote (?:role|position|job|opportunity)\b/i,
  /\bremote[- ]first (?:role|position)\b/i,
  /(?:本|该|此)(?:岗位|职位|職位|職缺)(?:为|是|為|可)?(?:全|完全)?(?:远程|遠端)|全远程(?:岗位|职位|工作)|远程办公岗位|全遠端(?:職缺|工作)|遠端工作職缺/,
];
// "N days a week in the office" is hybrid only for 1-4 days; 5 days is on-site.
const DESC_HYBRID = [
  /\bhybrid (?:role|position|work(?:ing)? (?:model|arrangement|schedule)|schedule)\b/i,
  /\b(?:this|the) (?:role|position|job) is hybrid\b/i,
  /\b[1-4]\s*(?:days?|x) (?:a|per) week (?:in|at) (?:the|our) office\b/i,
  /\bin[- ]office [1-4]\s*days? (?:a|per) week\b/i,
  /混合办公|混合辦公|每周[1-4一二三四]天(?:到岗|到公司|进办公室)|每週[1-4一二三四]天(?:進辦公室|進公司)|每[周週](?:进办公室|進辦公室|到岗|進公司)[1-4一二三四]天/,
];
const DESC_ONSITE = [
  /\b(?:this|the) (?:is an? )?(?:role|position|job) is (?:fully |100% )?(?:on-?site|in[- ]office|in[- ]person)\b/i,
  /\b(?:fully|100%) (?:on-?site|in[- ]office)\b/i,
  /\b(?:this is an?|is an?) (?:on-?site|in[- ]office) (?:role|position|job)\b/i,
  /\b5\s*days? (?:a|per) week (?:in|at) (?:the|our) office\b|\bin[- ]office 5\s*days? (?:a|per) week\b/i,
  /不支持远程|不接受远程|不提供远程|需全职坐班|不可遠端|無法遠端/,
];
const NEGATED_REMOTE = /\b(?:not|no|isn['’]t|is not|non)[- ](?:a )?(?:fully )?remote\b|not open to remote|不支持远程|不接受远程|不可遠端|無法遠端/i;

/** Work model stated by one of the description's unambiguous sentences, or null. */
export function workModelFromDescription(text: string | null | undefined): WorkModel | null {
  if (!text) return null;
  const s = text.normalize('NFKC');
  const remote = !NEGATED_REMOTE.test(s) && DESC_REMOTE.some((re) => re.test(s));
  const hybrid = DESC_HYBRID.some((re) => re.test(s));
  const onsite = DESC_ONSITE.some((re) => re.test(s));
  const hits = [remote && 'remote', hybrid && 'hybrid', onsite && 'onsite'].filter(Boolean) as WorkModel[];
  return hits.length === 1 ? hits[0] : null;
}

export interface WorkModelInputs {
  provider?: string | null;
  /** Legacy client field: only 'remote' is trusted. */
  legacyWorkType?: string | null;
  locationModels?: readonly (WorkModel | null)[];
  title?: string | null;
  description?: string | null;
}

const TITLE_SEGMENT_SPLIT = /\s*(?:[()（）[\]【】|｜,，/]|\s[-–—]\s|[-–—](?=\s*(?:remote|hybrid|on-?site|(?:可|支持)?(?:远程|遠端|遠距|混合))))\s*/i;
const TITLE_WORD_RE =
  /^(?:(?:fully|100%)\s+)?(remote|hybrid|on-?site|in[- ]office|in[- ]person|work from home|wfh)(?:\s+(?:ok|only|first|friendly|eligible|possible|optional|available))?(?:\s*[:-]?\s*(.*))?$/i;
const TITLE_CJK_RE = /^(?:可|支持|接受)?(?:全|完全)?(远程|遠端|遠距|居家|混合|驻场|駐點)(?:办公|辦公|工作)?$/;

/**
 * Work model stated by a title segment of its own ("Engineer (Remote)",
 * "Engineer – Hybrid, Taipei"), never by a word inside the job name.
 */
export function workModelFromTitle(title: string | null | undefined): WorkModel | null {
  if (!title) return null;
  const segments = title.normalize('NFKC').split(TITLE_SEGMENT_SPLIT).map((t) => t.trim()).filter(Boolean);
  if (segments.length < 2) return null;
  const found = new Set<WorkModel>();
  for (const seg of segments) {
    const cjk = seg.match(TITLE_CJK_RE);
    if (cjk) {
      const w = cjk[1];
      found.add(w === '混合' ? 'hybrid' : w === '驻场' || w === '駐點' ? 'onsite' : 'remote');
      continue;
    }
    const m = seg.match(TITLE_WORD_RE);
    if (!m) continue;
    // Anything after the word must be a place ("Remote US", "Hybrid Taipei"), not more job name ("Remote Sensing").
    const rest = (m[2] ?? '').trim();
    if (rest) {
      const place = parseLocation(rest);
      if (!place.country && !place.city) continue;
    }
    const w = m[1].toLowerCase();
    found.add(w === 'hybrid' ? 'hybrid' : w === 'remote' || w === 'work from home' || w === 'wfh' ? 'remote' : 'onsite');
  }
  return found.size === 1 ? [...found][0] : null;
}

/** The first level that states a work model wins; disagreement within a level → null. */
export function resolveWorkModel(inputs: WorkModelInputs): Sourced<WorkModel> | null {
  const levels: [FieldSource, (WorkModel | null)[]][] = [
    ['provider', [workModelFromProvider(inputs.provider), inputs.legacyWorkType === 'remote' ? 'remote' : null]],
    ['location_text', [...(inputs.locationModels ?? [])]],
    ['title', [workModelFromTitle(inputs.title)]],
    ['description', [workModelFromDescription(inputs.description)]],
  ];
  for (const [source, values] of levels) {
    const stated = [...new Set(values.filter((v): v is WorkModel => v !== null))];
    if (stated.length === 1) return { value: stated[0], source };
    if (stated.length > 1) return null;
  }
  return null;
}
