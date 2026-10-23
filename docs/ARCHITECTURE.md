# Architecture (target MVP)

```text
GitHub Projects V2 --(read only)--> GitHub collector
Orca supervised/manual workflows --> Orca collector
CodeBurn Claude/Codex sessions --> Usage collector
                 \                |                /
                   normalized records
                          |
                  verified correlation
                          |
                     SQLite store
                          |
                  CLI issue/project report
```

## Contract boundaries

- **GitHub**: Project, repository, Issue identifiers and planning state are authoritative. Project↔Issue is many-to-many.
- **Orca**: Task, dispatch, worker, and worktree metadata are authoritative only when exposed by verified interfaces. Manual worktrees do not imply live supervised workers.
- **CodeBurn**: Session usage is authoritative only for data CodeBurn can verifiably extract. Do not mix provider billing with API-equivalent cost estimates.
- **Adapter**: Correlates identifiers and stores snapshots. Never invent missing execution IDs or silent attribution.

## Accounting invariants

1. Repeated imports do not increase totals for unchanged cumulative session snapshots.
2. Session identity is namespaced by provider and source; different providers cannot collide.
3. A complete session cannot be allocated to two distinct Issues simultaneously.
4. Multiple distinct sessions may be attributed to one Issue.
5. Cache/read/write token definitions remain source-specific until confirmed.
6. `unknown` is not `0` and estimated API cost is not actual subscription billing.
7. Project reports deduplicate underlying sessions within the selected Project.
8. Source metadata and verified links are persisted outside target application repositories.

## MVP operational model

No daemon, webhook, remote service, GitHub mutation, Claude hook, agent interception, arbitrary source parsing, or execution lifecycle changes. `collect` is explicit. `link` is explicit and verified.

## Risks to resolve in discovery

- GitHub Projects GraphQL pagination/permissions.
- Stable Orca dispatch/session correlation identifiers.
- CodeBurn JSON formats and cumulative-token semantics by provider.
- Source-level subagent usage aggregation.
- Cross-platform local profile storage and SQLite support in Node 24.
