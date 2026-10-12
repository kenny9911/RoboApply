# Browser extension (MV3)

One package, two brand builds: RoboApply ("RoboApply for Chrome", action
**Fill this form**) and GoApply (一键填表, portal adapters from WP-71). It fills
application forms the user opened, from the user's own profile and saved
answers. **It never submits, never presses Next/Continue/Submit, and never
watches the employer's form** (D1). The panel ends with "Check the form, then
submit it yourself." and asks "Did you submit this application?"; that answer
is the only source of `userMarkedSubmitted`.

Not part of the root workspace: own `package.json` and `package-lock.json`;
the root `tsconfig.json` and `vitest.config.mts` exclude `extension/`.

## Commands

```bash
npm --prefix extension install          # once (Playwright browsers are not downloaded)
npm --prefix extension run typecheck    # src + unit tests, and the e2e spec
npm --prefix extension test             # vitest (jsdom) + the D1 no-submit gate
npm --prefix extension run build        # dist/roboapply-chrome/
npm --prefix extension run build:goapply  # dist/goapply-edge/
npm --prefix extension run build:all    # RoboApply × chrome/edge, GoApply × its stores (edge, chrome, crx)
npm --prefix extension run e2e          # Playwright, unpacked extension (see below)
```

`node scripts/build.mjs --brand=roboapply|goapply --target=chrome|edge [--dev] [--api-origin=<origin>] [--out=<dir>]`

GoApply builds follow `GOAPPLY_DISTRIBUTION` (`src/brands/goapply/index.ts`):
`node scripts/build.mjs --brand=goapply --store=edge|chrome|crx` builds the
target that store receives (Edge Add-ons first). The store name, short name,
description and toolbar title come from `extension-cn.manifest.*`
(`i18n/staging/extension-cn.{en,zh}.json`) and are written to `_locales/en`
and `_locales/zh_CN`; `default_locale` is `zh_CN` for GoApply and `en` for
RoboApply. The self-hosted CRX channel gets the Chrome build; packing and
signing it, and serving the update manifest, are not part of this script.

Every build runs `scripts/check-extension-no-submit.mjs` first and refuses a
manifest that breaks the permission policy (`src/manifest.ts`).

## Unpacked dev build (for INT / local testing)

1. Run the app locally (`npm run dev`; web on `http://localhost:3611`).
2. `npm --prefix extension run build:dev` → `extension/dist/roboapply-chrome-dev/`.
   Dev builds talk to `http://localhost:3611` (override with `--api-origin`),
   accept pairing from `localhost`/`127.0.0.1`, and use an open shadow root.
3. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → pick
   that folder. Note the extension id; set `NEXT_PUBLIC_EXT_ID` (GoApply:
   `NEXT_PUBLIC_CN_EXT_ID`) so `/extension` can find it.
4. Pair: open `/extension` while logged in and press Connect (the page sends
   `{ type: 'pair', token, apiOrigin }`), or click the toolbar button and enter
   the 8-character code the page shows.
5. Open a Greenhouse, Lever or Ashby application page. A "Fill this form"
   button appears bottom right; nothing is sent until it is clicked. Dev builds
   also detect the saved fixtures in `test/fixtures/**` served from
   `http://localhost` or `http://127.0.0.1`.

Edge: build with `--target=edge` and load it from `edge://extensions`.

## End-to-end test

`test/e2e/fill.spec.ts` builds `dist/e2e` (dev, API `http://127.0.0.1:4799`),
launches Chromium with `launchPersistentContext` and
`--disable-extensions-except` / `--load-extension`, routes the saved Greenhouse
fixture to a real Greenhouse URL, and runs a local fake of the `/ext` API. It
asserts the fields are filled, the resume is attached, an AI draft reaches the
page only after "Use this answer", and nothing on the form is pressed or
submitted. It needs a local Chromium: `npx --prefix extension playwright install chromium`.

## One run per application

A panel keeps one fill session: filling again (the next page of a page-by-page
form that changes in place, or a second pass on the same page) reuses the run
and reports running totals (`PATCH /ext/autofill-runs/:id` `fieldsFilled` /
`fieldsTotal`), so it uses one form-fill credit. A reloaded tab gets the same
run back from `POST /ext/autofill-runs` (`reused: true`): for two hours the
server keys on device + host + job, or — when the page is not a job it knows —
on the page URL without its query string, told apart by the query parameters
that name the job (`gh_jid`, `token`, `job`, …; tracking parameters are
ignored). A reused run that filled nothing yet holds a credit again first, so
an account with none left gets `credits_exhausted`, never an uncharged fill.

The panel says "The whole application uses 1 form fill" only on
`ONE_RUN_MULTI_PAGE` forms (Workday: the pages change in place). On Taleo and
SuccessFactors a step can load as a new document under another path, which
starts a new run unless the job is matched, so the panel promises nothing
about the cost there. The panel is keyed by origin + path, so a portal that
names the job only in the URL fragment (`#/job/123`) keeps one panel and one
run across jobs until the tab reloads.

Page-by-page forms (`MULTI_PAGE_STEP`): the button reads "Fill this page" and
is offered again on each page. The content controller keys the panel by
`formPageKey()` and keeps it across steps; the panel looks at the step only
when the user returns to it or uses the toolbar button (nothing observes the
page). Workday is in `ONE_RUN_MULTI_PAGE` (its pages change in place) and is
offered on job pages again; Taleo and SuccessFactors (and iCIMS) stay in the
server's `EXTENSION_PER_PAGE_ATS_TYPES` until checked against a live form.

After the user uses a draft, "Save this answer" sends it to their saved
answers (`POST /ext/answers/save`); the server refuses protected questions.

GoApply popup: on a page with no content script the toolbar click injects it
once under `activeTab` and asks again, so the label-based fallback adapter can
find a form on a company's own career site. Job boards are never injected.

## Layout

| Path | What |
|---|---|
| `src/background/` | service worker: token storage, pairing, API client, message router |
| `src/content/` | detection, the fill session (`fill.ts`), the shadow-DOM panel |
| `src/content/boards/` | job-board readers for "Check fit" / "Save" (WP-70: LinkedIn, Indeed, Glassdoor, ZipRecruiter, Wellfound, 104, Cake); run only after a toolbar click, no host permission |
| `src/adapters/_kit/` | field model, setters; `interact.ts` is the only file that presses anything, and it refuses submit-like controls |
| `src/adapters/intl/` | Greenhouse, Lever, Ashby; Workday (multi-page), SmartRecruiters, iCIMS, Workable, Taleo, SuccessFactors; label-based generic for Jobvite, BambooHR, Recruitee (WP-70) |
| `src/adapters/cn/` | GoApply portals: Moka, Beisen, Feishu, Dayee, plus a label-based fallback (WP-71) |
| `src/brands/` | per-brand build values; names and hosts come from the brand registry |
| `src/mapping/` | label → field key, protected questions, value resolution |
| `src/i18n/` | strings; English is authored in `i18n/staging/extension.en.json` |
| `test/fixtures/` | anonymized form fixtures (≥3 per form host) |

## Store listing (D1)

Listing and description say the user checks every answer and submits the
application. Privacy fields: "website content — user-initiated only" (the
form is read only on the user's click; job-board pages are read only after a
toolbar click under `activeTab`); personal info is sent only to the brand's own
API. Permissions: `activeTab`, `scripting`, `storage`, the brand API origin and
the supported form hosts. No LinkedIn or Indeed host permissions.
