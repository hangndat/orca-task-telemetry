# Contributor instructions for coding agents

## Mission

Build `orca-task-telemetry` as a reusable, install-once Node.js/TypeScript CLI that links GitHub Projects V2 work items with Orca execution metadata and CodeBurn usage for Claude Code and Codex.

## Read first

- `docs/MVP-SPEC.md` — bounded scope and Definition of Done.
- `docs/ARCHITECTURE.md` — integration boundaries and trust model.
- `BACKLOG.md` — features explicitly excluded from MVP.

## Engineering rules

- Treat GitHub Projects as the canonical work-management source.
- Use TypeScript strict mode; pin and validate the minimum Node.js runtime.
- Keep one npm package (no monorepo, server, frontend or framework).
- Prefer verified, documented CLI JSON interfaces; inspect versions and `--help` before implementation.
- Never invent Orca, CodeBurn or GitHub data fields.
- Never write to existing target repositories, GitHub Project fields or agent configurations during MVP.
- Preserve session provenance, provider token semantics, unknown values, and idempotent usage snapshots.
- Manual Issue ↔ session linking is sufficient for MVP. Do not silently auto-attribute ambiguous sessions.
- Avoid retries/parallelism that waste AI tokens, and do not dispatch work owned by an existing worker.
- Add tests and create a conventional commit after each validated vertical slice.
- Distinguish fixture-tested behavior from live integration evidence.
- Do not claim a feature is complete unless its acceptance criteria are satisfied.

## Delivery order

1. Inspect local tools and document relevant compatibility facts in `docs/discovery.md`.
2. Complete package foundation and install test.
3. Implement GitHub Project/Issue reader and `init` profile.
4. Implement Orca/CodeBurn collectors and persistent storage.
5. Add explicit session mapping and Issue-level accounting.
6. Add Task/Project CLI reports, fixtures, and live integration validation.

Do not implement anything in `BACKLOG.md` before the MVP meets Definition of Done.
