# GitHub Projects V2 — fixtures

Nguồn live (read-only), không mutation. Thu thập trên máy worker **2026-10-23** (UTC+8).

| Thuộc tính | Giá trị |
| --- | --- |
| `gh` | **2.103.0** (`gh --version`) |
| Account | `hangndat` (active) |
| Project | User project **#4** — *Orca Task Telemetry — Development Roadmap* (`PVT_kwHOAGoDWs4BoZ5m`) |
| Linked repo | `hangndat/orca-task-telemetry` |
| Lệnh chính | `gh api graphql -f query=…` (file query trong `docs/discovery.md`) |

## Files

| File | Mô tả |
| --- | --- |
| `user-projectsV2.json` | `user(login:).projectsV2` |
| `repository-projectsV2.json` | `repository.projectsV2` |
| `project-view-cli.json` | `gh project view 4 --owner hangndat --format json` |
| `project-items-page1.json` | `items(first:100)` — **2** node mẫu; `pageInfo` và `rateLimit` **đầy đủ** từ live |
| `project-items-page2.json` | `items(first:100, after:<page1.endCursor>)` — **3** node; `pageInfo` **đầy đủ** |

## Redact

- **Giữ nguyên** `hangndat`, `hangndat/orca-task-telemetry`, title Issue/Epic public trong repo này (fixture phục vụ parser MVP của chính project).
- **Không** đưa token OAuth, email, hay nội dung repo private khác vào fixture.
- `@hangndat` trong title project GitHub là username hiển thị, không phải email.

Kiểm tra: `rg -i 'gho_|github_pat_|Bearer |@[a-z0-9.-]+\.[a-z]{2,}' tests/fixtures/github` → không khớp token/email.

## Gaps (không có fixture)

| Content / field | Lý do |
| --- | --- |
| `DraftIssue` | Project #4: 103/103 item là `Issue` (live jq 2026-10-23) |
| `PullRequest` | Cùng quan sát |
| `ProjectV2ItemFieldIterationValue` | Không có iteration field trên item live |
| `repository.issueTypes` | `null` trên repo cá nhân `hangndat/orca-task-telemetry` |
| Issue xóa / không quyền (`REDACTED`) | Chưa có item quan sát — xem bảng nullable trong discovery |
