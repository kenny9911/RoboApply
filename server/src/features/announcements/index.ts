// server/src/features/announcements/index.ts — public surface (FND-5; owner WP-61).

export * from './contract.js';
export { createAnnouncementsRouter } from './routes.js';
export { createAnnouncementsAdminRouter } from './adminRoutes.js';
export {
  AnnouncementsService,
  matchesCohort,
  missingLocales,
  pickAnnouncement,
  statusOf,
  validateDraft,
} from './service.js';
export type { AudienceFacts } from './service.js';
export { createPrismaAnnouncementsRepo, fromRow, LIST_IN_WINDOW_LIMIT, PUBLISHED_WHERE, readActive } from './repo.js';
export type { AnnouncementRecord } from './repo.js';
