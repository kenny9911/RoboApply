-- 000_extensions.sql — run ONCE by the owner on each database, BEFORE db push #1
-- (docs/jobright-clone/TASK_PLAN.md §4.0 G1; ARCHITECTURE.md §2.1).
--
-- RAJob.searchText carries a trigram GIN index declared in the Prisma schema:
--   @@index([searchText(ops: raw("gin_trgm_ops"))], type: Gin)
-- That index needs the pg_trgm extension. The index lives in the schema (not
-- here) because `prisma db push` drops indexes the schema does not declare.
--
-- Idempotent: safe to run again. Neon and Aliyun RDS PostgreSQL both ship pg_trgm.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
