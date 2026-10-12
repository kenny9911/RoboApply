// __tests__/fixtures/uistate — per-user UI state (fictional data).
import type * as U from '../../../lib/api/contracts/uistate';
import type { RequestFixture } from '../types';

export const uiStateResponse = {
  state: { tours: {}, dismissals: {}, popupLastShownAt: null, announcementsSeen: [], values: {} },
  lastFeedVisitAt: null,
  updatedAt: null,
} satisfies U.UiStateResponse;

export const uiStateRequests: RequestFixture[] = [
  { contract: 'uistate', schema: 'UiStatePatchSchema', value: { toursSeen: ['jobs.intro'] } },
  { contract: 'uistate', schema: 'UiStatePatchSchema', value: {}, valid: false },
  { contract: 'uistate', schema: 'UiStatePatchSchema', value: { popupShown: true } },
];
