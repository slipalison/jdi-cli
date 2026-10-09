<!-- JDI:BEGIN managed by jdi-cli 0.18.1 - edits inside this block are replaced on update; write project rules outside it -->
# JDI

This project uses JDI (Just Do It): phase work runs through the `/jdi-*` commands.
`/jdi-next` derives the next step from the artifacts; `/jdi-issue <card>` takes a
card to a pull request; `/jdi-status` shows where the project is.

- State lives in `.jdi/` (one file per phase, decision, todo). Phase status is
  derived from the artifacts in `.jdi/phases/<slug>/`; `STATE.md` and the
  `ROADMAP.md`/`DECISIONS.md` views are untracked and regenerated.
- Commits: Conventional Commits, scope = phase slug, one task = one commit,
  never `--no-verify`. Locked decisions (`.jdi/decisions/`) are not reopened.
- One orchestration session per phase: after `/jdi-ship`, start a new session
  (`/clear`); the next one resumes from `.jdi/` alone.
<!-- JDI:END -->
