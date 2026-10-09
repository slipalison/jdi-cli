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

## Delegated issues (github.com coding agent)

A delegated session runs headless with ONE persona and no sub-agents:

1. Use the `jdi-solo` agent (`.github/agents/jdi-solo.agent.md`); the other
   `jdi-*` agents are internal sub-agents of the interactive flow.
2. Artifacts before code: CONTEXT.md and PLAN.md written, `git add`-ed and
   committed before implementation starts. Short on budget? Cut code, never the
   protocol.
3. Gates are executed, never narrated: every `Verify:` and test runs in the
   terminal and its real exit code decides.
4. `git add` every `.jdi/` file you create (agent harnesses drop untracked files).
5. Done = `npx -y jdi-cli@0.18.1 validate-phase <slug> --for-pr` green before the PR.
   Never merge.

Commands live in `.github/prompts/` (VS Code `/` menu) and `.github/skills/`
(Copilot CLI and the coding agent: type the command in the message).
<!-- JDI:END -->
