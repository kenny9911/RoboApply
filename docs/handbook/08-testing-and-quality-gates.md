# Testing and quality gates

As of 2026-11-03 (main @ b89d5256).

The repository has three packages, each with its own tests: the root (Next app and Express API, Vitest), `extension/` (Vitest), and `interview-agent/` (`node --test`). Root `npm test` covers only the root. CI runs all three. The static gates (`npm run check`) catch failures that the build and the tests do not: missing translation keys, banned copy, design-scale drift, raw API URLs in components, and an extension that could press Submit.

## Vitest (root)

### Configuration

[`vitest.config.mts`](../../vitest.config.mts) is a single config with no `projects`:

- **Environment.** The default is `jsdom`. Server tests opt out per file with a `// @vitest-environment node` docblock (552 of the 802 root test files on 2026-11-03). Add it to every new server test.
- **`globals: false`.** Import `describe`/`it`/`expect`/`vi` from `vitest`.
- **Include.** `__tests__/**/*.test.ts(x)` and `**/*.test.ts(x)`.
- **Exclude.** `**/node_modules/**`, `**/.claude/**` (agent worktrees are separate checkouts), `**/.codex/**`, `.next/**`, `dist/**`, `interview-agent/**`, `extension/**`.
- **Database pinning.** `env` pins `DATABASE_URL` and `DIRECT_DATABASE_URL` to `postgresql://ci@127.0.0.1:1/ci`, a closed port, and `server/src/lib/prisma.ts` skips loading `.env` under `VITEST`. A stray query fails fast with "connection refused" and can never reach Neon. Tests must not depend on `.env`; CI has none.
- **Setup file.** [`__tests__/setup.ts`](../../__tests__/setup.ts) adds the jest-dom matchers, runs `cleanup()` after each test, and polyfills `matchMedia`, `ResizeObserver` and `Element.scrollTo`. It also adds the Node 26 Web Storage shim and silences React's `act()` warning. It deletes `CN_ALIPAY_NOTIFY_ORIGIN`, `ALIPAY_SECRETLESS_UNTIL` and `CN_ALIPAY_PACKAGE_ID_MODE` from the environment so a developer's shell cannot move the frozen Alipay tests.
- **Aliases.** `@/`, `@/components`, `@/lib`, `@/app`, the same as `tsconfig.json`.

[`vitest.eval.config.mts`](../../vitest.eval.config.mts) is used only by `npm run eval:match`. It runs in a `node` environment, collects only `server/src/features/match/eval/**/*.eval.ts`, pins the same database URLs, and installs an offline guard that makes `fetch` throw.

### Where tests live

Tests sit next to the code (`foo.ts` and `foo.test.ts`), plus a top-level `__tests__/` tree for cross-cutting and page-level tests. Root test files on 2026-11-03:

| Location | Files |
|---|---|
| `server/` | 557 |
| `components/` | 131 |
| `__tests__/` (brand, components, contracts, deploy, hooks, lib, pages, prisma, routeShells, scripts, server, shell, utils) | 82 |
| `hooks/`, `lib/`, `app/`, `scripts/`, `i18n/` | 18, 7, 4, 2, 1 |
| **Total** (`npx vitest list --filesOnly`) | **802** |

The last full green run on record was 794 files and 21,183 tests (owner's figure; the M5 gate on 2026-10-12 recorded 779 files and 20,853 tests). I did not run the full suite for this document.

### Helpers and fixtures

- [`__tests__/utils/renderWithProviders.tsx`](../../__tests__/utils/renderWithProviders.tsx) is the canonical React wrapper. It renders with the real `en.json` in `NextIntlClientProvider`, a fresh `QueryClient` per test (no retries), and a stubbed signed-in user. `mockAuth.tsx`, `mockTranslations.tsx` and `prepFixtures.ts` sit next to it.
- [`__tests__/fixtures/<area>/index.ts`](../../__tests__/fixtures/README.md) holds the contract fixtures. Responses `satisfies` the area's view types, so `typecheck:web` breaks when a contract changes shape. Request fixtures are parsed against their zod schemas by `__tests__/contracts/fixtures.test.ts`. Names are obviously fictional.
- Area test kits, for example `server/src/features/auth-cn/__tests__/testkit.ts`.

### Mocking conventions

These are the patterns visible in the code (counts are the number of root test files that use each `vi.mock` target):

- `vi.mock('…/lib/prisma.js', () => ({ default: db }))` with an in-memory or `vi.fn()` fake (about 221 files). Server imports keep their `.js` suffix in mocks as well.
- `vi.mock('…/services/LoggerService.js')` to silence logging (about 196 files).
- LLM calls: `vi.mock('…/services/llm/LLMService.js', () => ({ llmService: { chat: llm.chat } }))`, where `llm` comes from `vi.hoisted(...)`, often together with a mock of `lib/llm/llmModels.js` (`getModelSetting`). See `server/src/job-search/agent.test.ts`. No test calls a real model.
- Frontend: `next/navigation` (about 71 files), `@/lib/auth/AuthProvider` (about 48), and the `lib/api/*` area wrappers.
- **Dependency injection** is preferred in newer feature code: services take a `deps` object (for example `deps.createSession` in `server/src/features/auth/service.ts`), and tests pass fakes rather than module mocks.
- **Frozen tests.** Tests named `A<n> …` (Alipay characterisation, in `server/src/platform/billing/` and `server/src/roboapply/…billing…`) are never edited, skipped or weakened. If one goes red, the change is wrong ([HANDOFF §5](../jobright-clone/HANDOFF.md)).

## Running tests

```bash
npm test                                              # vitest run: the whole root suite
npx vitest run server/src/job-search/agent.test.ts    # one file
npx vitest run __tests__/scripts                      # one folder
npx vitest run path/to/file.test.ts -t "part of a test name"   # one test by name
npm run test:watch                                    # vitest watch mode
npm run typecheck:server                              # tsc -p server/tsconfig.json --noEmit
npm run typecheck:web                                 # tsc -p tsconfig.json --noEmit
npm --prefix extension test                           # extension: vitest + the no-submit gate
npm --prefix interview-agent test                     # worker: tsc build, then node --test
```

Typecheck coverage has a gap. `server/tsconfig.json` excludes `src/**/*.test.ts` and `__tests__`, and the root `tsconfig.json` excludes `server/`, so **server test files are not type-checked by either command**. Vitest strips types without checking them. Frontend tests and `__tests__/` are covered by `typecheck:web`. If `typecheck:web` reports missing Next route types, run `npx next typegen` first, as the M5 gate did. CI runs `typecheck:web` without it, so it may not be needed (unverified).

Inside the Claude Code Bash sandbox:

- tests that start a server (`app.listen`) fail with `Cannot read properties of null (reading 'port')`. For example, `npx vitest run __tests__/scripts` gives 4 files passing and `alipayNotifyPreflight.test.ts` failing.
- `tsx`-based commands fail with `listen EPERM …tsx-*.pipe`.

Run those outside the sandbox. The sandbox causes these failures; the repository does not.

<a id="e2e"></a>
### End-to-end

- **`e2e/ia-dry-run.py`** is a Python Playwright walk of the information architecture against a running dev server (`RA_APP`, default `http://localhost:3611`): shell and nav, mobile parity, old-route redirects, `/jobs`, `/resume`, `/applications`, `/practice`, `/settings`, banned words, theme, zh rendering, console errors. Run it with `RA_SESSION=<token> python3 e2e/ia-dry-run.py`. Without `RA_SESSION` it runs only the public groups. It is **not maintained and not in CI**. It was last changed on 2026-07-27, before the Paper redesign. It plants the cookie as `session_token`, but the app's cookie is now `ra_session_token` (`lib/config.ts`), so the authenticated groups will not authenticate until that is fixed. Its expected labels predate later UI changes (unverified whether they still match).
- **Extension e2e** (`npm --prefix extension run e2e`): Playwright with an unpacked build against a local fake `/ext` API. It needs `npx --prefix extension playwright install chromium`. It is run before a release, not in CI.
- There is no Playwright setup for the web app in the root `package.json`.

## Quality gates

### `npm run check`

`npm run check` runs six gates in sequence and stops at the first failure. CI runs it. All six exit 0 on main @ b89d5256, except `check:llm-costs`, which I could only run inside the sandbox, where `tsx` cannot start. Each gate accepts `--root <dir>`, which its own tests use.

| Gate | Script | What it enforces | Typical failure and fix |
|---|---|---|---|
| `check:design` | [`scripts/check-design.mjs`](../../scripts/check-design.mjs) | The Paper design system in app chrome: only type-scale font sizes, no half pixels, no uppercase labels, only weights 400/500/600/700, no glow shadows, no legacy font variables, no literal `font-family` (next/font emits hashed names, so a literal family silently falls back to system fonts), no deleted concepts, and brand stylesheets (`styles/brands/*.css`) that redefine only the identity and action tokens. Résumé document styles (`styles/v3-resume.css`, `.rb-*`, résumé components) are exempt. | `type-scale font-size: 13px`: use a scale token. `literal-family`: use `var(--font-ui)`/`var(--font-display)`. Design reference: [`docs/design-system.md`](../design-system.md) and the `roboapply-design` skill. |
| `check:copy` | [`scripts/check-copy.mjs`](../../scripts/check-copy.mjs) | (1) Banned vocabulary in all 9 locale bundles, `i18n/staging`, the GoApply override bundles, the server email bundles and the extension bundles. These are jargon a first-time job seeker would not understand, plus claims the product may not make (for example that it auto-applies). (2) Brand neutrality: no literal "RoboApply"/"GoApply" in a bundle; use `%BRAND%`/`%OTHER_BRAND%`, with the same token count per key in every locale. (3) Call-site integrity: every `t('key')` resolves in `en.json` (plus staged English), and every locale has exactly the English key set. GoApply-only prefixes (`authCn`, `billingCn`, `jobsCn`, `onboardingCn`, `practiceCn`, `notifyCn`, `campus`, `landing.cnHome`) need only `en` and `zh`. | `missing-key`/`missing-string`: add the key to all nine bundles. `orphan-key`: delete it from all nine bundles. `literal-brand`: replace the name with `%BRAND%`. `banned-word`: reword; the rule prints its reason. |
| `check:llm-costs` | [`scripts/print-llm-costs.ts`](../../scripts/print-llm-costs.ts) `--check` | `docs/LLM_COSTS.md` matches the cost table in `server/src/lib/modelCostTable.ts`. It also reports configured models that have no priced row, because those bill at the default tier. | The doc is stale: `npm run llm:costs -- --write` and commit the doc. Uses `tsx`. |
| `check:api-boundary` | [`scripts/check-api-boundary.mjs`](../../scripts/check-api-boundary.mjs) | No raw `/api/v1/` string in `app/`, `components/`, `hooks/` or `lib/` outside `lib/api/**` and `lib/server/publicApi.ts`, and no `prisma as any` in `server/src/features/**` or `server/src/platform/**`. Existing offenders are listed in `scripts/api-boundary-baseline.json`; only new ones fail. | Call a `lib/api/<area>` wrapper. When you remove an offender, delete its baseline row in the same change. |
| `check:extension` | [`scripts/check-extension-no-submit.mjs`](../../scripts/check-extension-no-submit.mjs) | Product rule D1: the extension never presses or submits anything. That means no `.click(`/`.submit(`/`requestSubmit(` in any spelling, no synthetic click, submit or key events, and no submit listeners anywhere in `extension/src`, except `src/adapters/_kit/interact.ts`, which may export only `openListbox` and `chooseOption`, and both must call `assertNotSubmitLike`. | Route the interaction through `_kit/interact.ts`, or drop it. Never widen the allowlist without the owner. |
| `check:zh-variants` | [`scripts/check-zh-variants.mjs`](../../scripts/check-zh-variants.mjs) | Simplified vs Taiwan Traditional vocabulary: no mainland words (简历, 视频 …) in `zh-TW` bundles and no Taiwan words (履歷, 職缺 …) in `zh` bundles. Term lists and exceptions are in `i18n/glossary/zh-variants.json`. | Use the variant's word. A real exception gets an `allow` row (key path, term, reason). |

`check-design.mjs` says in its header that it is "wired into `prebuild`". There is no `prebuild` script in `package.json`, so `npm run build` does **not** run it. Only `npm run check` and CI do.

### Other gates

- **`npm run gen:brand`.** It copies `server/src/platform/brand/registry.ts` byte for byte to `lib/brand/registry.generated.ts`. Edit only the canonical file, then run it. It must leave no diff (`node scripts/gen-brand-mirror.mjs --check` exits 1 when the mirror is stale; `__tests__/lib/brandParity.test.ts` also fails in `npm test`).
- **`npm run eval:match -- --enforce M4`.** This is the match-ranking regression harness ([`server/src/features/match/eval/run.ts`](../../server/src/features/match/eval/run.ts)). It is offline by default (no network, no database), runs the ten ranking invariants through `vitest.eval.config.mts` plus every `eval/suites/*.suite.ts`, and prints a table with layer, metric, value, gate and status. It exits 1 when a due invariant or a gated suite fails. Never edit the ranking baseline by hand, and pass `--write-baseline` only deliberately. `--live` reads the real index and calls models, and it refuses to run unless `EVAL_LIVE=1` is set in the shell. The finished-phase invariants also run inside `npm test` (`eval/enforced.test.ts`). Uses `tsx`.
- **`npm run build`.** This is the exact Vercel build: `prisma generate && tsc -p server/tsconfig.json && next build` (`vercel.json` `buildCommand` matches). Never run it in a checkout where `next dev` is running, because both use `.next`. Build in a separate worktree with a real (not symlinked) `node_modules` and copies of the env files ([HANDOFF §4 step 4](../jobright-clone/HANDOFF.md)). After a build that touches `/legal`, confirm that the route's `.nft.json` trace under `.next/server/app/legal/` lists `content/legal/**`.
- **Schema.** After a schema change: `npx prisma validate`, then `npm run db:generate`, then `typecheck:server` and the server tests. Never `db:push` against an unknown database. The additive-only review is in [HANDOFF §5](../jobright-clone/HANDOFF.md).
- **`npm run lint`** is dead: Next 16 removed `next lint`, and there is no ESLint config. Nothing lints in CI.

## CI

[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs on every `pull_request` and on pushes to `main`. A newer run cancels an older one on the same ref. It uses no secrets, no database and no provider.

| Job | Steps |
|---|---|
| Root (API + web) | Node 24, `npm ci`, `typecheck:server`, `typecheck:web`, `npm test` with `DATABASE_URL=postgresql://ci@127.0.0.1:1/ci`, `npm run check` |
| Extension | root `npm ci` (the extension imports root sources and needs zod), `npm --prefix extension ci`, then `typecheck` and `test` |
| Interview agent | `npm --prefix interview-agent ci`, then `typecheck` and `test` |

CI does **not** run `npm run build`, `eval:match --enforce`, `gen:brand --check` (the brand parity test covers it), `i18n:merge --check`, or any e2e. Run those yourself when your change touches their area.

[`deploy-cn.yml`](../../.github/workflows/deploy-cn.yml) is manual (`workflow_dispatch`). It builds and pushes the GoApply mainland images and rolls them out on ACK, and skips itself when the Aliyun secrets are missing. RoboApply deploys through Vercel's Git integration ([`docs/runbooks/cn-deploy.md`](../runbooks/cn-deploy.md) covers the mainland side).

**Merging.** Per the owner, PRs are merged by hand after CI is green, and GitHub auto-merge is disabled on the repository. I could not verify the repository settings offline. The history is mixed: two merges came in through PRs (#4 Jobright clone, #5 practice prep), and most recent merges are local `Merge branch '…'` commits on `main`. Do not merge to `main` or deploy without the owner.

## The i18n workflow

- **Locales.** There are 9: `en` (master), `zh`, `zh-TW`, `ja`, `ko`, `es`, `fr`, `pt`, `de` (`LOCALES` in `lib/localeConfig.ts`). All nine bundles in `i18n/messages/` carry every key; only the GoApply-only prefixes listed above are limited to `en`/`zh`. On 2026-11-03: `en`/`zh` had 9,815 leaves and the other seven had 8,970. GoApply overrides live in `i18n/brands/<brand>/<locale>.json`. Server email strings are in `server/src/i18n/email/`, and extension strings in `extension/src/i18n/`.
- **Normal change** (what recent feature commits on `main` do): add or change the key in `en.json` and in the other eight bundles in the same commit, then run `npm run check`.
- **Staging** (used for multi-agent waves): new English goes to `i18n/staging/<namespace>.en.json`, GoApply Chinese to `<namespace>.zh.json`, and removals to `<namespace>.remove.json`; email strings go to `server/src/i18n/email/staging/`. `npm run i18n:merge -- --dry-run` prints the plan. `npm run i18n:merge` validates the files (ICU, no literal brand names, one namespace per file), merges them, writes `i18n/staging/_pending-translation.json`, and resets staging. `--check` exits 1 while any staging file has content. On 2026-11-03 staging was empty (86 files). HANDOFF warns that `_pending-translation.json` accumulates and goes stale, so compute the real gap per locale by diffing key sets.
- **Translating.** Use the `i18n-locale-sync` skill ([`.claude/skills/i18n-locale-sync/SKILL.md`](../../.claude/skills/i18n-locale-sync/SKILL.md)) for register per market and the machine-voice rules. Two parts of it are out of date. It describes "partial bundles" (`ko`, `es`, `fr`, `pt`, `de`) that fall back to English, but `check:copy` now requires full parity in all nine. It also validates with its own `scripts/apply_translations.py`, while the M5 translation pass used `docs/jobright-clone/orch/apply-translations.mjs` ([HANDOFF §4 step 3](../jobright-clone/HANDOFF.md)). Taiwan vocabulary rules: `check-zh-variants.mjs` and `CN_TW_LAUNCH_PLAN.md` §9. No translation may say the product applies for the user.
- **Missing keys.** `lib/i18n.ts` deep-merges each locale over English, so a key missing only in, say, `ja` renders in English. A key missing from English too would render as its literal dotted path (`jobs.headline`) in every locale. Since the `onIntlError` handler in [`app/providers.tsx`](../../app/providers.tsx), the client provider **throws in development** and only logs in production. So "silently renders the dotted path" now holds only for production builds. `check:copy` catches the static `t('…')` cases before that. Keys built from template literals are caught only by the development throw.

## Before you open a PR

From AGENTS.md "Verification" and the gates above:

1. Run the smallest relevant test first (`npx vitest run <file>`), then the affected suite.
2. Server changes: `npm run typecheck:server` and the relevant server tests. Remember that server test files are not type-checked.
3. Frontend or shared changes: `npm run typecheck:web`, `npm test`, `npm run check`.
4. Copy changes: all nine bundles updated (or staged and merged), `npm run check` clean, and `%BRAND%` instead of brand names.
5. Brand registry changes: edit `server/src/platform/brand/registry.ts` only, run `npm run gen:brand`, and confirm `git diff lib/brand/registry.generated.ts` shows nothing unexpected.
6. Schema changes: additive only, `npx prisma validate`, `npm run db:generate`, server typecheck and tests. No `db:push` against an unknown database.
7. Match, retrieval or scoring changes: `npm run eval:match -- --enforce M4` exits 0, and the baseline is untouched.
8. Extension changes: `npm --prefix extension run typecheck && npm --prefix extension test`. Worker changes: `npm --prefix interview-agent run typecheck && npm --prefix interview-agent test`.
9. Deployment-affecting changes (`next.config.mjs`, `vercel.json`, `api/`, dependencies, `/legal`): `npm run build` in a separate worktree, never next to a running `next dev`.
10. Do not touch the frozen `A<n>` Alipay tests or the Alipay callback path. Never commit `.env*`, credentials or production data.
11. Stage explicit paths. Other sessions share this checkout, so check `git status` for files you did not write. Delete any `.vitest/` output, and clean up test users you created in a real database.
12. Commit `AGENTS.md` if `next dev` rewrote its managed block.
