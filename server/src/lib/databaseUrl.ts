/**
 * Brand-aware database URL resolution — the SINGLE source of truth for which
 * Postgres the app and the Prisma migration CLI connect to.
 *
 * RoboHire is white-labelled per deploy via APP_NAME (see lib/brand.ts). The
 * two live brands point at two physically separate databases:
 *   - RoboHire (APP_NAME unset / 'robohire') → Neon         (DATABASE_URL)
 *   - GoHire   (APP_NAME = 'gohire')          → LightArk.cc  (DATABASE_URL_LIGHTARK)
 *
 * Routing here lets a single .env that holds BOTH DBs be flipped between them
 * just by changing APP_NAME (the local-dev workflow), while each production
 * brand service keeps working when it only sets the plain DATABASE_URL to its
 * own DB.
 *
 * Prod-safety invariant: when the *_LIGHTARK vars are ABSENT, every resolver
 * falls back to the plain DATABASE_URL / DIRECT_DATABASE_URL — i.e. behaviour
 * is byte-for-byte identical to before this module existed. A GoHire Render
 * service that simply sets DATABASE_URL to the LightArk DB (no _LIGHTARK var)
 * keeps working; only when the _LIGHTARK vars ARE set does APP_NAME route to
 * them. RoboHire NEVER reads the _LIGHTARK vars.
 *
 * Kept dependency-free (reads process.env directly; mirrors the case-insensitive
 * APP_NAME → brand normalisation in brands/index.ts) so it is safe to import
 * from BOTH the runtime client (lib/prisma.ts) and the Prisma config loader
 * (prisma.config.ts) without dragging brand bundles or the Prisma client into
 * the migration-CLI process.
 */

export type DbBrand = 'gohire' | 'robohire';

/**
 * Resolve the active DB brand from APP_NAME (legacy BRAND fallback),
 * case-insensitive. Anything other than 'gohire' resolves to 'robohire' (the
 * default), matching getBrand()'s "unknown → default" behaviour.
 */
export function resolveDbBrand(): DbBrand {
  const raw = (process.env.APP_NAME ?? process.env.BRAND ?? '').trim().toLowerCase();
  return raw === 'gohire' ? 'gohire' : 'robohire';
}

/**
 * Pooled (runtime) connection string for the active brand — used by the app's
 * pg.Pool in lib/prisma.ts. GoHire prefers DATABASE_URL_LIGHTARK and only falls
 * back to DATABASE_URL when it is unset (production GoHire service that points
 * DATABASE_URL straight at the LightArk DB).
 */
export function resolvePooledDatabaseUrl(): string | undefined {
  if (resolveDbBrand() === 'gohire') {
    return process.env.DATABASE_URL_LIGHTARK || process.env.DATABASE_URL;
  }
  return process.env.DATABASE_URL;
}

/**
 * Direct (non-pooler) connection string for the active brand — used by the
 * Prisma migration CLI (`db push` / `migrate`), which cannot go through
 * pgbouncer transaction-mode pooling. Falls back through the pooled URL and
 * then the non-brand vars so a deploy that only sets one of them still works.
 */
export function resolveDirectDatabaseUrl(): string | undefined {
  if (resolveDbBrand() === 'gohire') {
    return (
      process.env.DIRECT_DATABASE_URL_LIGHTARK ||
      process.env.DATABASE_URL_LIGHTARK ||
      process.env.DIRECT_DATABASE_URL ||
      process.env.DATABASE_URL
    );
  }
  return process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL;
}

// ──────────────────────────────────────────────────────────────────────────
// Cross-bank job-search (RoboApply candidate side). The candidate app reads
// recruiter `Job`/`Company` rows out of BOTH banks at once, regardless of
// which brand it runs as, so it needs explicit per-bank URLs rather than the
// single active-brand URL the resolvers above return.
//
// Fallbacks keep local dev + single-brand deploys working with NO new env:
//   - RoboHire bank → DATABASE_URL_ROBOHIRE, else DATABASE_URL when the active
//     brand IS robohire (its own DB already holds the RoboHire Job bank).
//   - GoHire bank   → DATABASE_URL_GOHIRE, else DATABASE_URL_LIGHTARK, else
//     DATABASE_URL when the active brand IS gohire.
// `undefined` = that bank is not configured → the search round degrades to the
// other bank (see raBankClients.isBankEnabled).
// ──────────────────────────────────────────────────────────────────────────

/** Active brand as a bank id (robohire default). */
export function activeBank(): DbBrand {
  return resolveDbBrand() === 'gohire' ? 'gohire' : 'robohire';
}

export function resolveRoboHireDatabaseUrl(): string | undefined {
  return (
    process.env.DATABASE_URL_ROBOHIRE ||
    (resolveDbBrand() === 'robohire' ? process.env.DATABASE_URL : undefined)
  );
}

export function resolveGoHireDatabaseUrl(): string | undefined {
  return (
    process.env.DATABASE_URL_GOHIRE ||
    process.env.DATABASE_URL_LIGHTARK ||
    (resolveDbBrand() === 'gohire' ? process.env.DATABASE_URL : undefined)
  );
}

export function resolveDirectRoboHireDatabaseUrl(): string | undefined {
  return process.env.DIRECT_DATABASE_URL_ROBOHIRE || resolveRoboHireDatabaseUrl();
}

export function resolveDirectGoHireDatabaseUrl(): string | undefined {
  return process.env.DIRECT_DATABASE_URL_GOHIRE || resolveGoHireDatabaseUrl();
}
