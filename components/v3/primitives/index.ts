// V3 shared primitives — the self-contained kit every V3 screen lane imports.
// Built in Wave 0 (foundation); frozen after. See docs/roboapply/v3/
// 00-design-system.md §7 + 03-build-waves.md "Shared primitives".

export { PageHeader } from './PageHeader';
export { Btn, type BtnVariant } from './Btn';
export { Tag } from './Tag';
export { Pill, type PillTone } from './Pill';
export { EmptyState } from './EmptyState';
export { Modal } from './Modal';
export { Markdown } from './Markdown';
export * from './Iconset';

// FND-6a additions (ARCHITECTURE.md §10.2 rule 3): shared so no two areas
// build their own.
export { Drawer } from './Drawer';
export { Sheet } from './Sheet';
export { Tabs, tabPanelProps, type TabItem } from './Tabs';
export { Toaster, toast } from './Toast';
export {
  MIN_SAMPLE,
  SourceNote,
  SourcedValue,
} from './SourceNote';
export { CreditNotice, type CreditBucketLike } from './CreditNotice';
export { FitMeter } from './FitMeter';
export { FitTierLabel } from './FitTierLabel';
export { HonestyLine } from './HonestyLine';
