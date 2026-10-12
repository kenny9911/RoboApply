// components/features/notify-cn — public surface of GoApply WeChat notices (WP-73).
// Other areas import from here only (TASK_PLAN.md §2.1 rule 4).
//
//   <SubscribeOnTap template="deadline_reminder" eventId={id} onAnswer={({ accepted }) => …}>…remind-me control…</SubscribeOnTap>
//   <WechatShareCard title="…" description="…" path="/jobs/…" />   (job pages, inside WeChat)

export { SubscribeOnTap, SETTINGS_HREF, type SubscribeAnswer, type SubscribeOnTapOptions, type SubscribeOnTapProps, type SubscribeTemplate } from './SubscribeOnTap';
export { WechatShareCard, type WechatShareCardProps } from './WechatShareCard';
export { isWechatBrowser } from './wechatSdk';
