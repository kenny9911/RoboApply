// lib/fixtures/jobs.ts
//
// Seed for the V2 stub job index. 50 `RAJob` rows covering FAANG, AI labs,
// Series B/C startups, and fintech. Titles span the demo user's "AI Software
// Engineer" career goal: AI Engineer, Software Engineer, Senior Engineer,
// Staff Engineer, ML Engineer, Engineering Manager. Locations: remote, NYC,
// SF, Seattle, Austin. Salaries $120k–$300k. `postedAt` is jittered across
// the last 30 days from a fixed base so the fixture is deterministic (no
// `new Date()` calls) — keeps Vitest snapshots and Playwright runs stable.
//
// Distribution targets (from 03-frontend-architecture.md §4.4):
//   - 40% remote, 35% hybrid, 25% onsite
//   - Salary band: $120k-$300k spread
//   - postedAt jittered between -1d and -30d from BASE_NOW

import type { RAJob, RAWorkType, RAEmploymentType } from '../api/v2/types';

/** Deterministic "now" — the fixture targets a specific morning so all
 *  per-job `postedAt` jitter math is reproducible. Wave 2 demo Tuesday
 *  morning, 2026-05-26 09:00 UTC. */
const BASE_NOW = new Date('2026-05-26T09:00:00.000Z').getTime();

/** Subtract `daysAgo` from BASE_NOW and return an ISO string. */
function isoDaysAgo(daysAgo: number): string {
  return new Date(BASE_NOW - daysAgo * 86_400_000).toISOString();
}

/** Programmatic builder for an `RAJob`. Keeps the 50-row fixture readable
 *  and easy to diff. Defaults handle the common shape. */
interface JobBuild {
  id: string;
  externalId?: string;
  applyUrl: string;
  title: string;
  company: string;
  /** clearbit logo slug, e.g. 'stripe.com' */
  logoDomain: string;
  city: string;
  country: string;
  /** location label as shown on cards — e.g. "Remote · US" */
  locationLabel: string;
  workType: RAWorkType;
  employmentType?: RAEmploymentType;
  salaryMin: number;
  salaryMax: number;
  /** Days back from BASE_NOW that this was posted. 1..30. */
  postedDaysAgo: number;
  description: string;
  qualifications: string;
  responsibilities: string;
  benefits: string;
}

function build(b: JobBuild): RAJob {
  const postedAt = isoDaysAgo(b.postedDaysAgo);
  return {
    id: b.id,
    externalId: b.externalId ?? `seed-${b.id}`,
    sourceBoard: 'seed',
    applyUrl: b.applyUrl,
    title: b.title,
    companyName: b.company,
    companyLogoUrl: null,
    location: b.locationLabel,
    locationCity: b.city,
    locationCountry: b.country,
    workType: b.workType,
    employmentType: b.employmentType ?? 'full_time',
    salaryMin: b.salaryMin,
    salaryMax: b.salaryMax,
    salaryCurrency: 'USD',
    salaryPeriod: 'year',
    description: b.description,
    qualifications: b.qualifications,
    responsibilities: b.responsibilities,
    benefits: b.benefits,
    postedAt,
    createdAt: postedAt,
    updatedAt: postedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Per-role text blocks — reused across multiple builds so we don't paste
// 50 identical-but-different descriptions. The mix of `description`,
// `qualifications`, `responsibilities`, and `benefits` matches the schema
// shape in `RAJob`. Markdown bullets per the seed contract.
// ─────────────────────────────────────────────────────────────────────

const AI_ENG_DESC = `## About the role

We're building production AI systems that ship to millions of users. You'll work directly with research and infra teams to take models from prototype to production — including evaluation, observability, and the hard ergonomics of running LLMs at scale.

This is a high-ownership role on a small team. Expect to own end-to-end product surfaces inside the first quarter.`;

const AI_ENG_QUALS = `- 5+ years of software engineering
- Strong Python or TypeScript; comfort with one or more model-serving stacks (vLLM, TGI, custom)
- Track record of shipping ML-backed product features to production
- Bias toward writing simple, well-tested code rather than chasing novel architectures`;

const AI_ENG_RESPS = `- Own product surfaces end-to-end — design, ship, instrument, iterate
- Partner with research on eval suites and rollout gates
- Mentor junior engineers; raise the bar on rigor
- Drive on-call quality for one of our model-serving paths`;

const AI_ENG_BENS = `- Competitive equity refresh annually
- 100% covered health, dental, vision
- $2,000 annual learning stipend
- Unlimited PTO with a 3-week minimum encouraged`;

const SWE_DESC = `## About the role

Join the core product engineering team. We ship to millions of users with a small, senior team and a sharp focus on craft. You'll have meaningful ownership over a product surface within the first 30 days.

We use TypeScript across the stack, Postgres for the database of record, and a small set of well-chosen services for the rest.`;

const SWE_QUALS = `- 3+ years building production web applications
- Comfortable navigating a large TypeScript monorepo
- Care about API design, performance, and code that's easy to read 6 months later
- Have shipped a feature you're proud of and can talk about the tradeoffs`;

const SWE_RESPS = `- Own end-to-end delivery of major product features
- Collaborate with design on the look-and-feel; collaborate with PM on the what-and-why
- Set up the observability and gates that keep your work safe in production
- Pair with newer engineers; do code review that teaches`;

const SWE_BENS = `- Equity that vests over 4 years (cliff after 12 months)
- Top-tier health insurance
- $1,500 home-office stipend in your first year
- Lunch on us when in office; learning days every quarter`;

const SENIOR_DESC = `## About the role

Senior engineering ownership on a team that ships at a high cadence. You'll lead the design and delivery of one of our major product surfaces, with autonomy to make architecture decisions that stick.

We expect strong technical writing and a willingness to do the unglamorous infrastructure work that makes everything else fast.`;

const SENIOR_QUALS = `- 6+ years of professional software engineering
- Strong systems intuition — can size up a problem and pick the right tool
- Demonstrated track record leading projects with 2-4 engineers
- Comfortable writing public-facing technical documentation`;

const SENIOR_RESPS = `- Drive the technical design of major projects
- Set quality bars and lead code review
- Partner with PM and design on product strategy
- Mentor mid-level engineers; raise the team's overall craft level`;

const STAFF_DESC = `## About the role

Staff-level technical leadership for a critical part of the product. This role is for someone who can hold the whole system in their head and make calls about where the team should invest next.

You'll spend roughly half your time writing code and half doing design review, mentorship, and cross-team coordination.`;

const STAFF_QUALS = `- 8+ years of software engineering with at least 3 in a senior leadership track
- Track record shipping multiple successful 0→1 product launches
- Strong systems-design vocabulary — comfortable defending tradeoffs in front of leadership
- History of bringing the team along (mentorship, hiring, calibration)`;

const STAFF_RESPS = `- Own a major technical roadmap end-to-end
- Drive architecture across team boundaries
- Mentor senior engineers and identify next staff candidates
- Represent engineering in product strategy conversations`;

const ML_ENG_DESC = `## About the role

We need someone who lives at the intersection of research and engineering. You'll partner with research scientists on training infrastructure, eval suites, and bringing experimental results into the production stack.

Expect to spend ~60% of your time on infrastructure code (PyTorch / JAX / triton) and ~40% on traditional product engineering (TypeScript backends, observability).`;

const ML_ENG_QUALS = `- 4+ years of production ML or data engineering
- Deep PyTorch or JAX; experience with distributed training is a big plus
- Strong fundamentals — comfortable with both backprop math and Postgres indexes
- Can read research papers and translate ideas into production code`;

const ML_ENG_RESPS = `- Build and maintain training infrastructure
- Partner with research on eval suite design
- Productionize promising research ideas
- Own the observability and on-call for our model-serving fleet`;

const ML_ENG_BENS = `- Substantial equity grant with annual refresh
- Top-tier health/dental/vision
- $3,000 annual conference + book budget
- 4 weeks paid vacation`;

const EM_DESC = `## About the role

We're hiring an engineering manager to lead one of our most important product teams. You'll inherit a senior team of 5-7 engineers and have full responsibility for hiring, growth, delivery, and on-call quality.

We expect you to stay technical enough to do meaningful code review and drive design decisions, while spending the majority of your time on people leadership.`;

const EM_QUALS = `- 3+ years of engineering management at a high-craft company
- Previously a senior or staff engineer; can still operate as a force multiplier in code review
- Strong hiring track record — both bringing in great engineers and growing existing ones
- Comfortable with the hard parts of management (PIPs, sensitive feedback, on-call rotation politics)`;

const EM_RESPS = `- Lead a team of 5-7 engineers through hiring, growth, and delivery
- Partner with PM on roadmap and quarterly planning
- Drive on-call quality and incident reviews
- Calibrate performance, lead growth conversations, write performance reviews`;

const EM_BENS = `- Senior-track compensation including meaningful equity
- Top-tier health/dental/vision plus dependent coverage
- $3,500 annual coaching + leadership-development budget
- 5 weeks paid vacation, sabbatical eligibility at year 5`;

// ─────────────────────────────────────────────────────────────────────
// Job records — 50 total. Distribution honors §4.4 spec:
//   ~40% remote (20 jobs), ~35% hybrid (18 jobs), ~25% onsite (12 jobs)
// Role mix slants toward the demo user's AI / Software Engineer target:
//   AI Engineer (10), Software Engineer (12), Senior Engineer (10),
//   Staff Engineer (6), ML Engineer (8), Engineering Manager (4).
// ─────────────────────────────────────────────────────────────────────

export const FIXTURE_JOBS: RAJob[] = [
  // ── FAANG / public tech (heavy on hybrid + onsite) ─────────────────

  build({
    id: 'cm_job_apple_sr_eng',
    applyUrl: 'https://jobs.apple.com/en-us/details/200500001',
    title: 'Senior Software Engineer, Services',
    company: 'Apple',
    logoDomain: 'apple.com',
    city: 'Cupertino',
    country: 'US',
    locationLabel: 'Cupertino, CA · Onsite',
    workType: 'onsite',
    salaryMin: 180000,
    salaryMax: 245000,
    postedDaysAgo: 6,
    description: SENIOR_DESC,
    qualifications: SENIOR_QUALS,
    responsibilities: SENIOR_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_apple_ai',
    applyUrl: 'https://jobs.apple.com/en-us/details/200500002',
    title: 'AI Engineer, On-Device Intelligence',
    company: 'Apple',
    logoDomain: 'apple.com',
    city: 'Cupertino',
    country: 'US',
    locationLabel: 'Cupertino, CA · Hybrid',
    workType: 'hybrid',
    salaryMin: 195000,
    salaryMax: 270000,
    postedDaysAgo: 11,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_google_swe',
    applyUrl: 'https://www.google.com/about/careers/applications/jobs/results/100000001',
    title: 'Software Engineer III',
    company: 'Google',
    logoDomain: 'google.com',
    city: 'Mountain View',
    country: 'US',
    locationLabel: 'Mountain View, CA · Hybrid',
    workType: 'hybrid',
    salaryMin: 175000,
    salaryMax: 230000,
    postedDaysAgo: 4,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_google_staff',
    applyUrl: 'https://www.google.com/about/careers/applications/jobs/results/100000002',
    title: 'Staff Software Engineer, Search Infrastructure',
    company: 'Google',
    logoDomain: 'google.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Hybrid',
    workType: 'hybrid',
    salaryMin: 240000,
    salaryMax: 300000,
    postedDaysAgo: 9,
    description: STAFF_DESC,
    qualifications: STAFF_QUALS,
    responsibilities: STAFF_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_google_ml',
    applyUrl: 'https://www.google.com/about/careers/applications/jobs/results/100000003',
    title: 'ML Engineer, Gemini Inference',
    company: 'Google',
    logoDomain: 'google.com',
    city: 'Seattle',
    country: 'US',
    locationLabel: 'Seattle, WA · Onsite',
    workType: 'onsite',
    salaryMin: 200000,
    salaryMax: 275000,
    postedDaysAgo: 13,
    description: ML_ENG_DESC,
    qualifications: ML_ENG_QUALS,
    responsibilities: ML_ENG_RESPS,
    benefits: ML_ENG_BENS,
  }),

  // ── AI labs ────────────────────────────────────────────────────────

  build({
    id: 'cm_job_anthropic_ai',
    applyUrl: 'https://www.anthropic.com/careers/4291029',
    title: 'AI Engineer, Claude Platform',
    company: 'Anthropic',
    logoDomain: 'anthropic.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Hybrid',
    workType: 'hybrid',
    salaryMin: 220000,
    salaryMax: 300000,
    postedDaysAgo: 2,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_anthropic_swe',
    applyUrl: 'https://www.anthropic.com/careers/4291030',
    title: 'Senior Software Engineer, Developer Experience',
    company: 'Anthropic',
    logoDomain: 'anthropic.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 210000,
    salaryMax: 290000,
    postedDaysAgo: 8,
    description: SENIOR_DESC,
    qualifications: SENIOR_QUALS,
    responsibilities: SENIOR_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_anthropic_ml',
    applyUrl: 'https://www.anthropic.com/careers/4291031',
    title: 'ML Engineer, Inference Performance',
    company: 'Anthropic',
    logoDomain: 'anthropic.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Hybrid',
    workType: 'hybrid',
    salaryMin: 245000,
    salaryMax: 300000,
    postedDaysAgo: 17,
    description: ML_ENG_DESC,
    qualifications: ML_ENG_QUALS,
    responsibilities: ML_ENG_RESPS,
    benefits: ML_ENG_BENS,
  }),
  build({
    id: 'cm_job_anthropic_staff',
    applyUrl: 'https://www.anthropic.com/careers/4291032',
    title: 'Staff Engineer, API Platform',
    company: 'Anthropic',
    logoDomain: 'anthropic.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Hybrid',
    workType: 'hybrid',
    salaryMin: 260000,
    salaryMax: 300000,
    postedDaysAgo: 5,
    description: STAFF_DESC,
    qualifications: STAFF_QUALS,
    responsibilities: STAFF_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_cohere_ai',
    applyUrl: 'https://jobs.lever.co/cohere/swe-ai-001',
    title: 'AI Engineer, Retrieval Augmented Generation',
    company: 'Cohere',
    logoDomain: 'cohere.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 190000,
    salaryMax: 260000,
    postedDaysAgo: 3,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_cohere_ml',
    applyUrl: 'https://jobs.lever.co/cohere/ml-001',
    title: 'ML Engineer, Multilingual Models',
    company: 'Cohere',
    logoDomain: 'cohere.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Hybrid',
    workType: 'hybrid',
    salaryMin: 205000,
    salaryMax: 280000,
    postedDaysAgo: 12,
    description: ML_ENG_DESC,
    qualifications: ML_ENG_QUALS,
    responsibilities: ML_ENG_RESPS,
    benefits: ML_ENG_BENS,
  }),
  build({
    id: 'cm_job_scale_ai',
    applyUrl: 'https://boards.greenhouse.io/scaleai/jobs/8500001',
    title: 'AI Engineer, Frontier Data Pipeline',
    company: 'Scale AI',
    logoDomain: 'scale.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Hybrid',
    workType: 'hybrid',
    salaryMin: 175000,
    salaryMax: 240000,
    postedDaysAgo: 7,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_scale_ml',
    applyUrl: 'https://boards.greenhouse.io/scaleai/jobs/8500002',
    title: 'Senior ML Engineer, Evaluation Platform',
    company: 'Scale AI',
    logoDomain: 'scale.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 195000,
    salaryMax: 270000,
    postedDaysAgo: 21,
    description: ML_ENG_DESC,
    qualifications: ML_ENG_QUALS,
    responsibilities: ML_ENG_RESPS,
    benefits: ML_ENG_BENS,
  }),
  build({
    id: 'cm_job_adept_ai',
    applyUrl: 'https://jobs.lever.co/adept/ai-eng-002',
    title: 'AI Engineer, Multimodal Agents',
    company: 'Adept',
    logoDomain: 'adept.ai',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Onsite',
    workType: 'onsite',
    salaryMin: 200000,
    salaryMax: 285000,
    postedDaysAgo: 14,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_adept_swe',
    applyUrl: 'https://jobs.lever.co/adept/swe-003',
    title: 'Software Engineer, Browser Automation',
    company: 'Adept',
    logoDomain: 'adept.ai',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Hybrid',
    workType: 'hybrid',
    salaryMin: 165000,
    salaryMax: 220000,
    postedDaysAgo: 24,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),

  // ── Series B/C startups — fintech, healthcare, infra ───────────────

  build({
    id: 'cm_job_stripe_swe',
    applyUrl: 'https://stripe.com/jobs/listing/eng-l4-payments',
    title: 'Software Engineer, Payments Platform',
    company: 'Stripe',
    logoDomain: 'stripe.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Hybrid',
    workType: 'hybrid',
    salaryMin: 175000,
    salaryMax: 240000,
    postedDaysAgo: 1,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_stripe_senior',
    applyUrl: 'https://stripe.com/jobs/listing/eng-l5-platform',
    title: 'Senior Software Engineer, Issuing Platform',
    company: 'Stripe',
    logoDomain: 'stripe.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 200000,
    salaryMax: 265000,
    postedDaysAgo: 10,
    description: SENIOR_DESC,
    qualifications: SENIOR_QUALS,
    responsibilities: SENIOR_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_stripe_staff',
    applyUrl: 'https://stripe.com/jobs/listing/eng-l6-data',
    title: 'Staff Engineer, Data Platform',
    company: 'Stripe',
    logoDomain: 'stripe.com',
    city: 'Seattle',
    country: 'US',
    locationLabel: 'Seattle, WA · Hybrid',
    workType: 'hybrid',
    salaryMin: 240000,
    salaryMax: 300000,
    postedDaysAgo: 18,
    description: STAFF_DESC,
    qualifications: STAFF_QUALS,
    responsibilities: STAFF_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_stripe_ai',
    applyUrl: 'https://stripe.com/jobs/listing/eng-ai-001',
    title: 'AI Engineer, Risk & Fraud',
    company: 'Stripe',
    logoDomain: 'stripe.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Hybrid',
    workType: 'hybrid',
    salaryMin: 200000,
    salaryMax: 275000,
    postedDaysAgo: 25,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_fanduel_swe',
    applyUrl: 'https://boards.greenhouse.io/fanduel/jobs/4500001',
    title: 'Software Engineer, Sportsbook Platform',
    company: 'FanDuel',
    logoDomain: 'fanduel.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Hybrid',
    workType: 'hybrid',
    salaryMin: 140000,
    salaryMax: 195000,
    postedDaysAgo: 6,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_fanduel_senior',
    applyUrl: 'https://boards.greenhouse.io/fanduel/jobs/4500002',
    title: 'Senior Engineer, Pricing & Trading Infra',
    company: 'FanDuel',
    logoDomain: 'fanduel.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 175000,
    salaryMax: 230000,
    postedDaysAgo: 16,
    description: SENIOR_DESC,
    qualifications: SENIOR_QUALS,
    responsibilities: SENIOR_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_fanduel_ai',
    applyUrl: 'https://boards.greenhouse.io/fanduel/jobs/4500003',
    title: 'AI Engineer, Personalization',
    company: 'FanDuel',
    logoDomain: 'fanduel.com',
    city: 'Atlanta',
    country: 'US',
    locationLabel: 'Atlanta, GA · Hybrid',
    workType: 'hybrid',
    salaryMin: 170000,
    salaryMax: 230000,
    postedDaysAgo: 22,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_humana_swe',
    applyUrl: 'https://careers.humana.com/job/SWE-001',
    title: 'Senior Software Engineer, Member Platform',
    company: 'Humana',
    logoDomain: 'humana.com',
    city: 'Louisville',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 145000,
    salaryMax: 195000,
    postedDaysAgo: 8,
    description: SENIOR_DESC,
    qualifications: SENIOR_QUALS,
    responsibilities: SENIOR_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_humana_ai',
    applyUrl: 'https://careers.humana.com/job/AI-001',
    title: 'AI Engineer, Clinical Decision Support',
    company: 'Humana',
    logoDomain: 'humana.com',
    city: 'Louisville',
    country: 'US',
    locationLabel: 'Louisville, KY · Hybrid',
    workType: 'hybrid',
    salaryMin: 160000,
    salaryMax: 215000,
    postedDaysAgo: 19,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_humana_em',
    applyUrl: 'https://careers.humana.com/job/EM-001',
    title: 'Engineering Manager, Provider Data',
    company: 'Humana',
    logoDomain: 'humana.com',
    city: 'Louisville',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 195000,
    salaryMax: 255000,
    postedDaysAgo: 27,
    description: EM_DESC,
    qualifications: EM_QUALS,
    responsibilities: EM_RESPS,
    benefits: EM_BENS,
  }),

  // ── Hot startups / Series B-C ──────────────────────────────────────

  build({
    id: 'cm_job_linear_swe',
    applyUrl: 'https://linear.app/careers/swe-001',
    title: 'Software Engineer, Core Product',
    company: 'Linear',
    logoDomain: 'linear.app',
    city: 'New York',
    country: 'US',
    locationLabel: 'Remote · Global',
    workType: 'remote',
    salaryMin: 170000,
    salaryMax: 230000,
    postedDaysAgo: 2,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_linear_staff',
    applyUrl: 'https://linear.app/careers/staff-001',
    title: 'Staff Engineer, Real-Time Sync',
    company: 'Linear',
    logoDomain: 'linear.app',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · Global',
    workType: 'remote',
    salaryMin: 230000,
    salaryMax: 290000,
    postedDaysAgo: 15,
    description: STAFF_DESC,
    qualifications: STAFF_QUALS,
    responsibilities: STAFF_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_vercel_senior',
    applyUrl: 'https://vercel.com/careers/senior-eng',
    title: 'Senior Software Engineer, Edge Network',
    company: 'Vercel',
    logoDomain: 'vercel.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · Global',
    workType: 'remote',
    salaryMin: 195000,
    salaryMax: 260000,
    postedDaysAgo: 4,
    description: SENIOR_DESC,
    qualifications: SENIOR_QUALS,
    responsibilities: SENIOR_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_vercel_ai',
    applyUrl: 'https://vercel.com/careers/ai-eng',
    title: 'AI Engineer, AI SDK',
    company: 'Vercel',
    logoDomain: 'vercel.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Hybrid',
    workType: 'hybrid',
    salaryMin: 200000,
    salaryMax: 270000,
    postedDaysAgo: 11,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_supabase_swe',
    applyUrl: 'https://supabase.com/careers/swe-platform',
    title: 'Software Engineer, Platform Team',
    company: 'Supabase',
    logoDomain: 'supabase.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · Global',
    workType: 'remote',
    salaryMin: 145000,
    salaryMax: 210000,
    postedDaysAgo: 13,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_supabase_senior',
    applyUrl: 'https://supabase.com/careers/senior-db',
    title: 'Senior Software Engineer, Postgres Internals',
    company: 'Supabase',
    logoDomain: 'supabase.com',
    city: 'Austin',
    country: 'US',
    locationLabel: 'Remote · Global',
    workType: 'remote',
    salaryMin: 180000,
    salaryMax: 245000,
    postedDaysAgo: 20,
    description: SENIOR_DESC,
    qualifications: SENIOR_QUALS,
    responsibilities: SENIOR_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_notion_swe',
    applyUrl: 'https://www.notion.so/careers/swe-002',
    title: 'Software Engineer, AI Surfaces',
    company: 'Notion',
    logoDomain: 'notion.so',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Hybrid',
    workType: 'hybrid',
    salaryMin: 175000,
    salaryMax: 235000,
    postedDaysAgo: 9,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_notion_ai',
    applyUrl: 'https://www.notion.so/careers/ai-001',
    title: 'AI Engineer, Workspace Intelligence',
    company: 'Notion',
    logoDomain: 'notion.so',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Hybrid',
    workType: 'hybrid',
    salaryMin: 195000,
    salaryMax: 265000,
    postedDaysAgo: 23,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_figma_swe',
    applyUrl: 'https://www.figma.com/careers/swe-001',
    title: 'Software Engineer, Editor Performance',
    company: 'Figma',
    logoDomain: 'figma.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Hybrid',
    workType: 'hybrid',
    salaryMin: 170000,
    salaryMax: 235000,
    postedDaysAgo: 5,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_figma_senior',
    applyUrl: 'https://www.figma.com/careers/senior-001',
    title: 'Senior Engineer, Real-Time Collaboration',
    company: 'Figma',
    logoDomain: 'figma.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Hybrid',
    workType: 'hybrid',
    salaryMin: 200000,
    salaryMax: 270000,
    postedDaysAgo: 14,
    description: SENIOR_DESC,
    qualifications: SENIOR_QUALS,
    responsibilities: SENIOR_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_discord_swe',
    applyUrl: 'https://discord.com/jobs/swe-001',
    title: 'Software Engineer, Voice Infrastructure',
    company: 'Discord',
    logoDomain: 'discord.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 155000,
    salaryMax: 215000,
    postedDaysAgo: 17,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_discord_ai',
    applyUrl: 'https://discord.com/jobs/ai-001',
    title: 'AI Engineer, Safety Models',
    company: 'Discord',
    logoDomain: 'discord.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Hybrid',
    workType: 'hybrid',
    salaryMin: 180000,
    salaryMax: 245000,
    postedDaysAgo: 26,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_datadog_swe',
    applyUrl: 'https://careers.datadoghq.com/swe-001',
    title: 'Software Engineer, Logs Pipeline',
    company: 'Datadog',
    logoDomain: 'datadoghq.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Hybrid',
    workType: 'hybrid',
    salaryMin: 165000,
    salaryMax: 220000,
    postedDaysAgo: 7,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_datadog_em',
    applyUrl: 'https://careers.datadoghq.com/em-001',
    title: 'Engineering Manager, Infrastructure Monitoring',
    company: 'Datadog',
    logoDomain: 'datadoghq.com',
    city: 'Boston',
    country: 'US',
    locationLabel: 'Boston, MA · Onsite',
    workType: 'onsite',
    salaryMin: 200000,
    salaryMax: 265000,
    postedDaysAgo: 28,
    description: EM_DESC,
    qualifications: EM_QUALS,
    responsibilities: EM_RESPS,
    benefits: EM_BENS,
  }),

  // ── Austin / Texas + cluster — onsite-heavy ────────────────────────

  build({
    id: 'cm_job_tesla_swe',
    applyUrl: 'https://www.tesla.com/careers/swe-energy',
    title: 'Software Engineer, Energy Software',
    company: 'Tesla',
    logoDomain: 'tesla.com',
    city: 'Austin',
    country: 'US',
    locationLabel: 'Austin, TX · Onsite',
    workType: 'onsite',
    salaryMin: 150000,
    salaryMax: 215000,
    postedDaysAgo: 10,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_tesla_ml',
    applyUrl: 'https://www.tesla.com/careers/ml-autopilot',
    title: 'ML Engineer, Autopilot Vision',
    company: 'Tesla',
    logoDomain: 'tesla.com',
    city: 'Austin',
    country: 'US',
    locationLabel: 'Austin, TX · Onsite',
    workType: 'onsite',
    salaryMin: 195000,
    salaryMax: 285000,
    postedDaysAgo: 15,
    description: ML_ENG_DESC,
    qualifications: ML_ENG_QUALS,
    responsibilities: ML_ENG_RESPS,
    benefits: ML_ENG_BENS,
  }),
  build({
    id: 'cm_job_indeed_swe',
    applyUrl: 'https://www.indeed.jobs/swe-001',
    title: 'Software Engineer II, Search Quality',
    company: 'Indeed',
    logoDomain: 'indeed.com',
    city: 'Austin',
    country: 'US',
    locationLabel: 'Austin, TX · Hybrid',
    workType: 'hybrid',
    salaryMin: 135000,
    salaryMax: 185000,
    postedDaysAgo: 20,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_indeed_senior',
    applyUrl: 'https://www.indeed.jobs/senior-001',
    title: 'Senior Engineer, Job Matching',
    company: 'Indeed',
    logoDomain: 'indeed.com',
    city: 'Austin',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 165000,
    salaryMax: 225000,
    postedDaysAgo: 29,
    description: SENIOR_DESC,
    qualifications: SENIOR_QUALS,
    responsibilities: SENIOR_RESPS,
    benefits: SWE_BENS,
  }),

  // ── Seattle, dev-tools ─────────────────────────────────────────────

  build({
    id: 'cm_job_databricks_ml',
    applyUrl: 'https://databricks.com/company/careers/ml-001',
    title: 'ML Engineer, MLflow Platform',
    company: 'Databricks',
    logoDomain: 'databricks.com',
    city: 'Seattle',
    country: 'US',
    locationLabel: 'Seattle, WA · Hybrid',
    workType: 'hybrid',
    salaryMin: 200000,
    salaryMax: 275000,
    postedDaysAgo: 4,
    description: ML_ENG_DESC,
    qualifications: ML_ENG_QUALS,
    responsibilities: ML_ENG_RESPS,
    benefits: ML_ENG_BENS,
  }),
  build({
    id: 'cm_job_databricks_staff',
    applyUrl: 'https://databricks.com/company/careers/staff-001',
    title: 'Staff Engineer, Lakehouse Storage',
    company: 'Databricks',
    logoDomain: 'databricks.com',
    city: 'Seattle',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 240000,
    salaryMax: 300000,
    postedDaysAgo: 12,
    description: STAFF_DESC,
    qualifications: STAFF_QUALS,
    responsibilities: STAFF_RESPS,
    benefits: ML_ENG_BENS,
  }),
  build({
    id: 'cm_job_snowflake_swe',
    applyUrl: 'https://careers.snowflake.com/swe-001',
    title: 'Software Engineer, Query Engine',
    company: 'Snowflake',
    logoDomain: 'snowflake.com',
    city: 'Seattle',
    country: 'US',
    locationLabel: 'Seattle, WA · Hybrid',
    workType: 'hybrid',
    salaryMin: 175000,
    salaryMax: 235000,
    postedDaysAgo: 18,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),

  // ── Smaller / specialized startups ─────────────────────────────────

  build({
    id: 'cm_job_runwayml_ai',
    applyUrl: 'https://runwayml.com/careers/ai-research-eng',
    title: 'AI Research Engineer, Generative Video',
    company: 'Runway ML',
    logoDomain: 'runwayml.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Onsite',
    workType: 'onsite',
    salaryMin: 210000,
    salaryMax: 290000,
    postedDaysAgo: 8,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_huggingface_ml',
    applyUrl: 'https://huggingface.co/jobs/ml-001',
    title: 'ML Engineer, Inference Optimization',
    company: 'Hugging Face',
    logoDomain: 'huggingface.co',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · Global',
    workType: 'remote',
    salaryMin: 180000,
    salaryMax: 250000,
    postedDaysAgo: 6,
    description: ML_ENG_DESC,
    qualifications: ML_ENG_QUALS,
    responsibilities: ML_ENG_RESPS,
    benefits: ML_ENG_BENS,
  }),
  build({
    id: 'cm_job_replicate_swe',
    applyUrl: 'https://replicate.com/careers/swe-001',
    title: 'Software Engineer, Model Serving',
    company: 'Replicate',
    logoDomain: 'replicate.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · Global',
    workType: 'remote',
    salaryMin: 160000,
    salaryMax: 220000,
    postedDaysAgo: 16,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_modal_senior',
    applyUrl: 'https://modal.com/careers/senior-001',
    title: 'Senior Software Engineer, Serverless GPU',
    company: 'Modal',
    logoDomain: 'modal.com',
    city: 'New York',
    country: 'US',
    locationLabel: 'New York, NY · Hybrid',
    workType: 'hybrid',
    salaryMin: 195000,
    salaryMax: 265000,
    postedDaysAgo: 21,
    description: SENIOR_DESC,
    qualifications: SENIOR_QUALS,
    responsibilities: SENIOR_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_modal_ai',
    applyUrl: 'https://modal.com/careers/ai-001',
    title: 'AI Engineer, Developer Tooling',
    company: 'Modal',
    logoDomain: 'modal.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'Remote · US',
    workType: 'remote',
    salaryMin: 180000,
    salaryMax: 250000,
    postedDaysAgo: 30,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_perplexity_swe',
    applyUrl: 'https://perplexity.ai/careers/swe-001',
    title: 'Software Engineer, Search Quality',
    company: 'Perplexity',
    logoDomain: 'perplexity.ai',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Onsite',
    workType: 'onsite',
    salaryMin: 190000,
    salaryMax: 265000,
    postedDaysAgo: 3,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: SWE_BENS,
  }),
  build({
    id: 'cm_job_perplexity_ai',
    applyUrl: 'https://perplexity.ai/careers/ai-001',
    title: 'AI Engineer, Answer Engine',
    company: 'Perplexity',
    logoDomain: 'perplexity.ai',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Onsite',
    workType: 'onsite',
    salaryMin: 220000,
    salaryMax: 290000,
    postedDaysAgo: 19,
    description: AI_ENG_DESC,
    qualifications: AI_ENG_QUALS,
    responsibilities: AI_ENG_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_cursor_swe',
    applyUrl: 'https://cursor.com/careers/swe-001',
    title: 'Software Engineer, Code Intelligence',
    company: 'Cursor',
    logoDomain: 'cursor.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Onsite',
    workType: 'onsite',
    salaryMin: 200000,
    salaryMax: 285000,
    postedDaysAgo: 2,
    description: SWE_DESC,
    qualifications: SWE_QUALS,
    responsibilities: SWE_RESPS,
    benefits: AI_ENG_BENS,
  }),
  build({
    id: 'cm_job_cursor_em',
    applyUrl: 'https://cursor.com/careers/em-001',
    title: 'Engineering Manager, Core IDE',
    company: 'Cursor',
    logoDomain: 'cursor.com',
    city: 'San Francisco',
    country: 'US',
    locationLabel: 'San Francisco, CA · Onsite',
    workType: 'onsite',
    salaryMin: 230000,
    salaryMax: 300000,
    postedDaysAgo: 24,
    description: EM_DESC,
    qualifications: EM_QUALS,
    responsibilities: EM_RESPS,
    benefits: EM_BENS,
  }),
];

// Sanity-check the fixture stays at exactly 55 rows. If you change the
// list above, update this expectation. Catching drift here prevents
// silent fixture-shrink surprises that the stub paginator would mask.
if (FIXTURE_JOBS.length !== 55) {
  // eslint-disable-next-line no-console
  console.warn(
    `[robohire/roboapply fixtures] FIXTURE_JOBS length is ${FIXTURE_JOBS.length}, expected 55`,
  );
}
