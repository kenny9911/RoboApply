// extension/src/adapters/cn/index.ts — GoApply's portal adapters (一键填表).
//
// Moka, Beisen, Feishu and Dayee are matched by host + form markup; the
// label-heuristic generic adapter comes last and has no host permission of its
// own (see generic.ts). The manifest's host permissions and content scripts
// follow the hostPatterns of this list (src/manifest.ts).
//
// None of these adapters has a submit() or next(): the user presses the
// portal's own buttons. After a fill the panel outlines the portal's submit
// control and says "请核对后自行提交" (content/panel/submitHint.ts).

import type { AtsAdapter } from '../types';
import { beisenAdapter } from './beisen';
import { dayeeAdapter } from './dayee';
import { feishuAdapter } from './feishu';
import { genericCnAdapter } from './generic';
import { mokaAdapter } from './moka';

export { isCnAdapter, type CnAdapter } from './kit';

/** The portal adapters with a form host of their own (store listing, server's supported list). */
export const CN_PORTAL_ADAPTERS = [mokaAdapter, beisenAdapter, feishuAdapter, dayeeAdapter] as const;

export const CN_ADAPTERS: readonly AtsAdapter[] = [...CN_PORTAL_ADAPTERS, genericCnAdapter];
