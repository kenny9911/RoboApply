export const meta = {
  name: 'jobright-wave-gate-v2',
  description: 'Gate after a merged wave: apply orchestrator requests, make the merged tree green, cross-bundle review through several lenses, fix',
  phases: [
    { title: 'Integrate', detail: 'requests addressed to the orchestrator, queue items, red tests at the seams, all gates' },
    { title: 'Cross-review', detail: 'independent read-only reviewers, one lens each' },
    { title: 'Fix', detail: 'resolve the findings, gates green' },
  ],
}
// args: { wave, handoffDir, bundlesFile, docs: [repo-relative], context, lenses: [{ key, prompt }], schemaOwner?: boolean }
const CLONE = '/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone'
const PLAN = CLONE + '/docs/jobright-clone'
const A = args
const docs = (A.docs || []).map((d) => ` - ${CLONE}/${d}`).join('\n')

const COMMON = `
You are the integration engineer for the Jobright clone of RoboApply: one codebase, two brands resolved per request from the Host header. RoboApply (roboapply.io) serves the international market including Taiwan (market 'intl'); GoApply (goapply.top) serves mainland China (market 'cn'). Wave ${A.wave} has just been merged into branch feat/jobright-clone.
WORKING DIRECTORY: ${CLONE} (the clone worktree; the owner's dev stack runs from it and hot-reloads your edits). Work ONLY here: never in /Users/kenny/code/RoboApply (the main checkout) or any wp-* worktree.
READ:
 - the wave's handoffs, one Markdown file per bundle, in ${A.handoffDir}/ (sections: Items, Red tests for other bundles, Requests, Schema requests, Env variables, i18n keys, Known gaps, Review resolution)
 - ${CLONE}/${A.bundlesFile} (bundles, owns, items, notes)
${docs}
 - ${PLAN}/README.md (rulings D1–D6), ${PLAN}/requests/orchestrator-queue.md (work the orchestrator owes at this gate), ${CLONE}/AGENTS.md
RULINGS: D1 the product never submits a job application. D3 never fabricate data, sources, licences, prices or counts. D5 both brands have the same robust functionality; China-specific providers are optional overrides that fall back to the shared stack; only job boards, job sources, job-search APIs and what follows from the market differ. D6 sources, prices and rails are per market; mainland China pays with Alipay through the EXISTING implementation, which must keep working exactly as it does: the characterisation tests named "A<n> …" are never edited, and server/src/platform/billing/fulfilPass.ts, the Alipay callback route and handleAlipayCallback are not edited; the international brand pays with Stripe.
YOU ACT FOR THE ORCHESTRATOR at a wave gate, so you MAY edit any merged file, hot files included, to integrate. Keep every change minimal and explained. Do NOT commit, push, stash, reset, rebase or switch branches. ${A.schemaOwner ? 'Schema: additive changes only, and never run db push or any DDL / DML (the orchestrator pushes after reading the diff).' : 'Do NOT edit *.prisma files and never run prisma db push, migrate, db execute or any DDL / DML; a schema need goes to "Owner decisions / schema".'} No new runtime dependency. Never print a secret value; the clone .env holds LIVE third-party keys (a live Stripe key among them), so no command or test may call a real provider. Do not start or stop servers, and do not run 'next build' (it would fight the running dev server over .next).
i18n: do not edit i18n/messages/*.json (the orchestrator merges i18n/staging and translates after this gate). A missing string is added to i18n/staging/<namespace>.en.json (GoApply-only Chinese also to <namespace>.zh.json).
${A.context ? 'WAVE CONTEXT\n' + A.context + '\n' : ''}
GATES (run from ${CLONE}; all must be green at the end): 'npx prisma validate', 'npm run db:generate', 'npm run gen:brand' (must leave no diff), 'npm run typecheck:server', 'npx next typegen && npm run typecheck:web', 'npx vitest run --exclude ".claude/**"', 'npm run check', 'npm --prefix extension run typecheck', 'npm --prefix extension test', and 'npm --prefix interview-agent test' when interview-agent/ changed in this wave.`

phase('Integrate')
const integ = await agent(`${COMMON}

TASK: integrate wave ${A.wave}.
1) Read EVERY handoff in ${A.handoffDir}/ in full. Build one table of every Request, Red test for another bundle, Schema request and Known gap: source bundle, target (another bundle of this wave / orchestrator / owner / a later wave), what, and what you did.
2) Run the whole suite first and list what is red. A red test at a seam between two bundles is yours: decide from the plan documents which side is right, fix the code or the test (never an "A<n> …" Alipay characterisation test: if one is red, the code is wrong), and say which.
3) Apply every request addressed to the orchestrator or to a hot file, and every request one bundle addressed to another bundle of this wave that the target did not carry out (check the code: many were done in parallel). Apply every item of the "At the parity-wave (PAR) gate" section of ${PLAN}/requests/orchestrator-queue.md that is code or documentation in this repository (not the i18n merge, not database rows), and delete each line you completed from that file.
4) Verify the cross-bundle contracts named in the plan documents field by field: producer and consumer agree on paths, request and response shapes, error codes, capability and flag keys, env variable names and defaults; the consumer is wired to the real producer, not to a default or a stub.
5) What belongs to a LATER wave or bundle: do not build it; write it to ${PLAN}/requests/wave${A.wave}-carryover.md grouped by target, with enough detail to act on. What only the owner can decide or supply goes under "Owner" there.
6) Run all GATES until green.
Return: the table, every fix with its reason, env variables that are new or redefined after this wave (name, meaning, default), the i18n staging state (namespaces with new keys), and the final gate results with counts.`, { label: `integrate-${A.wave}`, phase: 'Integrate', effort: 'high' })

const REVIEW_SCHEMA = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, file: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'title', 'detail', 'fix'] } }, checked: { type: 'array', items: { type: 'string' } } }, required: ['findings'] }

phase('Cross-review')
const reviews = await parallel((A.lenses || []).map((l) => () => agent(`${COMMON}

ROLE: READ-ONLY reviewer of the merged wave. Do not edit, create or delete any file; you may run tests, typechecks and read-only curl requests against the running dev stack (API http://localhost:4621, RoboApply web http://localhost:3621, GoApply web http://goapply.localhost:3621; send 'Host: goapply.localhost:3621' to the API for GoApply). Never sign up real people, never start a payment, never call a third-party provider.
LENS (${l.key}): ${l.prompt}
The integrator reported:
${integ}

Report only real, specific defects (file and line, what happens, why it is wrong under the plan documents or the rulings) each with a concrete fix. List under "checked" what you verified and found correct.`, { label: `xreview-${A.wave}-${l.key}`, phase: 'Cross-review', schema: REVIEW_SCHEMA, effort: 'high' }).then((r) => (r ? { key: l.key, ...r } : null))))
const findings = reviews.filter(Boolean).flatMap((r) => r.findings.map((f) => ({ lens: r.key, ...f }))).filter((f) => f.severity !== 'low')
const low = reviews.filter(Boolean).flatMap((r) => r.findings.map((f) => ({ lens: r.key, ...f }))).filter((f) => f.severity === 'low')
log(`cross-review findings: ${findings.length} to fix, ${low.length} low`)

phase('Fix')
let fix = 'no findings'
if (findings.length || low.length) {
  fix = await agent(`${COMMON}

TASK: resolve the cross-review findings below. Verify each against the code first; fix the real ones at the root (with a test that fails before and passes after, where a test can express it); reject a wrong one with evidence. Low findings: fix when it is a few lines, otherwise carry over. A larger gap that belongs to a later wave goes to ${PLAN}/requests/wave${A.wave}-carryover.md. Re-run all GATES until green.
Return: finding → fixed (root cause, fix, test) / rejected (why) / carried over (where), then the final gate results with counts.

FINDINGS TO FIX:
${JSON.stringify(findings, null, 2)}

LOW FINDINGS:
${JSON.stringify(low, null, 2)}`, { label: `fix-${A.wave}`, phase: 'Fix', effort: 'high' })
}
return { integ, findings: findings.length, low: low.length, fix }
