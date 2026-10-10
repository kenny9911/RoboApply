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
