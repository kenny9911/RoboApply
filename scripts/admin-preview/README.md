# Admin design preview

Run `ROBOAPPLY_PREVIEW=admin node scripts/design-preview.mjs` with Node 24,
then open <http://localhost:3614/admin>.

This renders the actual admin and admin detail components with fictional data.
The fixed banner labels all data as examples. The preview-only admin identity
is aliased only for this mode; ordinary previews and production auth are unchanged.
Shared preview fetch blocking and CSP prevent live API/network activity.
Exports and plan changes are intentionally unavailable.

Useful review URLs:

- `/admin?locale=zh-CN&theme=light`
- `/admin?locale=en&theme=dark`
- `/admin?locale=zh-CN&theme=light&tab=payments`
- `/admin?locale=en&theme=dark&tab=users`
- `/admin?tab=activity&userId=preview-user-01`
- `/admin/users/preview-user-01?locale=zh-CN&theme=light`
- `/admin/sessions/preview-session-01?locale=en&theme=dark`

Operations tables support search, region/type/status/provider/currency filters,
date ranges, pagination, and per-user drill-downs. All amounts remain in their
fictional transaction currency (CNY, USD, EUR, TWD, JPY); model/media costs use USD.
`scenario=empty`, `scenario=error`, and `scenario=partial` exercise empty,
failed, and partial Stripe coverage states. Source edits rebuild automatically;
reload the browser to view changes. Use responsive browser sizing for mobile QA.
