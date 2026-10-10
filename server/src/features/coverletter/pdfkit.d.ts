// pdfkit ships no types and the repo has no @types/pdfkit (no new
// dependencies, TASK_PLAN.md §2.1 rule 7). The server compiles without
// noImplicitAny, but the web type check (strict) follows the routes' lazy
// import into this area, so the module is declared here as untyped.
declare module 'pdfkit';
