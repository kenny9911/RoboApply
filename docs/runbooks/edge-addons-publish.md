# Runbook: publish the GoApply extension (一键填表) to Microsoft Edge Add-ons

Owner: CN ops, with the extension package owner. Written for WP-71 (Wave 5).
Applies to the GoApply build only. RoboApply ships to the Chrome Web Store
under its own listing (ARCHITECTURE.md §6.8).

## Why Edge first

The Chrome Web Store is not reliably reachable from mainland networks, and
Edge Add-ons is (CN_TW_LAUNCH_PLAN.md: extension stores). GoApply therefore
publishes to:

1. **Microsoft Edge Add-ons**: the primary channel.
2. **Chrome Web Store**: secondary, for users who can reach it.
3. **Self-hosted signed CRX** at `https://www.goapply.top/extension/goapply.crx`
   with an update manifest at `/extension/goapply-updates.xml`. This is a
   best-effort channel for 360 and QQ browsers that accept a manual install.

These values live in `extension/src/brands/goapply/index.ts`
(`GOAPPLY_DISTRIBUTION`).

## Before you start (blocking)

- [ ] A Microsoft Partner Center account with the Edge program enabled, owned
      by the GoApply operating entity (CN_TW_LAUNCH_PLAN.md §5 credentials table).
- [ ] Real icon artwork. The build draws plain brand-colour tiles until artwork
      exists (`extension/scripts/build.mjs`). Edge rejects placeholder icons.
- [ ] Privacy policy URL on `goapply.top` that covers the extension: what is
      read (the form the user opened, after their click), what is sent (only
      to the GoApply API), retention, and the PIPL contact.
- [ ] The portal fixtures in `extension/test/cn/fixtures/` refreshed from live
      pages (see that folder's README) and the tests green.
- [ ] One manual fill on a real form per portal (Moka, Beisen, Feishu, Dayee)
      with the unpacked dev build, checked by a person:
      - nothing was submitted;
      - the portal's own submit button is outlined;
      - the panel says "请核对后自行提交".
- [ ] Reachability check of the listing on the three mainland carriers
      (China Telecom, China Unicom, China Mobile).

## Build

```bash
npm --prefix extension install
npm --prefix extension run typecheck
npm --prefix extension test                    # unit tests + the D1 no-submit gate
npm --prefix extension run build:goapply       # → extension/dist/goapply-edge/
node extension/scripts/build.mjs --brand=goapply --target=chrome   # → dist/goapply-chrome/ (CWS + CRX)
```

The build refuses a manifest that breaks the permission policy. Check
`dist/goapply-edge/manifest.json` before you upload:

- `permissions` is exactly `activeTab`, `scripting`, `storage`. There is no
  `cookies`, no `tabs`, no `webRequest`, and no `optional_permissions`.
- `host_permissions` holds the GoApply origin plus the portal hosts only:
  `*.mokahr.com`, `*.zhiye.com`, `*.beisen.com`, `*.jobs.feishu.cn`,
  `*.dayee.com`, `*.hotjob.cn`. There are no job boards and no `<all_urls>`.
- `content_scripts.matches` holds the same portal hosts.
- `version` comes from `extension/package.json`. Bump it for every upload.
  Edge rejects a version it has already seen.

Zip the folder's contents, not the folder itself:

```bash
cd extension/dist/goapply-edge && zip -r ../goapply-edge-$(node -p "require('../../package.json').version").zip .
```

## Listing (Partner Center → Extensions → Create new / Update)

Write every field in Chinese first, then English. Use the product name
**一键填表** (zh-TW 一鍵填表). Never write 一键网申, 一键投递, 自动投递, 代投,
海投 or 自动打招呼. Never name a portal vendor in a way that implies a
partnership. You may list the portals as sites where filling works.

| Field | Content |
|---|---|
| Name | GoApply 一键填表 (matches `extension-cn.manifest.nameEdge` once INT wires it; see below) |
| Short description | 用你在 GoApply 的资料填写网申表单。每一项由你核对，申请由你自己提交。 |
| Description | What it fills (basic info, education, internships, optional details you entered yourself), the three modes (全部填写 / 只填空白 / 填写选中区域), and that **it never submits**: after filling it outlines the form's own submit button and says 请核对后自行提交. Name personal details it never guesses (gender, birth date, ID number, ethnicity). |
| Category | Productivity |
| Privacy: data collected | Personally identifiable info, website content |
| Privacy: how it is used | Website content is read only after the user clicks the panel or toolbar button, on the form the user opened, and is used only to fill that form. Sent only to the GoApply API. Not sold, not used for ads. |
| Single purpose | Fill job application forms the user opened, from the user's own profile. The user reviews and submits. |
| Permission justifications | `activeTab`: read the current form after the user's click. `scripting`: inject the fill panel after a toolbar click. `storage`: keep the device token. Host permissions: the supported application-form hosts and the GoApply API. |
| Screenshots | 1280×800: the panel on a fixture form (modes; after fill with the outlined submit button). Use fixture data only, never a real person's details. |
| Support / privacy URLs | `https://www.goapply.top/help`, `https://www.goapply.top/legal/privacy` |

Certification notes for the reviewer (English): "The extension never presses
Submit, Next or Continue (enforced by a CI check). It fills fields from the
signed-in user's profile only after a click, and leaves submitting to the user."

## Upload and review

1. Partner Center → the GoApply extension → **Packages** → upload the zip.
2. Fill in **Availability**: Markets = all, including China. Visibility = Public.
3. **Submit for review.** Review usually takes several business days. Watch the
   Partner Center inbox for questions.
4. After approval, copy the **extension id** from the listing URL. If it changed,
   set `NEXT_PUBLIC_CN_EXT_ID` and `NEXT_PUBLIC_CN_EXT_STORE_URL` in the web
   app's env (Vercel and the CN stack). `/extension` uses them to find the
   extension and to link the store.
5. If the server enforces a minimum version, raise it only after the new
   version is live in every channel.

## Chrome Web Store (secondary)

Upload `dist/goapply-chrome/` as a separate item under the GoApply developer
account. Use the same listing text, privacy answers and justifications. The
store item id differs from Edge's. The web app's `/extension` page shows the
store that fits the visitor's browser.

## Self-hosted CRX (best effort)

1. Pack `dist/goapply-chrome/` with the GoApply signing key. Keep the `.pem`
   in the secrets vault and never in the repo:
   `chrome --pack-extension=dist/goapply-chrome --pack-extension-key=<vault>/goapply.pem`.
2. Publish the `.crx` at `/extension/goapply.crx`. Publish an update manifest at
   `/extension/goapply-updates.xml` with the new version and the CRX URL.
3. On the download page, say plainly that this is a manual install. Chrome and
   Edge block it outside their stores; 360 and QQ browsers may accept it.

## Rollback

- Edge and Chrome stores: upload the previous zip with a **higher** version
  number. Stores do not allow downgrades.
- CRX: point the update manifest back to the previous file.
- To pause filling for everyone without a new release, turn off the
  `ext.autofill` capability for GoApply. The `/ext` API then returns
  `feature_disabled` and the panel says that form filling is not available.

## Follow-ups owned elsewhere

- The manifest name, description and zh `_locales` for GoApply come from
  `extension-cn.manifest.*`. The build reads only `extension.manifest.*` today,
  so the GoApply store name stays "GoApply for Edge" until INT wires it
  (WP-71 handoff, request to INT).
- The server's list of fillable form hosts for GoApply
  (`EXTENSION_ATS_TYPES_BY_MARKET.cn`) gains `moka`, `beisen`, `feishu` and
  `dayee` at INT.
