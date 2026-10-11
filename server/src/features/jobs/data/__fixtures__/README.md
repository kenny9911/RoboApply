# Fixtures of `features/jobs/data`

**Every file here is SYNTHETIC.** No row comes from a government file, and no real employer, organisation, person, tax number, town or count is in this folder. Employer and organisation names are placeholders (`EXAMPLE EMPLOYER LLC`, `Sample Robotics Limited`, `Example Analytics, Inc.`), places are `EXAMPLE CITY`, `Exampletown` and `Sampleton`, tax numbers are `0000`, the state is `ZZ` and postal codes are `00000`.

Only the **header row** of each file is real: it is the header of the official file, copied as that file writes it, so the importers are tested against the columns they will meet.

| File | Header copied from | Read on |
|---|---|---|
| `LCA_Disclosure_Data_FY2026_Q1.sample.csv` | The US Department of Labor LCA disclosure file layout (see `../lca.ts`) | before this folder had a README |
| `uscis.sample.csv` | `h1b_datahubexport-2023.csv`, linked from <https://www.uscis.gov/archive/h-1b-employer-data-hub-files> (USCIS H-1B Employer Data Hub, yearly file) | 2026-10-12 |
| `uk-sponsors.sample.csv` | `SP_-_Worker_and_Temporary_Worker_Web_Register_-_2026-10-09.csv`, the attachment of <https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers> (read through the page's own preview of the file) | 2026-10-12 |

The two values of `Type & Rating` and the two values of `Route` in `uk-sponsors.sample.csv` are values that register uses (`../ukSponsors.ts` lists what was seen); they describe no organisation.

Do not add a real row to make a test more "realistic". A government file is downloaded by the owner and imported with the command-line tools next to these fixtures; it is never committed.
