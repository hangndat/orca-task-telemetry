# Orca Task Telemetry

**GitHub Projects-first AI coding cost intelligence for Orca, Claude Code, and Codex.**

> **Status: foundation scaffold — not a working telemetry collector.** The CLI currently supports `--help`, `--version`, and `doctor`. The integration commands listed below are implementation targets, not completed features.

## Goal

Install one CLI globally, then attribute Claude Code / Codex session usage to GitHub Issues in existing repositories without changing application code or agent configuration.

```text
GitHub Project -> GitHub Issue -> Orca execution -> provider session -> CodeBurn usage -> SQLite -> CLI report
```

GitHub is the source of truth for issues and project planning; Orca provides execution metadata; CodeBurn provides session usage. The first MVP uses explicit, verified session-to-issue linking where exact identifiers are not available.

## Prerequisites

- Node.js 24+
- npm or pnpm
- GitHub CLI (`gh`) and access to GitHub Projects V2, for future integration
- Orca and CodeBurn for future local execution and token collection

## Local development

```bash
npm install
npm run build
npm test
node dist/cli.js --help
node dist/cli.js doctor
npm pack
```

The npm package will expose the command `orca-telemetry` via the `bin` entry point. Once it has been implemented and packed, you can install the tarball globally or use a Git-based install. The intended production package must operate outside the current source directory.

## Planned MVP usage (NOT IMPLEMENTED)

```bash
cd /path/to/ticket-solution
orca-telemetry init
orca-telemetry collect
orca-telemetry link --issue https://github.com/OWNER/REPO/issues/123 --provider codex --session SESSION_ID
orca-telemetry report tasks
orca-telemetry report project
orca-telemetry report unmapped
```

These commands are illustrative interfaces to be implemented, not instructions that work in this scaffold.

## MVP definition

The first validated slice must map **one real GitHub Issue** to **one real Claude Code or Codex session**, and display its token usage with clear attribution provenance. Work with multiple repositories must not mutate their `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`, `.cursor/`, or application dependencies.

See [MVP specification](docs/MVP-SPEC.md), [architecture](docs/ARCHITECTURE.md), and [backlog](BACKLOG.md).

## Create your GitHub repository

After extracting this starter, authenticate the GitHub CLI (`gh auth login`) and run:

```bash
bash scripts/publish-github.sh
```

The script initializes a Git repository (if needed), creates one scaffold commit, creates `hangndat/orca-task-telemetry` as a **private** repository, and pushes `main`. To create a public repository intentionally, use `VISIBILITY=public bash scripts/publish-github.sh`.

This project is independent of `ticket-solution`. Do not commit secrets, local session logs, telemetry databases, or application source code from other projects.

## License

Not yet selected. Choose a license before public distribution.
