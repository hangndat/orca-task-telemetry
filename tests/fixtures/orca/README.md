# Orca CLI — fixtures

Nguồn live (chỉ lệnh read-only), thu **2026-10-23** (UTC+8).

| Thuộc tính | Giá trị |
| --- | --- |
| Orca CLI | `/Applications/Orca.app/Contents/Resources/bin/orca` **1.4.241** |
| Runtime | `reachable: true`, `appVersion: 1.4.241` (xem `status-trimmed.json`) |
| Run mẫu supervised | `run_1a060327fe49` |
| Dispatch settled mẫu | `ctx_005f2513ac06` / `task_6be81dd44e83` |
| Worktree thủ công mẫu | `github:<OTHER_OWNER>/<OTHER_REPO>` (`00000000-0000-4000-8000-0000000000aa::<HOME>/<OTHER_REPO_PATH>`) |

## Redact

- Đường dẫn: `/Users/admin` → `<HOME>`; repo khác project → `<OTHER_OWNER>`, `<OTHER_REPO>`, `<OTHER_REPO_PATH>`.
- `preview`, `launch_token_hash`, pane keys, `ptyId`, `tabId`, `leafId`, `incarnationId` → `<REDACTED>`.
- `spec` / worker `result.body` → cắt hoặc placeholder; **không** lưu task spec đầy đủ hay transcript terminal.
- `creator_orca_session_id` → `orca_session_id:<REDACTED>` (định danh Orca coordinator, không phải Claude/Codex usage session).

Kiểm tra:

```sh
rg '/Users/admin|gho_|github_pat_' tests/fixtures/orca
rg $'Task Spec \u2014' tests/fixtures/orca --glob '*.json'   # expect no match
# Cross-project manual worktree guard: see T02 review rg one-liner (JSON only).
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
| `worktree-manual-show.json` | `orca worktree show --worktree path:<HOME>/<OTHER_REPO_PATH> --json` |
| `worktree-manual-ps-row.json` | `orca worktree ps --json` (1 row) |
| `reference-list-empty.json` | `orca reference list --worktree path:…/Foundation --json` |
| `reference-find-no-match.json` | `orca reference find --query https://github.com/hangndat/orca-task-telemetry/issues/64 --json` |
