# 事求人 fixtures: SYNTHETIC

Every record in `sample.xml` is **SYNTHETIC**. No real vacancy, agency, official
or contact detail is committed here (D3; the dataset's contact fields hold
officials' names, e-mail addresses and phone numbers, which the licence does
not cover).

- `sample.xml`: three hand-built records in the exact shape of
  `GET https://web3.dgpa.gov.tw/WANT03FRONT/AP/WANTF00003.aspx?GETJOB=Y`
  (data.gov.tw dataset 7229, 行政院人事行政總處事求人機關徵才資料, OGDL v1):
  1. 約僱人員, one place, open through 115-12-31. Its `WORK_ITEM` holds a fake
     e-mail address and a fake phone number inside the text, as some real rows
     do, to prove the adapter takes them out.
  2. 一般人員 (a transfer post for serving civil servants), two places.
  3. 其他人員, with `&lt;`, `&gt;` and an empty `RESERVE_NUM`.

The two contact elements (`VITAE_EMAIL`, `CONTACT_METHOD`) hold obviously fake
values: every address is on the reserved `example.invalid` host and every
number is `(00)5550-01xx`. The adapter never reads those two elements; the test
scans every posting it produces for them.

What is real is the **structure**, confirmed with one read-only request to the
endpoint on 2026-10-12 (identifying User-Agent; the answer was analysed for
element names, value shapes and counts only, and deleted; nothing of a vacancy
was kept):

- UTF-8 XML, 6.3 MB, 2,054 records. `<ROOT>`, one `<ANNOUNCE_DATE>` (a Republic
  of China date, `1151012`), then one `<ROW>` per vacancy. No whitespace
  between elements, no attributes, no CDATA; the entities seen are `&amp;`,
  `&lt;` and `&gt;`. An empty element is written `<RANK />`.
- 26 elements per record on every record, in this order: `ORG_ID`, `ORG_NAME`, `PERSON_KIND`,
  `RANK`, `TITLE`, `SYSNAM`, `NUMBER_OF`, `RESERVE_NUM`, `GENDER_TYPE`,
  `WORK_PLACE_TYPE`, `DATE_FROM`, `DATE_TO`, `IS_HANDICAP`, `IS_ORIGINAL`,
  `IS_LOCAL_ORIGINAL`, `IS_TRANING`, `TYPE`, `VITAE_EMAIL`, `WORK_QUALITY`,
  `WORK_ITEM`, `WORK_ADDRESS`, `CONTACT_METHOD`, `URL_LINK`, `VIEW_URL`,
  `Work_Type`, `IS_TRANSFER`. `URL_LINK` (always empty) and `Work_Type` (1, 2
  or 3; mixed case) are not in the research note's field list and are not in
  the dataset's field description either: the adapter does not read them, nor
  `IS_TRANSFER` (`Y` on 10 records of several kinds; meaning not documented).
- `PERSON_KIND` values and counts: 其他人員 604, 一般人員 592, 約僱人員 248,
  聘用人員 238, 工友 79, 教育人員 77, 駕駛 70, 主計人員 51, 人事人員 45, 技工 38,
  會計人員（非主辦） 4, 代理教師 2, 審計人員 2, 駐衛警 1, 代課教師 1, 司法人員 1,
  清潔隊員 1.
- `WORK_PLACE_TYPE` starts with a comma and lists one or more `NN-縣市` parts
  (`,10-臺北市`; `,60-嘉義市,61-嘉義縣`; 39 records name more than one; one part
  seen is `99-跨縣市`, which is not a place).
- `DATE_FROM` and `DATE_TO` are seven digits (Republic of China year, month,
  day). `DATE_TO` is `9991231` on two records: no end date.
- `VIEW_URL` is `https://web3.dgpa.gov.tw/want03front/ap/wantf00001_1.aspx?work_id=<10 digits>`
  on every record, and the ids are unique.
- `NUMBER_OF` is a small integer (1 on 1,689 records, at most three digits).
- Contact details are not only in the two contact elements: an `@` appears in
  `WORK_QUALITY` (5 records), `WORK_ITEM` (5) and `WORK_ADDRESS` (3), and a
  phone number in `WORK_ITEM` (about 30) and `WORK_QUALITY` (about 9).
- `WORK_ADDRESS` is filled on 2,043 records; 129 of them start with a postal
  code of 3, 5 or 6 digits (bare, followed by a space, or in brackets), and a
  county name follows it on 121.

The structure was read a second time on 2026-10-12, in memory only, for the
review of this adapter: the same 2,054 records (6,307,787 bytes), 26 elements
on each, one element order, no attribute and no CDATA anywhere. The adapter's
own reading of that answer: 1,090 vacancies listed by default, 592 transfer
posts and 372 of an unconfirmed kind left out; 58 sentences with contact
details taken out of 53 records.

The dataset record on data.gov.tw (`https://data.gov.tw/api/v2/rest/dataset/7229`,
read the same day) names the documented fields: 徵才機關, 人員區分, 官職等, 職稱,
職系, 名額, 性別, 工作地點, 有效期間, 資格條件, 工作項目, 工作地址, 聯絡E-Mail,
聯絡方式. Licence 政府資料開放授權條款－第1版, free, updated every 12 hours.

To look at a real answer, save it OUTSIDE the repository.
