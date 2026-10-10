# Known schema-diff false positives

`prisma migrate diff --from-config-datasource --to-schema server/prisma/schema` reports
these statements even when the database already matches the schema. They come from Prisma
not round-tripping raw operator classes on introspection. Additive-check scripts ignore
exactly these pairs and nothing else.

| Index | Reported as | Actual DB definition (verified on the clone branch, 2026-10-10) |
|---|---|---|
| `RAJob_sourceBoard_externalId_idx` | `DROP INDEX` + `CREATE INDEX … ("sourceBoard", "externalId" text_pattern_ops)` | `CREATE INDEX … USING btree ("sourceBoard", "externalId" text_pattern_ops)` — identical |

Release push (main DB): the `CREATE INDEX` runs once; afterwards the same pair reappears in
every diff and is safe to ignore.

## How `scripts/check-schema-additive.mjs` reads this table

- Only with `--sql`, on a diff made from a database. A diff between two schema folders
  (the default mode and `--check`) never uses this table: nothing is introspected there,
  so a dropped index is a real drop.
- First column: the index name, as one code span.
- Second column: the code span that starts with `CREATE` is the definition, written as the
  diff prints it, with `…` in place of the index name and its table. A pair is set aside
  only when the `CREATE INDEX` of that name in the diff is exactly this definition: same
  index method, same columns in the same order, same operator classes, no `WHERE`. The same
  name with another definition is a real change and fails. A row with no such code span
  excuses nothing.
- Prose and the third column are not read.

## Market wave (MKT-0, phase M0): no new entry expected

The GIN indexes added in M0, `RAJob_searchTsv_idx` (on the `Unsupported("tsvector")`
column) and `RAJob_skillIds_idx`, are declared in the plain form
(`@@index([searchTsv], type: Gin)`): `npx prisma validate` accepts it on an `Unsupported`
column, so no raw operator class was needed. They use the default GIN operator classes,
like `RAJob_skills_idx` and `RAJob_taxonomyIds_idx`, which have never appeared in a diff.
The expectation is therefore that neither appears after the push.

This could not be verified without a database (the M0 engineer connects to none). The
second diff of `server/prisma/sql/README.md` step 5 settles it. If that diff shows a
`DROP INDEX` + `CREATE INDEX` pair for one of the two, confirm with `\d "RAJob"` that the
definition in the database is identical, then add a row to the table above in the same
form: the name in the first column and, in the second, the `CREATE INDEX` statement of the
diff with `…` for the name and table, for example
`CREATE INDEX … USING GIN ("searchTsv")`. The acceptance line of SM-7 ("no drop of the
`searchTsv` index on a second push") is then read with that documented pair in mind.
