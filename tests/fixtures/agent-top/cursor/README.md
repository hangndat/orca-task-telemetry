# Cursor agent-top fixtures

Synthetic `counted_sessions` rows with `harness: "cursor"`.

**Live evidence (2026-10-27, agent-top 0.27.1):** zero rows
`WHERE harness = 'cursor'` on local store. agent-top README lists
`cursor-agent` as **process table only** — tokens/cost **not yet** synced
into SQL. These fixtures exercise OTT parser/import plumbing only; they are
**not** measured Cursor usage.

| File | Intent |
| --- | --- |
| `session-zero-tokens.json` | Honest zeros + `cost_usd: 0` → cost `unknown`, allocation `unknown` |
| `session-null-model.json` | Null model + zeros → allocation `unknown` |
| `session-with-tokens-synthetic.json` | Non-zero buckets matching verified columns (synthetic shape) |
