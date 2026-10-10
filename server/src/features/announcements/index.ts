// server/src/features/announcements/index.ts — public surface (FND-5; owner WP-61).

export * from './contract.js';
export { createAnnouncementsRouter, requestLocale } from './routes.js';
export type { AnnouncementsRouterDeps } from './routes.js';
export { createAnnouncementsAdminRouter } from './adminRoutes.js';
export type { AnnouncementsAdminRouterDeps } from './adminRoutes.js';
export {
  AnnouncementsService,
  announcementsService,
  matchesCohort,
  missingLocales,
  pickAnnouncement,
  statusOf,
  toAdminView,
  validateDraft,
  viewFor,
} from './service.js';
export type { AnnouncementsServiceDeps, AudienceFacts, SeenState } from './service.js';
export { createPrismaAnnouncementsRepo, fromRow, LIST_IN_WINDOW_LIMIT, PUBLISHED_WHERE, readActive } from './repo.js';
export type { AnnouncementRecord, AnnouncementsRepo } from './repo.js';
