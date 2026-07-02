// lib/fixtures/resumes.ts
//
// 3 RAResumeVariant rows: 1 base ("Master Resume"), 1 tailored for Anthropic,
// and 1 from a template ("ATS-Friendly"). resumeMarkdown bodies are short
// realistic stubs — the Resume Builder shell viewer (V2.0) renders these
// through ReactMarkdown for the demo.

import type { RAResumeVariant } from '../api/v2/types';

const BASE_RESUME_MD = `# Alex Chen
*AI Software Engineer · alex.chen@example.com · github.com/alexchen · linkedin.com/in/alexchen-eng*

## Summary

AI-focused software engineer with 6 years building production ML systems. Shipped retrieval, evaluation, and inference platforms used by millions. Strong at the seam between research and infra.

## Experience

### Notion · Senior Software Engineer, AI · 2023 – present
- Led the Notion AI launch surface, scaling to 8M weekly active users in 6 months
- Designed the eval harness now used company-wide for any LLM rollout decision
- Owned on-call quality for the model-serving fleet; reduced p99 by 38%

### Stripe · Software Engineer, Risk Platform · 2020 – 2023
- Migrated the fraud-scoring pipeline from offline batch to streaming, cutting decision latency from 3s to 80ms
- Pair-programmed a new feature-store with the data-platform team — currently the company default
- Mentored 3 junior engineers through their first ship-to-production

### Square · Junior Engineer, Payments · 2019 – 2020
- First role out of school; learned to ship safely in a regulated environment

## Skills

Python · TypeScript · PyTorch · Postgres · vLLM · Kafka · Terraform · DataDog · Linear

## Education

B.S. Computer Science, University of California Berkeley · 2019`;

const TAILORED_ANTHROPIC_MD = `# Alex Chen
*AI Software Engineer · alex.chen@example.com · github.com/alexchen · linkedin.com/in/alexchen-eng*

## Summary

AI-focused software engineer with 6 years building production LLM systems. Most recent work: scaling Notion AI from 0 → 8M weekly active users including eval harness design and inference cost optimization — directly applicable to the Claude Platform team's mission.

## Experience

### Notion · Senior Software Engineer, AI · 2023 – present
- **Owned the Claude-powered Notion AI launch surface**, scaling to 8M weekly active users in 6 months
- Designed the **company-wide LLM eval harness** — every model rollout passes through it, prevents regressions
- Reduced **inference p99 latency by 38%** through vLLM tuning + speculative decoding rollout
- Partnered with Anthropic's API team on a multi-tier model routing system that cut spend by 23%

### Stripe · Software Engineer, Risk Platform · 2020 – 2023
- Migrated the fraud-scoring pipeline from offline batch to streaming; **3s → 80ms decision latency**
- Pair-programmed a new feature-store now used company-wide
- Mentored 3 junior engineers through their first ship-to-production

### Square · Junior Engineer, Payments · 2019 – 2020

## Skills

Python · TypeScript · PyTorch · vLLM · Postgres · Kafka · Terraform · LLM evaluation · inference optimization · prompt engineering

## Education

B.S. Computer Science, University of California Berkeley · 2019`;

const ATS_TEMPLATE_MD = `# Alex Chen

alex.chen@example.com | (555) 123-4567 | linkedin.com/in/alexchen-eng | github.com/alexchen

## Professional Summary

AI Software Engineer with 6 years of experience designing and deploying production LLM systems, evaluation infrastructure, and ML platforms at high-growth technology companies.

## Professional Experience

**Senior Software Engineer, AI** · Notion · 2023 – Present
- Led production launch of Notion AI surface, reaching 8 million weekly active users within 6 months
- Architected company-wide LLM evaluation framework used for all model rollout decisions
- Optimized inference serving latency, reducing p99 by 38 percent
- Managed on-call quality for model serving infrastructure

**Software Engineer, Risk Platform** · Stripe · 2020 – 2023
- Migrated fraud scoring pipeline from batch to streaming architecture, reducing decision latency from 3 seconds to 80 milliseconds
- Co-developed feature store solution adopted as company standard
- Mentored 3 junior engineers in production deployment best practices

**Junior Engineer, Payments** · Square · 2019 – 2020
- Built and maintained payment processing services within a regulated environment

## Technical Skills

Languages: Python, TypeScript, SQL
ML/AI: PyTorch, vLLM, LLM evaluation, inference optimization
Infrastructure: Postgres, Kafka, Terraform, AWS, DataDog
Tools: Linear, GitHub, Notion

## Education

Bachelor of Science in Computer Science · University of California Berkeley · 2019`;

export const FIXTURE_RESUMES: RAResumeVariant[] = [
  {
    id: 'cm_rv_base',
    userId: 'cm_user_demo',
    name: 'Master Resume',
    kind: 'base',
    targetJobId: null,
    basedOnVariantId: null,
    templateKey: null,
    resumeMarkdown: BASE_RESUME_MD,
    resumeContentHash: 'sha256:8f1c4e2a',
    matchScoreCached: null,
    isPrimary: true,
    sourceKind: 'upload',
    lastEditedAt: '2026-05-22T19:00:00.000Z',
    createdAt: '2026-04-30T08:00:00.000Z',
    deletedAt: null,
  },
  {
    id: 'cm_rv_anthropic',
    userId: 'cm_user_demo',
    name: 'For Anthropic — Claude Platform AI Engineer',
    kind: 'tailored_for_jd',
    targetJobId: 'cm_job_anthropic_ai',
    basedOnVariantId: 'cm_rv_base',
    templateKey: null,
    resumeMarkdown: TAILORED_ANTHROPIC_MD,
    resumeContentHash: 'sha256:b22a9f1d',
    matchScoreCached: 91,
    lastEditedAt: '2026-05-23T11:00:00.000Z',
    createdAt: '2026-05-22T20:00:00.000Z',
    deletedAt: null,
  },
  {
    id: 'cm_rv_ats',
    userId: 'cm_user_demo',
    name: 'ATS-Friendly',
    kind: 'from_template',
    targetJobId: null,
    basedOnVariantId: null,
    templateKey: 'ats-clean-2026',
    resumeMarkdown: ATS_TEMPLATE_MD,
    resumeContentHash: 'sha256:9d4f1a3c',
    matchScoreCached: null,
    lastEditedAt: '2026-05-18T16:00:00.000Z',
    createdAt: '2026-05-15T14:00:00.000Z',
    deletedAt: null,
  },
];
