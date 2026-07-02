// lib/fixtures/keywords.ts
//
// Keyword extractions for the top 10 jobs in `FIXTURE_JOBS`. Used by the
// stub `jobs.get(id, { includeKeywords: true })` and by the demo's
// premium-gated Top Keywords panel on the Job Detail page.
//
// Top-10 here means the most-likely-to-be-viewed jobs given the demo user's
// "AI Software Engineer" career goal — AI / Senior / Staff roles at
// recognizable companies. The remaining 40 jobs return `keywords: null`
// from the stub (Wave-2 OK — the panel just shows the empty state).

import type { RAKeyword } from '../api/v2/types';

export const FIXTURE_KEYWORDS: Record<string, RAKeyword[]> = {
  cm_job_anthropic_ai: [
    { keyword: 'Python', importance: 'high', frequency: 5 },
    { keyword: 'LLM evaluation', importance: 'high', frequency: 4 },
    { keyword: 'inference optimization', importance: 'high', frequency: 3 },
    { keyword: 'vLLM', importance: 'medium', frequency: 2 },
    { keyword: 'distributed training', importance: 'medium', frequency: 2 },
    { keyword: 'production ML', importance: 'high', frequency: 3 },
    { keyword: 'on-call', importance: 'low', frequency: 1 },
    { keyword: 'eval suites', importance: 'medium', frequency: 2 },
  ],
  cm_job_anthropic_swe: [
    { keyword: 'TypeScript', importance: 'high', frequency: 5 },
    { keyword: 'API design', importance: 'high', frequency: 4 },
    { keyword: 'developer experience', importance: 'high', frequency: 4 },
    { keyword: 'SDK', importance: 'high', frequency: 3 },
    { keyword: 'Node.js', importance: 'medium', frequency: 2 },
    { keyword: 'Python', importance: 'medium', frequency: 2 },
    { keyword: 'documentation', importance: 'medium', frequency: 2 },
    { keyword: 'product engineering', importance: 'low', frequency: 1 },
  ],
  cm_job_anthropic_ml: [
    { keyword: 'PyTorch', importance: 'high', frequency: 5 },
    { keyword: 'JAX', importance: 'high', frequency: 3 },
    { keyword: 'CUDA', importance: 'high', frequency: 3 },
    { keyword: 'vLLM', importance: 'high', frequency: 3 },
    { keyword: 'triton', importance: 'medium', frequency: 2 },
    { keyword: 'inference', importance: 'high', frequency: 4 },
    { keyword: 'distributed systems', importance: 'medium', frequency: 2 },
    { keyword: 'profiling', importance: 'medium', frequency: 2 },
  ],
  cm_job_anthropic_staff: [
    { keyword: 'systems design', importance: 'high', frequency: 5 },
    { keyword: 'API platform', importance: 'high', frequency: 4 },
    { keyword: 'technical leadership', importance: 'high', frequency: 3 },
    { keyword: 'mentorship', importance: 'medium', frequency: 3 },
    { keyword: 'scaling', importance: 'high', frequency: 3 },
    { keyword: 'Python', importance: 'medium', frequency: 2 },
    { keyword: 'TypeScript', importance: 'medium', frequency: 2 },
    { keyword: 'cross-team', importance: 'medium', frequency: 2 },
  ],
  cm_job_stripe_ai: [
    { keyword: 'Python', importance: 'high', frequency: 5 },
    { keyword: 'fraud detection', importance: 'high', frequency: 4 },
    { keyword: 'streaming ML', importance: 'high', frequency: 3 },
    { keyword: 'feature stores', importance: 'medium', frequency: 2 },
    { keyword: 'Kafka', importance: 'medium', frequency: 2 },
    { keyword: 'low-latency inference', importance: 'high', frequency: 3 },
    { keyword: 'production ML', importance: 'high', frequency: 3 },
    { keyword: 'observability', importance: 'low', frequency: 1 },
  ],
  cm_job_stripe_staff: [
    { keyword: 'data platform', importance: 'high', frequency: 5 },
    { keyword: 'systems design', importance: 'high', frequency: 4 },
    { keyword: 'Postgres', importance: 'high', frequency: 3 },
    { keyword: 'streaming', importance: 'medium', frequency: 3 },
    { keyword: 'technical leadership', importance: 'high', frequency: 3 },
    { keyword: 'Python', importance: 'medium', frequency: 2 },
    { keyword: 'Java', importance: 'medium', frequency: 2 },
    { keyword: 'platform engineering', importance: 'high', frequency: 3 },
  ],
  cm_job_linear_swe: [
    { keyword: 'TypeScript', importance: 'high', frequency: 5 },
    { keyword: 'React', importance: 'high', frequency: 4 },
    { keyword: 'GraphQL', importance: 'high', frequency: 3 },
    { keyword: 'real-time', importance: 'medium', frequency: 2 },
    { keyword: 'Postgres', importance: 'medium', frequency: 2 },
    { keyword: 'product engineering', importance: 'high', frequency: 3 },
    { keyword: 'frontend', importance: 'medium', frequency: 3 },
    { keyword: 'remote', importance: 'low', frequency: 1 },
  ],
  cm_job_linear_staff: [
    { keyword: 'systems design', importance: 'high', frequency: 5 },
    { keyword: 'real-time sync', importance: 'high', frequency: 4 },
    { keyword: 'CRDT', importance: 'high', frequency: 3 },
    { keyword: 'TypeScript', importance: 'high', frequency: 4 },
    { keyword: 'distributed systems', importance: 'high', frequency: 3 },
    { keyword: 'WebSocket', importance: 'medium', frequency: 2 },
    { keyword: 'technical leadership', importance: 'high', frequency: 3 },
    { keyword: 'Postgres', importance: 'medium', frequency: 2 },
  ],
  cm_job_perplexity_ai: [
    { keyword: 'LLM', importance: 'high', frequency: 5 },
    { keyword: 'RAG', importance: 'high', frequency: 4 },
    { keyword: 'search quality', importance: 'high', frequency: 4 },
    { keyword: 'Python', importance: 'high', frequency: 3 },
    { keyword: 'retrieval', importance: 'high', frequency: 3 },
    { keyword: 'eval suites', importance: 'medium', frequency: 2 },
    { keyword: 'prompt engineering', importance: 'medium', frequency: 2 },
    { keyword: 'onsite SF', importance: 'low', frequency: 1 },
  ],
  cm_job_vercel_ai: [
    { keyword: 'TypeScript', importance: 'high', frequency: 5 },
    { keyword: 'AI SDK', importance: 'high', frequency: 4 },
    { keyword: 'Node.js', importance: 'high', frequency: 3 },
    { keyword: 'streaming', importance: 'high', frequency: 3 },
    { keyword: 'developer experience', importance: 'high', frequency: 3 },
    { keyword: 'React', importance: 'medium', frequency: 2 },
    { keyword: 'serverless', importance: 'medium', frequency: 2 },
    { keyword: 'open source', importance: 'low', frequency: 1 },
  ],
};
