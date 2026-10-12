# Retrieval suite fixtures

`suites/retrieval.suite.ts` measures Recall@200 of the recency-only list and of the fused list (recency, lexical and dense legs) over the synthetic postings of `fixtures/postings.<market>.json`. The dense leg needs a vector for every posting and every persona.

## `vectors.<market>.json` (recorded, optional)

Real embeddings of the synthetic texts, written by a live run and committed so CI needs no network:

```bash
EVAL_LIVE=1 npm run eval:match -- --live
```

A live run is the owner's step. It embeds only the synthetic card texts of the postings and the synthetic resume texts of the personas (no user data), with the embedding settings of the market's brand, and skips every text that is already recorded with the same model.

| Field | Meaning |
|---|---|
| `_synthetic` | always `true` |
| `market` | `intl` or `cn` |
| `model` | the model tag of every vector in the file (`<model>@1024`) |
| `dimensions`, `encoding` | `1024`, `f32le-base64` (little-endian float32, base64) |
| `postings`, `personas` | id → `{ hash, v }`: the sha1 of the text that was embedded, and its vector |

Rules the suite applies when it reads the file:

- A vector is used only when its `hash` is the sha1 of the text as the suite builds it now. After `fixtures/build.ts` changes a posting or a resume, that text has no recorded vector any more.
- Recorded vectors are used only when they cover every text. Otherwise the whole run is on proxy vectors: an embedding model and the proxy are never mixed in one value.
- A file recorded with another model is not reused when the model changes: the next live run records every text again.

## Without the file: proxy vectors

Until the file exists the suite builds a deterministic stand-in for each text: a hashed bag of its search tokens. It is not an embedding model. A run on proxy vectors prints its values with the note "proxy vectors" and status `no_fixture`; it is never held against the retrieval gate and never fails the command.

Numbers of the proxy run on the committed fixtures, for orientation only: Recall@200 0.62 recency-only and 0.99 fused on `intl` (326 postings), 0.83 and 1.00 on `cn` (246 postings). With 246 postings the newest 200 already hold four in five of them, so the gate (fused at least recency-only plus 15 points) needs a fused recall of 0.98 or more on `cn`.
