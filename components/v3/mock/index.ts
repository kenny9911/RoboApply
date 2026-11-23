// V3 Mock-interview (Routes 5–7) components. See app/(auth)/mock-interview/*.
//
// A re-skin of the legacy mock-interview surface onto the V3 token system +
// the .iv-* class family in styles/v3.css, wired to the mock.* API envelope
// (useMockV3 hooks → raV2Api.mock.* → stub today). Setup → live → report.

// Setup (Route 5) — one screen in two columns: the job picker, the plan chips
// and the prep brief on the left, the side panel (how a practice works and the
// recent practices, then the summary with Start) on the right; all composed by
// PracticeSetupFlow. The per-step pickers the old four-step wizard composed
// (RolePicker, InterviewerPicker, TypePicker, FormatPicker, LangDurationPicker,
// LaunchBar) went with it.
export {
  PracticeSetupFlow,
  JD_MIN_CHARS,
  DEFAULT_PRACTICE_MINUTES,
  practiceDurationOptions,
  type RecentPractice,
  type RoleSourceMode,
} from './PracticeSetupFlow';
export { PracticeTargetPicker, type PracticeTarget, type LoadState } from './PracticeTargetPicker';

// Live (Route 6)
export { LiveBar } from './LiveBar';
export { InterviewerTile, type AiState } from './InterviewerTile';
export { YourTile } from './YourTile';
export { LiveTranscript } from './LiveTranscript';
// Live coach layer (conversational engine): hint + nudge + meters.
export {
  useLiveCoach,
  LiveQuestionCard,
  LiveCoachNudge,
  CoachMeters,
  type LiveTurn,
} from './LiveCoach';

// Report (Route 7)
export { QuestionBreakdownSection } from './QuestionBreakdownSection';
export { TranscriptViewer } from './TranscriptViewer';
