import { getModelSetting } from './llmModels.js';
import {
  parseReasoningEffort,
  type ReasoningEffort,
} from '../../services/llm/reasoningEffort.js';

export const LLM_TASKS = ['matching', 'extract', 'onboarding', 'rewrite', 'interview'] as const;
export type LlmTask = (typeof LLM_TASKS)[number];

const EFFORT_ENV: Record<LlmTask, string> = {
  matching: 'LLM_MATCHING_REASONING_EFFORT',
  extract: 'LLM_EXTRACT_REASONING_EFFORT',
  onboarding: 'LLM_ONBOARDING_REASONING_EFFORT',
  rewrite: 'LLM_REWRITE_REASONING_EFFORT',
  interview: 'LLM_INTERVIEW_REASONING_EFFORT',
};

/** Resolve a task model through the central DB-override → env seam. */
export function getTaskModel(task: LlmTask): string | undefined {
  return getModelSetting(task);
}

/** Read and validate a task effort at call time so env reloads take effect. */
export function getTaskReasoningEffort(task: LlmTask): ReasoningEffort | undefined {
  return parseReasoningEffort(process.env[EFFORT_ENV[task]]);
}
