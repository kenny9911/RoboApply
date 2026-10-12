# Contract fixtures (FND-7)

One folder per API area. Each `index.ts` exports:

- typed sample **responses** (`satisfies` the area's view types from
  `lib/api/contracts/<area>`), so `npm run typecheck:web` breaks when a
  contract changes shape under a component test that uses them;
- sample **requests** (`RequestFixture[]`), each parsed against the named zod
  schema by `__tests__/contracts/fixtures.test.ts`.

These are test data, never product data: names are obviously fictional, and
numbers that would be "real" in the product (counts, pay) carry a source the
way the wire contract requires (D3). Feature WPs add fixtures for their area
here and keep them valid when they change a contract.
