// server/src/features/uistate/contract.ts
//
// Wire contract for GET/PATCH /api/v1/roboapply/ui-state (ARCHITECTURE.md
// §3.9, F-NOTIF-06). Per-user UI memory that follows the user across devices:
// tours seen, dismissals (with counts, e.g. "Finish setting up" demotes after
// two), the popup gate's last-shown time (lib/ui/popupGate.ts, 24 h gap),
// announcements seen, and small named values (e.g. the Assistant rail's open
// state, an offer's server-side start time).
//
// PATCH takes operations, not a whole document, so two tabs never overwrite
// each other's changes. Timestamps are stamped by the server; a client cannot
// back-date `popupLastShownAt` to dodge the popup budget.
// The web mirrors these types through lib/api/contracts/uistate.ts.

import { z } from 'zod';

/** Keys: letters, digits and `_ . : -`, 1–64 chars (e.g. 'onboarding.finishBanner'). */
export const UI_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const UiKeySchema = z.string().regex(UI_KEY_RE, 'Use 1–64 letters, digits, "_", ".", ":" or "-".');

/** Caps that keep one user's row small. */
export const UI_STATE_LIMITS = {
  /** Keys per operation list in one PATCH. */
  keysPerOp: 50,
  tours: 200,
  dismissals: 200,
  values: 100,
  /** Most recent announcement ids kept. */
  announcementsSeen: 200,
  /** Max length of a string value. */
  valueLength: 500,
} as const;

export const UiValueSchema = z.union([z.string().max(UI_STATE_LIMITS.valueLength), z.number().finite(), z.boolean(), z.null()]);
export type UiValue = z.infer<typeof UiValueSchema>;

export const DismissalSchema = z.object({
  count: z.number().int().min(0),
  /** ISO time of the latest dismissal. */
  at: z.string(),
});
export type Dismissal = z.infer<typeof DismissalSchema>;

/** The stored document (`RAUserUiState.state`). */
export const UiStateSchema = z.object({
  /** tour key → ISO time first seen. */
  tours: z.record(z.string(), z.string()),
  dismissals: z.record(z.string(), DismissalSchema),
  /** ISO time the popup gate last showed a non-essential popup, or null. */
  popupLastShownAt: z.string().nullable(),
  /** Announcement ids seen, oldest first. */
  announcementsSeen: z.array(z.string()),
  /** Small named values (no personal data). */
  values: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type UiState = z.infer<typeof UiStateSchema>;

export const EMPTY_UI_STATE: UiState = Object.freeze({
  tours: {},
  dismissals: {},
  popupLastShownAt: null,
  announcementsSeen: [],
  values: {},
}) as UiState;

const KeyList = z.array(UiKeySchema).max(UI_STATE_LIMITS.keysPerOp);

/** PATCH body: every field optional; at least one operation required. */
export const UiStatePatchSchema = z
  .object({
    /** Mark tours seen (first-seen time is kept on repeat). */
    toursSeen: KeyList.optional(),
    /** Forget tours (replay). */
    toursReset: KeyList.optional(),
    /** Record a dismissal (count += 1, at = now). */
    dismiss: KeyList.optional(),
    /** Forget dismissals. */
    undismiss: KeyList.optional(),
    /** The popup gate showed a popup now. */
    popupShown: z.literal(true).optional(),
    /** Add announcement ids. */
    announcementsSeen: z.array(z.string().min(1).max(64)).max(UI_STATE_LIMITS.keysPerOp).optional(),
    /** Set values; `null` deletes the key. */
    values: z
      .record(UiKeySchema, UiValueSchema)
      .refine((v) => Object.keys(v).length <= UI_STATE_LIMITS.keysPerOp, { message: 'Too many values in one request.' })
      .optional(),
  })
  .strict()
  .refine((p) => Object.values(p).some((v) => v !== undefined), { message: 'Send at least one operation.' });
export type UiStatePatch = z.infer<typeof UiStatePatchSchema>;

/** GET and PATCH response `data`. */
export interface UiStateResponse {
  state: UiState;
  /** Stamped by the feed (`GET /feed/new-count`), read-only here. */
  lastFeedVisitAt: string | null;
  updatedAt: string | null;
}

export const UI_STATE_ERROR_CODES = ['invalid_request', 'unauthorized', 'conflict'] as const;
