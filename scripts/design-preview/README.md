# Local design preview

Run `node scripts/design-preview.mjs` from the repository, using Node 24.
Open <http://localhost:3612/jobs>.

The harness renders actual application components with repository fixtures.
It is a separate esbuild process: it does not run Next, read environment files,
start the API, or change production authentication. Requests outside its small
local fixture map return explicit errors. Browser connection policy also blocks
live services. The preview server accepts loopback hosts only.

Available routes:

- `/jobs`, `/resume`, `/resume/cm_rv_base`, `/applications`, `/practice`
- `/settings`, `/settings#billing`, `/settings#account`
- `/design-system` serves the standalone internal style guide.
- `/responsive` embeds the actual pages at fixed phone/tablet dimensions with
  native page, language, and device selectors.

Append `?locale=zh-TW` (or any supported locale) for locale review. The application
theme control works normally. Example content retains the fixture authors and
dates; the account avatar is Avery Chen. Voice, payment, uploads, and external
application submission are not live integrations in this harness.

Application and CSS source changes rebuild in memory; reload the browser to see
them. Restart the command after editing `scripts/design-preview.mjs`. Nothing is
written to `.next` or to a generated build directory.
