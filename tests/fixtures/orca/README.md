# Orca CLI — fixtures

Nguồn live (chỉ lệnh read-only), thu **2026-10-23** (UTC+8).

| Thuộc tính | Giá trị |
| --- | --- |
| Orca CLI | `/Applications/Orca.app/Contents/Resources/bin/orca` **1.4.237** |
| Runtime | `reachable: true`, `appVersion: 1.4.237` (xem `status-trimmed.json`) |
| Run mẫu supervised | `run_1a060327fe49` |
| Dispatch settled mẫu | `ctx_005f2513ac06` / `task_6be81dd44e83` |
| Worktree thủ công mẫu | `ticket-solution` main (`909e450c-…::<HOME>/SideProject/ticket-solution`) |

## Redact

- Đường dẫn: `/Users/admin` → `<HOME>` (giữ tên repo `orca-task-telemetry`, `ticket-solution` khi đã redact path).
- `preview`, `launch_token_hash`, pane keys → `<REDACTED>`.
- `spec` / worker `result.body` → cắt hoặc placeholder; **không** lưu task spec đầy đủ hay transcript terminal.
- `creator_orca_session_id` → `orca_session_id:<REDACTED>` (định danh Orca coordinator, không phải Claude/Codex usage session).

Kiểm tra:

```sh
rg '/Users/admin|gho_|github_pat_' tests/fixtures/orca
rg 'Task Spec —' tests/fixtures/orca   # expect no match
```

## Files

| File | Nguồn lệnh |
| --- | --- |
| `status-trimmed.json` | `orca status --json` |
| `agent-context-snippets.json` | `orca agent-context --json` (4 lệnh mẫu) |
| `run-show.json` | `orca orchestration run-show --id run_1a060327fe49 --json` |
| `task-supervised-brief.json` | `orca orchestration task-list --run … --brief --json` (1 task) |
| `worker-show-settled.json` | `orca orchestration worker-show --dispatch ctx_005f2513ac06 --json` |
| `dispatch-show.json` | `orca orchestration dispatch-show --task task_6be81dd44e83 --json` |
| `worker-list-snippet.json` | `orca orchestration worker-list --run … --json` (1 row) |
| `worktree-manual-show.json` | `orca worktree show --worktree path:<HOME>/SideProject/ticket-solution --json` |
| `worktree-manual-ps-row.json` | `orca worktree ps --json` (1 row) |
| `reference-list-empty.json` | `orca reference list --worktree path:…/Foundation --json` |
| `reference-find-no-match.json` | `orca reference find --query https://github.com/hangndat/orca-task-telemetry/issues/64 --json` |
