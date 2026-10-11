# 台灣就業通 open-data fixtures: SYNTHETIC

Every row in this folder is **SYNTHETIC**. No real posting, employer, contact
or vacancy link is committed here (D3; the dataset's free-text fields can hold
personal data, which the licence does not cover).

- `joblist.synthetic.csv`: eight hand-built rows in the exact shape of one
  answer of `GET https://free.taiwanjobs.gov.tw/webservice_taipei/Webservice.ashx?CITY=<code>&COUNT=1000&T=CSV`.

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
