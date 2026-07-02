// prisma.config.ts (repo root)
//
// RoboApply shares the RoboHire Prisma schema (same Neon database for now).
// The schema lives under server/prisma/schema.prisma; its generator emits the
// client to server/src/generated/prisma. `prisma generate` (build/postinstall)
// only reads the schema and never connects, so a placeholder migration URL is
// fine when DIRECT_DATABASE_URL / DATABASE_URL aren't set in the build env.
//
// For `prisma db push` / `migrate`, set DIRECT_DATABASE_URL to the direct
// (non-pooler) Neon endpoint — DDL over the pgbouncer transaction pooler
// silently no-ops multi-statement changes.

import 'dotenv/config';
import path from 'node:path';
import { defineConfig } from 'prisma/config';

const migrationUrl =
  process.env.DIRECT_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://noop:noop@127.0.0.1:5432/noop';

export default defineConfig({
  schema: path.join('server', 'prisma', 'schema.prisma'),
  datasource: {
    url: migrationUrl,
  },
});
