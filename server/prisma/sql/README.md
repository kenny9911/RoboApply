# server/prisma/sql: extensions and the push order

The files here are run by hand, once per database, by the owner or the orchestrator.
They only install PostgreSQL extensions. Every table, column and index is declared in
the Prisma schema (`server/prisma/schema/`), because `prisma db push` drops whatever
the schema does not declare.

| File | What it does | When |
|---|---|---|
| `000_extensions.sql` | `CREATE EXTENSION IF NOT EXISTS pg_trgm;` | once per database, before the first push |
| `001_vector.sql` | `CREATE EXTENSION IF NOT EXISTS vector;` | once per database, before the market-wave push (M0) |

Both files are idempotent. No work-package engineer runs them, and no script in this
repository runs them for you.

## Order for the market-wave push (M0, bundle MKT-0)

The orchestrator follows this on the Neon branch of the clone. The owner follows it on
every other database (each deployment database before its deploy, the main database at
release). `DIRECT_DATABASE_URL` must be the direct, non-pooler endpoint
(`prisma.config.ts` explains why).

1. Run `000_extensions.sql` if it never ran on this database.
2. Run `001_vector.sql`, then confirm the version:

   ```sql
   SELECT extversion FROM pg_extension WHERE extname = 'vector';
   ```

   It must be 0.7.0 or newer. The push below creates three columns of type `halfvec(1024)`;
   that type does not exist in older versions, and the push fails without the extension.
   Neon ships it. For any other PostgreSQL see "Databases that are not Neon" below.
3. Read the diff from the database to the schema, before the push:

   ```bash
   npx prisma migrate diff --from-config-datasource --to-schema server/prisma/schema --script > /tmp/m0-before.sql
   node scripts/check-schema-additive.mjs --sql /tmp/m0-before.sql
   ```

   Expected: only `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN`, `CREATE INDEX` and
   `ADD CONSTRAINT`, and no drop of anything. The check exits 1 on a drop, a rename, a
   changed type, a changed default or a tightened column. With `--sql` it sets aside the
   pairs listed in `docs/jobright-clone/schema-diffs/KNOWN_DRIFT.md`, each only when its
   `CREATE INDEX` is the definition recorded there, and nothing else. Compare the output
   with `docs/jobright-clone/schema-diffs/market-additive.sql`, the diff reviewed before the
   push: the same six tables, 22 columns, 20 indexes and two foreign keys, plus whatever
   this database still lacks from earlier pushes (see step 6). Show this diff to the owner.
4. Push: `npm run db:push`.
5. Read the diff again, after the push, into a second file. Do not overwrite the first:

   ```bash
   npx prisma migrate diff --from-config-datasource --to-schema server/prisma/schema --script > /tmp/m0-after.sql
   node scripts/check-schema-additive.mjs --sql /tmp/m0-after.sql
   ```

   The diff must now be empty apart from `KNOWN_DRIFT.md` pairs. An empty second diff
   proves that `db push` sees neither the three `Unsupported` vector columns, nor the
   `Unsupported` text-search column `RAJob.searchTsv`, nor its GIN index as drift, so a
   later push will not drop them. If a `DROP INDEX` + `CREATE INDEX` pair for
   `RAJob_searchTsv_idx` or `RAJob_skillIds_idx` appears here, do not push again: read the
   note at the end of `KNOWN_DRIFT.md`.

   Keep both files, `/tmp/m0-before.sql` and `/tmp/m0-after.sql`, with the gate record of
   this database and show both to the owner. The acceptance line of SM-7 and the M0 gate
   ask for the two diffs: the one before the first push and the one of a second push with
   no schema change.
6. Confirm the three SR-16b-1 columns exist afterwards: `RAJob.lastSeenQueryId`,
   `RAJob.lastSeenRun` and `RAIngestQuery.runCount`. They were declared before this wave;
   the push creates them where a database lacked them.
7. From this commit on (M0, not M1) the generated client selects the new columns on every
   read or write that has no `select`. Push every database before it runs this commit or
   any later one: the Neon branch before any dev stack is restarted on the merged tree,
   each deployment database before its deploy. Code of this commit on a database without
   the push fails with `P2022` (column does not exist) on the feed
   (`rAUserAffinity.findUnique`), match scoring (`rAJobMatchScore.upsert`), career sources
   (`rACareerSiteSource.findUnique`) and plain job reads (`rAJob.findUnique`). The M1
   projections then add the new `RAJob` columns by name on top of that.

## Databases that are not Neon

The mainland stack does not have the `vector` extension today, and two files outside this
folder still describe a database without it. Both need a change before that database can
take the M0 push (no market bundle owns either file; the orchestrator assigns it):

- `deploy/cn/compose.yaml`: the `localdb` profile runs `postgres:16-alpine`, an image
  with no `vector` extension. `001_vector.sql` fails there and so does the push, at the
  first `halfvec(1024)` column. It needs an image that ships pgvector 0.7.0 or newer.
- `docs/runbooks/cn-deploy.md`: section 3 item 4 names only `pg_trgm` for the RDS
  instance, and section 6 goes straight to the push. Both need step 2 above (run
  `001_vector.sql`, confirm 0.7.0 or newer) before the push, and the owner has to confirm
  that the RDS instance offers the extension at that version.

Until then the mainland database stays on the schema before M0 and must not run code from
this commit or later (step 7).

## What the push must never do

Nothing in the market wave drops, renames or retypes a column, changes a default or makes
a column required. `AlipayOrder` is not changed at all. If a diff in step 3 or step 5 shows
anything else, stop and do not push.

## The text-search column and the vector columns

- `RAJob.searchTsv` is an ordinary nullable column. The application writes it in the same
  statement that writes `RAJob.searchDoc`. It is not a computed column: Prisma cannot
  declare one, and a column or an index created outside the schema is reported as drift
  and dropped by the next push. Its GIN index is declared in `ra-jobs.prisma`.
- Raw SQL on `RAJob` lists the columns it needs. It never uses `SELECT *`, `SELECT j.*` or
  `RETURNING *`, and it never returns `searchTsv` as it is: `@prisma/adapter-pg` has no
  mapping for that built-in type and throws `UnsupportedNativeDataType` on the result. Use
  the column in `WHERE` and `ORDER BY` (`@@`, `ts_rank_cd(...)`), or return
  `"searchTsv"::text`. A unit test with a fake Prisma client cannot catch this. The vector
  columns come back as text, because their type belongs to an extension.
- `RAJobEmbedding`, `RAUserEmbedding` and `RASkill.embedding` hold `halfvec(1024)` values.
  The Prisma client cannot write an `Unsupported` column, so those rows are read and
  written with `$queryRaw` / `$executeRaw`.
- Never edit the type inside `Unsupported("...")` of a column that exists. For a change
  such as `halfvec(1024)` to `halfvec(1536)` Prisma prints an empty migration and
  `db push` applies nothing, so the schema and the database drift apart without any
  error. A new vector dimension needs a new column (or a new table), filled and then
  switched to. `scripts/check-schema-additive.mjs` compares the two schema folders as
  text for this and fails with `unsupported_type_changed`.
- There is no HNSW index. Prisma 7.10 cannot declare one and the next push would drop it.
  Retrieval scans exactly over the filtered rows. When a market passes about 200,000 live
  rows the index is needed, and how the schema is migrated then is an owner decision.

## Checking a schema change without a database

```bash
npx prisma validate
node scripts/check-schema-additive.mjs            # diff from the merge base, datamodel to datamodel
node scripts/check-schema-additive.mjs --check docs/jobright-clone/schema-diffs/market-additive.sql
```

The script compares two schema folders and connects to nothing. In this mode it does not
read `KNOWN_DRIFT.md`: those pairs come from reading a database, so between two schema
folders a dropped index is always a real drop.
