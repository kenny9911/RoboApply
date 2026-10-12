**INT-01 · status: complete — all four review findings fixed with tests, all gates green. Nothing committed or pushed, and nothing was launched (no dev server or browser was run from this bundle).**

Worktree: `/Users/kenny/code/RoboApply/.claude/worktrees/wp-INT-01` (branch `wp/INT-01`, index clean).

## Review resolution

1. **GoApply consent hash for text never shown (medium) — fixed.** The form now shows the compliance catalog text and the stored hash is the hash of that exact string.
   - `GET /auth/phone/policy?locale=` returns each required consent with `prose { text, locale, version, hash }` (`requiredSignupConsentsWithProse` in `auth-cn/signupPolicy.ts`).
   - `SignupConsents.tsx` renders one box per required consent with `prose.text` verbatim. The document names inside the text become links without changing a character.
   - The email form sends `proseHash` per consent. `planGoApplyEmailSignup` writes a row only when that hash equals the hash of a text the server serves (Chinese or English).
   - A missing or stale hash gets 422 `consent_required` with `details.outdated`. The form then reloads the text, unticks the boxes and shows `authCn.errors.consent_outdated`.
   - A tick is keyed by consent and hash, so a reworded text is never pre-ticked.
   - Tests: the stored hash equals the hash recomputed from the served string, for zh and en, at service and route level (`goapplySignup.test.ts`, `legacyAuth.test.ts`); the policy's hash is recomputable from what it serves (`auth-cn/routes.test.ts`); the form's text equals `prose.text` character for character (`authCn.test.tsx`); the email form sends the shown hashes and recovers from `outdated` (`auth.test.tsx`).
   - Side effects you should know about:
     - The phone and WeChat forms share these boxes, so they now show three boxes with the catalog wording instead of two with the `authCn` wording.
     - A bare `marketingOptIn: true` on GoApply email signup no longer writes a `marketing_email` row, because no such box is shown.
2. **Phone and WeChat ignore the free-tool `next` during onboarding (low) — fixed.** `routeAfterSignIn` returns a safe `next` first when `isPriorityNext(next)`. Tests in `intWiring.test.ts`: phone signup, phone sign-in mid-onboarding, WeChat signup through the callback, and the rule itself (off-site and non-tool paths still wait).
3. **Google and LINE lose the stored first and last touch (low) — fixed.** `oauthStartUrl` sends the stored touches as `ft` / `lt`. `/oauth/:provider/start` keeps them, sanitized, in the state row, and the callback, `/oauth/complete` and the LINE email-verification link read them back as `clientTouches`.
   - An over-long or malformed value is dropped and never fails the start.
   - Tests in `service.test.ts`: Google signup with a ref held only in the stored touch creates the invite; without analytics consent only functional fields are kept; the login-page and LINE-email paths; junk input. Also one route test and two `oauthStartUrl` tests.
4. **Bind-merge does not trigger the invite check (low) — fixed.** `bind()` calls `afterWechatLinked(deps.hooks, owner.id)` after the merge transaction. Two tests in `intWiring.test.ts`: the owner is checked, and a failing check does not fail the merge.

Unowned edits: none. Every changed path is in `owns`.

## Per-item result

1. **Two-step sign-in gates — done.** Six gated `setSession(` calls in `features/auth/routes.ts` and `issueSessionCookie` in `auth-cn/accounts.ts`; all readiness entries `gated: true`; web goes to `/login/2fa?next=…`.
2. **Bearer JWT cut-off — done.** `requireAuth`, `optionalAuth` and `resolveUserFromTokens` refuse a JWT issued before `User.tokensValidAfter`; `verify()` and `disable()` set it.
3. **GoApply email signup — done.** Real rules in `features/auth/goapplySignup.ts`, now with the shown-text hash from finding 1; invite spent in the account transaction; email sits behind "其他方式".
4. **Signup attribution — done.** WP-23 recipe in `afterAccountCreated`, now also for Google and LINE (finding 3).
5. **GoApply invite attribution — done.** `ref` rides phone, WeChat and mini-program signup; `'goapply'` is in both brand lists.
6. **`checkReferralFor` triggers — done.** Email verified, Google/LINE linked, WeChat linked, and now the bind-merge (finding 4).
7. **Unread count, region, phone credit — done.**
8. **Mission read removed — done.** Service and test deleted; one comment remains in `server/src/lib/rateCard.ts:59` (see Requests).
9. **`next` to the free tools — done.** Now on every method, including phone and WeChat (finding 2).
10. **Error-code audit — nothing was wrong.** Helpers hardened to read `details.reason` too.
11. **`safePath('/r/abc123')` → `'/r/:code'` — done.**

## Files

- **Created (9, unchanged list):** `lib/auth/twoFactor.ts`; `server/src/features/account-v2/challengeResponse.ts` and `__tests__/bearerCutoff.test.ts`; `server/src/features/auth-cn/hooks.ts` and `intWiring.test.ts`; `server/src/features/auth/goapplySignup.ts`, `goapplySignup.test.ts`, `requestContext.ts`, `twoStepGates.test.ts`.
- **Deleted (2):** `server/src/roboapply/services/RoboApplyMissionService.ts` and its test.
- **Modified (68, all in `owns`).** New in this pass: `components/features/auth-cn/SignupConsents.tsx`, `lib/api/authCn.ts`, and `server/src/features/auth-cn/{signupPolicy.ts,index.ts,routes.test.ts}`.
- **Touched again in this pass:**
  - server: `features/auth/{service.ts,routes.ts,contract.ts,signupPolicy.ts,goapplySignup.ts}` with their tests; `features/auth-cn/{accounts.ts,phoneAuthService.ts,contract.ts,routes.ts,intWiring.test.ts}`; `roboapply/routes/auth.ts`, `auth.brand.test.ts`; `SeekerAuthService.ts`
  - web: `components/auth/methods/EmailMethod.tsx`; `components/features/auth-cn/{shared.ts,index.ts,PhoneMethod.tsx}` and its test; `components/features/auth/auth.test.tsx`; `lib/api/auth.ts`; `lib/auth/auth.test.ts`
  - i18n: `i18n/staging/authCn.{en,zh}.json`

## Tests run

- **Owned paths:** `npx vitest run` over the bundle's server and web paths (`features/{auth,auth-cn,account-v2,growth}`, `middleware`, the three legacy auth tests, `components/{auth,features/…}`, `lib/auth`, `hooks/growth`) — 35 files, 655 passed, 2 todo.
- **`npm run typecheck:server` and `npm run typecheck:web`:** clean.
- **`npm run check`:** all six checks clean.
- **`npx vitest run --exclude ".claude/**"`, default timeouts:** 551 of 551 files, 10093 passed, 1 skipped, 25 todo. The run before it had one 5-second timeout in `components/features/practice/__tests__/server/externalRoutes.practice.test.ts` (not this bundle's; passes alone in about 4 s).
- Extension not touched.

## Requests

- **INT-11 / counsel:** the catalog wording in `compliance/consents.ts` is now what every GoApply signup form shows and hashes; it needs counsel review before launch. Changing it means bumping `CONSENT_PROSE_VERSION`; open forms then get the `outdated` answer and reload.
- **INT-13:** `server/src/lib/rateCard.ts:59` still names `RoboApplyMissionService.ts` in a comment.
- **INT-12:** mount `<TwoFactorSettings/>` and `<ChangePhoneSection/>` in `#security`; confirm `ToolResultClaimHost` is mounted where a new account lands on `/tools/*`.
- **INT-08:** `checkReferralFor` at onboarding `done` is still theirs.
- **WP-91/92:** translate the new keys below.
- **WP-95/96:** nothing here was viewed in a browser. Check the three GoApply consent boxes (the cross-border text is long) at 375 and 1280, light and dark, on the phone, WeChat and "其他方式" email forms; and `/login/2fa` reached from OAuth, phone and WeChat.
- **Owner:** enrolment opens only where `TOTP_ENCRYPTION_KEY` / `CN_TOTP_ENCRYPTION_KEY` is set.

## i18n keys

- **Added (en):** `auth.contextual.signupResumeJobMatch`, `auth.panel.resumeJobMatch`, `auth.loginForm.twoFactorUnavailable`.
- **Added (en + zh):** `authCn.otherMethods`, `authCn.otherMethodsEmail`, `authCn.errors.consent_outdated`.
- **Changed (en):** `authCn.consent.agreeFirst` is now "Tick every box above to continue."
- **Removed (en + zh):** `authCn.consent.agreement`, `authCn.consent.crossBorder` — the boxes show the served catalog text; no caller remained.
- **Obsolete, left in place:** `auth.methods.useEmail` (no caller on GoApply).

## Env vars introduced

None.

## Known gaps

- Phone and WeChat signup rows still store only the legal-documents version, no `proseHash`. The policy now serves the hash, so storing it is a small follow-up, but it changes which version those rows record.
- An API caller that posts GoApply email signup consents without `proseHash` is refused; only the web form (which reads the policy) can sign up by email.
- The stored touches ride the OAuth start URL as `ft` / `lt` (capped at 1500 characters each; a longer one loses its landing page or is left out).
- The JWT cut-off adds one primary-key read per bearer-JWT request and fails closed if the read fails.
- GoApply email signup in production checks the documents version only, as the item specified, not whether a phone or WeChat method is live.
- A mini-program client (no cookie jar) cannot complete the second step; no such client exists yet.
- A WeChat account with two-step sign-in loses the `bind=1` hint on the redirect to `/login/2fa`.
- A GoApply email account can earn both the `email_verified` and `phone_verified` practice credits; that is an owner decision.
- H34 (cross-brand signup answer) is unchanged.