// backend/src/interview-engine/catalog/interviewFormats.ts
//
// Interview FORMATS — the WHAT dimension, layered beside personas (the WHO) and
// archetypes (the HOW, see interviewArchetypes.ts). A format defines the
// STRUCTURE of the exercise (live-coding vs take-home vs clinical scenario vs
// mock sales call …) and carries a `blueprintDirective` that threads into the
// question-design agent so the generated questions actually fit that format —
// orthogonal to the archetype's "how to probe" directive. `suitedRoleCategories`
// lets the UI recommend the right formats per chosen role.
//
// Researched across 8 industry clusters (see project memory). The 7 original ids
// (screening/behavioral/technical/system/case/culture/panel) are preserved —
// past sessions reference them.

export interface InterviewFormat {
  id: string;
  labelEn: string;
  subEn: string;
  minutes: number;
  /** Format-specific question-design instruction injected into InterviewBlueprintAgent. */
  blueprintDirective: string;
  focusAreas: string[];
  /** Role-category names this format suits, or ['All'] for cross-industry formats. */
  suitedRoleCategories: string[];
}

export const INTERVIEW_FORMATS: InterviewFormat[] = [
  {
    id: "screening",
    labelEn: "Phone Screen",
    subEn: "Background, fit, motivation, logistics — the gate before the loop",
    minutes: 20,
    blueprintDirective: "Design this as a short, breadth-over-depth recruiter screen whose job is to GATE entry to the loop, not to grade craft. Open with a high-level walk-through of the candidate's background and a quick why-this-role / why-now, then confirm the basics line up against the role's core requirements (relevant experience, level, key must-haves) with light surface-level touches rather than deep drilling. Cover the practical fit signals a recruiter checks: motivation, what they're looking for next, salary/timeline/logistics readiness, and basic communication polish. Keep each question short and conversational so six to eight ground-covering items fit in twenty minutes; every idealSignal should describe a clear, honest, well-organized answer that confirms fit and surfaces no red flags, and probeIfWeak should clarify a gap or inconsistency rather than tunnel into technical depth. Stay role-aware (a nurse screen confirms licensure and shift availability; a sales screen confirms quota history; an engineer screen confirms stack and level) but never run the actual skills exercise here.",
    focusAreas: ["background fit","motivation","compensation/logistics alignment","communication","obvious red flags"],
    suitedRoleCategories: ["All"],
  },
  {
    id: "behavioral",
    labelEn: "Behavioral (STAR)",
    subEn: "Real past stories: ownership, conflict, failure, influence, leadership",
    minutes: 40,
    blueprintDirective: "Design every question as a STAR-grounded behavioral prompt anchored in a REAL past event — open each with \"Tell me about a time\", \"Walk me through a situation where\", or \"Give me a specific example of\", never a hypothetical or a knowledge check. Target the competencies the role implies but express each as a behavior to elicit: ownership and accountability, navigating conflict and disagreement, collaborating and influencing without formal authority, handling failure or ambiguity, and showing leadership or initiative. Set each idealSignal as a complete Situation-Task-Action-Result arc with a clearly personal contribution and a concrete, measurable outcome; set probeIfWeak to extract the specific missing element (the action they personally took, the obstacle, or the result). Include at least one question that forces a real failure, conflict, or setback, and at least one that makes the candidate separate their individual contribution from team credit. Stay role-appropriate in the situations you reference (a sales rep's lost deal, a nurse's difficult family, an EM's underperformer) so the stories are recognizable to that field, but the FORMAT is always one real story, drilled for action and result.",
    focusAreas: ["ownership & accountability","conflict & disagreement","collaboration & influence without authority","failure & ambiguity","leadership & initiative"],
    suitedRoleCategories: ["All"],
  },
  {
    id: "technical",
    labelEn: "Live Coding / Technical",
    subEn: "Real-time problem solving in a shared editor: data structures, algorithms, correctness",
    minutes: 50,
    blueprintDirective: "Design this as a live, shared-editor coding session: produce one or two well-scoped problems (a primary problem plus an optional warm-up or extension) that the candidate solves in real time while narrating their approach. Each question must be a concrete, solvable programming task — manipulate a data structure, implement an algorithm, parse/transform input — with an explicit starting prompt, the clarifications a candidate should ask, and at least one obvious edge case. For each problem, set idealSignal to describe a working, readable solution with the right data-structure choice and correct time/space complexity stated out loud, and set probeIfWeak as an ESCALATION ladder: first nudge toward the bug or edge case, then ask to optimize (e.g. from quadratic to linear), then ask for a unit test or a follow-up extension. Favor depth on one problem over many shallow ones, keep the difficulty calibrated to the role's seniority, and make the exercise about thinking-aloud and iterating, not recalling memorized answers. For data/ML engineers, the same structure applies to a pipeline-transform or feature-engineering task rather than pure DSA.",
    focusAreas: ["problem decomposition","data structure & algorithm choice","code correctness & cleanliness","complexity reasoning","testing & edge cases"],
    suitedRoleCategories: ["Engineering & DevOps","Data, AI & Analytics"],
  },
  {
    id: "system",
    labelEn: "System / Architecture Design",
    subEn: "Design a large-scale system end to end; defend scale & trade-offs",
    minutes: 55,
    blueprintDirective: "Design this as an open-ended, whiteboard-style architecture exercise: produce one broad design prompt (\"Design X\") plus a sequenced set of follow-up probes that walk the candidate through the canonical arc — clarify requirements and scale, sketch the high-level architecture (APIs, services, data stores, caches, queues), then deep-dive one component and defend its trade-offs. The opening question must be genuinely open and scale-ambiguous so the candidate has to gather requirements before drawing; later questions force specific trade-off calls (consistency vs availability, sharding, caching, rate-limiting) and stress the design (\"what breaks at 10x traffic?\", \"what's the failure mode?\", \"why eventual consistency here?\"). Set each idealSignal to describe a defensible architecture with explicit, justified trade-offs and named failure modes — never a single 'correct' diagram — and set probeIfWeak to push the candidate to surface an unprompted edge case or defend a hand-waved choice. At senior level the candidate is expected to DRIVE the conversation. For an ML-flavored variant, frame the prompt around the full ML lifecycle (data → features → model → serving → monitoring → retraining) instead of a generic distributed system; a TPM variant keeps the architecture conversation but weights orchestration and trade-off literacy over hands-on implementation.",
    focusAreas: ["requirements gathering","high-level architecture","component deep-dive","scalability & reliability trade-offs","failure modes"],
    suitedRoleCategories: ["Engineering & DevOps","Data, AI & Analytics","Product & Design"],
  },
  {
    id: "case",
    labelEn: "Case / Business Problem",
    subEn: "Open business problem: structure, data, recommendation",
    minutes: 40,
    blueprintDirective: "Design this as an interactive consulting-style case: open with one realistic business challenge (profitability decline, market entry, pricing, ops efficiency, M&A) and build a sequence of sub-prompts that walk the standard arc — structure the problem into a driver tree, request and interpret data/exhibits, run quick out-loud arithmetic, then deliver a crisp recommendation with the top risks. The opening prompt must be broad enough to demand a framework before any number; mid-case questions should hand the candidate a data point or exhibit to interpret and a quantitative step to compute; the final prompt forces a synthesized 'so-what' recommendation, not just analysis. Set each idealSignal to describe a clean, MECE structure, sound assumptions and arithmetic, and a defensible recommendation; set probeIfWeak to challenge a shaky structure, an unstated assumption, or a leap to an answer without support. There is no single right answer — grade the logic and communication of the path. Keep the case domain-appropriate (a finance/consulting profitability case, a PM product-prioritization case, a marketing GTM-diagnosis case, an ops process-bottleneck case) so the exhibits and levers fit the role.",
    focusAreas: ["problem structuring (MECE/driver tree)","quantitative reasoning","data interpretation","prioritization & trade-offs","synthesis & recommendation"],
    suitedRoleCategories: ["Finance & Accounting","Product & Design","Marketing & Content","People, Ops & Trades","Data, AI & Analytics"],
  },
  {
    id: "culture",
    labelEn: "Values / Culture Fit",
    subEn: "Values alignment, motivation, working style, integrity under ambiguity",
    minutes: 30,
    blueprintDirective: "Design this as a values-and-motivation conversation that probes alignment with team and company principles, ways of working, and how the candidate behaves when there's no clean right answer — distinct from a behavioral loop because it weights MOTIVATION and JUDGMENT over a complete STAR arc. Blend three question kinds: motivation prompts (why this work, what environment brings out their best, what they do when values and pressure collide), working-style prompts (how they give and take feedback, handle disagreement on a team decision, collaborate across differences), and short value-tension prompts where they must weigh competing principles and commit to a position. Set each idealSignal to describe authentic, self-aware alignment — a genuine reason, a real example of acting on a value even at a cost, a constructive response to hard feedback — and set probeIfWeak to test for rehearsed or generic answers by asking for the concrete moment behind the claim. Keep it warm and low-pressure; reserve deep technical or failure drilling for other formats. Make it role-aware where values matter most (patient-safety integrity for healthcare, customer-obsession for CS, craft standards for design).",
    focusAreas: ["values alignment","motivation & purpose","feedback & growth mindset","collaboration & working style","integrity under ambiguity"],
    suitedRoleCategories: ["All"],
  },
  {
    id: "panel",
    labelEn: "Panel / Mixed Loop",
    subEn: "Rapid-fire mix across competencies, as a multi-interviewer panel would",
    minutes: 35,
    blueprintDirective: "Design this as a multi-competency panel loop that simulates several interviewers each owning a different angle — deliberately MIX question types rather than staying in one mode. Construct the set so it samples the role's main evaluation areas in sequence: a behavioral/ownership question, a role-specific technical or craft question, a problem-solving or judgment question, and a values/collaboration question, with brisk transitions that force the candidate to context-switch the way a real panel does. Keep each item self-contained and moderately weighted so the loop covers four to six distinct areas without tunneling into any one; set idealSignal per question to match whatever mode it's in (a STAR arc for the behavioral one, correct reasoning for the technical one, a structured approach for the judgment one), and set probeIfWeak to a single tight follow-up before the panel pivots to the next area. Reward consistency and composure across the switches. Tailor the specific competencies sampled to the chosen role so the panel mirrors that field's real onsite mix.",
    focusAreas: ["breadth across competencies","context-switching","consistency under varied questioning","communication","composure"],
    suitedRoleCategories: ["All"],
  },
  {
    id: "take_home",
    labelEn: "Take-Home Defense",
    subEn: "Defend & extend a self-paced project: design choices, trade-offs, scaling",
    minutes: 45,
    blueprintDirective: "Design this as a follow-up DEFENSE conversation for an asynchronous take-home the candidate built on their own (a small service/feature, a dataset analysis, or a content/campaign deliverable) — not as a live build. Assume a realistic submission exists and generate questions that interrogate it: why they structured it the way they did, the trade-offs they consciously made and documented, how they chose what to test or validate, what they cut for the time-box, and how they would scale or extend it. Each opening question targets a decision in the artifact; probeIfWeak escalates from the stated rationale to a stress-test ('what breaks if the input is 100x larger?', 'why this approach over the obvious alternative?', 'where would this fail in production?'). Set idealSignal to describe clear ownership of every decision, honest articulation of trade-offs and limitations, and credible answers on extension/scaling — clever-but-unexplained work should score lower than simple-but-well-reasoned work. Keep the deliverable type role-appropriate (a REST service or model for engineering/data, a churn analysis for analytics, a campaign brief for marketing). The candidate is defending and extending real work, so reward retrospective judgment over re-deriving the solution live.",
    focusAreas: ["design & structure justification","documented trade-offs","testing & quality","scaling & extension","ownership of decisions"],
    suitedRoleCategories: ["Engineering & DevOps","Data, AI & Analytics","Marketing & Content"],
  },
  {
    id: "debugging",
    labelEn: "Debugging / Code Review",
    subEn: "Diagnose a broken program or critique existing code/PR",
    minutes: 45,
    blueprintDirective: "Design this around EXISTING code rather than a blank editor — two interchangeable modes the question set should pick from based on seniority: (a) a debugging exercise where the candidate is dropped into a broken program or a failing test and must reproduce, hypothesize, read the trace/logs, and isolate the root cause methodically; or (b) a code-review exercise where they're handed a snippet or pull request seeded with a mix of small issues (typos, a missing null check, weak naming) and large ones (poor factoring, missing tests, a security flaw) and must critique it and propose fixes as they would to a teammate. Each question presents the concrete artifact and asks for the next move; probeIfWeak nudges toward a systematic narrowing-down (binary search, reading the stack trace) for debugging, or toward both tactical and structural feedback for review ('you flagged the bug — what about test coverage and readability?'). Set idealSignal to describe methodical diagnosis and composure (not a lucky guess) for debugging, and balanced, well-prioritized, appropriately-toned feedback for review. Reward judgment and communication over greenfield cleverness. Keep the codebase domain-appropriate (a backend endpoint, a flaky test, a data pipeline silently dropping rows).",
    focusAreas: ["systematic diagnosis","reading code/traces","spotting bugs & smells","security & test-coverage gaps","communicating feedback"],
    suitedRoleCategories: ["Engineering & DevOps","Data, AI & Analytics"],
  },
  {
    id: "incident_sre",
    labelEn: "Incident / SRE Scenario",
    subEn: "Triage a live production incident: stabilize, command-line, post-mortem",
    minutes: 50,
    blueprintDirective: "Design this as a reliability-flavored, time-pressured incident scenario for DevOps/Platform/SRE: present a concrete production-incident situation and walk the candidate through triaging it live — identify the failing component, prioritize stabilization over root-cause, name the exact commands and observability tools they'd run, then describe mitigation, rollback, and a blameless post-incident review. The opening question drops them into an unfolding incident ('error rates spiked right after a deploy — your next ten minutes?'); follow-ups force concrete fundamentals (which command, which log, which metric) and decision points (roll back now or investigate?). Interleave a few quick-fire fundamentals (top/htop, journalctl, ss/netstat, strace, lsof, systemctl, networking/DNS, connection pools) and one automation/scripting touch. Set idealSignal to describe stabilize-first thinking, specific commands and a methodical narrowing of the cause, and a structured, blameless post-mortem with a prevention follow-up; set probeIfWeak to push from a vague 'check the logs' to the exact command and what they'd look for. Scale incident severity and post-mortem rigor with seniority. This format is about on-call instinct and production judgment, not algorithm puzzles.",
    focusAreas: ["live triage & stabilize-first instinct","Linux/observability fundamentals","root-cause isolation","mitigation & rollback","blameless post-mortem"],
    suitedRoleCategories: ["Engineering & DevOps"],
  },
  {
    id: "sql_analytics",
    labelEn: "SQL / Analytics Exercise",
    subEn: "Hands-on queries + metric reasoning against real tables",
    minutes: 50,
    blueprintDirective: "Design this as a hands-on SQL-and-analytics round against a small, described schema (one to three tables — state the columns and grain in the prompt). Build the question set as a difficulty ramp: start with a straightforward join/filter/aggregation, then escalate to window functions, date logic, deduplication ('keep the latest row per user'), and a 'this query is slow — how would you optimize it?' step. Layer in metric-reasoning prompts that bridge to analytics: define a metric, slice it, and turn a business question into the query that answers it. For data-engineer or analytics-engineer flavor, add a schema/grain/partition or slowly-changing-dimension modeling prompt. Each question states the concrete task and expected output shape; set idealSignal to describe a correct, performant query plus the reasoning behind the chosen approach, and set probeIfWeak to introduce an edge case (nulls, ties, late-arriving data) or push for the optimization. Keep the dataset role-appropriate (events/users/orders) so the exercise feels like real analytics work, not textbook SQL trivia.",
    focusAreas: ["joins/aggregation/window functions","query debugging & optimization","metric definition","data-quality & dedup discipline","translating business questions to queries"],
    suitedRoleCategories: ["Data, AI & Analytics","Finance & Accounting"],
  },
  {
    id: "product_sense",
    labelEn: "Product Sense / Execution",
    subEn: "Open product design prompt + metrics: structure, users, prioritize, measure",
    minutes: 45,
    blueprintDirective: "Design this as a product-sense plus product-execution exercise — the core PM signal. Generate one or two open design prompts ('Design X for user-group Y' or 'How would you improve product Z?') that demand the candidate STRUCTURE the problem: clarify goals, segment users, identify pain points, brainstorm and prioritize solutions, then recommend with trade-offs. Pair this with an execution/analytical sub-track: define success metrics for a feature, diagnose a metric drop ('DAU fell 5% this week — investigate'), and reason about a metric trade-off. The opening design prompt must be broad and goal-ambiguous so the candidate sets the frame themselves; the execution prompts must demand concrete metrics, hypotheses, and a decision. Set each idealSignal to describe structured thinking, genuine user empathy, a prioritized recommendation, and metrically sound reasoning — never a single 'right' feature; set probeIfWeak to challenge an unsegmented user, a vanity metric, or a leap to a solution before defining the problem. There is no correct answer — grade the structure, taste, and metric judgment. For data/growth flavors, lean the prompts toward experimentation and metric diagnosis; for marketing, toward audience and channel fit.",
    focusAreas: ["problem structuring & user segmentation","pain identification & ideation","prioritization & trade-offs","success metrics & instrumentation","metric-movement diagnosis"],
    suitedRoleCategories: ["Product & Design","Data, AI & Analytics","Marketing & Content"],
  },
  {
    id: "portfolio",
    labelEn: "Portfolio / Past-Work Review",
    subEn: "Walk through real past work: process, decisions, contribution, impact",
    minutes: 50,
    blueprintDirective: "Design this as a guided walkthrough of the candidate's REAL past work — the anchor round for designers, researchers, marketers, and senior ICs — assuming they bring one to three projects (a design case, a campaign, a research study, a built system, a writing portfolio). Generate questions that drill each project along a Problem → Process → Decisions → Contribution → Impact arc: what problem they were solving and how they knew it, the process and methods they chose, the hardest trade-off or compromise they made, what was specifically THEIRS versus the team's, the measured outcome, and what they'd do differently now. Each opening question targets a project; probeIfWeak presses on a hand-waved decision, an ambiguous personal contribution ('what exactly did you do here?'), or a missing outcome metric. Set idealSignal to describe clear ownership, sound rationale behind each decision, honest reflection on trade-offs, and a credible link from the work to a business or user result — storytelling backed by rigor, not a slideshow. Keep the artifact type role-appropriate (UX flows and craft for designers, campaign metrics for marketers, study methodology for researchers, system trade-offs for senior engineers). This is a defense-of-real-work format; reward authentic ownership over polished narration.",
    focusAreas: ["problem framing & process","design/creative decisions & trade-offs","individual contribution vs team","measurable outcomes","storytelling & rationale"],
    suitedRoleCategories: ["Product & Design","Marketing & Content","Engineering & DevOps","Data, AI & Analytics"],
  },
  {
    id: "design_critique",
    labelEn: "Design Critique / Whiteboard",
    subEn: "Critique an app or design live, or sketch a solution to a fresh prompt",
    minutes: 45,
    blueprintDirective: "Design this around live design reasoning in one of two interchangeable modes the question set picks from: (a) an APP/DESIGN CRITIQUE where the candidate evaluates a well-known product they didn't build — starting at the 10,000-foot view (business context, the problem it solves, who the user is), stating an evaluation framework, then drilling into specific, actionable UX/interaction/visual improvements with rationale; or (b) a WHITEBOARD CHALLENGE where they get a fresh design prompt and must define the problem space, generate multiple solution directions, sketch the primary user flow, and narrate their reasoning while you play a stakeholder. The opening question sets the artifact or prompt; probeIfWeak pushes from a surface observation to a justified critique ('why is that worse, and what would you change?') or from a single idea to an explored alternative and a trade-off. Set idealSignal to describe a clear philosophy/framework, strong problem definition, breadth of ideas, and crisp rationale — process and reasoning, not pixel-perfect output. Keep prompts in consumer/product-UX territory appropriate to a product or UX designer; the signal is recognizing good vs bad design and articulating WHY.",
    focusAreas: ["evaluation framework / design philosophy","problem definition","idea generation & flows","actionable UX/visual critique","collaboration & reasoning aloud"],
    suitedRoleCategories: ["Product & Design"],
  },
  {
    id: "research_design",
    labelEn: "UX Research Study Design",
    subEn: "Design a study on the spot or critique a flawed research plan",
    minutes: 45,
    blueprintDirective: "Design this as a live UX-research methods exercise — distinct from a research case study because it tests on-the-feet judgment, not rehearsed past work. Two interchangeable modes: (a) STUDY DESIGN, where the candidate is given a business question ('onboarding completion is low — find out why') and must design a study on the spot: choose methods (qual vs quant, generative vs evaluative), frame the research question, define target participants and sample size, state what data they expect, and explain how they'd analyze and report it; or (b) PLAN CRITIQUE, where they're handed a flawed research plan and must find what's wrong and fix it. Stress real constraints — 'you have two weeks and no budget, now what?' — to force method trade-offs. Each opening question states the business question or the plan; probeIfWeak pushes for the rationale behind a method choice, the risk it introduces, or the cheaper/faster alternative under tightened constraints. Set idealSignal to describe a defensible method matched to the question, sound sampling, and a clear analysis-to-decision path — sound methodological reasoning over a 'textbook' answer. Keep prompts in product/UX research territory.",
    focusAreas: ["method selection (qual/quant, generative/evaluative)","research question framing","sampling & participants","analysis & reporting plan","trade-offs under constraints"],
    suitedRoleCategories: ["Product & Design"],
  },
  {
    id: "sales_roleplay",
    labelEn: "Mock Sales Call / Role-Play",
    subEn: "Live discovery, cold call, or escalation against a role-played counterpart",
    minutes: 30,
    blueprintDirective: "Design this as a LIVE role-play where the interviewer plays a counterpart and the candidate runs a real GTM motion — pick the scenario from the role: a discovery call (uncover pain, qualify against MEDDPICC/SPIN/Challenger, set a next step), a cold-call opener (earn the meeting past a brush-off, for SDR/BDR), or a customer escalation/de-escalation (acknowledge frustration, take ownership, coordinate a fix, for CSM/AM/support). Provide a short mock-prospect or account brief up front, then generate the role-play's beats as questions/turns the COUNTERPART would say — opening context, the discovery or qualification turns, two or three curveball objections injected mid-call (price, timing, authority, status-quo, or an angry 'why should we renew?'), and a close. Set idealSignal to describe strong rapport-building, open discovery questions, listening for and reframing the real concern before discounting, clear value articulation, and a committed next step; set probeIfWeak to throw a harder objection or test whether the candidate digs into the 'why' versus caving. Crucially, include a coaching beat: offer feedback mid-exercise and see if they adapt. This is a performance simulation, not a Q&A — the turns ARE the prompts.",
    focusAreas: ["discovery & qualification","active listening for buying/churn signals","objection handling","value articulation","coachability & next-step drive"],
    suitedRoleCategories: ["Sales & Customer Success"],
  },
  {
    id: "pitch_demo",
    labelEn: "Pitch / Demo Presentation",
    subEn: "Deliver a tailored demo or pitch to a stakeholder panel, then field pushback",
    minutes: 45,
    blueprintDirective: "Design this as a capstone PITCH/DEMO where the candidate presents a tailored solution to a panel role-playing customer stakeholders or an executive buyer (assume a fictional customer case study was provided in advance). Structure the question flow as the presentation arc — intro, a discovery recap that proves they understood the customer, a tailored demo/solution that maps features to the customer's stated pains, then objection handling and Q&A — and generate the stakeholder challenges as the probing turns: 'how is this different from the incumbent?', 'I'm the CFO — justify the ROI', 'that feature doesn't fit our workflow, what's your alternative?'. Set idealSignal to describe consultative, customer-centric framing (the customer is the focus, not the product), tight feature-to-pain mapping, credible business/ROI reasoning, and composure fielding pushback; set probeIfWeak to escalate a stakeholder objection or expose a generic, untailored pitch. The deliverable being graded is the persuasive presentation itself plus how they handle the room. Keep it role-appropriate — a sales-engineer pre-sales demo, a PMM go-to-market pitch, or a product launch narrative.",
    focusAreas: ["consultative framing & discovery recap","tailoring to stated pains","business acumen / ROI","handling stakeholder objections","crisp communication"],
    suitedRoleCategories: ["Sales & Customer Success","Marketing & Content","Product & Design"],
  },
  {
    id: "account_strategy",
    labelEn: "Account / Success Case",
    subEn: "Analyze an account and build an onboarding/retention/expansion plan",
    minutes: 45,
    blueprintDirective: "Design this as a strategic account case for CSM/AM roles (the CS analogue of a business case): present a described customer account (situation, goals, usage/health data, risks) and generate questions that make the candidate build and defend a success/retention strategy — a 30/60/90 onboarding or adoption plan, identification of health risks and contingencies, an expansion or renewal play, and a prioritization call across multiple at-risk accounts. The opening question hands them the account and asks for the plan; follow-ups force trade-offs ('which of these three at-risk accounts do you save first and why?', 'usage dropped 40% — what's your next move?', 'how do you turn this into expansion?'). Set idealSignal to describe proactive, structured account thinking — clear prioritization, concrete actions tied to the account's actual signals, risk planning, and a credible path to retention or growth — not reactive firefighting; set probeIfWeak to challenge a generic plan or push for the reasoning behind a prioritization. This is strategy-and-defense, not a live customer conversation; reward strategic account ownership.",
    focusAreas: ["account analysis & health risk","onboarding/adoption planning","risk identification & contingencies","renewal & expansion strategy","prioritization across a book"],
    suitedRoleCategories: ["Sales & Customer Success"],
  },
  {
    id: "modeling_test",
    labelEn: "Financial Modeling / Excel",
    subEn: "Build or stress an LBO / 3-statement / DCF / FP&A model and defend it",
    minutes: 75,
    blueprintDirective: "Design this as a hands-on financial-modeling exercise: give a prompt of assumptions and financial data, then ask the candidate to build (or fix and extend) the RIGHT model — an LBO, a 3-statement, a DCF, or an FP&A forecast/variance model — and compute and interpret the key outputs (IRR, MOIC, EBITDA impact, the variance drivers). Frame it as build-then-defend: the opening question states the model to build and the data; follow-ups probe the mechanics and force interpretation ('walk me through the sources & uses', 'what's the sponsor IRR and is it good?', 'model the sensitivity to price vs volume', 'opex came in 12% over budget — decompose and explain it to the VP'). Interleave a couple of rapid sanity-check drills ('quick — EBITDA impact if churn rises two points?'). Set idealSignal to describe a correct, well-structured model built efficiently to spec (the right model, not the most complex), sound assumptions, and a clear interpretation of what the outputs mean for the decision; set probeIfWeak to flag a broken link, a missing assumption, or push for the business meaning behind a number. Reward following instructions, prioritization, and the ability to explain the model to a non-finance stakeholder, not just spreadsheet mechanics.",
    focusAreas: ["model construction (LBO/3-statement/DCF)","Excel speed & prioritization","forecasting & variance/sensitivity","unit economics / NPV / IRR","interpreting and defending outputs"],
    suitedRoleCategories: ["Finance & Accounting","Data, AI & Analytics"],
  },
  {
    id: "finance_technical",
    labelEn: "Finance Technical Q&A",
    subEn: "Accounting, valuation, deal mechanics, and an investment thesis",
    minutes: 35,
    blueprintDirective: "Design this as rapid-fire verbal finance technicals plus one judgment piece — the backbone of IB/PE/ER/corporate-finance and accounting screens. Generate 'walk-me-through' and edge-case questions across the core canon: the three financial statements and how a change flows through them ('depreciation goes up $10 — walk me through all three statements'), valuation methodologies (DCF, comparable companies, precedent transactions), enterprise vs equity value, accretion/dilution, and — for accounting/audit flavor — standards and procedures (revenue recognition under ASC 606, 'how would you audit fixed assets step by step'). Then add ONE differentiated-thinking prompt matched to the role: a stock pitch / investment thesis for ER/buy-side ('pitch me a name — what's mispriced, what's the catalyst, what would make you wrong?') or a deal/transaction walkthrough for IB/PE ('walk me through a deal you worked on — the rationale, the risks, what you'd change'). Set idealSignal to describe genuine mechanical understanding (not a memorized script) and, for the judgment piece, a defensible, independent point of view; set probeIfWeak to stress-test an edge case or press the thesis ('what's priced in?'). Calibrate accounting-vs-valuation weight to the specific role; entry level gets the heaviest mechanics drilling.",
    focusAreas: ["3-statement linkages","valuation (DCF / comps / precedents)","enterprise vs equity value & accretion/dilution","accounting standards (GAAP/IFRS)","investment thesis & deal judgment"],
    suitedRoleCategories: ["Finance & Accounting"],
  },
  {
    id: "clinical_scenario",
    labelEn: "Clinical Scenario",
    subEn: "Reason through a realistic patient/unit situation: assess, prioritize, escalate",
    minutes: 30,
    blueprintDirective: "Design this as a spoken clinical-scenario interview for nurses, physicians, pharmacists, and allied-health roles: present realistic patient or unit situations (a deteriorating patient, conflicting orders, an angry family, a staffing crunch, a medication discrepancy) and ask the candidate to talk through how they would assess, prioritize, escalate, and act. Each question is a hypothetical 'what would you do if…' the candidate may never have faced — frame the situation concretely with vitals or context, then ask for their next steps. Follow-ups force the chain of clinical reasoning: what they assess first, how they prioritize between competing patients, when and to whom they escalate, and how they communicate with the patient/family and the team. Set idealSignal to describe sound clinical judgment, clear triage and prioritization, an appropriate escalation/safety chain, protocol adherence, and compassionate communication; set probeIfWeak to add a complication ('the physician is unreachable', 'now a second patient is at fall risk') and watch whether they adapt safely. This is judgment under urgency, not a knowledge quiz — keep scenarios realistic to the specific clinical role and setting, and reward patient-centered, safety-first reasoning over textbook recall.",
    focusAreas: ["clinical assessment & judgment","prioritization & triage","escalation chain","patient-centered communication","protocol adherence & safety"],
    suitedRoleCategories: ["Healthcare & Life Sciences"],
  },
  {
    id: "situational_judgement",
    labelEn: "Situational Judgement (SJT)",
    subEn: "Ranked/spoken workplace dilemmas testing ethics, professionalism, judgment",
    minutes: 20,
    blueprintDirective: "Design this as a situational-judgement exercise (Casper / AAMC-PREview / NHS-style) that measures professional JUDGMENT rather than knowledge: present short workplace or clinical dilemmas and have the candidate explain aloud what they would do and why — or rank the effectiveness of possible responses. Each question is a tight scenario with an ethical or professional tension ('a colleague asks you to cover an error on a chart', 'you notice a coworker seems impaired at work', 'a customer asks you to do something against policy'). For each, the candidate should name the problem, identify the stakeholders, weigh the competing principles (honesty, autonomy, beneficence, fairness, safety), and commit to a defensible course of action. Set idealSignal to describe sound reasoning that surfaces the real issue, balances the principles, and lands on a professional, accountable choice — there is NO single right answer, so grade the reasoning and the values it reveals; set probeIfWeak to add a wrinkle ('what if the colleague is your friend?', 'what if pushing back risks the deal?') and test whether the judgment holds. Keep dilemmas role- and industry-appropriate. This format probes ethics and professionalism at scale, distinct from STAR behavioral stories.",
    focusAreas: ["professional ethics & integrity","stakeholder identification","weighing competing principles","service orientation & teamwork","defensible judgment"],
    suitedRoleCategories: ["Healthcare & Life Sciences","People, Ops & Trades","Sales & Customer Success"],
  },
  {
    id: "practical_skills",
    labelEn: "Practical Skills / Trade Test",
    subEn: "Narrated hands-on task: technique, safety, code compliance, diagnosis",
    minutes: 60,
    blueprintDirective: "Design this as a narrated, hands-on practical assessment for a tradesperson or a clinical-skills station — a task-driven exercise, not open Q&A. Present a concrete real-world task the candidate performs while talking through every step: diagnose an HVAC fault, wire and terminate a circuit to code, braze/weld a joint, read a schematic, OR (clinical variant, OSCE-style) site a cannula, take and escalate vital signs, administer a medication safely with consent. Each 'question' is a station prompt ('this unit isn't cooling — diagnose it and tell me your steps'); follow-ups probe the safety checks, the code/standard that applies, the next diagnostic move, and what they'd do if a step fails. Interleave a few knowledge/standard checks tied to the task (EPA 608 before recovering refrigerant; the relevant electrical or clinical code; consent and hand-hygiene for the clinical variant) and, for apprenticeship-level candidates, a couple of aptitude-style schematic-reading or trade-math items. Set idealSignal to describe correct technique, explicit safety and compliance, sound diagnostic narration, and an orderly step-by-step method; set probeIfWeak to introduce a fault or an unsafe shortcut and see if they catch it. Reward safety-first, code-compliant, methodical work over speed.",
    focusAreas: ["correct technique & procedure","safety & code compliance","diagnostic reasoning","tool/equipment knowledge","step-by-step narration"],
    suitedRoleCategories: ["People, Ops & Trades","Healthcare & Life Sciences"],
  },
  {
    id: "teaching_demo",
    labelEn: "Teaching Demo",
    subEn: "Deliver a short lesson, engage learners, then defend your approach",
    minutes: 25,
    blueprintDirective: "Design this as a teaching demonstration for any role requiring instruction or enablement (faculty, trainers, clinical educators, onboarding/enablement leads): the candidate teaches a short lesson on a set topic and is then questioned on their approach. Frame the primary prompt as a teaching brief, not a question ('teach a 15-minute lesson on [topic] to a first-year class / new hires'), and instruct the design to expect the candidate to SHOW rather than tell — open a learning objective, use at least one active-learning strategy, create dialogue rather than lecture, and check understanding. Generate the assessor follow-ups that come after the demo: 'why did you structure it that way?', 'how would you handle a learner who's completely lost?', 'how do you know they actually learned it?', plus a live curveball ('a student gives a wrong answer — what do you do?'). Set idealSignal to describe a clear, well-paced lesson that genuinely engages learners, checks for understanding, and adapts; set probeIfWeak to test whether they can recover engagement or re-explain a concept a different way. The deliverable being graded is the act of teaching plus the reasoning behind it — reward making a topic land in limited time over content coverage. Keep the topic appropriate to the candidate's domain.",
    focusAreas: ["clarity & lesson structure","learner engagement & active learning","checking for understanding","adapting to a confused learner","rationale for instructional choices"],
    suitedRoleCategories: ["People, Ops & Trades","Healthcare & Life Sciences","Product & Design"],
  },
  {
    id: "ops_case",
    labelEn: "Operations / Process Case",
    subEn: "Diagnose a process or supply-chain disruption; prioritize improvements",
    minutes: 50,
    blueprintDirective: "Design this as an operations/process-improvement or supply-chain case for ops, logistics, procurement, and operational-excellence roles. Two interchangeable framings: (a) PROCESS IMPROVEMENT — present a process with data ('this fulfillment line ships 80 units/hour against a target of 120'), and make the candidate define the success metric, decompose the process into People/Process/Technology components, diagnose the bottleneck, and prioritize improvements by impact, ease, and cost (Lean/Six Sigma/DMAIC framing welcome); or (b) DISRUPTION SCENARIO — present a delay, quality failure, supplier loss, or disaster ('your single-source supplier goes offline for six weeks'), and probe contingency thinking, inventory/safety-stock trade-offs (carrying cost vs stockout risk), alternative sourcing, and stakeholder communication. The opening question states the process or disruption; follow-ups force the metric, the decomposition, the prioritization, or the first-48-hours plan. Set idealSignal to describe a clear metric, a structured decomposition, a data-grounded diagnosis, and a prioritized, cost-aware action plan; set probeIfWeak to challenge a prioritization or inject a new constraint. Reward structured operational reasoning and contingency planning, with a worked before/after where apt.",
    focusAreas: ["metric definition & process decomposition","bottleneck/root-cause diagnosis (Lean/DMAIC)","prioritization by impact/ease/cost","contingency & risk planning","stakeholder communication"],
    suitedRoleCategories: ["People, Ops & Trades","Finance & Accounting"],
  },
  {
    id: "presentation",
    labelEn: "Presentation Interview",
    subEn: "Prepare and deliver a structured presentation, then field challenge",
    minutes: 30,
    blueprintDirective: "Design this as a presentation interview where the deliverable being graded is a persuasive PRESENTATION the candidate prepares and delivers, then defends — distinct from a case because the artifact is the structured pitch itself. Frame the primary prompt as a presentation brief ('prepare a 10-minute presentation on how you'd enter this market / your 90-day plan for this role / your recommendation on this problem'), then generate the assessor challenge questions that follow: 'what's your single biggest risk?', 'defend your top recommendation', 'what did you deprioritize and why?', 'how would you know if this is working?'. Instruct the design to expect a clear structure (a lead message, supporting points, a recommendation), tight time management, and composure under challenge. Set idealSignal to describe a well-structured, audience-appropriate, persuasive message with a defensible recommendation and confident handling of pushback; set probeIfWeak to press a weakly supported claim or test whether they can re-prioritize under a new constraint. This is cross-industry and used as the delivery vehicle for senior, leadership, marketing, and consulting rounds; tailor the topic to the role and seniority.",
    focusAreas: ["structuring a persuasive message","communication & influence","time management","handling challenge & Q&A","defending a recommendation"],
    suitedRoleCategories: ["Product & Design","Marketing & Content","Sales & Customer Success","Finance & Accounting","People, Ops & Trades","Data, AI & Analytics"],
  },
  {
    id: "leadership_strategy",
    labelEn: "Leadership / Strategy",
    subEn: "Team-building, vision, and a 90-day plan for leadership & exec roles",
    minutes: 50,
    blueprintDirective: "Design this as a leadership-and-strategy interview for managers, directors, and executive seats — the format replaces hands-on craft exercises at the leadership tier. Blend three strands: (1) PEOPLE LEADERSHIP, behavioral-style stories on building/growing/steering a team — turning around an underperformer, resolving conflict between senior reports, driving delivery and accountability, articulating a leadership philosophy; (2) CROSS-FUNCTIONAL INFLUENCE — aligning competing functions behind one direction, influencing without authority, leading through a pivot; (3) STRATEGY & BETS — for senior/exec roles, the quality of a bet they made (the cost if wrong, the signal they watched, when they'd have killed it), where the org should place its next bet, and a 30/60/90-day plan (learn → set priorities → execute, covering hiring, playbook/operating model, and cross-functional alignment). The opening question targets the candidate's actual leadership scope; probeIfWeak pushes a roadmap-execution answer up to org-level judgment ('how would you have known it was failing?', 'what would you NOT do?') and tests gravitas under a skeptical follow-up. Set idealSignal to describe sound people judgment, defensible strategy with explicit kill-signals, and the ability to build and run the team that delivers — not individual heroics. Tailor the function (sales, eng, CS, marketing, ops) to the role; the implicit test shifts from 'can you do the work' to 'can you build and lead the team that does.'",
    focusAreas: ["leadership philosophy & people management","cross-functional influence & alignment","strategic vision & quality of bets","30/60/90-day operating plan","handling conflict, underperformance & ambiguity"],
    suitedRoleCategories: ["Engineering & DevOps","Product & Design","Sales & Customer Success","Marketing & Content","People, Ops & Trades","Finance & Accounting"],
  },
  {
    id: "reference_check",
    labelEn: "Reference / Credentialing",
    subEn: "Verification-stage probing of track record, reliability, and credentials",
    minutes: 20,
    blueprintDirective: "Design this as a verification-stage exercise that prepares the candidate for the final reference and credentialing step — a coaching simulation, not a skills test. Two interleaved angles: (a) REFERENCE-STYLE, where the questions are phrased as a reference checker probing the candidate's track record, reliability, conduct under pressure, conflict handling, and rehireability ('describe how you handled pressure or a serious conflict', 'when did you perform best, and where did you struggle', 'why should a former manager vouch for you'); and (b) CREDENTIALING, especially for regulated fields, where the candidate must credibly narrate and confirm their credentials — active licensure, board certifications, education, work history, and any disciplinary or malpractice history. Set idealSignal to describe consistent, honest, specific answers that align with their earlier claims and surface no integrity red flags, plus a confident, accurate walk-through of credentials; set probeIfWeak to test for inconsistency with a prior story or to ask how they'd brief a reference to speak to a specific competency. Keep it role-aware — rigorous primary-source credentialing for healthcare and other licensed fields, lighter reference-narration for general roles. Reward authenticity, consistency, and verifiable specifics over polish.",
    focusAreas: ["track record & reliability verification","integrity & conduct","rehireability signals","credential/licensure narration","consistency with prior claims"],
    suitedRoleCategories: ["Healthcare & Life Sciences","People, Ops & Trades","Finance & Accounting","Sales & Customer Success"],
  },
];

const BY_ID = new Map(INTERVIEW_FORMATS.map((f) => [f.id, f]));

export function getFormat(id?: string | null): InterviewFormat | undefined {
  return id ? BY_ID.get(id) : undefined;
}

/** Thin {id,label,sub,minutes,suitedRoleCategories} projection for the catalog /
 *  picker — never leaks the blueprintDirective over the wire. */
export function formatsAsTypes(): Array<{ id: string; label: string; sub: string; minutes: number; suitedRoleCategories: string[] }> {
  return INTERVIEW_FORMATS.map((f) => ({ id: f.id, label: f.labelEn, sub: f.subEn, minutes: f.minutes, suitedRoleCategories: f.suitedRoleCategories }));
}
