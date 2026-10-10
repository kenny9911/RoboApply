export const meta = {
  name: 'jobright-bundle-wave',
  description: 'Implement a wave of disjoint bundles: each bundle in its own worktree, implement → independent review → fix',
  phases: [
    { title: 'Implement', detail: 'one engineer per bundle in its own worktree' },
    { title: 'Review', detail: 'independent review per bundle against its items and the plan documents' },
    { title: 'Refix', detail: 'resolve review findings, gates green' },
  ],
}
// args: {
//   wave: 'PAR' | 'MKT-A' | …,
//   bundlesFile: repo-relative path of the bundles JSON ({ bundles: [{ id, title, namespace, owns, items }] }),
//   docs: [repo-relative plan documents every engineer reads],
//   handoffDir: absolute directory for the handoff files,
//   context: extra wave-specific instructions (string, may be empty),
//   items: [{ id, worktree }]
// }
const CLONE = '/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone'
const A = args
const docsList = (wt) => (A.docs || []).map((d) => ` - ${wt}/${d}`).join('\n')

function common(id, wt) {
  return `
You are a senior full-stack engineer on the Jobright clone of RoboApply: one codebase, two brands resolved per request from the Host header. RoboApply (roboapply.io) serves the international market including Taiwan (market 'intl'); GoApply (goapply.top) serves mainland China (market 'cn').
YOUR BUNDLE: ${id} (wave ${A.wave}).
YOUR WORKTREE (cwd for every command; work ONLY here): ${wt} — branch wp/${id}. Never cd into or modify /Users/kenny/code/RoboApply (main checkout), the clone worktree (${CLONE}: the owner's dev stack RUNS from it), or any other wp-* worktree (sibling bundles run in parallel). The single exception is your handoff file (see HANDOFF).

READ FIRST
 - ${wt}/${A.bundlesFile} → the bundle with id "${id}". "items" is your work (each item: priority, CHANGE, ACCEPT, TESTS, FILES). "owns" is your EXCLUSIVE file ownership. "namespace" lists the i18n staging namespaces you own. Read the top-level "notes" too.
${docsList(wt)}
 - ${wt}/docs/jobright-clone/README.md (rulings D1–D6 and owner decisions), ${wt}/AGENTS.md (repository rules; this is NOT the Next.js you know: read node_modules/next/dist/docs before using a Next API you are unsure of).

BINDING RULINGS
 - D1: the product never submits a job application. It prepares everything; the user clicks Submit.
 - D3: never fabricate data, sources, licences, prices or counts. An honest empty state beats filler.
 - D5: GoApply and RoboApply have the same robust functionality. A capability that is on for RoboApply is on for GoApply by default; China-specific providers are optional overrides that fall back to the shared stack. Only the job boards, job sources, job-search APIs and what follows from the market (language, currency, prices, payment rail, extra sign-in methods, legal lines) differ.
 - D6: sources, prices and payment rails are per market. Mainland China pays with Alipay through the EXISTING implementation, which must keep working exactly as it does (additive changes only, frozen by characterisation tests). The international brand pays with Stripe.
 - PRECEDENCE: where a bundle item disagrees with the plan documents listed above, the documents win. Say so in your handoff.
${A.context ? '\nWAVE CONTEXT\n' + A.context + '\n' : ''}
METHOD
 For each item, in priority order (P0, P1, P2): read the code paths it names (line numbers may have drifted: find the code, do not trust the number); write or rewrite the tests first so they state the new truth; implement the root change (one rule in one place, never a special case per caller); meet every ACCEPT line. A test that pinned old behaviour which the item deliberately changes is rewritten by you when you own it: it either sets the documented off switch explicitly or asserts the new default. Do every item unless it is wrong (say why, with evidence from the code) or needs a change outside your owns (put the exact change, file and reason under Requests, addressed to the owning bundle id or to the orchestrator).

RULES
 - Edit only paths inside your owns (new files inside owned directories and tests colocated with owned files are fine). Anything else is a Request.
 - i18n: never edit i18n/messages/*.json. A NEW or CHANGED English string goes to i18n/staging/<namespace>.en.json for a namespace you own (shape {"<namespace>": {...}}; the runtime merges staging over en.json; the orchestrator merges and translates into all nine locales afterwards). GoApply-only Chinese copy also goes to i18n/staging/<namespace>.zh.json. Copy is brand-neutral (%BRAND%), plain language, no jargon, no em dashes.
 - Database: never edit *.prisma files and never run prisma db push, migrate, DDL or DML, unless the wave context above says this bundle owns the schema. A schema need goes under "Schema requests" as an exact ADDITIVE Prisma snippet (new model, new nullable or defaulted column, new index).
 - No new runtime dependency (ask under Requests). Server TypeScript is ESM with .js suffixes on relative imports. Route handlers stay thin; logic lives in the service or library module. Frontend API access stays behind lib/api/.
 - Never commit, push, stash, reset, rebase or switch branches. Never print a secret value. Do not run next build, a dev server or a browser. Tests must never reach a real database or the network (the suite pins DATABASE_URL to a closed port; mock HTTP clients).
 - UI work: both brands, light and dark, 375px and 1280px; design tokens only (bg-bg-card and friends, never literal bg-white); load the "roboapply-design" skill first if the Skill tool is available.
 - RoboApply must not regress: unless an item says otherwise its behaviour, plans, providers and copy are unchanged.

GATES (run in your worktree; all green before you finish)
 the tests you wrote or touched; 'npm run typecheck:server' for server changes; 'npx next typegen && npm run typecheck:web' for web changes; 'npm run check' when copy or UI changed; then the whole suite: 'npx vitest run --exclude ".claude/**"'. If you touched extension/: 'npm --prefix extension run typecheck && npm --prefix extension test'. If you touched interview-agent/: 'npm --prefix interview-agent test' (and its typecheck script if it has one).
 A test that fails OUTSIDE your owns because of your change: do not edit it. List it under "Red tests for other bundles" with the owning bundle id (find the owner in the bundles file) and one line on what the test should now assert. A test that already failed before your change (decide by reading the failure and 'git diff'; never stash or reset to find out) is listed under "Pre-existing failures".

HANDOFF
 Write the handoff as Markdown to ${A.handoffDir}/${id}.md (create the directory if needed; this is the only file you may write outside your worktree) AND return the same text as your final message. Sections: "# ${id}" · Items (per item: done + what changed + tests / rejected + why / not done + what is needed) · Files changed · Tests run (commands and pass counts) · Red tests for other bundles · Pre-existing failures · Requests (by bundle id / orchestrator / owner) · Schema requests · Env variables added or redefined (name, meaning, default) · i18n keys added or changed · Known gaps.`
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, done: { type: 'boolean' }, evidence: { type: 'string' } }, required: ['item', 'done'] } },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] }, file: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' }, fix: { type: 'string' } }, required: ['severity', 'title', 'detail', 'fix'] } },
    unownedEdits: { type: 'array', items: { type: 'string' } },
  },
  required: ['items', 'findings', 'unownedEdits'],
}

async function runBundle(id, wt) {
  const impl = await agent(`${common(id, wt)}\n\nTASK: implement every item of bundle ${id}.`, { label: `impl:${id}`, phase: 'Implement', effort: 'high' })
  const review = await agent(`You are an independent senior reviewer for bundle ${id} (wave ${A.wave}) of the Jobright clone of RoboApply (two brands by Host: RoboApply international incl. Taiwan; GoApply mainland China). READ-ONLY: do not edit, create or delete any file.
Worktree: ${wt} (branch wp/${id}). Inspect the uncommitted work: 'git -C ${wt} status --porcelain -uall', 'git -C ${wt} diff', and read the untracked files.
Read ${wt}/${A.bundlesFile} (bundle "${id}": items, owns, namespace; top-level notes) and the plan documents:
${docsList(wt)}
Rulings: D1 the product never submits an application; D3 never fabricate data; D5 same functionality on both brands, China providers are optional overrides falling back to the shared stack; D6 per-market sources, prices and rails, the existing Alipay path must keep working exactly as it does, Stripe for the international brand. Where an item and the plan documents disagree, the documents win.
${A.context ? 'WAVE CONTEXT\n' + A.context + '\n' : ''}
For EACH item decide whether every ACCEPT line is really met: trace the code path, do not accept a test that only asserts the new code exists, and give evidence (file:line). Then hunt for defects the change introduces: other callers of changed functions (grep them), RoboApply regressions, GoApply still dark by a leftover gate, credential sets mixed across brands, brand identity leaking across brands, authz gaps, races and replay safety (payments, webhooks, grants), money and unit errors, secrets in logs, tests that reach the network or a database, i18n keys used but not staged, copy that is not plain language, mobile layout. List every changed path that is not inside the bundle's owns (i18n staging files for its namespaces and tests colocated with owned files are fine). Run the bundle's tests and the relevant typecheck.
Report only real, specific defects, each with a concrete fix.

ENGINEER HANDOFF:
${impl || '(none returned; read ' + A.handoffDir + '/' + id + '.md if it exists)'}`, { label: `review:${id}`, phase: 'Review', schema: REVIEW_SCHEMA, effort: 'high' })
  const blocking = review ? review.findings.filter((f) => f.severity !== 'low') : []
  const undone = review ? review.items.filter((a) => !a.done) : []
  let final = impl
  if (review && (blocking.length || undone.length || review.unownedEdits.length)) {
    final = await agent(`${common(id, wt)}\n\nTASK: finish bundle ${id} after an independent review. Your work is already in the worktree (uncommitted). Resolve every real review finding and every item the reviewer judged not done (verify each first; reject a wrong one with a reason and evidence). Revert unowned edits (those paths only, with 'git checkout -- <path>' for tracked files or by deleting the new file) and move the need into Requests. Re-run all gates. Rewrite ${A.handoffDir}/${id}.md as the COMPLETE updated handoff plus a "Review resolution" list, and return it as your final message.\n\nREVIEW:\n${JSON.stringify({ undone, findings: review.findings, unownedEdits: review.unownedEdits }, null, 2)}\n\nPREVIOUS HANDOFF:\n${impl || '(none)'}`, { label: `refix:${id}`, phase: 'Refix', effort: 'high' })
  }
  return { id, worktree: wt, review: review ? { undone: undone.length, findings: review.findings.length, blocking: blocking.length, unowned: review.unownedEdits } : null, handoffChars: (final || '').length }
}

const results = await pipeline(A.items, (item) => runBundle(item.id, item.worktree))
return results.filter(Boolean)
