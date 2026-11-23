import type { EnvSource } from '../../platform/brand/brandEnv.js';
import { getDefaultModel, getModelSetting, type LlmBrandArg } from './llmModels.js';
import {
  parseReasoningEffort,
  type ReasoningEffort,
} from '../../services/llm/reasoningEffort.js';

// ARCHITECTURE.md §1.8: the clone adds `copilot` (the Assistant: tool-capable,
// streamed), `enrich` (cheap job enrichment) and `writing` (cover letters,
// outreach). Each maps to LLM_<TASK>_MODEL. GoApply reads CN_LLM_<TASK>_MODEL
// as an optional override and otherwise the shared value (per key, see
// llmModels.ts).
export const LLM_TASKS = [
  'matching',
  'extract',
  'onboarding',
  'rewrite',
  'interview',
  'copilot',
  'enrich',
  'writing',
] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

const EFFORT_ENV: Record<LlmTask, string> = {
  matching: 'LLM_MATCHING_REASONING_EFFORT',
  extract: 'LLM_EXTRACT_REASONING_EFFORT',
  onboarding: 'LLM_ONBOARDING_REASONING_EFFORT',
  rewrite: 'LLM_REWRITE_REASONING_EFFORT',
  interview: 'LLM_INTERVIEW_REASONING_EFFORT',
  copilot: 'LLM_COPILOT_REASONING_EFFORT',
  enrich: 'LLM_ENRICH_REASONING_EFFORT',
  writing: 'LLM_WRITING_REASONING_EFFORT',
};

export function isLlmTask(value: unknown): value is LlmTask {
  return typeof value === 'string' && (LLM_TASKS as readonly string[]).includes(value);
}

/** Resolve a task model through the central per-brand, per-key seam (llmModels.ts). */
export function getTaskModel(task: LlmTask, brand?: LlmBrandArg, env: EnvSource = process.env): string | undefined {
  return getModelSetting(task, brand, env);
}

/**
 * The task model, or the brand's default model when the task has none. The
 * clone tasks (copilot, enrich, writing) use this so a deployment that sets
 * only LLM_MODEL works for both brands: GoApply with no CN_LLM_* gets
 * RoboApply's selector, and its own CN_LLM_<TASK>_MODEL / CN_LLM_MODEL when set.
 */
export function getTaskModelOrDefault(task: LlmTask, brand?: LlmBrandArg, env: EnvSource = process.env): string | undefined {
  return getTaskModel(task, brand, env) ?? getDefaultModel(brand, env);
}

/**
 * The model that scores a finished interview (scorecard, per-question review,
 * recommendations): the Evaluation area (else the Default area), its saved
 * override or `LLM_EVALUATION`, else the default model. Like every area it
 * no longer borrows another task's model when nothing is set.
 */
export function getEvaluationModel(brand?: LlmBrandArg, env: EnvSource = process.env): string | undefined {
  return getModelSetting('evaluation', brand, env) ?? getDefaultModel(brand, env);
}

/**
 * The model that reads images and scanned pages (OCR): the Visual area (else
 * the Default area), its saved override or `LLM_VISION_MODEL`, else the
 * default model.
 */
export function getVisionModel(brand?: LlmBrandArg, env: EnvSource = process.env): string | undefined {
  return getModelSetting('vision', brand, env) ?? getDefaultModel(brand, env);
}

/**
 * The model that writes insights (the weekly career summary, the cross-bank
 * search summary): the Insights area or `RA_V2_CAREER_INSIGHT_MODEL`.
 * Undefined → the caller uses the default model.
 */
export function getInsightsModel(brand?: LlmBrandArg, env: EnvSource = process.env): string | undefined {
  return getModelSetting('insights', brand, env);
}

/** Read and validate a task effort at call time so env reloads take effect. */
export function getTaskReasoningEffort(task: LlmTask): ReasoningEffort | undefined {
  return parseReasoningEffort(process.env[EFFORT_ENV[task]]);
}
