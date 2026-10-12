# MKT-0

Schema foundation of the market wave (phase M0), after the independent review. Worktree `/Users/kenny/code/RoboApply/.claude/worktrees/wp-MKT-0`, branch `wp/MKT-0`, base `03b140f`. Nothing is committed.

**State:** all five items are implemented. `npx prisma validate`, `npm run db:generate`, `node scripts/check-schema-additive.mjs`, both typechecks and `npm run check` pass, and the 97 tests of this bundle pass.

**One gate is still not met and only the orchestrator can close it:** the full suite has 4 new red tests in 2 files that no bundle owns. Both files list every `RA*` model by hand, so any new model fails them. I did not edit them. The exact lines are in Requests O-1 and O-2; I ran O-1 in a temporary copy of the test and it passes 24 of 24. Every other failure is one of the 95 tests in 43 files of PAR-1's list, file for file and count for count.

**Decisions waiting for the orchestrator before the push:**
- **O-3:** what the account purge does with `RABillingRefund` rows.
- **O-6:** the unique key I added to `RABillingConsentArchive` after the review. It goes beyond the plan's schema list; confirm it or remove it (one line).
- **O-5:** the mainland database cannot take this push yet (no `vector` extension).

No database was contacted. I ran no `db push`, `migrate`, `db execute`, `db pull` or `studio`, and did not open `.env`.

## Items

### 1. Job index: RAJob, RACareerSiteSource, RASponsorRegisterEntry: done

`server/prisma/schema/ra-jobs.prisma`, added lines only (81 added, 0 removed).

- **RAJob:** one block directly above `userStates`, under the header comment the item gives, with the twelve fields: `atsPostingKey String?`, `sponsorshipSource String?`, `locationDistrict String?`, `workShift String?`, `titleMatchScore Float? @db.Real`, `skillIds String[] @default([])`, `searchDoc String? @db.Text`, `searchTsv Unsupported("tsvector")?`, `contentHash String?`, `lang String?`, `requirements Json?`, `embedding RAJobEmbedding?`. The `///` comments are copied from the schema entry.
- **RAJob indexes**, after the last existing one: `@@index([market, atsPostingKey])`, `@@index([market, locationCountry, locationDistrict])`, `@@index([skillIds], type: Gin)`, `@@index([searchTsv], type: Gin)`.
- **The plain form of the `searchTsv` index validates** on the `Unsupported` column. No raw operator class was needed, so no pair was added to `KNOWN_DRIFT.md`.
- **New after the review:** four `//` lines above the `searchTsv` comment tell raw-SQL writers never to return the column bare (see "Other bundles").
- **RACareerSiteSource:** `origin String @default("admin")`, `discoveredFrom String?`, `countries String[] @default([])`, `failCount Int @default(0)`, `lastChangeAt DateTime?`, `nextSyncAt DateTime?`, `disabledAt DateTime?` after `lastError`, and `@@index([enabled, nextSyncAt])`. `market`, `countryCode`, the unique key and the existing index are untouched.
- **RASponsorRegisterEntry:** appended at the end of the file exactly as in the schema entry, no relation field.
- `searchTsv` is absent from the generated client types. No generated column, nothing in raw SQL.
- Not declared again, as the item says: `skills`, `skillsDetail`, `sponsorship`, `sponsorshipEvidence`, `searchText`, `locationCountry`, `employmentType`, `firstSeenAt`, `lastSeenAt`, `lastSeenQueryId`, `lastSeenRun`, `RAIngestQuery.runCount`.

### 2. Fit, affinity, tailoring: done

- `ra-match.prisma`, `RAJobMatchScore`: `jobContentHash String?` and `rubricVersion String?` after `searchProfileVersion`. Unique key and all four indexes unchanged.
- `ra-feed.prisma`, `RAUserAffinity`: `titleWeights Json @default("{}")` after `skillWeights`.
- `ra-resume.prisma`, `RATailorSession`: `fitSnapshot Json?` after `scoreAfter`.
- The generated client carries all four as optional fields.

### 3. Vector extension file, embedding tables, skill vocabulary: done

- `server/prisma/sql/001_vector.sql`: header in the style of `000_extensions.sql`, one executable statement (`CREATE EXTENSION IF NOT EXISTS vector;`), the reason the tables live in the schema, the HNSW note. New after the review: the version query to run afterwards and the fact that the mainland `localdb` image has no such extension.
- `server/prisma/schema/ra-retrieval.prisma`: `RAJobEmbedding` and `RAUserEmbedding` exactly as in the schema entries, both with `onDelete: Cascade`.
- `server/prisma/schema/ra-skills.prisma`: `RASkill` exactly as in the schema entry.
- `legacy.prisma`: one added line in model `User`, `raUserEmbeddings RAUserEmbedding[]`, after `raCancelSurveys`.
- Generated client, checked by reading it: `rAJobEmbedding` and `rAUserEmbedding` have `findMany`, `update`, `delete` and no `create`, `createMany` or `upsert`. `rASkill` has full CRUD. No `embedding` column appears in any client type.

### 4. Billing records: done, with one addition beyond the schema entry

`ra-credits.prisma`: `RABillingRefund` and `RABillingConsentArchive` appended, no relation fields. `AlipayOrder` is byte-identical to the base (a test holds its text). `SeekerSubscription`, `RACreditLedger`, `RACreditGrant` and the other models of the file are unchanged.

- `RABillingRefund` is exactly the schema entry.
- `RABillingConsentArchive` has every field and the three indexes of the schema entry, **plus `@@unique([userId, consentType, consentedAt])`**, added after the review. This is the one place where the bundle departs from "exactly as in the schema entries". Reason and the way back are in Request O-6.

### 5. Additive-only check, review diff, runbook: implemented; one acceptance line open

- **`scripts/check-schema-additive.mjs`:** exports the base's schema folder to a temp directory, runs `prisma migrate diff --from-schema … --to-schema … --script`, prints the SQL and exits 1 on a non-additive statement. Flag names were read from the installed 7.10 help. The child process gets a closed-port placeholder for both database URLs.
- **SQL rules:** the seven the item names, plus any other `DROP`, a changed default, `ADD COLUMN … NOT NULL` with no default, and any statement that is not CREATE TABLE / ADD COLUMN / CREATE INDEX / ADD CONSTRAINT / CREATE TYPE / CREATE EXTENSION. A unique index or a constraint on an existing table is a warning.
- **New rule `unsupported_type_changed`:** the script compares the two schema folders as text for the type of every field where one side is `Unsupported("...")`. Prisma prints an empty migration for `halfvec(1024)` to `halfvec(1536)` and for `tsvector` to another raw type; the script now exits 1 on both.
- **KNOWN_DRIFT is stricter in two ways:**
  - It is applied with `--sql` only (a diff made from a database). The default mode and `--check` compare two schema folders, where nothing is introspected, so a dropped index is always a real drop.
  - A pair is set aside only when its `CREATE INDEX` is the definition recorded in the second column of the table: same method, same columns in the same order, same operator classes, no `WHERE`. A row with no recorded definition excuses nothing.
- **Other flags:** `--out <file>` writes below a marker line and keeps the header, `--check <file>` regenerates from the base commit recorded in the file and fails when it differs.
- **`docs/jobright-clone/schema-diffs/market-additive.sql`:** the script's output under a header that lists the additions beyond strategy 7 item 11 and, separately, the unique key beyond the plan's list. Content: 6 CREATE TABLE, 22 ADD COLUMN on 5 tables, 20 CREATE INDEX (three unique, all on new tables), 2 foreign keys with ON DELETE CASCADE. `--check` on it exits 0.
- **`server/prisma/sql/README.md`:** the seven-step order, reworded after the review (details under "Review resolution"), a section on databases that are not Neon, the raw-SQL rule for `RAJob`, and the rule that an `Unsupported` type is never edited in place.
- **`KNOWN_DRIFT.md`:** no new row. A new section states how the script reads the table. The M0 section says the two new GIN indexes are expected not to appear, that this is unverified without a database, and how to record a pair if step 5 shows one.
- **Open acceptance line 1, "npm test fails no test that passed before":** not met, 4 tests in 2 unowned files (Requests O-1, O-2, O-3).
- **Open acceptance line 2, SM-7:** the two database diffs are the orchestrator's step (Request O-4).

## Files changed

Modified, added lines only (0 removed lines in the whole diff):
- `server/prisma/schema/ra-jobs.prisma` (+81), `ra-credits.prisma` (+64), `ra-match.prisma` (+5), `ra-feed.prisma` (+2), `ra-resume.prisma` (+2), `legacy.prisma` (+1)
- `docs/jobright-clone/schema-diffs/KNOWN_DRIFT.md` (+32)

New:
- `server/prisma/schema/ra-retrieval.prisma`, `server/prisma/schema/ra-skills.prisma`
- `server/prisma/sql/001_vector.sql`, `server/prisma/sql/README.md`
- `scripts/check-schema-additive.mjs`
- `docs/jobright-clone/schema-diffs/market-additive.sql`
- `server/prisma/__tests__/marketSchema.test.ts`, `server/prisma/__tests__/checkSchemaAdditive.test.ts`

All inside MKT-0's owns. No unowned path is edited (`git status` shows only the paths above). `server/src/generated/prisma/` was regenerated in the worktree (gitignored).

## Tests run

All after the last change of this pass.

| Command | Result |
|---|---|
| `npx prisma validate` | valid |
| `npm run db:generate` | client generated (7.10.0) |
| `node scripts/check-schema-additive.mjs` | exit 0: 6 CREATE TABLE, 5 ALTER TABLE … ADD COLUMN, 20 CREATE INDEX, 2 ADD CONSTRAINT, no Unsupported type changed |
| `node scripts/check-schema-additive.mjs --check docs/jobright-clone/schema-diffs/market-additive.sql` | exit 0 |
| `npx vitest run server/prisma/__tests__ --exclude ".claude/**"` | 97 / 97 (`marketSchema` 41, `checkSchemaAdditive` 56) |
| `npm run typecheck:server` | exit 0 |
| `npx next typegen && npm run typecheck:web` | exit 0 |
| `npm run check` | exit 0 |
| `npx vitest run --exclude ".claude/**"` | 12,923 tests: 12,813 passed, 99 failed in 45 files, 1 skipped, 10 todo. The 99 are PAR-1's 95 in 43 files plus the 4 below |

Checks with the real Prisma engine on mutated copies of the schema in a scratch folder (schema to schema, no database):

| Mutation | Result |
|---|---|
| `text_pattern_ops` removed from the KNOWN_DRIFT index | exit 1, `drop_index` (it exited 0 before this pass) |
| `RAJobEmbedding.embedding` to `halfvec(1536)` | empty migration, exit 1, `unsupported_type_changed` |
| `RAJob.searchTsv` to `Unsupported("jsonb")?` | empty migration, exit 1, `unsupported_type_changed` |
| `searchTsv` made required | exit 1, `set_not_null` and `unsupported_type_changed` |
| `searchTsv` and its index removed | exit 1, `drop_index` and `drop_column` |
| `searchTsv` to `Json?` | exit 1, `drop_index`, `alter_column_type`, `unsupported_type_changed` |

`--sql` on stdin: the recorded KNOWN_DRIFT pair exits 0 with both statements ignored; the same pair without the operator class exits 1.

The two test files are in neither tsconfig (the root one excludes `server`, the server one includes only `src`), so they are checked by vitest only.

## Red tests for other bundles

Caused by this bundle. Neither file is in any market bundle's owns, so they go to the orchestrator.

- **`__tests__/prisma/schemaInvariants.test.ts` (3).** Its header says "SCHEMA-n steps that add models must extend PLACEMENT and SCOPE below".
  - "has no RA* model that the placement map does not know about" and "classifies every RA* model": the six new models must be in `PLACEMENT` and `SCOPE`.
  - "every RA* model with a userId/ownerUserId but no User relation is a listed no-FK exemption": `RABillingRefund` and `RABillingConsentArchive` must be `no_fk` entries of `NO_CASCADE`.
- **`server/src/features/auth/accountDeletion.test.ts` (1).** "zero rows remain in every RA table for the purged user": the leftovers are `RABillingRefund` and `RABillingConsentArchive`. The archive belongs in `KEPT_BY_DESIGN`. The refund row needs the decision of O-3.

## Pre-existing failures

The 95 tests in 43 files listed in `docs/jobright-clone/orch/handoffs-par/PAR-1.md` under "Red tests for other bundles". I matched my run against that list by file and by count: every listed file fails with the listed count, and no listed file is green. The 12 failures in 5 files that PAR-1 lists as pre-existing do not fail on this base.

## Requests

### Orchestrator

- **O-1. `__tests__/prisma/schemaInvariants.test.ts`: extend the three maps.** Verified: with exactly these lines in a temporary copy of the test the file passes 24 of 24.
  - `PLACEMENT`: `RASponsorRegisterEntry: 'ra-jobs.prisma'`, `RABillingRefund: 'ra-credits.prisma'`, `RABillingConsentArchive: 'ra-credits.prisma'`, `RAJobEmbedding: 'ra-retrieval.prisma'`, `RAUserEmbedding: 'ra-retrieval.prisma'`, `RASkill: 'ra-skills.prisma'`.
  - `SCOPE`: `RASponsorRegisterEntry: 'global'` (public register data), `RASkill: 'global'` (one vocabulary for both brands), `RABillingRefund: 'brand'`, `RABillingConsentArchive: 'brand'`, `RAJobEmbedding: 'brand'`, `RAUserEmbedding: 'brand'` (the last two carry `market`).
  - `NO_CASCADE`: `RABillingConsentArchive: { behaviour: 'no_fk', reason: 'proof of a checkout acknowledgement that must outlive the account (AB 2863); compliance-daily deletes it at retainUntil' }` and `RABillingRefund: { behaviour: 'no_fk', reason: … }` with the reason that follows from O-3 (for the recommended choice: `'refund record with no FK so User and AlipayOrder gain no back-relation; the account purge deletes it by userId'`).
- **O-2. `server/src/features/auth/accountDeletion.test.ts`:** add `RABillingConsentArchive` to `KEPT_BY_DESIGN` with the same reason.
- **O-3. Decide what the purge does with `RABillingRefund` rows.** The row holds a user id, charge, invoice and order ids and two free-text fields, and has no FK. The purge deletes only `rAOnboardingSession` and `rAWorkItem` by hand (`deleteRowsWithoutUserFk` in `server/src/roboapply/services/SeekerAccountPurgeService.ts`) and then the `User` row, so nothing removes refund rows. MKT-2D writes them from M2; the purge file has no owner before MKT-4A in M4.
  - **Recommended: the purge deletes them.** Payment rows go with the account today (`AlipayOrder` cascades from `User`), and the record of truth stays with Stripe and the merchant console. Change: add `prisma.rABillingRefund.deleteMany({ where: { userId } })` to the transaction in `deleteRowsWithoutUserFk`, and add that delegate to the hand-made mock in `SeekerAccountPurgeService.brand.test.ts`. Then the fourth red test passes with O-2 alone.
  - **Alternative: keep them** as financial records. Then `RABillingRefund` goes into `KEPT_BY_DESIGN`, and MKT-4A gets a retention rule for it in `features/compliance/retention.ts`.
  - No rows exist until M2, so either choice is safe at the M0 merge. If it is the first one, do it at the merge or give it to MKT-2D together with the file; do not leave it for M4.
- **O-4. The M0 push** follows `server/prisma/sql/README.md`.
  - **Push before anything runs on the merged tree.** The client generated from this commit already selects the new columns on every read or write without a `select`. I checked four call sites: `rAUserAffinity.findUnique` (`features/feed/repo.ts`), `rAJobMatchScore.upsert` (`features/match/repo.ts`), `rACareerSiteSource.findUnique` (`features/jobs/sources/atsPublic/service.ts`), `rAJob.findUnique` (`roboapply/v2/lib/legacyJobScope.ts`). On a database without the push they fail with `P2022`. So push the Neon branch before restarting any dev stack on the merged tree.
  - **Two sentences elsewhere still say M1** and should say M0 (I own neither file): the M0 merge row of `docs/jobright-clone/market/MARKET_TASK_PLAN.md` ("No M1 code runs against a database that lacks this push") and the schema note in `docs/jobright-clone/orch/market-bundles.json` ("From M1 on the code selects the new RAJob columns").
  - `001_vector.sql` runs before the push; then `SELECT extversion FROM pg_extension WHERE extname = 'vector'` must print 0.7.0 or newer.
  - Keep both diff files (`/tmp/m0-before.sql`, `/tmp/m0-after.sql`), classify each with `node scripts/check-schema-additive.mjs --sql <file>`, and show both to the owner (SM-7).
  - If the second diff shows a `DROP INDEX` + `CREATE INDEX` pair for `RAJob_searchTsv_idx` or `RAJob_skillIds_idx`, follow the note at the end of `KNOWN_DRIFT.md`.
- **O-5. The mainland stack cannot take the M0 push.** No market bundle owns either file below (`cn-deploy` and `compose.yaml` appear in no owns list), so this needs an assignment.
  - `deploy/cn/compose.yaml`, service of the `localdb` profile: the image is `postgres:16-alpine`, which has no `vector` extension. `001_vector.sql` fails there and the push fails at the first `halfvec(1024)` column. The reviewer proposes `pgvector/pgvector:pg16`; whoever makes the change confirms with the version query that the image carries 0.7.0 or newer (I did not check that image).
  - `docs/runbooks/cn-deploy.md`: section 3 item 4 names only `pg_trgm` for RDS and section 6 goes straight to `prisma db push`. Both need "run `server/prisma/sql/001_vector.sql` and confirm the version is 0.7.0 or newer" before the push.
  - It fails loudly, so nothing is corrupted. But until it is fixed GoApply's mainland database stays on the old schema and must not run code from M0 on (D5).
- **O-6. Confirm or remove the unique key on `RABillingConsentArchive`.** I added `@@unique([userId, consentType, consentedAt])` because the schema is frozen after M0 and a unique key cannot be added safely once the table has rows.
  - **Why:** MKT-4A must write the archive once even when the purge runs twice (a retry after a blocked storage cleanup, two overlapping sweeps). Its item plans "skip when rows for that userId exist", which is a read-then-insert and cannot hold under concurrency.
  - **If confirmed, three texts need the line** (I own none of them): the MKT-0 and MKT-4A schema entries in `market-bundles.json`, the `RABillingConsentArchive` row in MARKET_TASK_PLAN section 4, and MKT-4A's item, which should write with `createMany({ skipDuplicates: true })`. With a plain `create` an overlapping run would throw `P2002` instead of doing nothing.
  - **Collision check:** the three billing consent types are each written by one `seekerConsentRecord.create` per call (`platform/billing/acknowledgements.ts`, `features/billing-cn/service.ts`), so two records of one user and type with the same timestamp do not occur in normal use.
  - **To remove it:** delete the `@@unique` line in `ra-credits.prisma` and its entry in `marketSchema.test.ts`, then run `node scripts/check-schema-additive.mjs --base 03b140f --out docs/jobright-clone/schema-diffs/market-additive.sql` and `npm run db:generate`.
- **O-7. `RASkill` is not carried by the CN migration plan.** `deploy/cn/migration/plan.mjs` scopes tables by brand, market or user. `RASkill` has none of the three, so it lands under "unscoped" and is not migrated, while GoApply's `RAJob` rows keep their `skillIds`. The reviewer generated the plan and saw this; I confirmed the rule by reading the planner. No market bundle owns it. Either add a `MANUAL_SCOPES` entry for `RASkill` that copies the whole table (reason: shared vocabulary that `RAJob.skillIds` points to), or tell MKT-2G that its vocabulary seed must be runnable on each database and add that step to section 8 of `docs/runbooks/cn-deploy.md`.

### Other bundles (information, no change asked of them)

- **MKT-2H, MKT-3C, MKT-4F: raw SQL on `RAJob`.** List the columns you need. Never `SELECT *`, `SELECT j.*` or `RETURNING *`, and never return `searchTsv` bare. `@prisma/adapter-pg` has no mapping for the built-in type `tsvector` and throws `UnsupportedNativeDataType` on the result. Use the column in `WHERE` and `ORDER BY` (`@@`, `ts_rank_cd(...)`), or return `"searchTsv"::text`. A unit test with a fake Prisma client cannot catch this. The vector columns come back as text. No raw query on the branch selects `RAJob.*` today.
- **MKT-2H, MKT-4F:** `RAJob.searchTsv` and the three `embedding` columns are not in the client types. `rAJobEmbedding` and `rAUserEmbedding` have no `create`, `createMany` or `upsert`.
- **MKT-2H and whoever changes the embedding model later:** never edit the dimension inside `Unsupported("halfvec(1024)")`. A new dimension needs a new column or table; the check now fails on an edit.
- **MKT-2G:** `rASkill.create` and `upsert` work for every column except `embedding`. See O-7 for the mainland database.
- **MKT-2D, MKT-4A, MKT-4B:** `userId` on both billing models is a plain string with no relation, as specified. MKT-4A: see O-6.

### Owner

- O-3, if the orchestrator wants the owner's word on keeping refund records after account deletion.
- O-5: confirm that the mainland RDS instance offers the `vector` extension at 0.7.0 or newer.

## Schema requests

None for other bundles. Every entry of every bundle's schema array is delivered with the listed name, type, default and index. One thing is delivered beyond them: the unique key of O-6.

## Env variables added or redefined

None.

## i18n keys added or changed

None.

## Known gaps

- **Nothing was verified against a database.** The schema-to-schema diff proves the change is additive. It does not prove that `db push` leaves the `Unsupported` columns and the plain GIN index alone on a second push; step 5 of the runbook does, and the SM-7 acceptance line stays open until the orchestrator records both diffs.
- **Precedence notes.**
  - Strategy 2.1 still says "generated `tsvector('simple')`", while 2.3 "Stack constraints", SM-7 and critic C11 say no generated column. I followed 2.3, as the item does.
  - The additions beyond strategy 7 item 11 are the ones MARKET_TASK_PLAN section 4 lists; they are named in the header of `market-additive.sql`.
  - The unique key of O-6 is in neither the item nor the plan documents. It comes from the review.
  - The item's runbook step 7 says "from phase M1 on". The README now says M0, because that is what the generated client does.
- **`market-additive.sql` is not a database diff.** On a database that lacks the SR-16b-1 columns the real diff also shows those.
- **`--check` regenerates from the base commit recorded in the file.** It stays valid only while no later commit changes the schema folder, which the plan forbids for this wave.
- **The Unsupported comparison is text-based.** It reads `model` blocks and field lines of the two folders. It does not follow `@map`; no `Unsupported` field in the schema uses one.
- **The existing `.prisma` files were not run through `prisma format`**, to keep the diffs to added lines.
- **No HNSW index**, as planned.
- **`marketSchema.test.ts` freezes the pre-MKT-0 field lists** of ten models and the text of `AlipayOrder`. A later additive change to one of those models has to extend the expected lists in that test.

## Review resolution

1. **Item 5 judged not done ("npm test fails no test that passed before").** Confirmed and still open, because it cannot be closed inside my owns: the 4 failures are in two test files that list `RA*` models by hand. Not edited. Requests O-1 to O-3 carry the exact lines; O-1 is verified in a temporary copy (24 of 24).
2. **High, 4 new red tests in 2 unowned files.** Same as 1. Requests O-1, O-2, O-3.
3. **Medium, `RABillingRefund` rows survive the purge.** Confirmed by reading `deleteRowsWithoutUserFk`. The fix is in a file I do not own. Request O-3, with the recommendation to delete and the note not to leave it for M4.
4. **Medium, the runbook says "from phase M1 on".** Confirmed at the four call sites. Fixed: step 7 of `server/prisma/sql/README.md` now says from this commit on, names the `P2022` failure and the four reads. The same wording in MARKET_TASK_PLAN and the bundles note is Request O-4.
5. **Medium, the mainland stack has no pgvector.** Confirmed (`deploy/cn/compose.yaml` line 28, `cn-deploy.md` line 46 and section 6). Both files are unowned: Request O-5. In my owns: the README has a section "Databases that are not Neon" naming both places, step 2 has the version query, and `001_vector.sql` says the same in its header.
6. **Low, a KNOWN_DRIFT name excuses a real change.** Confirmed and fixed. KNOWN_DRIFT is applied with `--sql` only, and a pair needs the recorded definition. 12 new tests: seven changed definitions of the listed name fail (no operator class, other columns, other order, other operator class, other method, partial, unique), a row without a definition excuses nothing, and `main` in schema mode fails on the pair. The reviewer's real-Prisma case now exits 1.
7. **Low, a retype of an `Unsupported` column is invisible.** Confirmed and fixed with the rule `unsupported_type_changed` (text comparison of the two folders). Both of the reviewer's cases exit 1 with the real engine. The README states that a vector dimension change needs a new column.
8. **Low, runbook step 5 overwrites the first diff.** Fixed: step 5 has its own command writing `/tmp/m0-after.sql`, and says to keep both files with the gate record.
9. **Low, a raw query returning `searchTsv` throws.** Confirmed in `@prisma/adapter-pg` (OID 3614 is below `FIRST_NORMAL_OBJECT_ID`, so `fieldToColumnType` throws). Fixed where I own: a comment above the field in `ra-jobs.prisma` (a test holds it), a bullet in the README, and the note to MKT-2H, MKT-3C and MKT-4F above.
10. **Low, `RABillingConsentArchive` has no unique key.** Implemented, because this is the only point where it can be added: `@@unique([userId, consentType, consentedAt])`, the test, the regenerated `market-additive.sql` and its header. The decision stays with the orchestrator: Request O-6 gives the three texts to update and the one-line way back.
11. **Low, the CN migration plan does not carry `RASkill`.** Confirmed by reading the planner's scope rules. The file is unowned: Request O-7 with both options.

Unowned edits: none to revert (the review found none, and `git status` shows only owned paths).
