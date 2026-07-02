// lib/mockInterview/tracks.ts
//
// 6 role categories covering the 124 most-asked-about tracks. The setup
// page uses these for the role picker — searchable across the whole set
// or filterable by category.
//
// Each track is just a string; the AI session uses the track name to seed
// the question generator (existing fixtures handle the popular ones,
// everything else flows through `makeMockFromTopic` at session creation).

export type TrackCategory = 'eng' | 'product' | 'design' | 'data' | 'gtm' | 'ops';

export const CATEGORY_LABEL: Record<TrackCategory, string> = {
  eng:     'Engineering',
  product: 'Product',
  design:  'Design',
  data:    'Data',
  gtm:     'GTM',
  ops:     'Operations',
};

export const CATEGORY_EMOJI: Record<TrackCategory, string> = {
  eng:     '⚙️',
  product: '🧭',
  design:  '🎨',
  data:    '📊',
  gtm:     '🚀',
  ops:     '🏛',
};

export interface Track {
  id: string;
  category: TrackCategory;
  title: string;
  /** A short pitch — keywords the AI uses to flavor the questions. */
  pitch: string;
}

function mk(category: TrackCategory, title: string, pitch: string): Track {
  const id = `tr_${title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
  return { id, category, title, pitch };
}

// ─── Engineering (35) ────────────────────────────────────────────────
const ENG: Track[] = [
  mk('eng', 'Frontend Engineer',           'React performance, accessibility, state'),
  mk('eng', 'Backend Engineer',            'APIs, databases, distributed systems'),
  mk('eng', 'Full-Stack Engineer',         'React + Node + Postgres + ops'),
  mk('eng', 'Mobile Engineer (iOS)',       'Swift, performance, App Store'),
  mk('eng', 'Mobile Engineer (Android)',   'Kotlin, Jetpack, Play Store'),
  mk('eng', 'React Native Engineer',       'cross-platform mobile + native bridge'),
  mk('eng', 'iOS — Senior',                'architecture, modules, build times'),
  mk('eng', 'DevOps Engineer',             'CI/CD, Terraform, observability'),
  mk('eng', 'SRE',                         'incident response, SLOs, on-call'),
  mk('eng', 'Platform Engineer',           'internal tooling, dev velocity'),
  mk('eng', 'Cloud Architect',             'AWS / GCP / Azure, cost, multi-region'),
  mk('eng', 'Security Engineer',           'AppSec, threat modeling, OWASP'),
  mk('eng', 'Infrastructure Engineer',     'Kubernetes, networking, scale'),
  mk('eng', 'Embedded Engineer',           'C / Rust, real-time, firmware'),
  mk('eng', 'Game Engineer',               'engines, perf, multiplayer netcode'),
  mk('eng', 'Database Engineer',           'Postgres / MySQL internals, indexing'),
  mk('eng', 'Distributed Systems Engineer','consensus, replication, CAP trade-offs'),
  mk('eng', 'Realtime Engineer',           'websockets, CRDTs, low-latency'),
  mk('eng', 'AI / ML Engineer',            'LLMs, evals, RAG, inference cost'),
  mk('eng', 'ML Infra Engineer',           'training, GPUs, model serving'),
  mk('eng', 'Compiler Engineer',           'parsers, LLVM, optimization'),
  mk('eng', 'Browser Engineer',            'rendering, V8, web platform'),
  mk('eng', 'Robotics Engineer',           'ROS, kinematics, sensor fusion'),
  mk('eng', 'Computer Vision Engineer',    'detection, segmentation, tracking'),
  mk('eng', 'NLP Engineer',                'embeddings, classification, RAG'),
  mk('eng', 'Crypto / Blockchain Engineer','EVM, gas, smart contracts, MEV'),
  mk('eng', 'API Designer',                'REST / gRPC / GraphQL trade-offs'),
  mk('eng', 'Search Engineer',             'Lucene, ranking, vectors'),
  mk('eng', 'Payments Engineer',           'idempotency, double-entry, fraud'),
  mk('eng', 'Engineering Manager — IC4',   'first-time manager, team health'),
  mk('eng', 'Engineering Manager — IC5',   'multi-team, planning, hiring'),
  mk('eng', 'Engineering Manager — IC6',   'org design, strategy, exec presence'),
  mk('eng', 'Director of Engineering',     'multi-org leadership, hiring bar'),
  mk('eng', 'Staff Engineer',              'tech strategy, multi-team influence'),
  mk('eng', 'Principal Engineer',          'company-level direction, judgment'),
];

// ─── Product (20) ────────────────────────────────────────────────────
const PRODUCT: Track[] = [
  mk('product', 'PM — B2C',                'consumer growth, retention'),
  mk('product', 'PM — B2B SaaS',           'enterprise, expansion, ICP'),
  mk('product', 'PM — Platform',           'developer tools, APIs'),
  mk('product', 'PM — Growth',             'funnels, experiments, acquisition'),
  mk('product', 'PM — Monetization',       'pricing, packaging, revenue'),
  mk('product', 'PM — AI / ML',            'eval, prompt, productizing models'),
  mk('product', 'PM — Marketplace',        'two-sided, supply / demand'),
  mk('product', 'PM — Mobile',             'app store, lifecycle, OS constraints'),
  mk('product', 'PM — Enterprise',         'long cycles, security, integrations'),
  mk('product', 'PM — Fintech',            'compliance, money movement, risk'),
  mk('product', 'PM — Developer Tools',    'DX, docs, time-to-first-success'),
  mk('product', 'PM — Search & Discovery', 'ranking, relevance, taste'),
  mk('product', 'PM — Internal Tools',     'process, scale, eng partnership'),
  mk('product', 'PM — Trust & Safety',     'policy, abuse, escalation'),
  mk('product', 'Senior PM',               'strategy, prioritisation, exec comms'),
  mk('product', 'Group PM',                'multi-PM team, planning'),
  mk('product', 'Director of Product',     'org, strategy, board'),
  mk('product', 'Head of Product',         'company vision, IPO-ready'),
  mk('product', 'Associate PM',            'craft, scoping, partnership'),
  mk('product', 'Founder / 0-to-1 PM',     'speed, conviction, scarcity'),
];

// ─── Design (16) ─────────────────────────────────────────────────────
const DESIGN: Track[] = [
  mk('design', 'Product Designer',         'craft, research, ship'),
  mk('design', 'Senior Product Designer',  'IA, systems, partnership'),
  mk('design', 'Staff Product Designer',   'strategy, vision, mentorship'),
  mk('design', 'UX Researcher',            'methods, synthesis, influence'),
  mk('design', 'Visual Designer',          'composition, typography, brand'),
  mk('design', 'Brand Designer',           'identity, story, marketing'),
  mk('design', 'Motion Designer',          'micro-interactions, principle'),
  mk('design', 'Design Systems Designer',  'tokens, governance, adoption'),
  mk('design', 'Marketing / Web Designer', 'landing pages, hero, conversion'),
  mk('design', 'Content Designer',         'voice, UX writing, IA'),
  mk('design', 'Industrial Designer',      'CMF, prototyping, manufacturing'),
  mk('design', '3D / AR Designer',         'spatial, lighting, depth'),
  mk('design', 'Illustration / Custom',    'craft, character, palette'),
  mk('design', 'Design Manager',           'team health, craft bar, hiring'),
  mk('design', 'Director of Design',       'multi-team, vision, exec'),
  mk('design', 'Head of Design',           'company identity, board'),
];

// ─── Data (18) ───────────────────────────────────────────────────────
const DATA: Track[] = [
  mk('data', 'Data Analyst',               'SQL, dashboards, storytelling'),
  mk('data', 'Senior Data Analyst',        'stakeholders, framing, hypothesis'),
  mk('data', 'Data Scientist',             'experimentation, modeling, causality'),
  mk('data', 'ML Engineer',                'training, evals, serving'),
  mk('data', 'Applied Scientist',          'research → product, papers'),
  mk('data', 'Research Scientist',         'novel methods, publication'),
  mk('data', 'Data Engineer',              'pipelines, warehouses, governance'),
  mk('data', 'Analytics Engineer',         'dbt, semantic layer, models'),
  mk('data', 'BI Engineer',                'dashboards, governance, self-serve'),
  mk('data', 'Decision Scientist',         'frameworks, business judgment'),
  mk('data', 'Quant Analyst (Finance)',    'risk, models, alpha'),
  mk('data', 'Marketing Analyst',          'attribution, MMM, channel mix'),
  mk('data', 'Product Analyst',            'experimentation, funnels, north star'),
  mk('data', 'Growth Analyst',             'cohorts, retention, virality'),
  mk('data', 'Forecasting Analyst',        'time series, planning, FP&A'),
  mk('data', 'Data Manager',               'team, bar, infra strategy'),
  mk('data', 'Director of Data',           'org, roadmap, partnership'),
  mk('data', 'Head of Data',               'company strategy, board'),
];

// ─── GTM (17) ────────────────────────────────────────────────────────
const GTM: Track[] = [
  mk('gtm', 'Growth Marketer',             'acquisition, activation, retention'),
  mk('gtm', 'Brand Marketer',              'narrative, positioning, voice'),
  mk('gtm', 'Product Marketer (PMM)',      'launches, positioning, sales enablement'),
  mk('gtm', 'Content Marketer',            'SEO, distribution, narrative'),
  mk('gtm', 'Lifecycle Marketer',          'CRM, segmentation, churn'),
  mk('gtm', 'Performance Marketer',        'paid, attribution, LTV/CAC'),
  mk('gtm', 'Demand Gen',                  'pipeline, MQL, ABM'),
  mk('gtm', 'Field Marketing',             'events, regions, partner co-marketing'),
  mk('gtm', 'Account Executive — SMB',     'velocity, qualifying, closing'),
  mk('gtm', 'Account Executive — Mid-Market', 'multi-thread, MEDDIC'),
  mk('gtm', 'Account Executive — Enterprise', 'champion, ROI story, procurement'),
  mk('gtm', 'Sales Engineer / Solutions',  'discovery, demo, technical depth'),
  mk('gtm', 'Customer Success Manager',    'health, expansion, renewals'),
  mk('gtm', 'Customer Support — Senior',   'empathy, technical debug, voice'),
  mk('gtm', 'Partnerships Manager',        'BD, contracts, multi-thread'),
  mk('gtm', 'Sales Director',              'team, planning, methodology'),
  mk('gtm', 'VP of Sales',                 'org, forecast, exec presence'),
];

// ─── Ops (18) ────────────────────────────────────────────────────────
const OPS: Track[] = [
  mk('ops', 'Recruiter (Tech)',            'sourcing, calibration, closing'),
  mk('ops', 'Recruiter (GTM)',             'rev hiring, brand pitch'),
  mk('ops', 'Recruiting Coordinator',      'logistics, candidate experience'),
  mk('ops', 'HR Business Partner',         'employee relations, perf cycles'),
  mk('ops', 'Talent Manager',              'leveling, calibration, growth'),
  mk('ops', 'People Operations',           'systems, policy, scale'),
  mk('ops', 'Compensation Analyst',        'bands, benchmarking, equity'),
  mk('ops', 'Finance Analyst',             'modeling, planning, board prep'),
  mk('ops', 'FP&A Lead',                   'three-statement, scenarios'),
  mk('ops', 'Controller',                  'close, audit, compliance'),
  mk('ops', 'Strategy / Chief of Staff',   'narrative, planning, exec'),
  mk('ops', 'Program Manager',             'cross-team, dependencies, comms'),
  mk('ops', 'Project Manager',             'scope, schedule, risk'),
  mk('ops', 'Operations Manager',          'process, throughput, vendors'),
  mk('ops', 'Legal / Counsel',             'contracts, IP, privacy'),
  mk('ops', 'Compliance / Risk',           'policy, controls, audits'),
  mk('ops', 'Office Manager / EA',         'logistics, calendar, executive support'),
  mk('ops', 'Founder / CEO',               'vision, fundraising, hiring bar'),
];

export const ALL_TRACKS: Track[] = [
  ...ENG, ...PRODUCT, ...DESIGN, ...DATA, ...GTM, ...OPS,
];

export const TRACKS_BY_CATEGORY: Record<TrackCategory, Track[]> = {
  eng: ENG, product: PRODUCT, design: DESIGN, data: DATA, gtm: GTM, ops: OPS,
};

export const POPULAR_TRACKS = [
  'tr_senior_pm',
  'tr_full_stack_engineer',
  'tr_ai_ml_engineer',
  'tr_product_designer',
  'tr_data_scientist',
  'tr_account_executive_mid_market',
];
