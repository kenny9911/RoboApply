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
npm --prefix extension run build:all    # both brands × chrome/edge
npm --prefix extension run e2e          # Playwright, unpacked extension (see below)
```

`node scripts/build.mjs --brand=roboapply|goapply --target=chrome|edge [--dev] [--api-origin=<origin>] [--out=<dir>]`

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

## Layout

| Path | What |
|---|---|
| `src/background/` | service worker: token storage, pairing, API client, message router |
| `src/content/` | detection, the fill session (`fill.ts`), the shadow-DOM panel |
| `src/content/boards/` | job-board readers for "Check fit" / "Save" (WP-70; empty seam) |
| `src/adapters/_kit/` | field model, setters; `interact.ts` is the only file that presses anything, and it refuses submit-like controls |
| `src/adapters/intl/` | Greenhouse, Lever, Ashby (WP-70 adds the rest) |
| `src/adapters/cn/` | GoApply portals (WP-71; empty seam) |
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
