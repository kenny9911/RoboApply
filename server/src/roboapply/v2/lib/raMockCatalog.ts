// backend/src/roboapply/v2/lib/raMockCatalog.ts
//
// The STATIC mock-interview setup catalog. Transcribed verbatim from the V3
// prototype's `INTERVIEWERS` / `INTERVIEW_TYPES` / `ROLE_CATEGORIES`
// (RoboApply_V3/data.jsx) — and kept byte-identical to the frontend fixture
// `roboapply/lib/fixtures/mockCatalog.ts` so `mock.catalog()` round-trips
// against `MockCatalogResponse` with no change to the contract.
//
// `mock.catalog` returns RA_MOCK_CATALOG as-is. RAMockService also reads the
// interviewer + type lists here to:
//   - validate `start({ interviewerId, typeId })`,
//   - resolve `interviewerName` / `typeLabel` for recentSessions summaries,
//   - feed the persona/tone/difficulty + type into the interviewer agent.
//
// This file lives under v2/lib/* (allowed by the V2 import boundary) and has
// ZERO runtime imports. The wire types are mirrored locally (the same
// convention every other v2 service follows — see RAQueueService /
// RAIntegrationsService) rather than imported from the `roboapply/` Next.js
// workspace, which would break the backend's `rootDir: ./src` constraint.

// ─── Wire types (mirror roboapply/lib/api/v2/types.ts exactly) ────────────

/** The interviewing philosophy a persona embodies — drives the live prompt +
 *  grading lens in the Interview Engine. Kept ID-aligned with the engine
 *  catalog (backend/src/interview-engine/catalog/interviewArchetypes.ts). */
export type RAMockArchetype =
  | 'warmup'
  | 'behavioral'
  | 'breadth'
  | 'potential'
  | 'depth'
  | 'communication'
  | 'pressure';

export interface RAMockInterviewer {
  id: string;
  /** e.g. "Maya" */
  name: string;
  /** e.g. "The Skeptical VP" */
  role: string;
  blurb: string;
  /** 1..3 */
  difficulty: number;
  /** two-stop gradient for the orb */
  palette: [string, string];
  /** e.g. "ex-Stripe" */
  company: string;
  /** e.g. "Pointed · Adversarial · Numbers-first" */
  style: string;
  /** The interviewing philosophy this persona embodies (drives prompt + grading). */
  archetype: RAMockArchetype;
}

export interface RAMockType {
  id: string;
  label: string;
  sub: string;
  minutes: number;
  /** Role-category names this format suits, or ['All'] (drives per-role recommendations). */
  suitedRoleCategories?: string[];
}

export interface RAMockRoleCategory {
  name: string;
  accent: string;
  roles: string[];
}

export interface RAMockCatalog {
  roleCategories: RAMockRoleCategory[];
  interviewers: RAMockInterviewer[];
  types: RAMockType[];
  /** exact summed count of all listed roles (e.g. 57) */
  totalRoles: number;
}

// Ordered most-approachable → hardest. `archetype` groups personas by their
// interviewing philosophy and MUST stay ID-aligned with the engine catalog
// (backend/src/interview-engine/catalog/interviewCatalog.ts) and byte-identical
// (data-wise) to the frontend fixture roboapply/lib/fixtures/mockCatalog.ts. The
// displayed role/blurb/style/company are localized via i18n keys
// mock.setup.personas.<id>.* in InterviewerPicker; the English here is the
// source + fallback.
export const RA_MOCK_INTERVIEWERS: RAMockInterviewer[] = [
  {
    id: 'maya',
    name: 'Maya',
    role: 'The Warm Recruiter',
    blurb: 'Conversational and kind. Draws out your story with gentle follow-ups. No tricks, no pressure.',
    difficulty: 1,
    palette: ['#4ADE80', '#4ED8FF'],
    company: 'Talent Partner at a high-growth scale-up',
    style: 'Calm, unhurried pace · open-ended questions · reflective listening · encouraging · never adversarial',
    archetype: 'warmup',
  },
  {
    id: 'june',
    name: 'June',
    role: 'The Founder',
    blurb: 'Mission-obsessed and personable. Wants to know if you genuinely care — why this, why now.',
    difficulty: 2,
    palette: ['#FFB547', '#FF6B9D'],
    company: 'Founder & CEO of an early-stage startup',
    style: "Friendly and energetic · values- and motivation-first · 'why this company?' · warm but tests sincerity once",
    archetype: 'warmup',
  },
  {
    id: 'nova',
    name: 'Nova',
    role: 'The Field Surveyor',
    blurb: "Curious and fast-moving. Hops across the whole landscape — 'what else is out there?'",
    difficulty: 2,
    palette: ['#4ED8FF', '#C9FF3B'],
    company: 'Principal at a global consulting firm',
    style: 'Wide-ranging · compare-the-alternatives · trend-aware · pivots sideways, never drills',
    archetype: 'breadth',
  },
  {
    id: 'priya',
    name: 'Priya',
    role: 'The Behavioral Probe',
    blurb: 'STAR-method enforcer. "Tell me about a time…" until your story has a real action and result.',
    difficulty: 2,
    palette: ['#FF6B9D', '#8B5BFF'],
    company: 'People Lead at a large consumer brand',
    style: "Story-based · STAR enforcement · patient follow-ups · conflict & failure scenarios · separates 'we' from 'you'",
    archetype: 'behavioral',
  },
  {
    id: 'rex',
    name: 'Rex',
    role: 'The Curveball',
    blurb: "Hands you a problem you've never seen and watches how you break it down — not the answer.",
    difficulty: 2,
    palette: ['#C9FF3B', '#8B5BFF'],
    company: 'Big-tech & consulting-style interview loop',
    style: 'Lateral thinking · estimation & hypotheticals · reason-out-loud · changes one constraint mid-answer',
    archetype: 'potential',
  },
  {
    id: 'diaz',
    name: 'Marcus Diaz',
    role: 'The Hands-On Operator',
    blurb: "Calm working-manager who's done the job. Keeps asking 'what did YOU specifically do?'",
    difficulty: 2,
    palette: ['#4ADE80', '#FFB547'],
    company: 'Working Practice Lead / hands-on manager',
    style: "Even-keeled · practice-over-theory · 'one real example, step by step' · separates doers from describers",
    archetype: 'depth',
  },
  {
    id: 'atlas',
    name: 'Atlas',
    role: 'The Renaissance Architect',
    blurb: "Senior generalist who's seen every corner of the field. Maps your coverage, probes the gaps.",
    difficulty: 3,
    palette: ['#8B5BFF', '#4ED8FF'],
    company: 'Distinguished Engineer at a major tech firm',
    style: 'Breadth-first · cross-domain · landscape-mapping · exposes blank spots by jumping to the next area',
    archetype: 'breadth',
  },
  {
    id: 'bishop',
    name: 'Bishop',
    role: 'The Hiring-Bar Director',
    blurb: 'Wants the failure story, the conflict you lost, and proof you owned it — not the highlight reel.',
    difficulty: 3,
    palette: ['#8B5BFF', '#FF6B9D'],
    company: 'Hiring Director at a high-growth scale-up',
    style: "Leadership-principles · ownership-obsessed · demands failure & conflict · distrusts rehearsed answers · 'what did YOU do?'",
    archetype: 'behavioral',
  },
  {
    id: 'okonkwo',
    name: 'Dr. Okonkwo',
    role: 'The Problem Architect',
    blurb: 'Rigorous case interviewer who keeps moving the goalposts. Cares only how you think under pressure.',
    difficulty: 3,
    palette: ['#8B5BFF', '#C9FF3B'],
    company: 'Partner at a top-tier strategy firm',
    style: 'First-principles framing · structured decomposition · escalating constraints · probes assumptions · composure under ambiguity',
    archetype: 'potential',
  },
  {
    id: 'kai',
    name: 'Kai',
    role: 'The Whiteboard Veteran',
    blurb: 'Loves edge cases, digs three levels down. Wants the exact decision and the case where it broke.',
    difficulty: 3,
    palette: ['#4ED8FF', '#8B5BFF'],
    company: 'Senior Staff Engineer on a large-scale infra team',
    style: "Technical depth · quiet pauses · 'walk me through exactly what happened' · relentless on the mechanism",
    archetype: 'depth',
  },
  {
    id: 'voss',
    name: 'Dr. Voss',
    role: 'The Skeptical VP',
    blurb: 'Pushes back on every claim. Demands the metric behind the story, not the vibe.',
    difficulty: 3,
    palette: ['#FF6B9D', '#FFB547'],
    company: 'VP-level executive interviewer',
    style: "Pointed · skeptical · numbers-first · 'how do you know that?' · accepts only evidence-backed depth",
    archetype: 'depth',
  },
  {
    id: 'lena',
    name: 'Lena',
    role: 'The Clarity Coach',
    blurb: 'Cares how clearly you land the point. Will ask you to explain the hard thing simply.',
    difficulty: 2,
    palette: ['#4ED8FF', '#4ADE80'],
    company: "Comms lead who's coached hundreds of execs",
    style: "Audience-first · 'explain it like I'm new' · rewards a clean headline · catches jargon and rambling",
    archetype: 'communication',
  },
  {
    id: 'mirae',
    name: 'Mirae',
    role: 'The Rapid Panel',
    blurb: 'Jumps topics every two minutes and keeps the clock running. Can you stay sharp and adapt?',
    difficulty: 2,
    palette: ['#FFB547', '#4ED8FF'],
    company: 'Final-round panel chair at a big-tech firm',
    style: 'Fast topic-switching · time-boxed answers · high tempo · rewards adaptability and poise',
    archetype: 'pressure',
  },
  {
    id: 'osei',
    name: 'Osei',
    role: 'The Culture Steward',
    blurb: "Looks for how you treat people when it's hard. Asks for the time you put the team over the win.",
    difficulty: 2,
    palette: ['#4ADE80', '#8B5BFF'],
    company: 'Head of People at a values-driven company',
    style: "Values-in-action · collaboration and inclusion stories · 'how did the team feel?' · warm but probing",
    archetype: 'behavioral',
  },
  {
    id: 'devi',
    name: 'Devi',
    role: 'The Thought Partner',
    blurb: 'Hands you an open problem and works it WITH you. Cares how you frame and reason, not the answer.',
    difficulty: 2,
    palette: ['#C9FF3B', '#4ED8FF'],
    company: 'Product strategist who reasons out loud with you',
    style: "Collaborative reasoning · 'let's figure it out together' · nudges your framing · thinking over the right answer",
    archetype: 'potential',
  },
  {
    id: 'amara',
    name: 'Amara',
    role: 'The Market Cartographer',
    blurb: 'Sweeps across markets and disciplines, hunting for range and the connections you can draw.',
    difficulty: 3,
    palette: ['#FFB547', '#FF6B9D'],
    company: 'Growth advisor across dozens of industries',
    style: "Cross-industry · maps the whole market · 'who else does this well?' · connects ideas across domains",
    archetype: 'breadth',
  },
  {
    id: 'sterling',
    name: 'Sterling',
    role: 'The Executive Presence',
    blurb: 'Senior, exacting, unhurried. Wants the executive summary first — then the proof, crisply.',
    difficulty: 3,
    palette: ['#8B5BFF', '#4ED8FF'],
    company: 'Board-level operator at a Fortune 500',
    style: 'Formal and polished · headline-first · concise under scrutiny · tests poise and precision of language',
    archetype: 'communication',
  },
  {
    id: 'tariq',
    name: 'Tariq',
    role: 'The Pressure Tester',
    blurb: 'Pushes hard and fast, talks over you, flips your answer back. Watching whether you hold steady.',
    difficulty: 3,
    palette: ['#FF6B9D', '#8B5BFF'],
    company: 'High-stakes trading-desk interview loop',
    style: "Rapid-fire · interrupts and challenges · plays devil's advocate · tests composure, not just answers",
    archetype: 'pressure',
  },
];

export const RA_MOCK_TYPES: RAMockType[] = [
  {
    id: "screening",
    label: "Phone Screen",
    sub: "Background, fit, motivation, logistics — the gate before the loop",
    minutes: 20,
    suitedRoleCategories: ["All"],
  },
  {
    id: "behavioral",
    label: "Behavioral (STAR)",
    sub: "Real past stories: ownership, conflict, failure, influence, leadership",
    minutes: 40,
    suitedRoleCategories: ["All"],
  },
  {
    id: "technical",
    label: "Live Coding / Technical",
    sub: "Real-time problem solving in a shared editor: data structures, algorithms, correctness",
    minutes: 50,
    suitedRoleCategories: ["Engineering & DevOps","Data, AI & Analytics"],
  },
  {
    id: "system",
    label: "System / Architecture Design",
    sub: "Design a large-scale system end to end; defend scale & trade-offs",
    minutes: 55,
    suitedRoleCategories: ["Engineering & DevOps","Data, AI & Analytics","Product & Design"],
  },
  {
    id: "case",
    label: "Case / Business Problem",
    sub: "Open business problem: structure, data, recommendation",
    minutes: 40,
    suitedRoleCategories: ["Finance & Accounting","Product & Design","Marketing & Content","People, Ops & Trades","Data, AI & Analytics"],
  },
  {
    id: "culture",
    label: "Values / Culture Fit",
    sub: "Values alignment, motivation, working style, integrity under ambiguity",
    minutes: 30,
    suitedRoleCategories: ["All"],
  },
  {
    id: "panel",
    label: "Panel / Mixed Loop",
    sub: "Rapid-fire mix across competencies, as a multi-interviewer panel would",
    minutes: 35,
    suitedRoleCategories: ["All"],
  },
  {
    id: "take_home",
    label: "Take-Home Defense",
    sub: "Defend & extend a self-paced project: design choices, trade-offs, scaling",
    minutes: 45,
    suitedRoleCategories: ["Engineering & DevOps","Data, AI & Analytics","Marketing & Content"],
  },
  {
    id: "debugging",
    label: "Debugging / Code Review",
    sub: "Diagnose a broken program or critique existing code/PR",
    minutes: 45,
    suitedRoleCategories: ["Engineering & DevOps","Data, AI & Analytics"],
  },
  {
    id: "incident_sre",
    label: "Incident / SRE Scenario",
    sub: "Triage a live production incident: stabilize, command-line, post-mortem",
    minutes: 50,
    suitedRoleCategories: ["Engineering & DevOps"],
  },
  {
    id: "sql_analytics",
    label: "SQL / Analytics Exercise",
    sub: "Hands-on queries + metric reasoning against real tables",
    minutes: 50,
    suitedRoleCategories: ["Data, AI & Analytics","Finance & Accounting"],
  },
  {
    id: "product_sense",
    label: "Product Sense / Execution",
    sub: "Open product design prompt + metrics: structure, users, prioritize, measure",
    minutes: 45,
    suitedRoleCategories: ["Product & Design","Data, AI & Analytics","Marketing & Content"],
  },
  {
    id: "portfolio",
    label: "Portfolio / Past-Work Review",
    sub: "Walk through real past work: process, decisions, contribution, impact",
    minutes: 50,
    suitedRoleCategories: ["Product & Design","Marketing & Content","Engineering & DevOps","Data, AI & Analytics"],
  },
  {
    id: "design_critique",
    label: "Design Critique / Whiteboard",
    sub: "Critique an app or design live, or sketch a solution to a fresh prompt",
    minutes: 45,
    suitedRoleCategories: ["Product & Design"],
  },
  {
    id: "research_design",
    label: "UX Research Study Design",
    sub: "Design a study on the spot or critique a flawed research plan",
    minutes: 45,
    suitedRoleCategories: ["Product & Design"],
  },
  {
    id: "sales_roleplay",
    label: "Mock Sales Call / Role-Play",
    sub: "Live discovery, cold call, or escalation against a role-played counterpart",
    minutes: 30,
    suitedRoleCategories: ["Sales & Customer Success"],
  },
  {
    id: "pitch_demo",
    label: "Pitch / Demo Presentation",
    sub: "Deliver a tailored demo or pitch to a stakeholder panel, then field pushback",
    minutes: 45,
    suitedRoleCategories: ["Sales & Customer Success","Marketing & Content","Product & Design"],
  },
  {
    id: "account_strategy",
    label: "Account / Success Case",
    sub: "Analyze an account and build an onboarding/retention/expansion plan",
    minutes: 45,
    suitedRoleCategories: ["Sales & Customer Success"],
  },
  {
    id: "modeling_test",
    label: "Financial Modeling / Excel",
    sub: "Build or stress an LBO / 3-statement / DCF / FP&A model and defend it",
    minutes: 75,
    suitedRoleCategories: ["Finance & Accounting","Data, AI & Analytics"],
  },
  {
    id: "finance_technical",
    label: "Finance Technical Q&A",
    sub: "Accounting, valuation, deal mechanics, and an investment thesis",
    minutes: 35,
    suitedRoleCategories: ["Finance & Accounting"],
  },
  {
    id: "clinical_scenario",
    label: "Clinical Scenario",
    sub: "Reason through a realistic patient/unit situation: assess, prioritize, escalate",
    minutes: 30,
    suitedRoleCategories: ["Healthcare & Life Sciences"],
  },
  {
    id: "situational_judgement",
    label: "Situational Judgement (SJT)",
    sub: "Ranked/spoken workplace dilemmas testing ethics, professionalism, judgment",
    minutes: 20,
    suitedRoleCategories: ["Healthcare & Life Sciences","People, Ops & Trades","Sales & Customer Success"],
  },
  {
    id: "practical_skills",
    label: "Practical Skills / Trade Test",
    sub: "Narrated hands-on task: technique, safety, code compliance, diagnosis",
    minutes: 60,
    suitedRoleCategories: ["People, Ops & Trades","Healthcare & Life Sciences"],
  },
  {
    id: "teaching_demo",
    label: "Teaching Demo",
    sub: "Deliver a short lesson, engage learners, then defend your approach",
    minutes: 25,
    suitedRoleCategories: ["People, Ops & Trades","Healthcare & Life Sciences","Product & Design"],
  },
  {
    id: "ops_case",
    label: "Operations / Process Case",
    sub: "Diagnose a process or supply-chain disruption; prioritize improvements",
    minutes: 50,
    suitedRoleCategories: ["People, Ops & Trades","Finance & Accounting"],
  },
  {
    id: "presentation",
    label: "Presentation Interview",
    sub: "Prepare and deliver a structured presentation, then field challenge",
    minutes: 30,
    suitedRoleCategories: ["Product & Design","Marketing & Content","Sales & Customer Success","Finance & Accounting","People, Ops & Trades","Data, AI & Analytics"],
  },
  {
    id: "leadership_strategy",
    label: "Leadership / Strategy",
    sub: "Team-building, vision, and a 90-day plan for leadership & exec roles",
    minutes: 50,
    suitedRoleCategories: ["Engineering & DevOps","Product & Design","Sales & Customer Success","Marketing & Content","People, Ops & Trades","Finance & Accounting"],
  },
  {
    id: "reference_check",
    label: "Reference / Credentialing",
    sub: "Verification-stage probing of track record, reliability, and credentials",
    minutes: 20,
    suitedRoleCategories: ["Healthcare & Life Sciences","People, Ops & Trades","Finance & Accounting","Sales & Customer Success"],
  },
];

export const RA_MOCK_ROLE_CATEGORIES: RAMockRoleCategory[] = [
  {
    name: 'Engineering & DevOps',
    accent: 'lime',
    roles: [
      'Frontend Engineer',
      'Backend Engineer',
      'Full-Stack Engineer',
      'Mobile Engineer (iOS/Android)',
      'DevOps / Platform Engineer',
      'Site Reliability Engineer',
      'Security Engineer',
      'Engineering Manager',
    ],
  },
  {
    name: 'Product & Design',
    accent: 'violet',
    roles: [
      'Product Manager',
      'Senior Product Manager',
      'Technical Program Manager',
      'Product Designer',
      'UX Researcher',
      'UX/UI Designer',
      'Brand / Visual Designer',
    ],
  },
  {
    name: 'Data, AI & Analytics',
    accent: 'cyan',
    roles: [
      'Data Analyst',
      'Data Scientist',
      'Data Engineer',
      'Machine Learning Engineer',
      'Analytics Engineer',
      'Business Intelligence Analyst',
      'AI / Research Scientist',
    ],
  },
  {
    name: 'Marketing & Content',
    accent: 'pink',
    roles: [
      'Digital Marketing Manager',
      'Content Marketer / Copywriter',
      'SEO Specialist',
      'Social Media Manager',
      'Growth Marketer',
      'Brand Manager',
      'Public Relations Specialist',
    ],
  },
  {
    name: 'Sales & Customer Success',
    accent: 'lime',
    roles: [
      'Account Executive',
      'Sales Development Rep (SDR)',
      'Solutions / Sales Engineer',
      'Customer Success Manager',
      'Account Manager',
      'Customer Support Specialist',
      'Sales Manager',
    ],
  },
  {
    name: 'Finance & Accounting',
    accent: 'violet',
    roles: [
      'Financial Analyst',
      'Accountant',
      'Controller',
      'Investment / Equity Analyst',
      'FP&A Manager',
      'Auditor',
      'Tax Advisor',
    ],
  },
  {
    name: 'Healthcare & Life Sciences',
    accent: 'cyan',
    roles: [
      'Registered Nurse',
      'Medical Doctor / Physician',
      'Pharmacist',
      'Clinical Research Associate',
      'Healthcare Administrator',
      'Medical Laboratory Scientist',
      'Physical Therapist',
    ],
  },
  {
    name: 'People, Ops & Trades',
    accent: 'pink',
    roles: [
      'HR Business Partner',
      'Technical Recruiter',
      'Project Manager',
      'Operations Manager',
      'Supply Chain / Logistics Manager',
      'Electrician',
      'Skilled Tradesperson (HVAC/Welding)',
    ],
  },
];

/** Exact summed role count (8 + 7×7), matches the fixture. */
export const RA_MOCK_TOTAL_ROLES = 57;

export const RA_MOCK_CATALOG: RAMockCatalog = {
  totalRoles: RA_MOCK_TOTAL_ROLES,
  roleCategories: RA_MOCK_ROLE_CATEGORIES,
  interviewers: RA_MOCK_INTERVIEWERS,
  types: RA_MOCK_TYPES,
};

// ─── Lookups ──────────────────────────────────────────────────────────────

export function findInterviewer(id: string): RAMockInterviewer | undefined {
  return RA_MOCK_INTERVIEWERS.find((i) => i.id === id);
}

export function findType(id: string): RAMockType | undefined {
  return RA_MOCK_TYPES.find((t) => t.id === id);
}

/** Display name for a session summary; falls back to the raw id. */
export function interviewerNameFor(id: string): string {
  return findInterviewer(id)?.name ?? id;
}

/** Display label for a session summary; falls back to the raw id. */
export function typeLabelFor(id: string): string {
  return findType(id)?.label ?? id;
}
