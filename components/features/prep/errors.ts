// components/features/prep/errors.ts — one plain message key per failed AI
// call (WP-59). Keys live under `practiceQuestions.errors`.

import { apiErrorCode, apiErrorDetails } from '../../../lib/api/contracts/wire';

export type PrepErrorKey = 'phone' | 'limit' | 'aiOff' | 'safetyDown' | 'blocked' | 'notFound' | 'generic';

export function prepErrorKey(err: unknown): PrepErrorKey {
  const code = apiErrorCode(err);
  switch (code) {
    case 'phone_binding_required':
      return 'phone';
    case 'rate_limited':
      return 'limit';
    case 'content_blocked':
      return 'blocked';
    case 'not_found':
      return 'notFound';
    case 'ai_unavailable':
      return apiErrorDetails<{ reason?: string }>(err)?.reason === 'content_safety_unavailable' ? 'safetyDown' : 'aiOff';
    default:
      return 'generic';
  }
}
