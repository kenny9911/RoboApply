// __tests__/fixtures/uistate — per-user UI state (fictional data).
import type { RequestFixture } from '../types';

export const uiStateRequests: RequestFixture[] = [
  { contract: 'uistate', schema: 'UiStatePatchSchema', value: { toursSeen: ['jobs.intro'] } },
  { contract: 'uistate', schema: 'UiStatePatchSchema', value: {}, valid: false },
  { contract: 'uistate', schema: 'UiStatePatchSchema', value: { popupShown: true } },
];
