// server/src/features/coaching/contract.ts
//
// Coaching roster + booking links (TASK_PLAN.md R-18, WP-72). Mounts:
// /api/v1/roboapply/coaching (seeker; capability `coaching` per route) and
// /api/v1/roboapply/admin/coaching (roster management). V2 has no paid
// booking: a coach's own booking link, or a request emailed to the coach and
// admin. There is no /coaching/bookings route (WP-72 asserts it 404s).
//
// D3: coaches are real people who agreed to be listed; ratings only after
// real sessions, shown with their count; the nav entry stays hidden while
// no coach is active.

import { z } from 'zod';

const Id = z.string().min(1).max(64);
export const CoachParamsSchema = z.object({ id: Id });

/** `RACoach.rates` (documented JSON column): `{ '30': amountMinor, '60': amountMinor, currency }`; empty when not listed. */
export const CoachRatesSchema = z
  .object({ currency: z.string().regex(/^[A-Z]{3}$/) })
  .catchall(z.union([z.number().int().min(0), z.string()]));

/** `RACoachBooking.contact` (documented JSON column; Later paid booking). */
export const CoachBookingContactSchema = z
  .object({ email: z.string().email().optional(), phone: z.string().optional(), preferredChannel: z.string().optional() })
  .passthrough();

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
  /** The coach's own booking page; null → use the request form. */
  bookingUrl: string | null;
  introVideoUrl: string | null;
  rating: { average: number; count: number } | null;
}

export const ListCoachesQuerySchema = z.object({ specialty: z.string().max(60).optional(), language: z.string().max(10).optional() });

/** POST /coaching/coaches/:id/request — emailed to the coach and admin. */
export const CoachRequestBodySchema = z
  .object({
    topic: z.string().trim().min(1).max(200),
    message: z.string().trim().max(2000).optional(),
    durationMin: z.number().int().min(15).max(180).optional(),
    preferredTimes: z.string().max(500).optional(),
    contactEmail: z.string().trim().email().max(254),
    resumeVariantId: Id.optional(),
  })
  .strict();

// ── Admin roster ─────────────────────────────────────────────────────────

export const CoachBodySchema = z
  .object({
    brand: z.enum(['roboapply', 'goapply']),
    userId: Id.optional(),
    displayName: z.string().trim().min(1).max(120),
    headline: z.string().trim().min(1).max(200),
    bio: z.string().trim().min(1).max(5000),
    photoUrl: z.string().url().max(500).optional(),
    languages: z.array(z.string().max(10)).max(10).default([]),
    specialties: z.array(z.string().max(60)).max(20).default([]),
    sessionLengths: z.array(z.number().int().min(15).max(180)).max(5).default([]),
    rates: CoachRatesSchema.optional(),
    bookingUrl: z.string().url().max(500).optional(),
    requestEmail: z.string().email().max(254).optional(),
    introVideoUrl: z.string().url().max(500).optional(),
    active: z.boolean().default(false),
  })
  .strict();
export const PatchCoachBodySchema = CoachBodySchema.partial().strict();
export const AdminCoachesQuerySchema = z.object({ brand: z.enum(['roboapply', 'goapply']).optional(), active: z.enum(['true', 'false']).optional() });

export const COACHING_ERROR_CODES = {
  coachNotFound: 'coach_not_found',
} as const;
