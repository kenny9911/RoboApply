// server/src/features/coaching/contract.ts
//
// Coaching roster + booking links (TASK_PLAN.md R-18, WP-72). Mounts:
// /api/v1/roboapply/coaching (seeker; capability `coaching` per route) and
// /api/v1/roboapply/admin/coaching (roster management). V2 has no paid
// booking: a coach's own booking link, or a request emailed to the coach and
// admin. There is no /coaching/bookings route (WP-72 asserts it 404s).
//
// D3: coaches are real people who agreed to be listed; ratings only after
// real sessions, shown with their count (V2 records no sessions, so `rating`
// is always null); the nav entry stays hidden while no coach is active.
// Payment: the coach is paid directly by the user. The platform takes no
// coaching payment on any rail, and never on the CN rails (no 二清).

import { z } from 'zod';

const Id = z.string().min(1).max(64);
export const CoachParamsSchema = z.object({ id: Id });

/** Only http(s) links reach a page or an email (no `javascript:` / `data:` URLs). */
const WebUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), { message: 'Use an http(s) link.' });

/** Session lengths a coach may offer, in minutes. */
export const SESSION_MINUTES = { min: 15, max: 180 } as const;

/**
 * `RACoach.rates` (documented JSON column): `{ '30': amountMinor, '60': amountMinor, currency }`
 * as set by the coach; `{}` when not listed. Keys other than `currency` are session lengths in minutes.
 */
export const CoachRatesSchema = z
  .object({ currency: z.string().regex(/^[A-Z]{3}$/) })
  .catchall(z.union([z.number().int().min(0), z.string()]))
  .superRefine((rates, ctx) => {
    for (const [key, value] of Object.entries(rates)) {
      if (key === 'currency') continue;
      if (!/^\d{2,3}$/.test(key)) ctx.addIssue({ code: 'custom', path: [key], message: 'Rate keys are session lengths in minutes.' });
      else if (typeof value !== 'number') ctx.addIssue({ code: 'custom', path: [key], message: 'Rates are amounts in minor units.' });
    }
  });

/** `RACoachBooking.contact` (documented JSON column; Later paid booking). */
export const CoachBookingContactSchema = z
  .object({ email: z.string().email().optional(), phone: z.string().optional(), preferredChannel: z.string().optional() })
  .passthrough();

/** How a user books this coach: the coach's own booking page, or a request emailed to the coach and admin. */
export type CoachBookingMode = 'link' | 'request';

/** One session length and the coach's own price for it (null → "Price not listed"). */
export interface CoachSessionOption {
  minutes: number;
  /** Amount in minor units of `currency`, as the coach set it; null when not listed. */
  amountMinor: number | null;
  currency: string | null;
}

export interface CoachView {
  id: string;
  displayName: string;
  headline: string;
  bio: string;
  photoUrl: string | null;
  languages: string[];
  specialties: string[];
  sessionLengths: number[];
  rates: Record<string, number | string> | null;
  /** Session lengths with the coach's own prices (derived from `sessionLengths` + `rates`). */
  sessions: CoachSessionOption[];
  /** The coach's own booking page; null → use the request form. */
  bookingUrl: string | null;
  /** 'link' when `bookingUrl` is set, else 'request' (the coach's email stays private). */
  booking: CoachBookingMode;
  introVideoUrl: string | null;
  /** Only from real post-session ratings, with their count. V2 has none, so always null. */
  rating: { average: number; count: number } | null;
}

export const ListCoachesQuerySchema = z.object({ specialty: z.string().max(60).optional(), language: z.string().max(10).optional() });

/** POST /coaching/coaches/:id/request — emailed to the coach and admin. */
export const CoachRequestBodySchema = z
  .object({
    /** The name the coach should use; optional. */
    name: z.string().trim().max(120).optional(),
    topic: z.string().trim().min(1).max(200),
    message: z.string().trim().max(2000).optional(),
    durationMin: z.number().int().min(SESSION_MINUTES.min).max(SESSION_MINUTES.max).optional(),
    preferredTimes: z.string().trim().max(500).optional(),
    contactEmail: z.string().trim().email().max(254),
    /**
     * The user's separate consent to send their name, email and message to the
     * coach (an independent third party). Required where the site's market asks
     * for it (GoApply: PIPL Art. 23); ignored elsewhere.
     */
    shareConsent: z.literal(true).optional(),
  })
  .strict();

export interface CoachRequestResponse {
  /** True once the email to the coach was accepted for delivery. */
  received: true;
}

// ── Admin roster ─────────────────────────────────────────────────────────

export const CoachBodySchema = z
  .object({
    brand: z.enum(['roboapply', 'goapply']),
    userId: Id.optional(),
    displayName: z.string().trim().min(1).max(120),
    headline: z.string().trim().min(1).max(200),
    bio: z.string().trim().min(1).max(5000),
    photoUrl: WebUrl.optional(),
    languages: z.array(z.string().trim().min(2).max(10)).max(10).default([]),
    specialties: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    sessionLengths: z.array(z.number().int().min(SESSION_MINUTES.min).max(SESSION_MINUTES.max)).max(5).default([]),
    rates: CoachRatesSchema.optional(),
    bookingUrl: WebUrl.optional(),
    requestEmail: z.string().trim().email().max(254).optional(),
    introVideoUrl: WebUrl.optional(),
    active: z.boolean().default(false),
    /**
     * Staff attest that this person agreed to be listed (D3). Required on
     * create: a roster row never exists without it. Not part of PATCH.
     */
    listingConsent: z.literal(true),
  })
  .strict();

/**
 * PATCH body: any subset of the create body. `null` clears an optional field
 * (photo, booking link, request email, intro video, rates).
 */
export const PatchCoachBodySchema = z
  .object({
    brand: z.enum(['roboapply', 'goapply']),
    userId: Id.nullable(),
    displayName: z.string().trim().min(1).max(120),
    headline: z.string().trim().min(1).max(200),
    bio: z.string().trim().min(1).max(5000),
    photoUrl: WebUrl.nullable(),
    languages: z.array(z.string().trim().min(2).max(10)).max(10),
    specialties: z.array(z.string().trim().min(1).max(60)).max(20),
    sessionLengths: z.array(z.number().int().min(SESSION_MINUTES.min).max(SESSION_MINUTES.max)).max(5),
    rates: CoachRatesSchema.nullable(),
    bookingUrl: WebUrl.nullable(),
    requestEmail: z.string().trim().email().max(254).nullable(),
    introVideoUrl: WebUrl.nullable(),
    active: z.boolean(),
  })
  .partial()
  .strict();

export const AdminCoachesQuerySchema = z.object({ brand: z.enum(['roboapply', 'goapply']).optional(), active: z.enum(['true', 'false']).optional() });

/** The roster row as staff see it (includes the private request address and listing state). */
export interface AdminCoachView extends CoachView {
  brand: 'roboapply' | 'goapply';
  userId: string | null;
  requestEmail: string | null;
  active: boolean;
  /** 'applied' | 'approved' | 'paused' | 'rejected' (Later marketplace; staff-added coaches are 'approved'). */
  status: string;
  createdAt: string;
  updatedAt: string;
}

export const COACHING_LIMITS = {
  /** Booking requests per user per day (abuse guard on emails to real people). */
  requestsPerUserPerDay: 5,
} as const;

/** Area reasons, carried in `details.reason` under a platform code. */
export const COACHING_ERROR_CODES = {
  /** 404 not_found: no such coach, or not listed on this site. */
  coachNotFound: 'coach_not_found',
  /** 409 conflict: this coach takes bookings on their own page (use `bookingUrl`). */
  useBookingLink: 'use_booking_link',
  /** 422 invalid_request: a listed coach needs a booking link or a request email. */
  noBookingPath: 'no_booking_path',
  /** 422 invalid_request: the session length is not one the coach offers. */
  durationNotOffered: 'duration_not_offered',
  /** 409 conflict: the account is already linked to another roster entry. */
  coachUserTaken: 'coach_user_taken',
  /** 422 invalid_request: the linked account ID does not exist. */
  coachUserNotFound: 'coach_user_not_found',
  /** 422 invalid_request: the linked account belongs to the other site. */
  coachUserWrongBrand: 'coach_user_wrong_brand',
  /** 422 invalid_request: this site needs the user's consent to share the request with the coach. */
  shareConsentRequired: 'share_consent_required',
} as const;
