# 台灣就業通 open-data fixtures: SYNTHETIC

Every row in this folder is **SYNTHETIC**. No real posting, employer, contact
or vacancy link is committed here (D3; the dataset's free-text fields can hold
personal data, which the licence does not cover).

- `joblist.synthetic.csv`: eight hand-built rows in the exact shape of one
  answer of `GET https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx?CITY=<code>&COUNT=1000&T=CSV`.
  Their `WKTIME` cells are `日班`, `日班、夜班、輪班二班制`,
  `部份工時：時分至時分`, an empty cell, `日班、中班`,
  `部份工時：9時0分至13時0分` and `夜班、輪班四班二輪制`: shapes that occur on
  the live endpoint (below; the hours are invented). Between them the rows
  hold every value the shift table maps.

What is real is the **structure**, confirmed against the live endpoint on
2026-10-11 with a handful of read-only requests (identifying User-Agent, a
pause between calls; nothing of a posting was kept):

- UTF-8 CSV with a byte-order mark, CRLF line ends, every cell quoted.
- 19 columns. Each header is the ASCII field name followed by its Chinese
  label in full-width brackets, for example `OCCU_DESC（職務名稱）`. The header
  line of the fixture is the live header line.
- `STOP_DATE` is `YYYYMMDD` or the words `額滿為止`; `TRANDATE` is `YYYYMMDD`.
- `NT_L` / `NT_U` are digits or `-`; a row can state a lower bound only.
- `SALARYCD` values seen: `月薪`, `時薪`, `日薪`, `論件計酬`, `部分工時(月薪)` and
  the no-figure sentence `依學經歷、證照核薪(每月經常性薪資達4萬元以上)`.
- `EXPERIENCE` values seen: `無`, `N年以上`, `1年內`.
- `WKTIME` (工作時間), read again on 2026-10-12 (two requests, `CITY=12` and
  `CITY=13`, 2,000 rows; only the cell's values were counted, with every digit
  masked, and nothing of a posting was kept). The cell is empty or holds one
  or more of these values joined by `、`:

  | Value as the source writes it | Rows that carry it (of 2,000) | `workShift` |
  |---|---|---|
  | `日班` | 1,678 | `day` |
  | `夜班` | 277 | `night` |
  | `中班` | 204 | `evening` (the shift between the day and the night shift) |
  | `輪班二班制` | 81 | `rotating` |
  | `輪班三班制` | 60 | `rotating` |
  | `輪班四班二輪制` | 47 | `rotating` |
  | `部份工時：N時N分至N時N分` (the hours of the job) | 119 | `part_time` |
  | `部份工時：時分至時分` (the same template, no hours filled in) | 42 | `part_time` |
  | (empty cell) | 93 | none |

  No other value was seen. 1,335 rows hold `日班` alone; with the digits
  masked the cell takes 34 distinct shapes, the empty cell among them
  (`日班、夜班`, `日班、中班`, `日班、夜班、輪班三班制、中班`, `日班、部份工時：…`
  and so on). The adapter's table (`TW_SHIFT_VALUES` in
  `twOpenData.ts`) holds exactly these values, plus the bare `輪班` and
  `部份工時` the research note names; a value outside it maps to no shift. A
  row that lists several values is stored as `rotating` when a `輪班` value is
  among them, else as the first value that maps, and the cell's own text is
  kept as a line of the description (`工作時間：…`).
- `STOP_DATE` and `TRANDATE` were `YYYYMMDD` on all 2,000 rows (140 rows said
  `額滿為止` instead of a deadline): the dataset writes no Republic-of-China
  year, so the adapter converts none.
- `EDGRDESC` values seen: `不拘`, `國小`, `國中`, `高中`, `高職`, `專科`, `大學`.
- `URL_QUERY` is `https://job.taiwanjobs.gov.tw/Internet/jobwanted/JobDetail.aspx?EMPLOYER_ID=<digits>&HIRE_ID=<digits>`.
- `CITY` combines with `zipno` and with `jobno` (one 大類).
- `CITY` and `zipno` do NOT select on the place a row displays (`CITYNAME`).
  `CITY=01&zipno=103` (大同區; 127 rows, under the cap) returned 125 rows that
  display 台北市大同區, one that displays 台北市中正區 and one that displays
  台北市不限. A county answer holds a few rows that display another county, and
  a district answer leaves out some rows the county answer displays in that
  district. So a row's place name does not tell which request returns it: a
  `<county>不限` row may or may not be under a `zipno`.

The 通俗職業 code and name pairs in the fixture are real pairs of the
classification (they are data about the classification, not about a posting).
Company names, titles, descriptions, ids and links are invented; the ids start
with `900000` and one link uses the reserved `example.invalid` host.

To look at real responses, save them OUTSIDE the repository and read them with
`node scripts/tw-jobno-catalog.mjs <file.csv>`.
