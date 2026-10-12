// V3 shared primitives — the self-contained kit every V3 screen lane imports.
// Built in Wave 0 (foundation); frozen after. See docs/roboapply/v3/
// 00-design-system.md §7 + 03-build-waves.md "Shared primitives".

export { PageHeader } from './PageHeader';
export { Btn, type BtnVariant } from './Btn';
export { Tag, type TagTone } from './Tag';
export { Pill, type PillTone } from './Pill';
export { Chip } from './Chip';
export { StatStrip, Stat } from './StatStrip';
export { ScoreDonut } from './ScoreDonut';
export { EmptyState } from './EmptyState';
export { Modal } from './Modal';
export { Markdown } from './Markdown';
export * from './Iconset';

// FND-6a additions (ARCHITECTURE.md §10.2 rule 3): shared so no two areas
// build their own.
export { Drawer, type DrawerProps } from './Drawer';
export { Sheet, type SheetProps } from './Sheet';
export { Tabs, tabIds, tabPanelProps, type TabItem, type TabsProps } from './Tabs';
export { Toaster, toast, dismissToast, useToasts, MAX_TOASTS, type ToastInput, type ToastItem, type ToastTone } from './Toast';
export {
  MIN_SAMPLE,
  SourceNote,
  SourcedValue,
  isEstimate,
  isPublishable,
  isSuppressed,
  type SourceNoteProps,
  type SourcedLike,
  type SourcedValueProps,
} from './SourceNote';
export { CreditNotice, creditsLeftOf, type CreditNoticeProps, type CreditBucketLike } from './CreditNotice';
export { FitMeter, type FitMeterProps } from './FitMeter';
export { FitTierLabel, resolveTier, type FitTierLabelProps } from './FitTierLabel';
export { HonestyLine, type HonestyLineProps } from './HonestyLine';
