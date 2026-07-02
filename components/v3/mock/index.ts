// V3 Mock-interview (Routes 5–7) components. See app/(auth)/mock-interview/*.
//
// A re-skin of the legacy mock-interview surface onto the V3 token system +
// the .iv-* class family in styles/v3.css, wired to the mock.* API envelope
// (useMockV3 hooks → raV2Api.mock.* → stub today). Setup → live → report.

// Setup (Route 5)
export { RecentSessionsStrip } from './RecentSessionsStrip';
export { RolePicker } from './RolePicker';
export { MarketRequirementsPanel } from './MarketRequirementsPanel';
export { InterviewerPicker } from './InterviewerPicker';
export { TypePicker } from './TypePicker';
export { FormatPicker } from './FormatPicker';
export { LangDurationPicker } from './LangDurationPicker';
export { LaunchBar } from './LaunchBar';

// Live (Route 6)
export { LiveBar } from './LiveBar';
export { InterviewerTile, type AiState } from './InterviewerTile';
export { QuestionCard } from './QuestionCard';
export { YourTile } from './YourTile';
export { MicViz } from './MicViz';
export { LiveControls } from './LiveControls';
export { CoachNudge } from './CoachNudge';
export { LiveTranscript } from './LiveTranscript';
// Live coach layer (conversational engine): hint + nudge + meters + toggle.
export {
  useLiveCoach,
  LiveQuestionCard,
  LiveCoachNudge,
  CoachMeters,
  CoachToggle,
  type CoachMetrics,
  type UseLiveCoachResult,
} from './LiveCoach';

// Report (Route 7)
export { ResultsTop } from './ResultsTop';
export { ResultsGrid } from './ResultsGrid';
export { RecommendationsCard } from './RecommendationsCard';
export { QuestionBreakdownSection } from './QuestionBreakdownSection';
export { QuestionBreakdownItem } from './QuestionBreakdownItem';
export { RatingChip } from './RatingChip';
