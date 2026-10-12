// server/src/features/admin/index.ts — public surface of the admin console (FND-5; owner WP-74).
//
//   createAdminConsoleRouter()   mounted at /api/v1/roboapply/admin (features/index.ts)
//   runAdminHealthEmail          jobs-maintain brand step: the daily health email to
//                                ADMIN_ALERT_EMAILS when a metric passes its alert level
//   buildSystemStatus / evaluateAlerts   the System panel and its alert rules

export * from './contract.js';
export { createAdminConsoleRouter } from './routes.js';
export type { AdminConsoleDeps } from './routes.js';
export { ADMIN_HEALTH_TEMPLATE_KEY, createAdminHealthTask, parseAdminEmails, runAdminHealthEmail } from './healthEmail.js';
export { buildSystemStatus, createPrismaSystemStore, evaluateAlerts, healthWindow } from './system.js';
export type { HealthMode, HealthWindow, SystemStore } from './system.js';
// For other areas' admin writes that need the same audit row (e.g. the credits area's override routes).
// Rows go to RAAdminAuditLog (adminId, subjectUserId, eventType, payload); writeAdminAudit never throws.
export { createPrismaAuditStore, writeAdminAudit } from './audit.js';
export type { AdminAuditRow, AdminAuditStore, AuditInput, AuditStore } from './audit.js';
