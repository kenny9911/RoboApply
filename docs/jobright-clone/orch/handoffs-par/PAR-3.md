# PAR-3

Accounts and messaging of the D5 parity wave, after the independent review. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-PAR-3`, branch `wp/PAR-3`, base `3fa104e` (PAR-1 merged). Nothing committed, pushed or stashed. No schema change, no new dependency, no dev server, no browser, no network call.

All seven items are done and the review is resolved (list at the end). Every test in a file PAR-3 owns is green (53 files, 1,011 passed, 2 todo). Both typechecks pass for the whole repository and `npm run check` passes. 76 files changed, all inside PAR-3's owns.

**Read first (orchestrator):**

1. Item 5 turns 7 tests red in three files that are in **no bundle's owns**. Each needs a one-line change at merge; the exact lines are under "Red tests for other bundles". With SMS live in their environment the three files pass (`SMS_DEV_CONSOLE=true npx vitest run …`: 23 / 23).
2. After the merge an unknown `CN_SIGNUP_MODE` is logged twice at boot: once by PAR-5 (`STARTUP`, its `startup.ts`) and once by PAR-3 (`AUTH_CN`, the review asked for it). Keep one; see O-D.
3. **Not verified in a browser.** The bundle rules forbid a dev server and a browser. The tabs on the GoApply sign-in card and the consent banner's position are covered by component tests and CSS only. O-C is a required check after the merge.

## Items

### 1. [P0] GoApply sign-up is open with email + password by default: done

`server/src/features/auth-cn/signupPolicy.ts`:
- `cnSignupMode(env)` returns `'open'` unless `CN_SIGNUP_MODE` is `invite` or `closed` (new value). `SignupMode` is `'open' | 'invite' | 'closed'`.
- `goapplySignupOpen(env)` = mode is not `closed`, in every environment. No `CN_LEGAL_DOCS_VERSION`, SMS or WeChat requirement.
- `buildSignupPolicy.signupOpen` = `goapplySignupOpen(env)`; `inviteRequired` = mode is `invite`.
- `crossBorderConsentRequired(env)` = offshore (`DEPLOY_REGION` is not `cn-mainland`) or `brandUsesSharedStack('goapply', env)`.
- **One list of required consents (review finding 4).** `requiredSignupConsents(env)` is now async and returns the sign-up types plus every sign-up consent the compliance catalog says is required on this deployment (`isConsentRequired`, lazy import). The policy endpoint (the boxes on the form), the phone and WeChat check (`checkSignupConsents`) and the email check (`planGoApplyEmailSignup`) all read this one list. The email path no longer adds the catalog's missing types on its own. So no path can demand a consent the form did not show, and none can skip one.
- `cnSignupModeProblem(env)` returns the raw value when `CN_SIGNUP_MODE` is set and is none of the three (such a value leaves sign-up open). New `cnSignupModeWarning(env)` is its log line. `createPhoneAuthRouter` logs it once per process when it is built at boot (review finding 3).

Followed in: `auth/goapplySignup.ts`, `auth-cn/contract.ts`, `auth-cn/index.ts` (exports `crossBorderConsentRequired`, `cnSignupModeProblem`, `cnSignupModeWarning`, `SignupMode`), and the comments of `wechatAuthService.ts`, `inviteService.ts`, `adminRoutes.ts`, `accounts.ts`, `SeekerAuthService.ts`, `roboapply/routes/auth.ts`, `lib/api/auth.ts`.

Web: `components/auth/methods/EmailMethod.tsx` shows the invite field only when the policy says `inviteRequired`, and shows the "sign-up is not open" notice up front when the policy says `signupOpen: false`.

Works before and after PAR-5 merges. PAR-5 widens the catalog's cross-border rule (`crossBorderConsentApplies`: also a GoApply model provider that is itself abroad, and database overrides). Because the list follows the catalog, sign-up asks for the consent in those cases too, with no code change here.

ACCEPT, all tested: production, no `CN_LEGAL_DOCS_VERSION`, no SMS, no WeChat → `POST /auth/signup` on a GoApply host with the required consents answers 201 with no invite code; the policy endpoint says `signupOpen: true, inviteRequired: false`; `CN_SIGNUP_MODE=invite` demands a code; `closed` answers 403 `signup_closed` (email, phone and WeChat), existing accounts still sign in, RoboApply is unaffected.

Tests: `auth-cn/signupPolicy.test.ts` (10: the mode, the logged warning, the predicate, the single list with a stubbed catalog rule on all three paths, the policy); rewritten cases in `auth/goapplySignup.test.ts`, `auth/legacyAuth.test.ts`, `auth/service.test.ts`, `auth-cn/phoneAuthService.test.ts`, `wechatAuthService.test.ts`, `routes.test.ts`, `__tests__/testkit.ts`, `roboapply/routes/auth.brand.test.ts`, `growth/referrals.test.ts`, `components/features/auth/auth.test.tsx`, `auth-cn/intWiring.test.ts`.

### 2. [P0] Email + password is the primary method on both brands: done

- `components/auth/methods/registry.ts`: `SECONDARY_AUTH_METHODS.goapply = []`. Optional `placement: 'before' | 'after'` on a redirect method (WeChat is `after`) and optional `follows` on `AuthMethodProps`.
- `components/features/auth/AuthEntryView.tsx`: forms keep the brand's order. With more than one form (GoApply with an SMS provider) they are tabs, email open first, using the existing `Tabs` primitive. RoboApply's card is unchanged (Google / LINE, "or", email form). New pure export `placeAuthMethods`.
- One set of agreement boxes per page: `useSignupInputsHost(who, wanted)` in `components/features/auth-cn/shared.ts` (rank: phone form, email sign-up form, WeChat button).
- Google and LINE stay RoboApply-only.

ACCEPT, tested: GoApply with no SMS and no WeChat credentials shows the email form first, no tabs, nothing behind another control; with `auth.phoneOtp` on the Phone tab is next to Email.

Tests: `components/features/auth/auth.test.tsx`.

### 3. [P0] GoApply mail goes out through the shared transport: done

`server/src/platform/email/EmailService.ts`:
- `transportNameFor(brand, env)` for GoApply: `aliyun_dm` or `none` when `CN_EMAIL_TRANSPORT` says so, otherwise `resend`. Typed `EmailTransportName` (exported). PAR-5 reads it for the processor list (confirmed in its handoff).
- `fromFor` for GoApply: `CN_EMAIL_FROM`, then on Resend only `ROBOAPPLY_EMAIL_FROM`, then `EMAIL_FROM`, last the registry address. The display name is always `GoApply`.
- `replyToFor`, `emailOrigin` and the legal footer are unchanged and brand-own. Tested that RoboApply's entity, address, origin and support inbox never appear in GoApply mail.
- The log row of a suppressed message names the transport of the injected env.

ACCEPT, tested: GoApply with only `RESEND_API_KEY` and `ROBOAPPLY_EMAIL_FROM` sends verification, password-reset, job-alert and billing mails via Resend with From `GoApply <shared address>`; password reset and email verification work on a GoApply host; `aliyun_dm` with its keys uses DirectMail and never Resend; `none` and a missing key suppress with `transport_not_configured`.

Tests: `platform/email/EmailService.test.ts`, `templates/notify/notify.test.ts`, `features/auth/routes.test.ts`, `components/features/auth/auth.test.tsx`.

### 4. [P0] Web push on GoApply with the shared VAPID pair: done (PAR-1 request P3-1)

- `server/src/features/push/config.ts`: `WEB_PUSH_BRANDS` = every brand id; `vapidConfig` unchanged (the `push` group through `brandEnv`).
- Removed: the RoboApply-only refusals in `workers.ts`, `service.ts` and `channel.ts`. `channel.ts` checks the message's own brand (`feature_disabled` when its flag is off, `not_configured` without its keys).
- **A device subscribed with another key is replaced, never reused (review finding 1).** `hooks/pwa/usePushSubscription.ts`: new `boundToAnotherKey(sub, publicKey)` compares the subscription's `options.applicationServerKey` with the key the server serves. `enable()` drops such a subscription (browser and server row) and subscribes with the served key. On mount, a device that is "on" for this account and bound to another key is renewed without asking (the permission is granted and the worker registered already); if that fails the device reads as off and a click tries again. A browser that does not report the key is left alone.
- Headers of `push/routes.ts`, `push/contract.ts`, `lib/api/push.ts` and `notify-cn/repo.ts` rewritten (review finding 7).

ACCEPT, tested: with the shared VAPID env a GoApply user subscribes and a notification is delivered through the push channel and the `push.send` worker, to GoApply devices only; `CN_VAPID_PUBLIC_KEY` with its private key and subject switches GoApply to its own pair while RoboApply keeps the shared one; `FLAG_GOAPPLY_WEB_PUSH=false` turns GoApply off and leaves RoboApply on; an own set left unfinished is not configured.

Tests: `features/push/push.test.ts`, `components/features/pwa/__tests__/pwa.test.tsx` (6 new for the key change: the comparison, renewal on load, renewal under strict mode, failed renewal then click, a pruned device with the old key, a device with the current key left alone), `components/features/notifications/notifications.test.tsx`.

### 5. [P1] Phone binding is required only when a phone can be bound: done

`server/src/features/auth-cn/phoneBinding.ts`: `phoneBindingRequired(userId, db, env)`, `assertPhoneBound(userId, db, env)`, `requirePhoneBound(db?, env?)`, new `phoneBindingAvailable(env)`. When a phone cannot be bound the function returns false before any read.

**Difference from the item, on purpose:** the item says "returns false when `requirementsMet('auth.phoneOtp', …)` is false". I used `isEnabledForBrand('auth.phoneOtp', goapply, env)`. It is false in every case the item names and also when the operator switched the phone method off with `FLAG_GOAPPLY_AUTH_PHONE_OTP=false`. The bind routes are gated with `requireFlag('auth.phoneOtp')`, so with that switch off `POST /auth/phone/bind` answers 404 and a WeChat-only account would be locked out of AI for good.

Also: the WeChat callback no longer adds `bind=1` when a phone cannot be bound.

ACCEPT, tested: a WeChat-only GoApply account with no SMS provider passes the gate; with SMS live it gets 403 `phone_binding_required` and the bind page works.

Tests: `auth-cn/phoneBinding.test.ts` (5), `wechatAuthService.test.ts`, `routes.test.ts`.

### 6. [P1] Two-factor works on GoApply with the shared key: done

`server/src/features/account-v2/sealing.ts`: `totpKeys(brand, env)` = [own key, shared key] without blanks, malformed values or duplicates; `totpKey` = the first; `unsealWithAny(sealed, keys, aad)`. `twoFactor.ts` opens a stored secret with any of them and seals with the first. `readiness.ts` reports ready when any key exists.

**A malformed key is no longer silent (review finding 5).** New `totpKeyProblems(env)` names each key variable that is set but is not a 32-byte key (`CN_TOTP_ENCRYPTION_KEY`, `TOTP_ENCRYPTION_KEY`), and `totpKeyWarning(name, env)` says what happens now. `createTwoFactorRouter` logs each once per process when it is built (`ACCOUNT_2FA`, warning, name only, never the value). The fallback itself is unchanged.

ACCEPT, tested end to end: GoApply with only `TOTP_ENCRYPTION_KEY` enrols and verifies; after `CN_TOTP_ENCRYPTION_KEY` is added the old secret still opens and a new enrolment is sealed with the CN key; RoboApply never reads the CN key.

Tests: `account-v2/__tests__/totp.test.ts`, `twoFactor.test.ts`, `student.test.ts` (the router log).

### 7. [P1] Student verification and notification channels on GoApply: done (tests; no guard found)

- No gate change was needed in `account-v2/routes.ts` or `student.ts`: `*.edu.cn` and `*.ac.cn` pass `eligibleSchoolDomain`, and the code mail goes through `sendEmail`.
- `notifications/service.ts`: `defaultCapabilities` reads the three flags with no brand guard. Comments only.

ACCEPT, tested: on a GoApply host a `name@pku.edu.cn` address gets the code and verifies; `FLAG_GOAPPLY_STUDENT=false` closes GoApply only; a GoApply reminder with no WeChat credentials is written to the inbox, sent by email and delivered by web push, and the WeChat channel is skipped as `not_configured`.

Tests: `account-v2/__tests__/student.test.ts`, `notifications/__tests__/notifications.test.ts`.

### Carry-over (waveFIX-carryover.md)

1. **Analytics banner covers "Already have an account? Sign in": done, not browser-verified.** While open, the banner publishes the room it takes as `--analytics-consent-h` on `<html>`. The sign-in layout reserves that room under the card on one column. On two columns (1024px and wider) the banner docks under the brand panel. RoboApply only (GoApply never shows this banner). See O-C.
2. **Notification settings, `not_offered`: done, branch kept.** It can still occur under D5 (no email key, or `CN_EMAIL_TRANSPORT=none`). The per-search "Email summary" select is hidden too when the server says `not_offered`.
3. **Hide the invite Email button when `notify.email` is off: rejected.** The button is a `mailto:` link that opens the person's own mail app. It does not use the product's email transport.
4. **`buildPublicUser`: not done.** `server/src/services/AuthService.ts` is not in PAR-3's owns.
5. **RoboApply sign-up rows carry no text hash (PAR-5 section, entry 4; the file `features/auth/signupPolicy.ts` is PAR-3's): not done.** It needs the RoboApply sign-up forms to show the catalog text in place of their own copy and send its hash. That changes RoboApply copy, which this wave must not do. It needs a product decision first.

No "Hot files" or "Unowned fix WPs" entry names a file inside PAR-3's owns.

### Requests from PAR-5's handoff addressed to PAR-3

- **Three tests PAR-5's change turns red after the merge: handled, green before and after.** (1) `auth-cn/routes.test.ts` no longer pins the cross-border sentence; it asserts the text says the data leaves the mainland (`中国大陆境外`, in both wordings) and that no placeholder reaches the page. (2) The "nothing leaves the mainland" kit `CN_OWN_STACK_ENV` now uses the values of PAR-5's `MAINLAND_OWN` (provider `deepseek`). The old kit used `siliconflow`, which PAR-5's vendor table does not list, so after the merge the catalog would have required the consent there and the tests that use the kit would have gone red. (3) `components/features/growth/invite.test.tsx` now asserts what holds on both sides: production GoApply never serves the draft referral terms as final (hidden, or served with `draft: true`). Tighten it to `kind: 'doc', draft: true` after the merge (O-E).
- **"Use one predicate for the cross-border requirement": done another way.** `crossBorderConsentApplies` does not exist at my base, so I could not import it. The single list follows the catalog's `isConsentRequired` instead, which uses that predicate once PAR-5 is merged. The dead end PAR-5 describes cannot occur.

## Files changed

76 files, all inside PAR-3's owns (checked against `parity-bundles.json`: 0 outside). 8 were added to the 68 of the first handoff by the review work: `hooks/pwa/usePushSubscription.ts`, `hooks/pwa/index.ts`, `lib/api/push.ts`, `server/src/features/push/routes.ts`, `server/src/features/push/contract.ts`, `server/src/features/notify-cn/repo.ts`, `server/src/features/account-v2/routes.ts`, `components/features/growth/invite.test.tsx`.

Server:
- `server/src/features/auth-cn/`: `signupPolicy.ts`, `signupPolicy.test.ts` (new), `phoneBinding.ts`, `phoneBinding.test.ts` (new), `contract.ts`, `index.ts`, `routes.ts`, `routes.test.ts`, `wechatAuthService.ts`, `wechatAuthService.test.ts`, `phoneAuthService.test.ts`, `intWiring.test.ts`, `accounts.ts`, `adminRoutes.ts`, `inviteService.ts`, `__tests__/testkit.ts`
- `server/src/features/auth/`: `goapplySignup.ts`, `goapplySignup.test.ts`, `legacyAuth.test.ts`, `routes.test.ts`, `service.ts` (comment), `service.test.ts`
- `server/src/features/account-v2/`: `sealing.ts`, `twoFactor.ts`, `readiness.ts`, `routes.ts`, `__tests__/totp.test.ts`, `__tests__/twoFactor.test.ts`, `__tests__/student.test.ts`
- `server/src/features/push/`: `config.ts`, `service.ts`, `channel.ts`, `workers.ts`, `routes.ts` (comment), `contract.ts` (comment), `push.test.ts`
- `server/src/features/notifications/`: `service.ts` (comments), `__tests__/notifications.test.ts`
- `server/src/features/notify-cn/repo.ts` (comment)
- `server/src/features/growth/referrals.test.ts`
- `server/src/platform/email/`: `EmailService.ts`, `EmailService.test.ts`, `index.ts`, `transports/resend.ts`, `transports/aliyunDirectMail.ts`, `templates/notify/notify.test.ts`
- `server/src/roboapply/routes/auth.ts` (comment), `auth.brand.test.ts`, `server/src/roboapply/engine/services/SeekerAuthService.ts` (comment)

Web:
- `components/auth/methods/registry.ts`, `EmailMethod.tsx`
- `components/features/auth/AuthEntryView.tsx`, `auth.module.css`, `auth.test.tsx`
- `components/features/auth-cn/shared.ts`, `PhoneMethod.tsx`, `WechatMethod.tsx`, `index.ts`, `SignupConsents.tsx`, `AdminInvites.tsx` (last two: comments)
- `components/features/growth/AnalyticsConsent.tsx`, `growth.module.css`, `growth.test.tsx`, `invite.test.tsx`
- `components/features/notifications/NotificationsSettings.tsx`, `notifications.test.tsx`
- `components/features/pwa/PushOptIn.tsx` (comment), `__tests__/pwa.test.tsx`
- `components/features/account-v2/StudentVerification.tsx` (comment)
- `hooks/pwa/usePushSubscription.ts`, `hooks/pwa/index.ts`
- `app/(public)/layout.tsx`, `lib/api/auth.ts` (comment), `lib/api/push.ts` (comment)
- `i18n/staging/auth.en.json`, `i18n/staging/auth.zh.json`

## Tests run

| Command | Result |
|---|---|
| Every test file inside PAR-3's owns (final) | 53 files, 1,011 passed, 2 todo, 0 failed |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 (design, copy, LLM costs, API boundary, extension, zh variants) |
| `npx vitest run --exclude ".claude/**"` (final, run twice, same failing set) | 624 files, 12,903 tests: 12,798 passed, 94 failed in 41 files, 1 skipped, 10 todo |
| `SMS_DEV_CONSOLE=true npx vitest run` on the three files of "Red tests for other bundles" | 23 / 23 |

The first handoff said 54 owned files. Counting the files of the JSON report against the `owns` list gives 53; no test file was removed.

The 94 failures: 87 were red at the base (PAR-11 44, PAR-2 17, PAR-4 11, PAR-5 6, PAR-7 5, PAR-8 3, PAR-9 1, by file owner) and 7 are turned red by item 5. None is in a file PAR-3 owns.

## Red tests for other bundles

Turned red by PAR-3 (item 5). The three files are in **no bundle's owns**, so they go to the orchestrator's merge step. They call the phone-binding gate with the default environment, which has no SMS provider, so the gate now lets the WeChat-only account through. Each must pass an environment where SMS is live: `const SMS_ON = { NODE_ENV: 'test', SMS_DEV_CONSOLE: 'true' }`. Line numbers checked against the files in this worktree.

- `server/src/features/cn/referrals/routes.test.ts` (4: "403 phone_binding_required: a WeChat-only account cannot share or report", and three that fail only because that test now stores a code: "admin queue…", "every moderation writes one audit row…", "an audit failure never fails the moderation"). Line 57: `requirePhoneBound(authCnDb as never, SMS_ON)`.
- `server/src/features/resume/tailor/routes.test.ts` (2). Line 67: `assertPhoneBound(userId, authCnDb as never, SMS_ON)`; line 71: `requirePhoneBound(authCnDb as never, SMS_ON)`.
- `server/src/roboapply/v2/routes/resumes.rewriteCredit.test.ts` (1). Line 54: widen the cast to `(db?: unknown, env?: unknown) => unknown`; line 59: `requirePhoneBound: () => actual.requirePhoneBound(db, SMS_ON)`.

Each file should also gain the opposite case (no SMS provider → the same account passes).

## Pre-existing failures

87 tests in 38 files, all red at the base and all in other bundles' files, as PAR-1's handoff lists them. PAR-3 changed none of them. The 12 older failures of PAR-1's handoff did not fail in this worktree.

## Requests

### Orchestrator

- **O-A. The three unowned test files above** (7 red tests). The wave cannot go green otherwise.
- **O-B. i18n:** merge and translate `auth.methods.tabs.{label,email_password,phone_otp}`. Until then GoApply shows the English tab labels in zh.
- **O-C. Required browser check after the merge, and record the result** (both brands, light and dark, 375px and 1280px). (1) `/login` and `/signup` on GoApply with and without `SMS_DEV_CONSOLE`: tabs, the boxes under the right form, the WeChat button below. (2) `/signup` on RoboApply from an EEA country at 1280×900 and 375×812: the consent banner must not cover "Already have an account? Sign in". The banner fix is proven only by tests that read the CSS source. A Playwright check of the two bounding boxes would be the durable guard; the repository has no Playwright setup and `e2e/` is in no bundle's owns, so it is not written.
- **O-D. One boot log line for an unknown `CN_SIGNUP_MODE`, not two.** After the merge PAR-5's `platform/startup.ts` logs it (`STARTUP`) and so does `createPhoneAuthRouter` (`AUTH_CN`). To keep PAR-5's, delete the `logSignupModeProblem(deps.env)` call in `server/src/features/auth-cn/routes.ts`. PAR-5's line depends on the export name `cnSignupModeProblem` in `features/auth-cn/index.ts`, which is unchanged.
- **O-E. After the merge, tighten `components/features/growth/invite.test.tsx`** "production GoApply never serves the draft as final terms" to `kind: 'doc'` with `draft: true` (PAR-5 item 8).
- **O-F. Optional follow-up, shell owner (PAR-8):** the renewal of a device subscribed with an old VAPID key runs where `PushOptIn` is mounted, which is Settings > Notifications only. To renew devices of people who never open that page, the signed-in shell would need to mount `usePushSubscription()` (or a renewal-only hook). Not needed while GoApply stays on the shared pair.

### PAR-5

- P5-A (log `cnSignupModeProblem`), P5-C (`startupAssertions.ts` reads unset as Resend) and P5-D (`disclosures.ts` uses `transportNameFor`) are done according to PAR-5's handoff; I saw the first and the last in its worktree.
- P5-B is answered above: sign-up follows the catalog through `isConsentRequired`.

### PAR-10

Three operator notes to add next to the variables:
1. `CN_VAPID_PUBLIC_KEY`: choose GoApply's pair before launch. Moving from the shared pair to an own pair later stops delivery to every device subscribed before the change. A device is renewed when its owner next opens Settings > Notifications; until then the server drops it after 5 failed sends.
2. `CN_TOTP_ENCRYPTION_KEY`: a value that is not 32 bytes (base64, or 64 hex characters) is skipped with one warning in the boot log, and GoApply seals with the shared key. Keep `TOTP_ENCRYPTION_KEY` in the GoApply environment after adding the CN key.
3. `CN_VAPID_PUBLIC_KEY` alone turns GoApply web push off (an own set must be complete).

At my base `.env.example:587` still says `CN_SIGNUP_MODE=invite` and line 830 still says GoApply has no web push. PAR-10's handoff says it redefined `CN_SIGNUP_MODE` and relabelled `CN_VAPID_*` as an optional override; confirm both lines at the merge.

### PAR-8

- For information: with no SMS provider `POST /v2/resumes/:id/rewrite` no longer answers `phone_binding_required` for a WeChat-only account. See also O-F.

### Owner

- GoApply mail goes out from the shared verified sender address under the display name "GoApply" until `CN_EMAIL_FROM` names a verified `goapply.top` sender. A recipient who looks at the address sees RoboApply's sending domain. Verify a GoApply sender on the Resend account, or set Aliyun DirectMail, before the mainland launch.
- Decide whether RoboApply sign-up should show the catalog consent text so its rows can carry a hash (carry-over 5).

## Schema requests

None.

## Env variables added or redefined

| Name | Meaning | Default |
|---|---|---|
| `CN_SIGNUP_MODE` | redefined: `open` \| `invite` \| `closed` (new). Any other value is `open` and is logged as an error at boot | `open` |
| `CN_LEGAL_DOCS_VERSION` | no longer a sign-up gate. Still the version recorded for a required consent the catalog has no text for | built-in prose version |
| `CN_EMAIL_TRANSPORT` | effective transport: `aliyun_dm` \| `none` when set so, anything else `resend` | `resend` |
| `CN_EMAIL_FROM` | GoApply sender address. Unset on Resend: `ROBOAPPLY_EMAIL_FROM`, then `EMAIL_FROM`, then the registry address, always named "GoApply". Never borrowed on DirectMail | shared verified sender |
| `CN_VAPID_PUBLIC_KEY`, `CN_VAPID_PRIVATE_KEY`, `CN_VAPID_SUBJECT` | GoApply's own web-push set; used only when the public key is set, then all three are needed. Changing the pair later needs each device renewed (PAR-10 note 1) | shared `VAPID_*` |
| `FLAG_GOAPPLY_WEB_PUSH` | `false` turns GoApply web push off (routes 404, channel and worker refuse) | on |
| `CN_TOTP_ENCRYPTION_KEY` | GoApply's own sealing key for new two-step secrets. Stored secrets open with it or with `TOTP_ENCRYPTION_KEY`. A malformed value is skipped and logged | shared `TOTP_ENCRYPTION_KEY` |
| `FLAG_GOAPPLY_AUTH_PHONE_OTP` | unchanged switch; new effect: when the phone method is off (this flag, or no SMS provider) no account is asked to bind a phone before AI | on when SMS is live |
| `FLAG_GOAPPLY_STUDENT` | unchanged; `false` closes student verification on GoApply only | on |

No new variable name is introduced. `closed` is a new value of `CN_SIGNUP_MODE`.

## i18n keys added or changed

Staged, namespace `auth`:
- `i18n/staging/auth.en.json`: `auth.methods.tabs.label` "Ways to sign in", `auth.methods.tabs.email_password` "Email", `auth.methods.tabs.phone_otp` "Phone".
- `i18n/staging/auth.zh.json` (GoApply): `登录方式`, `邮箱`, `手机号`.

The tabs render only where a brand has two form methods (GoApply with an SMS provider), but the keys live in the shared namespace, so translate them into all nine locales.

No key changed or removed. `authCn.otherMethods`, `authCn.otherMethodsEmail` and `auth.methods.useEmail` are still referenced by the "Other ways to sign in" control, which no brand shows today. Namespaces `authCn`, `accountV2`, `pwa`: nothing staged. The review work added no string.

## Known gaps

- **No browser verification** (O-C).
- **One column, consent banner:** the banner is still a fixed strip over the bottom of the window. The reserve guarantees the card's last link can be scrolled clear of it; on a short window it may be under the banner before scrolling.
- **Changing the VAPID pair:** a device is renewed only when its owner opens Settings > Notifications (O-F). A push service's 401 / 403 is still counted as a failed send, not as "gone" (see Review resolution 1).
- **Changing tabs on the GoApply card clears ticked agreement boxes.** Safe, slightly inconvenient.
- **GoApply sign-in page with WeChat configured:** the agreement boxes sit above the WeChat button also in sign-in mode (a WeChat sign-in can create an account).
- **An unknown `CN_EMAIL_TRANSPORT` value falls back to Resend silently** (as the item specifies). There is no detector for it.
- **Two-step sign-in:** if the shared key is removed after a CN key is added, secrets sealed with the shared key no longer open; recovery codes still work (tested).
- **Unverified GoApply sender on Resend:** with neither `CN_EMAIL_FROM` nor a shared sender set, the From address is the registry's `noreply@goapply.top`, which the shared Resend account will reject; the send is logged as `failed`.
- **The boot warnings are logged on a deployment that does not serve GoApply too** (the routers are built for every deployment).

## Review resolution

1. **Medium: changing GoApply's VAPID pair kills subscribed devices: fixed.** `enable()` and the mount-time check compare the subscription's key with the served key and replace a mismatched one (old browser subscription and server row dropped, new one stored). 6 tests. Operator note sent to PAR-10. **Rejected, the optional part:** treating 401 / 403 as "gone" in `sender.ts`. A wrong VAPID private key or subject on the server also makes the push service answer 401 / 403 for every device, so one bad deploy would delete every subscription at the first send. The existing 5-failure limit prunes the stale row without that risk.
2. **Medium: 7 red tests in three unowned files: confirmed, cannot be fixed here.** The files are in no bundle's owns. Exact changes under "Red tests for other bundles" (O-A); line numbers re-checked.
3. **Low: a mistyped `CN_SIGNUP_MODE` is not logged: fixed.** `createPhoneAuthRouter` logs `cnSignupModeWarning(env)` once per process. One correction to the finding: PAR-5 did see the request and logs the same problem from `startup.ts`, so after the merge there are two lines (O-D).
4. **Low: the email path can demand a consent the form never shows: fixed at the root.** `requiredSignupConsents` is the one list (sign-up types plus what the catalog requires), read by the policy and by all three sign-up paths. Tested with a stubbed catalog rule: the box is shown, and phone, WeChat and email all refuse without it and store it with it. PAR-5's handoff describes the same dead end; it is closed.
5. **Low: a malformed `CN_TOTP_ENCRYPTION_KEY` is ignored silently: fixed.** `totpKeyProblems` and `totpKeyWarning`, logged once from `createTwoFactorRouter`, name only. The fallback is unchanged.
6. **Low: the banner fix is proven only by regular expressions over CSS: accepted, not fixable here.** No browser is allowed in this bundle and the repository has no Playwright setup. O-C is now a required check with the result to be recorded.
7. **Low: stale headers say GoApply has no web push: fixed** in `push/routes.ts`, `push/contract.ts`, `lib/api/push.ts` and `notify-cn/repo.ts` (on GoApply `pushSentAt` means mirrored to a device or to WeChat), plus the header of `pwa.test.tsx`.

Not in the review, found while resolving it: PAR-5's handoff lists three PAR-3 tests its change turns red after the merge and one more I found (the `CN_OWN_STACK_ENV` kit). All four are handled so they pass before and after that merge (see "Requests from PAR-5's handoff"). A strict-mode fault in my first version of the renewal (the button stayed disabled) was caught and has a test.

Unowned edits: none (the review found none; re-checked, 0 of 76 files outside the owns).

Handoff file: `/Users/kenny/code/RoboApply/.claude/worktrees/jobright-clone/docs/jobright-clone/orch/handoffs-par/PAR-3.md`
