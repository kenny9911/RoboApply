// V3 Resume editor — the 6 inline-AI bullet actions. Source:
// RoboApply_V3/data.jsx AI_ACTIONS. The `id` maps 1:1 to
// RAResumeRewriteAction (lib/api/v2/types). Labels + descriptions are i18n
// keys under the `resumeEditor.action.*` namespace — the component resolves
// them with t(); only the glyph + id live here.

import type { RAResumeRewriteAction } from '../../../lib/api/v2/types';

export interface AiAction {
  id: RAResumeRewriteAction;
  /** Mono glyph shown on the action button. */
  icon: string;
}

export const AI_ACTIONS: AiAction[] = [
  { id: 'improve', icon: '✦' },
  { id: 'metrics', icon: '#' },
  { id: 'shorten', icon: '−' },
  { id: 'expand', icon: '+' },
  { id: 'confident', icon: '⚡' },
  { id: 'junior', icon: '↑' },
];

/** Non-traditional experience helpers for early-career users (proto
 *  YoungHelpers). Each maps to an i18n key under `resumeEditor.young.*`. */
export const YOUNG_HELPERS: Array<{ id: string; icon: string }> = [
  { id: 'class_project', icon: '🎓' },
  { id: 'hackathon', icon: '🏆' },
  { id: 'side_project', icon: '🛠' },
  { id: 'volunteer', icon: '🤝' },
  { id: 'freelance', icon: '💼' },
  { id: 'leadership', icon: '🏛' },
];
