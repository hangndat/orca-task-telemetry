# E2E fixtures (synthetic, labeled)

Tất cả file trong thư mục này là **dữ liệu tổng hợp** cho `tests/e2e.test.mjs`. Không chứa prompt thô, token GitHub hay log session thật.

| File | Mục đích |
| --- | --- |
| `github-init-*.json` | Phát hiện Project khi `init` |
| `github-project-page*.json` | Phân trang Project items khi `collect` |
| `agent-top-claude.json` | Session Claude + hàng parent_session_id (mảng JSON) |
| `agent-top-codex.json` | Session Codex có cost + session thiếu cost |
| `orca-status.json` / `orca-workers.json` | Stub Orca read-only |
| `link-issue-3.json` | GraphQL resolve Issue #3 cho `link` |
