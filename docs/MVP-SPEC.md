# MVP Specification

## Primary user story

As a developer using an existing GitHub repository with Orca and Claude Code/Codex, I can install one globally available CLI, select a GitHub Project, explicitly link an execution session to a real GitHub Issue, and inspect its token usage and estimated API-equivalent cost without modifying my application repository.

## P0 capabilities

| ID | Capability | Acceptance criterion |
|---|---|---|
| MVP-01 | Installable CLI | `npm pack`, isolated installation and `orca-telemetry --help` work outside source repo. |
| MVP-02 | `init` + profiles | Resolve GitHub repository identity; select GitHub Project; save profile in user data dir without touching repo files. |
| MVP-03 | GitHub Projects reader | Read Project items and linked Issue stable IDs, URLs and titles with pagination. |
| MVP-04 | Orca collector | Read supervised workers/tasks and manual worktrees where supported, without modifying state. |
| MVP-05 | CodeBurn collector | Read normalized Claude and Codex session usage from verified JSON interfaces. |
| MVP-06 | Session mapping | Explicit `link --issue --provider --session` maps a complete session to one GitHub Issue, rejecting conflicts. |
| MVP-07 | SQLite | Safe, idempotent import and schema versioning; no credentials or raw prompts stored. |
| MVP-08 | Reporting | `report tasks`, `report project`, and `report unmapped` distinguish attributed, unattributed, estimated and unknown usage. |

## Target commands (not yet implemented)

```bash
orca-telemetry doctor
orca-telemetry init
orca-telemetry projects
orca-telemetry collect
orca-telemetry link --issue <issue-url> --provider <codex|claude> --session <session-id>
orca-telemetry report tasks
orca-telemetry report task <issue-id>
orca-telemetry report project
orca-telemetry report unmapped
```

## Non-negotiable safeguards

- Read-only external integrations; do not modify GitHub Projects or repositories.
- Provider session IDs must be namespaced.
- Cumulative snapshots must be upserted, not summed repeatedly.
- Claude cache input/read/write semantics must be inspected before aggregation.
- Do not infer task ownership from timestamps/branches alone.
- Session-to-task associations must include provenance and conflict handling.
- A failed or unavailable collector must produce a partial report with errors, not invented data.

## Execution slices

1. **Foundation:** build, test, pack, install, doctor. (Starter repository contains the foundation scaffold, not a completed MVP.)
2. **GitHub:** profile init and Project/Issue listing.
3. **Telemetry:** Orca metadata + CodeBurn Claude/Codex usage → SQLite.
4. **Attribution:** explicit verified GitHub Issue ↔ session mapping.
5. **Reports & validation:** Issue and Project accounting, fixtures, live integration checks, docs.

## Definition of Done

- All P0 capabilities work and have deterministic tests.
- At least one real GitHub Project can be read if authorization is available.
- Claude and Codex parsing have fixture evidence; report unavailable live agents honestly.
- At least one live Issue↔session mapping and report are demonstrated if data exists.
- Repeated collection does not double-count.
- Package installs outside repo and cannot mutate existing target repository setup.
- No P1/P2 feature is implemented inadvertently.
- Relevant tests pass and meaningful conventional commits exist.
