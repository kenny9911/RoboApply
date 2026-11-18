// server/src/features/visitor/index.ts — public surface of the visitor area (owner WP-78).
//
//   - createVisitorCopilotRouter / createVisitorAlertsRouter: mounted by features/index.ts.
//   - runAnonAlertDigests: CronTask for the `job-alerts` cron (INT wires it beside
//     WP-39a's runJobAlerts; see digest.ts).
//   - VISITOR_EMAIL_EN: the English email strings (`visitor.email.*`) for INT to
//     move into server/src/i18n/email/staging/visitor.en.json.

export * from './contract.js';
export { runAnonAlertDigests } from './routes.js';
