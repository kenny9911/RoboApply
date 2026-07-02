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
