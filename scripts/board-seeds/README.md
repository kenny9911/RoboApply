# Employer-board seeds: how the lists are made

The three seed files of the employer boards
(`server/src/features/jobs/sources/atsPublic/seeds.{intl,tw,cn}.json`) are not
written by hand. They are the output of two scripts in this directory, and the
only thing that can put an employer into them is the answer of that employer's
live job board.

| File | What it is |
|---|---|
| `candidates.jsonl` | Guesses: "this employer hosts its careers on this job-board system under this board id". A line here is not a fact. |
| `validate.mjs` | Asks each candidate's board once, read-only, and writes what it answered into a report. |
| `places.mjs` | Reads which country a posting's location fields name. Used by the validator. |
| `report-<date>.json` | What every candidate answered on that date. Counts only: no posting title, no posting text. |
| `build-seeds.mjs` | Writes the three seed files from a report. Asks nothing. |
| `*.test.ts` | The rules of both scripts, against a fake fetch. No test reaches the network. |

The numbers of the last validation, what is left out and why, and the proposed
launch criterion are in `docs/jobright-clone/market/BOARD_SEEDS.md`.

## The rule

A candidate becomes a seed only when its board answers **200 with at least one
posting** and **passes the name check**:

- Greenhouse and SmartRecruiters state the company in their answer. That name
  must equal the candidate's `employer`, or one of its `aliases`, once case,
  accents, punctuation and legal forms (Inc, Ltd, GmbH, PBC, …) are set aside.
  The seed stores the name **as the board stated it**.
- Lever and Ashby state no company. The board id must equal the employer's
  name set the same way (`ramp` is Ramp, `woven-by-toyota` is Woven by Toyota).
  The seed stores the candidate's `employer`.
- A Lever or Ashby board id that does not spell the name (`shopback-2`,
  `kraken.com`) can be listed in the candidate's `aliases`. That is the
  candidates file speaking, not the board, so it gives the employer's name
  only with **`aliasSource`**: a document of this repository that confirms
  whose board it is (`board_id_alias` in the report; the source is written
  into the report and into the seed's note). Without a source the board is
  still a live board with postings: the report says `board_id_only` and the
  seed carries **the board id as its name**, the placeholder the server
  already knows (`hasPlaceholderName`). The guessed employer is stored nowhere.

Everything else is refused with a reason in the report: `not_found` (404),
`no_postings`, `name_mismatch` (with the name the board stated),
`name_unconfirmed` (the board id is neither the name nor listed for it),
`unexpected_shape`, `redirect`, and so on.

## What the validator asks, and how politely

One list-only read per candidate on the documented public endpoint the
server's connector already uses for that system (the test
`server/src/features/jobs/sources/atsPublic/seeds.test.ts` compares the URLs):

| System | Request |
|---|---|
| `greenhouse` | `GET boards-api.greenhouse.io/v1/boards/{id}/jobs` |
| `lever` | `GET api.lever.co/v0/postings/{id}?mode=json&skip&limit` |
| `lever_eu` | the same on `api.eu.lever.co` (reported only; no connector reads that host yet) |
| `ashby` | `GET api.ashbyhq.com/posting-api/job-board/{id}` |
| `smartrecruiters` | `GET api.smartrecruiters.com/v1/companies/{id}/postings` |

No other host can be asked: a URL outside these five is refused before a
request is made. None of them needs a key. It never calls RapidAPI, a career
site's HTML, or any site of the forbidden list (`MARKET_STRATEGY.md` 1.6).

- at most 2 requests in flight per host;
- at least 300 ms between one request to a host and the next (`--pause` can
  only make it longer);
- one retry after a network error; a 404 is never asked again;
- a host that answers 429 is left alone for the rest of the run;
- never more than `--max` requests per run (default 800);
- every request carries the identifying User-Agent the server's board sync
  sends (`RoboApplyJobs/1.0 (+<contact>)`, contact from `JOB_SOURCES_CONTACT`,
  else the site). It never poses as a browser.

It is run by hand. It is never part of a test, a build or a cron.

## What is kept

Per candidate: valid or the reason not; for a board that answered, the company
name as its answer stated it, the number of postings it listed, and the number
per ISO country. Countries come from **location fields only** (a location
line, a stated country code or name). No posting title or text is written
anywhere, and the date in the report is the `--date` argument, never the clock.

`places.mjs` decides "is this posting in mainland China / in Taiwan?" more
narrowly than the server does, on purpose: it names either only when every
place in the line agrees and the line ends on a place there. A line it does not
understand counts for the international market only. So a board's mainland and
Taiwan counts are a floor, never an overcount; the test beside the server
checks that on tens of thousands of generated lines against the server's own
parser.

A SmartRecruiters board is read for mainland China and for Taiwan with the
API's country filter (`countries: ['CN']` in the seed). Its count in those two
files is therefore the answer of that same listing: a candidate line with
`"countries": ["CN"]` (or `["TW"]`) beside the board's whole-listing line. The
builder takes the filtered answer where the report has one, and
`seeds.test.ts` fails for a SmartRecruiters entry of the mainland or the Taiwan
file that has none. A filtered listing longer than one page is read for its
first 100 rows; when all of them are in that country the rest is the API's own
count for it.

## Refreshing the lists

```bash
# 1. Add guesses (one JSON object per line) to candidates.jsonl.

# 2. Ask the boards. Run it again until it exits 0: each run stops at --max requests
#    and the next one asks only what has no final answer yet.
node scripts/board-seeds/validate.mjs \
  --candidates scripts/board-seeds/candidates.jsonl \
  --date 2026-10-11 --out scripts/board-seeds/report-2026-10-11.json

# 3. Long SmartRecruiters listings are not paged past --pages (default 10). To know the
#    countries of a long board, read it to its end:
node scripts/board-seeds/validate.mjs ... --only smartrecruiters --redo-incomplete --pages 50

#    A SmartRecruiters board that shows a posting in mainland China or in Taiwan: add a line
#    with "countries": ["CN"] (or ["TW"]) for it to candidates.jsonl and run again, one
#    request each. The lines of the last validation are in the file and are asked with the rest.
node scripts/board-seeds/validate.mjs ... --only smartrecruiters

#    One board again, whatever the report holds (a failure in passing never replaces an earlier answer):
node scripts/board-seeds/validate.mjs ... --redo greenhouse:acme

# 4. Read the name_mismatch lines of the report (see "Aliases" below). After editing
#    candidates.jsonl, judge the stored answers again. This asks nothing:
node scripts/board-seeds/validate.mjs ... --rejudge

# 5. See what the seed files would become, then write them.
node scripts/board-seeds/build-seeds.mjs --report scripts/board-seeds/report-2026-10-11.json
node scripts/board-seeds/build-seeds.mjs --report scripts/board-seeds/report-2026-10-11.json --write

# 6. The tests hold the files to the report.
npx vitest run scripts/board-seeds server/src/features/jobs/sources/atsPublic/seeds.test.ts

# 7. Put the new numbers into docs/jobright-clone/market/BOARD_SEEDS.md.
```

A refresh on another day uses a new `--date` and a new report file, so every
candidate is asked again (about 1,400 requests plus the pages of long
listings: two or three runs). Before a refresh, take the lines that answered
`not_found` out of `candidates.jsonl` (763 of them on 2026-10-11): a board id
that does not exist is not worth asking for again, and it halves the requests.
An existing seed entry the new report does not confirm is kept as it is and
named by `build-seeds.mjs`; the seed test then fails on it (an entry must carry
the facts of its last read), so the person refreshing decides what happens to
it and writes that down. Nothing is dropped silently. One kind of entry is
taken out, and named too: a board that has grown past a size cap (see "Limits
of the builder"), because a deployment must not seed a board it cannot read.

What a refresh does on a deployment: the loader adds the new boards and brings
the countries of the boards it owns to the list. It never switches a source
off, so a board that left the list stays as it is there until the board sync
or an admin switches it off. A refresh of the counts alone loads nothing.

## Aliases: when adding one is honest

An alias is a second spelling **of the same employer's name**, written into
`candidates.jsonl` where a reader can see it. Add one after a `name_mismatch`
only when the name the board stated is the candidate's employer under another
spelling: with its legal form or a describing word (`Chime Financial, Inc`,
`Gong.io`, `Take-Two Interactive Software, Inc.`), or under a shorter name the
company uses for itself (`Sword`, `Kodiak`, `Fubo`).

Do not add one when

- the board states **another company** (`palmetto` answered "Palmetto Animal
  Hospital", `watershed` on Greenhouse "Watershed Informatics", `codeorg`
  "CodeAI"): the guess was wrong, and that is the check working;
- the board states **a product or another brand** (`intercom` answered "Fin",
  `consensys` "MetaMask"): the seed would show that name as the employer;
- the board states **a label, not a name** ("Careers at Tide", "Rubrik Job
  Board", "R/GA Careers Page"): the seed stores the stated name, and a label
  is not a company name. An admin can add such a board by hand with the right
  name.

For Lever and Ashby an alias makes a stronger claim, because no answer of the
board confirms it: "this board id belongs to this employer". Writing a board
id into its own line proves nothing: any id can be written there. So the claim
needs its evidence on the same line:

```json
{"ats":"lever","token":"shopback-2","employer":"ShopBack","aliases":["shopback-2"],"aliasSource":"docs/jobright-clone/market/JOB_SOURCES_TW.md 3.5"}
```

`aliasSource` names a document of this repository, with the section, that
states the board id and the employer (`shopback-2`, `crypto` and `kraken.com`
are in `JOB_SOURCES_TW.md` 3.5; a test checks that the document exists and
names both). The report then says `board_id_alias` with `nameSource`, and the
seed's note repeats the source.

Without `aliasSource` the line still records whose board its author believes
it is, and nothing more. If the board answers, it is seeded under its board id
(`board_id_only`), never under the guessed name: `lever/octoenergy` is listed
as "octoenergy", although the line guesses Octopus Energy, because "octoenergy"
does not spell that name and no document confirms it. To give such a board its
name: write the document that confirms it, add `aliasSource`, run `--rejudge`
and rebuild (the loader then replaces the placeholder on every deployment); or
name the source in the admin console of a deployment. `BOARD_SEEDS.md` 2.5
lists these boards.

## Limits of the builder

`build-seeds.mjs` leaves a valid board out, and says so, when the server could
not read it as built:

- a Greenhouse or Ashby board whose single answer (all posting texts in one
  response) could come near the connector's 15 MB limit: more than 1,000
  postings on Greenhouse, 650 on Ashby (`--greenhouse-max`, `--ashby-max`). A
  refused answer is a hard failure and the third in a row switches the source
  off, so the caps leave more than a quarter of the limit free at the densest
  answer measured for each system (`MEASURED_CHARS_PER_POSTING`; a test holds
  them to the server's `MAX_RESPONSE_BYTES`). When the connector's limit is
  raised, set `MAX_RESPONSE_CHARS` in `validate.mjs` to the same value and
  rebuild with larger caps. An existing entry of a board over its cap is taken
  out of every file and named in the output;
- a SmartRecruiters board of more than 1,000 postings is not read whole from
  the international file (`--sr-max`); it is still seeded for mainland China
  and for Taiwan where it lists postings there, because the API's country
  filter keeps that listing short;
- a `lever_eu` board: no connector reads that host yet.
