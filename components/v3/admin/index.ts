// components/v3/admin barrel — the admin console component kit.

export {
  DateRangePicker,
  TabRail,
  KpiStrip,
  Unit,
  resolveRange,
  type RangeValue,
  type RangePreset,
  type KpiCell,
  type KpiTone,
} from './controls';
export {
  ChartCard,
  ChartLegend,
  CostBreakdownBar,
  CostRevenueArea,
  ColumnChart,
  Sparkline,
  ModalityDonut,
  type BreakdownItem,
} from './charts';
export {
  TierBadge,
  StatusBadge,
  MarginBadge,
  MarginBar,
  EstimatedMarker,
} from './badges';
export {
  DataTable,
  UserCell,
  type Column,
  type SortState,
  type SortDir,
} from './table';
export { ProfitabilitySummary, SetPlanModal, RateCardPanel } from './panels';
export * from './format';
// Admin console additions (WP-74).
export { AdminNav, ADMIN_AREAS, adminAreasFor, currentAdminArea, type AdminArea } from './AdminNav';
export { AdminGate } from './AdminGate';
export { SystemConsole, SYSTEM_VIEWS, AUDIT_ACTIONS, fmtUsd, type SystemView } from './SystemConsole';
export { ReportsConsole } from './ReportsConsole';
// Held invite rewards (INT-08; WP-60's review routes).
export { InviteRewardsConsole, HOLD_REASONS, reviewOutcome, type ReviewOutcome } from './InviteRewardsConsole';
export { UserOverridesPanel, RefundQuotePanel, parseOverrideValue } from './UserAdminPanels';
// Job sources per brand (PAR-7): the shared sources panel and GoApply's company job boards.
export { SourcesConsole, JobSourcesPanel, CareerBoardsPanel, BOARD_SYSTEMS, boardProblemKey, tallyLines } from './SourcesConsole';
