// server/src/interview-engine/skills/patterns.ts
//
// INTERVIEW PATTERNS — the recurring shapes of real interview loops that a
// company's own style is made of: a values/principles loop, a bar raiser, a
// past-project deep dive, a customer role-play, a group discussion, an HR
// final round … They are the fourth directive dimension, beside archetypes
// (HOW the interviewer probes), formats (the STRUCTURE of the exercise) and
// domains (the SUBSTANCE of a field).
//
// No company is named here. What a given employer does is researched per
// company (prep/companyStyle.ts) from public sources and EXPRESSED as a set of
// these patterns plus the specifics found (its published values, its stage
// names). The planner reads `summary` + `whenToUse` from the skill index and
// picks the patterns that fit; the chosen patterns' directives then thread
// into the same three stages as every other skill:
//   blueprintDirective → InterviewBlueprintAgent (question design)
//   voiceDirective     → the live interviewer's system prompt
//   evaluationLens     → the evaluation agents (grading + feedback framing)

import type { InterviewArchetype } from '../catalog/interviewArchetypes.js';

export type InterviewPatternKey =
  | 'values-principles'
  | 'bar-raiser'
  | 'structured-rubric'
  | 'algorithmic-coding'
  | 'practical-coding'
  | 'project-deep-dive'
  | 'research-depth'
  | 'customer-scenario'
  | 'problem-decomposition'
  | 'consulting-case'
  | 'mission-judgment'
  | 'safety-quality'
  | 'fundamentals-drill'
  | 'quant-reasoning'
  | 'finance-superday'
  | 'group-discussion'
  | 'hr-final'
  | 'cross-team'
  | 'presentation-qa'
  | 'startup-generalist'
  | 'learning-culture'
  | 'one-way-video'
  | 'competency-based';

export interface InterviewPatternPlaybook {
  key: InterviewPatternKey;
  labelEn: string;
  /** One line for the skill index the planner reads. */
  summary: string;
  /** The signals (in the job or the company research) that make this pattern fit. */
  whenToUse: string;
  /** Interview formats (interviewFormats.ts ids) this pattern usually runs as, best first. */
  formats: readonly string[];
  /** Archetypes that usually deliver it, best first. */
  archetypes: readonly InterviewArchetype[];
  blueprintDirective: string;
  voiceDirective: string;
  evaluationLens: string;
}

export const INTERVIEW_PATTERNS: Record<InterviewPatternKey, InterviewPatternPlaybook> = {
  'values-principles': {
    key: 'values-principles',
    labelEn: 'Values / principles loop',
    summary: "Every question is anchored in one of the company's published values or leadership principles and judged against it.",
    whenToUse: 'The company publishes values or leadership principles and is known to map its interview questions to them.',
    formats: ['behavioral', 'culture', 'panel'],
    archetypes: ['behavioral', 'depth'],
    blueprintDirective:
      "Tie every question to one named value or principle from the company research and name it in the question's focus. Use real-past-event prompts (\"Tell me about a time…\"), with two questions for each principle that matters most for this role. idealSignal is a story that visibly demonstrates that principle through a personal action and a measurable result; probeIfWeak digs for the data behind the result, the trade-off made and what the candidate would do differently.",
    voiceDirective:
      "Name the principle lightly when you ask (\"This one is about ownership…\"), the way principle-based interviewers do, then stay on one story for several follow-ups: who decided, what exactly the candidate did, what the numbers were, what went wrong. Do not accept team credit or a hypothetical in place of a real example.",
    evaluationLens:
      'Grade each answer against the principle it targeted: reward stories that show the principle in a concrete personal action with a measurable outcome and honest reflection; penalize generic stories that could fit any principle, "we" answers and results without numbers. In feedback, name the principle each answer did or did not demonstrate.',
  },
  'bar-raiser': {
    key: 'bar-raiser',
    labelEn: 'Bar raiser round',
    summary: 'An experienced interviewer from outside the hiring team tests whether the candidate raises the overall bar, with long follow-up chains.',
    whenToUse: 'The company uses an independent senior interviewer with a veto, or the research mentions a bar raiser or an equivalent role.',
    formats: ['behavioral', 'panel'],
    archetypes: ['behavioral', 'depth'],
    blueprintDirective:
      'Design fewer, deeper questions: three or four stories, each with a ladder of five or more follow-ups testing judgment, ownership beyond the job description, raising the bar for others and learning from failure. Include one decision made with incomplete data and one disagreement with leadership.',
    voiceDirective:
      "You are not on the hiring team; you are here to protect the hiring bar. Be courteous but relentless: follow each story down several levels, ask for the specific decision and its alternatives, check consistency between answers, and ask how the candidate made the people around them better.",
    evaluationLens:
      'Grade against the bar of the level above the role: reward judgment, ownership beyond scope, consistency under deep follow-up and evidence of raising others; penalize stories that collapse after two follow-ups, inconsistencies and answers that depend on other people’s decisions.',
  },
  'structured-rubric': {
    key: 'structured-rubric',
    labelEn: 'Structured, rubric-scored interviews',
    summary: 'Standardized questions scored on a written rubric (problem solving, role knowledge, leadership, culture) and decided by a committee.',
    whenToUse: 'The company is known for structured interviews with consistent questions, rubrics and a hiring committee rather than one interviewer deciding.',
    formats: ['behavioral', 'case', 'technical', 'panel'],
    archetypes: ['potential', 'behavioral'],
    blueprintDirective:
      'Use consistent, well-specified questions that mix hypothetical problem solving ("How would you approach…") and past behavior, each tagged with the rubric attribute it measures (problem solving, role knowledge, leadership, collaboration). idealSignal describes a strong answer on that attribute at this level; probeIfWeak is the clarifying or extending question a rubric-trained interviewer would ask, never a hint.',
    voiceDirective:
      "Be neutral and consistent: ask each question as written, give no help unless asked to clarify, pause between questions as if you are writing notes, and never signal how well an answer went.",
    evaluationLens:
      'Score each answer on its rubric attribute with a clear anchor (weak, mixed, strong) and quote the evidence; reward structured reasoning, alternatives considered and stated assumptions; penalize unstructured answers and claims without evidence. Frame feedback the way a committee reads notes: what evidence is there and what is missing.',
  },
  'algorithmic-coding': {
    key: 'algorithmic-coding',
    labelEn: 'Algorithms and data structures',
    summary: 'Classic coding rounds: solve one or two algorithm problems out loud with the right complexity, then test and extend.',
    whenToUse: 'Software roles at companies known for algorithm-heavy coding rounds, or research mentions algorithm or "LeetCode-style" questions.',
    formats: ['technical'],
    archetypes: ['depth', 'potential'],
    blueprintDirective:
      'Pick one medium problem and one harder follow-up calibrated to the level, with the clarifying questions a candidate should ask, the edge cases, the expected complexity and an extension that changes a constraint. In a voice session the candidate explains rather than types: ask for the approach, the data structures, the complexity and the test cases.',
    voiceDirective:
      'Present the problem concisely and let the candidate clarify. Expect a simple approach first, then optimization; nudge only after a long silence; ask for complexity and test cases; then change one constraint.',
    evaluationLens:
      'Reward clarifying the problem, a correct approach with the right data structure, correct complexity analysis, testing with edge cases and clear narration; penalize starting without a plan, wrong complexity and missed edge cases.',
  },
  'practical-coding': {
    key: 'practical-coding',
    labelEn: 'Practical engineering tasks',
    summary: 'Job-like tasks instead of puzzles: extend or debug existing code, integrate an API, make pragmatic trade-offs.',
    whenToUse: 'The company favors realistic coding (debugging, refactoring, building a small feature, integrating an API) over puzzles.',
    formats: ['technical', 'debugging', 'take_home'],
    archetypes: ['depth'],
    blueprintDirective:
      'Describe a small, realistic service or codebase and ask the candidate to add a feature, find a bug or integrate an external API step by step. Include production concerns (errors, retries, tests, logging) and one requirement change midway. idealSignal: a working, readable approach with sensible trade-offs and tests; probeIfWeak: what breaks in production and how they would notice.',
    voiceDirective:
      'Act like a colleague pairing on real code: describe the code and the task, answer questions as a teammate would, and push on production readiness — errors, edge cases, tests, monitoring — more than on cleverness.',
    evaluationLens:
      'Reward working, pragmatic solutions, reasoning about existing code, production awareness and testing; penalize over-engineering, ignored error cases and unchecked assumptions about the code.',
  },
  'project-deep-dive': {
    key: 'project-deep-dive',
    labelEn: 'Past project deep dive',
    summary: "One project from the resume examined in depth: architecture, decisions, the candidate's own role, results and what they would change.",
    whenToUse: 'Senior or research-heavy roles, and companies known for a "walk me through a project you are proud of" round.',
    formats: ['portfolio', 'technical', 'behavioral'],
    archetypes: ['depth'],
    blueprintDirective:
      "Choose the resume project that best matches the job's must-haves (or ask the candidate to choose) and plan a descent: goal and context, the candidate's exact role, the hardest decision and its alternatives, what failed, the measured result, and what they would do differently today. Add one question that checks depth in the area the job needs most.",
    voiceDirective:
      'Pick one project and stay on it for most of the interview. Keep asking why that choice, what they personally built, what the numbers were and what went wrong. Be curious, not hostile: you want the real depth behind the resume line.',
    evaluationLens:
      'Reward precise ownership, depth on decisions and trade-offs, quantified results and honest reflection; penalize vague "we" answers, buzzwords without mechanism and an inability to go below the resume line.',
  },
  'research-depth': {
    key: 'research-depth',
    labelEn: 'Research depth and taste',
    summary: "Discusses the candidate's research, a recent paper, experiment design and which problems are worth working on.",
    whenToUse: 'Research scientist and research engineer roles, AI labs and industry research groups.',
    formats: ['technical', 'portfolio', 'case'],
    archetypes: ['depth', 'potential'],
    blueprintDirective:
      "Plan a discussion of the candidate's main research contribution (motivation, method, ablations, limits), one recent development in the field they should know, the design of an experiment that tests a hypothesis from the job's area, and which research direction they would bet on and why.",
    voiceDirective:
      'Be a peer researcher: curious and precise, and skeptical of any claim made without a baseline, an ablation or a clear metric.',
    evaluationLens:
      'Reward clear motivation, rigorous experimental thinking, honest limitations and research taste; penalize overclaiming, missing baselines and shallow knowledge of the literature.',
  },
  'customer-scenario': {
    key: 'customer-scenario',
    labelEn: 'Customer scenario role-play',
    summary: 'The interviewer plays a customer or stakeholder; the candidate must discover needs, handle objections and propose a workable plan live.',
    whenToUse: 'Customer-facing technical roles (forward deployed, solutions, sales or customer engineering, consulting, account management), or research mentions a role-play or customer simulation.',
    formats: ['sales_roleplay', 'case', 'pitch_demo'],
    archetypes: ['potential', 'pressure', 'communication'],
    blueprintDirective:
      "Script a realistic customer scenario drawn from the job: the customer's industry and problem, constraints (data access, security, timeline, budget) and one skeptical stakeholder. Stage it: discovery questions the candidate should ask, a hidden requirement revealed only if asked, an objection, a technical or scope trade-off, and a close with next steps. idealSignal: structured discovery, a feasible plan, honesty about limits and clear next steps.",
    voiceDirective:
      "Step into the customer's role: you have a real problem, little time and some skepticism. Reveal information only when asked good questions, raise one realistic objection (security, cost, reliability, a failed earlier attempt), and step out of the role briefly at the end to ask the candidate to reflect.",
    evaluationLens:
      "Reward discovery before solutioning, turning the customer's goal into a concrete and feasible plan, handling objections with evidence, honesty about what will not work and clear next steps; penalize pitching before understanding, overpromising and jargon aimed at a non-technical buyer.",
  },
  'problem-decomposition': {
    key: 'problem-decomposition',
    labelEn: 'Ambiguous problem decomposition',
    summary: 'A broad real-world problem the candidate must break down, prioritize and turn into a concrete plan, mixing data, people and technology.',
    whenToUse: 'Companies known for decomposition rounds or open-ended real-world problems, and generalist problem-solving roles.',
    formats: ['case', 'system'],
    archetypes: ['potential'],
    blueprintDirective:
      "Open with a deliberately underspecified problem from the job's domain (for example \"a hospital network wants shorter emergency waits; you have their data\"). Plan the arc: clarify the goal and constraints, break the problem into parts, choose what to do first and why, define success metrics, then change one constraint. idealSignal: a clear decomposition, sensible priorities and measurable outcomes; there is no single right answer.",
    voiceDirective:
      'State the problem in one or two sentences and let silence work. Answer clarifying questions with realistic detail, push the candidate to commit to priorities, then change a constraint (budget halved, data missing, an earlier deadline) and watch them adapt.',
    evaluationLens:
      'Reward the right clarifying questions, a mutually exclusive breakdown, priorities with reasons, measurable success criteria and adapting to changed constraints; penalize jumping to a solution, trying to do everything and ignoring stakeholders.',
  },
  'consulting-case': {
    key: 'consulting-case',
    labelEn: 'Case plus personal experience',
    summary: 'A business case (interviewer-led or candidate-led) paired with one deep personal-experience story, as strategy firms run them.',
    whenToUse: 'Consulting, strategy and corporate development roles, or research mentions case interviews or a personal experience interview.',
    formats: ['case', 'behavioral'],
    archetypes: ['potential', 'behavioral'],
    blueprintDirective:
      'Combine one business case (structure, an exhibit to read, a calculation, a recommendation) with one personal-experience story on leadership, influence or drive, explored for about ten minutes with detailed follow-ups. Say whether the case is interviewer-led (the interviewer directs each step) or candidate-led (the candidate drives), following the company research.',
    voiceDirective:
      'Run the case the way the company does: interviewer-led means you direct each step and hand over the data; candidate-led means you wait for the candidate to drive. In the personal story, ask for moment-by-moment detail: what they said, how the other person reacted, what they did next.',
    evaluationLens:
      'Reward hypothesis-driven structure, accurate math, a "so what" synthesis and a crisp recommendation, plus a personal story with specific actions; penalize recited frameworks, calculation errors and stories without personal agency.',
  },
  'mission-judgment': {
    key: 'mission-judgment',
    labelEn: 'Mission and judgment',
    summary: 'Why the candidate wants this mission, and how they reason about impact, ethics and safety in the work.',
    whenToUse: 'Mission-driven organizations (AI labs, healthcare, climate, non-profits, public sector), or research highlights mission, safety or ethics questions.',
    formats: ['culture', 'behavioral'],
    archetypes: ['behavioral', 'potential'],
    blueprintDirective:
      'Include a "why this mission, why now" question that needs specifics about the organization, a judgment scenario where shipping fast conflicts with safety, privacy or users’ wellbeing, and a time the candidate raised an unpopular concern. idealSignal: specific, informed motivation and principled but pragmatic judgment.',
    voiceDirective:
      "Be warm but probing about motivation: ask what specifically about this organization's work matters to them, and present one realistic dilemma where the mission and a short-term goal collide.",
    evaluationLens:
      'Reward specific, informed motivation, principled judgment that still delivers, and evidence of acting on values at a cost; penalize generic enthusiasm, recited marketing lines and judgment that ignores real trade-offs.',
  },
  'safety-quality': {
    key: 'safety-quality',
    labelEn: 'Safety, quality and compliance',
    summary: 'Regulated or safety-critical work: standards, quality systems, root-cause analysis and speaking up.',
    whenToUse: 'Aerospace, automotive, energy, healthcare, pharma, medical devices, manufacturing, and risk or compliance roles, or research mentions safety culture or quality standards.',
    formats: ['behavioral', 'situational_judgement', 'practical_skills', 'ops_case'],
    archetypes: ['depth', 'behavioral'],
    blueprintDirective:
      'Cover the standards the job names (or the usual ones in the industry), one root-cause investigation the candidate led (5 Whys, fishbone, 8D or equivalent), one time they stopped work or escalated a safety or quality concern, and one scenario where schedule pressure conflicts with compliance. idealSignal: procedure followed, documented, escalated, a data-driven root cause and preventive action.',
    voiceDirective:
      'Be methodical and serious about safety: ask for exact procedures, documentation and who they escalated to, and challenge any shortcut taken under schedule pressure.',
    evaluationLens:
      'Reward rigor, adherence to standards, clear escalation, root cause with corrective and preventive action, and documentation; penalize shortcuts, blame and vague process descriptions.',
  },
  'fundamentals-drill': {
    key: 'fundamentals-drill',
    labelEn: 'Fundamentals drill',
    summary: "Rapid knowledge questions on the field's core concepts, each followed by a \"why\".",
    whenToUse: 'Employers that test core knowledge directly: engineering fundamentals rounds (common at large mainland Chinese companies), finance technicals, clinical knowledge checks.',
    formats: ['technical', 'finance_technical', 'clinical_scenario'],
    archetypes: ['breadth', 'depth'],
    blueprintDirective:
      "Prepare eight to twelve short knowledge questions across the job's core topics, from basic to deep, each with the one follow-up that checks real understanding (\"why does that happen?\", \"what changes if…?\"). idealSignal: an accurate, concise explanation of the underlying mechanism.",
    voiceDirective:
      'Keep a brisk rhythm: one concept per question, one "why" follow-up, then move on. If the candidate is wrong, ask one guiding question and move on without lecturing.',
    evaluationLens:
      'Reward accurate, mechanism-level explanations and knowing the limits of one’s knowledge; penalize memorized phrases that fall apart at the first "why" and guesses presented as fact.',
  },
  'quant-reasoning': {
    key: 'quant-reasoning',
    labelEn: 'Quant and mental-math reasoning',
    summary: 'Mental math, probability, expected value and estimation under time pressure, sometimes as a market-making game.',
    whenToUse: 'Trading, quantitative research, actuarial and some data roles, or research mentions mental math, probability puzzles or market making.',
    formats: ['technical', 'case'],
    archetypes: ['pressure', 'potential'],
    blueprintDirective:
      'Mix quick mental arithmetic, probability and expected-value questions, one estimation, and one simple market-making game (quote a two-sided market on an uncertain quantity, then update on new information). idealSignal: correct answers reached quickly, with the reasoning said aloud and sound updating.',
    voiceDirective:
      'Keep the clock present ("about thirty seconds"), ask for the reasoning aloud, add new information in the middle of the market-making game, and push for a number rather than a hedge.',
    evaluationLens:
      'Reward speed with accuracy, clear probabilistic reasoning, sensible updating and composure; penalize freezing, refusing to commit to a number and unchecked arithmetic.',
  },
  'finance-superday': {
    key: 'finance-superday',
    labelEn: 'Finance superday',
    summary: 'Back-to-back rounds mixing accounting and valuation technicals, a deal or market discussion, and fit.',
    whenToUse: 'Investment banking, private equity, asset management and corporate finance roles, or research mentions a superday.',
    formats: ['finance_technical', 'behavioral', 'modeling_test'],
    archetypes: ['depth', 'pressure'],
    blueprintDirective:
      'Alternate fit questions (a resume walk-through, why this firm) with technicals (the three statements, valuation methods, DCF mechanics, and accretion/dilution or LBO basics as the level warrants) and one recent deal or market view the candidate must defend.',
    voiceDirective:
      'Be crisp and time-conscious, like a banker between meetings: expect a tight resume walk-through, ask technicals in quick succession, and challenge the deal or market view.',
    evaluationLens:
      'Reward accurate technicals, a tight story, commercial awareness and composure; penalize memorized answers without understanding and an unprepared market view.',
  },
  'group-discussion': {
    key: 'group-discussion',
    labelEn: 'Group discussion',
    summary: 'A group task or debate judged on contribution, structure and collaboration; simulated here with the interviewer voicing the other participants.',
    whenToUse: 'Graduate and campus hiring in mainland China, Japan, Korea or India, assessment centres, or research mentions a group interview round.',
    formats: ['panel', 'case'],
    archetypes: ['communication', 'pressure'],
    blueprintDirective:
      'Set a short group task (rank options, solve a business problem, debate a statement) with a time limit, and script two or three simulated participants with distinct stances (a dominant talker, a quiet expert, a contrarian). Plan moments where the candidate can structure the discussion, include others, keep time and summarize. idealSignal: constructive leadership without dominating.',
    voiceDirective:
      'Act as the moderator and, when needed, voice the other participants briefly in the third person ("Participant B argues that…"). Give the candidate chances to structure, build on others, handle the contrarian and summarize before time runs out.',
    evaluationLens:
      'Reward structuring the discussion, building on and including others, time management, handling disagreement and a clear summary; penalize dominating, staying silent and attacking people instead of ideas.',
  },
  'hr-final': {
    key: 'hr-final',
    labelEn: 'HR or final round',
    summary: 'Motivation, stability, career plan, culture fit, expectations and questions for the company — the round that turns a pass into an offer.',
    whenToUse: 'Final or HR rounds (a standard step in mainland China, Taiwan, Japan and Korea), or a candidate close to an offer.',
    formats: ['screening', 'culture'],
    archetypes: ['warmup', 'behavioral'],
    blueprintDirective:
      'Cover the self-introduction, why this company and role, a three-to-five-year plan, reasons for leaving or choosing, strengths and a real weakness, salary and start-date expectations handled professionally, and the candidate’s questions for the company.',
    voiceDirective:
      "Be friendly but observant: listen for consistency, stability and realistic expectations. Ask about salary expectations and other offers the way local HR would, and close by inviting the candidate's questions; react to their quality.",
    evaluationLens:
      'Reward consistent, specific motivation, a realistic career plan, a candid weakness with a plan, professional handling of salary and good questions for the company; penalize generic answers, negativity about past employers and unrealistic expectations.',
  },
  'cross-team': {
    key: 'cross-team',
    labelEn: 'Cross-team round',
    summary: "An interviewer from a neighboring team checks breadth, learning ability and consistency rather than the job's core skill.",
    whenToUse: 'Companies with a cross-team review round (common at large Chinese tech companies) or senior hires reviewed outside the team.',
    formats: ['panel', 'behavioral'],
    archetypes: ['breadth', 'potential'],
    blueprintDirective:
      'Ask about adjacent areas the candidate should understand, how they learn a new domain fast, one project seen from a different angle (business impact, users, cost), and one open problem outside their specialty. idealSignal: broad understanding, learning ability and a consistent self-presentation.',
    voiceDirective:
      'You are from another team: curious and broad, less interested in the core skill than in how the candidate thinks outside it. Check that their story is consistent with what they would have told the hiring team.',
    evaluationLens:
      'Reward breadth, fast learning, business awareness and consistency; penalize narrow answers and contradictions with the candidate’s own earlier statements.',
  },
  'presentation-qa': {
    key: 'presentation-qa',
    labelEn: 'Presentation and Q&A',
    summary: 'The candidate presents a topic or a prepared case, then defends it under questions.',
    whenToUse: 'Assessment centres, senior roles, consulting and marketing, markets where presentation interviews are common (for example Korea), or research mentions a presentation round.',
    formats: ['presentation', 'pitch_demo'],
    archetypes: ['communication', 'depth'],
    blueprintDirective:
      'Give a presentation brief tied to the job (a short analysis, a plan or a past project), let the candidate present for a few minutes, then plan challenging questions on assumptions, data, risks and alternatives.',
    voiceDirective:
      'Let the candidate present without interrupting, then question like a stakeholder panel: assumptions, numbers, risks, and what they would cut with half the budget.',
    evaluationLens:
      'Reward a clear storyline, headline-first structure, evidence, time management and composed answers; penalize reading notes, running over time and defensive answers.',
  },
  'startup-generalist': {
    key: 'startup-generalist',
    labelEn: 'Startup generalist',
    summary: 'Speed, ownership and range: how the candidate gets things done with little structure and few resources.',
    whenToUse: 'Early-stage startups and small teams, or research shows founder interviews and work trials.',
    formats: ['behavioral', 'case', 'culture'],
    archetypes: ['warmup', 'potential'],
    blueprintDirective:
      'Ask about something the candidate shipped end to end, a time they worked well outside their job title, how they prioritize with no clear owner, and a quick product or business problem the company actually faces.',
    voiceDirective:
      'Be informal and quick like a founder; test resourcefulness and judgment; ask what they would do in their first two weeks.',
    evaluationLens:
      'Reward bias to action with judgment, end-to-end ownership, range and resourcefulness; penalize dependence on heavy process, narrow scope and plans instead of results.',
  },
  'learning-culture': {
    key: 'learning-culture',
    labelEn: 'Learning and collaboration culture',
    summary: 'How the candidate learns from mistakes, collaborates across teams and helps others grow.',
    whenToUse: 'Companies whose stated culture centers on learning, inclusion and collaboration, or research mentions a growth mindset.',
    formats: ['behavioral', 'culture'],
    archetypes: ['behavioral'],
    blueprintDirective:
      'Ask for a time they were wrong and changed their mind, learned a new skill fast, received hard feedback, collaborated across team boundaries, and helped a colleague succeed.',
    voiceDirective:
      'Be supportive and curious; ask what they learned and what they now do differently, and probe for the specific change in behavior.',
    evaluationLens:
      'Reward real learning with changed behavior, openness to feedback and collaboration that helped others; penalize defensiveness and stories in which nothing changed.',
  },
  'one-way-video': {
    key: 'one-way-video',
    labelEn: 'One-way video interview',
    summary: 'Recorded-style screening: fixed questions, short preparation time, timed answers, no follow-ups.',
    whenToUse: 'Employers that screen with one-way video or AI interview platforms (graduate programmes, high-volume hiring).',
    formats: ['screening', 'behavioral'],
    archetypes: ['warmup'],
    blueprintDirective:
      'Prepare five to seven standalone questions, each with a stated preparation time and answer time (for example 30 seconds to prepare and 2 minutes to answer); no follow-up ladders. idealSignal: a complete, structured answer within the time.',
    voiceDirective:
      'Read each question, state the preparation and answer time, do not react or follow up, and move to the next question when the time is up.',
    evaluationLens:
      'Reward complete, structured answers within the time, clear delivery and relevance; penalize running out of time, rambling and unfinished structure.',
  },
  'competency-based': {
    key: 'competency-based',
    labelEn: 'Competency-based interview',
    summary: 'Questions mapped to a published competency or strengths framework, answered with specific examples and scored per competency.',
    whenToUse: 'UK and European employers, the public sector and large corporates that publish competency or strengths frameworks.',
    formats: ['behavioral'],
    archetypes: ['behavioral'],
    blueprintDirective:
      'Map each question to one competency from the job description, ask for one specific example, and plan two follow-ups on the action and the impact; include one strengths-based question ("what energizes you at work?").',
    voiceDirective:
      'Be polite and structured: name the competency area, ask for one example, and follow up on what the candidate did and what changed as a result.',
    evaluationLens:
      'Score each competency on the evidence given; reward specific actions and measurable impact; penalize hypothetical answers and team-only stories.',
  },
};

export const INTERVIEW_PATTERN_KEYS = Object.keys(INTERVIEW_PATTERNS) as InterviewPatternKey[];

export function getPattern(key: string | null | undefined): InterviewPatternPlaybook | null {
  return key && Object.prototype.hasOwnProperty.call(INTERVIEW_PATTERNS, key)
    ? INTERVIEW_PATTERNS[key as InterviewPatternKey]
    : null;
}
