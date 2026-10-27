# V1.5–V1.9 — Diagnostics, budget, and suggested links

Stories [#48](https://github.com/hangndat/orca-task-telemetry/issues/48)–[#52](https://github.com/hangndat/orca-task-telemetry/issues/52) · Epic [#11](https://github.com/hangndat/orca-task-telemetry/issues/11).

**Architecture impact: Không** for read-only reports; **Có** for V1.9 only in that it adds an explicit opt-in `suggest-links apply` that writes the same local `session_links` table as `link` (never GitHub, never silent attribution).

## Commands

| Story | CLI | Behavior |
| --- | --- | --- |
| V1.5 | `report retries --run <id> [--host <id>] [--json]` | Retry chains from `orca_dispatches.retry_of_dispatch_id`; known worker role-link cost on retry nodes = wasted retry estimate. |
| V1.6 | `report duplicates --run <id> [--host <id>] [--json]` | Same Task with ≥2 Dispatches that are **not** linked by retry_of → duplicate groups. |
| V1.7 | `report waste [--json]` | Linked sessions: cache-miss ratio and oversized context heuristics from stored token buckets (no invented provider fields). |
| V1.8 | `report budget --limit-usd <n> [--issue <sel>] [--json]` | Compare hierarchy known cost to an operator-supplied limit; warn when over. Limits are CLI-only (no new GitHub fields). |
| V1.9 | `suggest-links` / `suggest-links apply …` | High-confidence projectHint suggestions vs Issue; ambiguous stay `needs_approval`. Apply requires explicit selectors + `--yes`. |

## Non-goals

- Auto-linking sessions without operator confirmation.
- Writing GitHub Project fields (see V1.2 `writeback`).
- Hard kill / budget enforcement of agents.
- Inventing Orca/agent-top fields beyond verified JSON.
