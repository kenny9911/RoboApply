// server/src/features/visitor/index.ts — public surface of the visitor area (owner WP-78).
//
//   - createVisitorCopilotRouter / createVisitorAlertsRouter: mounted by features/index.ts.
//   - runAnonAlertDigests: CronTask for the `job-alerts` cron (INT wires it beside
//     WP-39a's runJobAlerts; see digest.ts).
//   - VISITOR_EMAIL_EN: the English email strings (`visitor.email.*`) for INT to
//     move into server/src/i18n/email/staging/visitor.en.json.

export * from './contract.js';
export { createVisitorAlertsRouter, createVisitorCopilotRouter, runAnonAlertDigests, defaultAnonDigestDeps, defaultVisitorAlertsDeps } from './routes.js';
export { VisitorAlertsService } from './alerts.js';
export type { VisitorAlertsDeps, VisitorRate } from './alerts.js';
export { createAnonAlertDigestTask } from './digest.js';
export type { AnonDigestDeps } from './digest.js';
export { VISITOR_EMAIL_EN, VISITOR_EMAIL_TEMPLATES } from './emails.js';
export { createPrismaVisitorAlertsRepo } from './repo.js';
export type { VisitorAlertsRepo } from './repo.js';
