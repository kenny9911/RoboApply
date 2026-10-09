'use client';

// CopilotRail — the Assistant's right-rail drawer (desktop) / full-screen sheet
// (phone), mounted once by the app shell (FND-6a layout slot; F-ORION-01).
//
// STUB (FND-6a). Owner: WP-51. Renders nothing.
//
// Contract for the owner:
//   • read the open state and the request from `useAssistantRail()`
//     (hooks/shared/useOpenAssistant.ts); producers call `useOpenAssistant()`;
//   • NEVER open on route change. The shell does not touch the rail store on
//     navigation, and the rail must not either (a test in
//     __tests__/shell/layout.test.tsx guards the shell side);
//   • use the Drawer / Sheet primitives (focus management included);
//   • remember open/closed in RAUserUiState (`values['assistant.rail']`).
//   • render nothing when the `copilot` flag is off.

export type CopilotRailProps = Record<string, never>;

export function CopilotRail(_props: CopilotRailProps = {}): null {
  return null;
}

export default CopilotRail;
