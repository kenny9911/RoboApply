// Live-turn LLM selection (contract C12).
//
// The control plane decides which model drives live interviewer turns
// (LLM_INTERVIEW_LIVE_MODEL / LLM_INTERVIEW_LIVE_REASONING_EFFORT, allowlisted
// against ALIGNED_INTERVIEW_MODELS) and ships it in the dispatch metadata.
// Accepted shapes, most specific first:
//   meta.liveLlm = { model, reasoningEffort? }   (explicit live block)
//   meta.llm     = { model, reasoningEffort? }   (legacy / current: the
//                                                 control plane resolves the
//                                                 live model into `llm`)
// A liveLlm block without a model falls back to `llm` for the model but still
// contributes its reasoningEffort. Pure module; unit-tested.

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

const EFFORTS = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high']);

export interface LlmMetaBlock {
  model?: string;
  reasoningEffort?: string;
}

export interface LiveLlmMeta {
  llm?: LlmMetaBlock;
  liveLlm?: LlmMetaBlock;
}

export interface ResolvedLiveLlm {
  model: string;
  reasoningEffort?: ReasoningEffort;
  source: 'liveLlm' | 'llm';
}

function effortOf(raw: unknown): ReasoningEffort | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase() as ReasoningEffort;
  return EFFORTS.has(v) ? v : undefined;
}

/** Returns null when no model is configured anywhere (the worker fails the
 *  session with a clear configuration error). */
export function resolveLiveLlm(meta: LiveLlmMeta): ResolvedLiveLlm | null {
  const live = meta.liveLlm && typeof meta.liveLlm === 'object' ? meta.liveLlm : undefined;
  const base = meta.llm && typeof meta.llm === 'object' ? meta.llm : undefined;
  const liveModel = typeof live?.model === 'string' ? live.model.trim() : '';
  const baseModel = typeof base?.model === 'string' ? base.model.trim() : '';

  if (liveModel) {
    const reasoningEffort = effortOf(live?.reasoningEffort);
    return { model: liveModel, ...(reasoningEffort ? { reasoningEffort } : {}), source: 'liveLlm' };
  }
  if (!baseModel) return null;
  const reasoningEffort = effortOf(live?.reasoningEffort) ?? effortOf(base?.reasoningEffort);
  return { model: baseModel, ...(reasoningEffort ? { reasoningEffort } : {}), source: 'llm' };
}
