// components/features/auth-cn — public surface of GoApply sign-in (WP-11).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).

export { PhoneMethod } from './PhoneMethod';
export { WechatMethod } from './WechatMethod';
export { BindPhoneCard, BindPhoneForm, type BindPhoneFormProps } from './BindPhoneForm';
export { ChangePhoneSection } from './ChangePhoneSection';
export { WechatReturn, REVERIFY_STORAGE_KEY, type WechatReturnProps } from './WechatReturn';
export { WechatBrowserBanner, type WechatBrowserBannerProps } from './WechatBrowserBanner';
export { PhoneBindingNotice, type PhoneBindingNoticeProps } from './PhoneBindingNotice';
export { AdminInvites } from './AdminInvites';
export { isPhoneBindingRequired, isWechatBrowser, useIsWechatBrowser } from './shared';
// The GoApply signup inputs the email form shares with the phone form and the WeChat button (INT-01).
export { InviteCodeField, SignupConsents } from './SignupConsents';
export {
  agreementSatisfied,
  currentSignupLinkCodes,
  errorMessage as authCnErrorMessage,
  isConsentOutdated,
  isInviteInvalid,
  shownConsentsFromPolicy,
  prefillAccessCode,
  signupInputs,
  signupLinkCodes,
  useSignupInputs,
  useSignupPolicy,
} from './shared';
