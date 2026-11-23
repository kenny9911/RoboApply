# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Notes for Claude Code sessions

- The Bash sandbox blocks local sockets and IPC: test files that call
  `app.listen`, `tsx` scripts, `gh` (TLS) and `next build` fail or hang inside
  it with EPERM-style errors. Rerun those outside the sandbox; it is not a repo
  bug.
- To see the app in a browser, use the in-app Browser pane against the dev
  server. There is no auth stub: mint a session with `createSeekerSession` and
  set the `ra_session_token` cookie (handbook chapter 04).
- Production operations (Vercel env, redeploys, the production database) need
  the owner's confirmation; chapter 09 of the handbook has the release and
  rollback steps.
