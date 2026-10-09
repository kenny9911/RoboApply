import { getDefaultModel, getModelSetting, type LlmBrandArg } from './llmModels.js';
import {
  parseReasoningEffort,
  type ReasoningEffort,
} from '../../services/llm/reasoningEffort.js';

// ARCHITECTURE.md §1.8: the clone adds `copilot` (the Assistant: tool-capable,
// streamed), `enrich` (cheap job enrichment) and `writing` (cover letters,
// outreach). Each maps to LLM_<TASK>_MODEL, read as CN_LLM_<TASK>_MODEL on
// GoApply (no fallback to the unprefixed variable).
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

/** Resolve a task model through the central DB-override → env seam (per brand). */
export function getTaskModel(task: LlmTask, brand?: LlmBrandArg): string | undefined {
  return getModelSetting(task, brand);
}

/**
 * The task model, or the brand's default model when the task has none. The
 * clone tasks (copilot, enrich, writing) use this so a deployment that sets
 * only LLM_MODEL / CN_LLM_MODEL still works; it never crosses brands.
 */
export function getTaskModelOrDefault(task: LlmTask, brand?: LlmBrandArg): string | undefined {
  return getTaskModel(task, brand) ?? getDefaultModel(brand);
}

/** Read and validate a task effort at call time so env reloads take effect. */
export function getTaskReasoningEffort(task: LlmTask): ReasoningEffort | undefined {
  return parseReasoningEffort(process.env[EFFORT_ENV[task]]);
}
