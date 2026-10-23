# Báo cáo kiểm chứng MVP (self-check)

> **Không phải independent PASS.** Reviewer độc lập phải xác nhận từng gate trên **cùng candidate SHA** với worker report ngoài repo (`/tmp/orca-telemetry-resume/worker-Validation.md`).

| Trường | Giá trị |
| --- | --- |
| Implementation base (review runtime) | `340cf9a7788a43b48fea23527a25fe2ee3f1bb19` |
| Validation candidate | Xem worker report (SHA sau commit validation) |
| Self-check author | Worker T38–T43 (Orca dispatch) |

## MVP-01 — CLI có thể cài đặt

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| `pnpm pack` + tarball có `dist/cli.js` và bin | `tests/pack.test.mjs`, `scripts/test-pack.mjs` | fixture |
| Cài prefix tạm, `--help` / `--version` / `doctor` | `pnpm test:pack` log: `/tmp/orca-telemetry-resume/evidence-T39/test-pack.log` | fixture + pack |
| Node 24 thực chạy pack smoke | `/opt/homebrew/opt/node@24/bin/node` v24.22.1 — `evidence-T39/cli-version-node24.txt` | live Node24 |
| Node &lt; 24 | `tests/node-version.test.mjs`; Node 22: lỗi `node:sqlite` trước route (`evidence-T39/node22-cli-help.log`) | fixture + live |

**Giới hạn:** `pnpm test` trên máy validation chạy Node 26; Node 26 **không** thay thế bằng chứng Node 24 — dùng lệnh Node 24 riêng ở trên.

## MVP-02 — `init` + profile

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| Profile lưu ngoài repo, không đổi git tree | `tests/init.test.mjs` | fixture |
| E2E `init --project 4` | `tests/e2e.test.mjs` | fixture |
| Live init read-only trên checkout có sẵn | `evidence-T40/*/init-head.json`, git status rỗng sau | live |

## MVP-03 — Bộ đọc GitHub Projects

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| Phân trang items, ID ổn định | `tests/github-items.test.mjs`, `tests/collect.test.mjs` | fixture |
| E2E collect từ stub pages | `tests/fixtures/e2e/github-project-page*.json` | fixture |
| Live Project #4 (đọc) | `collect` exit 5 partial trên ticket-solution; 103 issues trong `report tasks` — `evidence-T41/` | live partial |

## MVP-04 — Orca collector

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| Read-only status / worker-list | `tests/orca-adapter.test.mjs`, E2E stub | fixture |
| Orca không khả dụng → partial | `tests/collect.test.mjs`, `tests/e2e.test.mjs` | fixture |

## MVP-05 — CodeBurn collector

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| Claude + Codex parse, subagent tách session | `tests/codeburn-claude.test.mjs`, `tests/e2e.test.mjs` | fixture |
| Cost unknown | `tests/fixtures/codeburn/synthetic-codex-missing-cost.json` trong E2E | fixture |
| Live CodeBurn | `doctor` warn khi không có binary; collect partial nếu thiếu — `evidence-T41/collect.json` (checksum only trong worker report) | live partial |

## MVP-06 — Ánh xạ session (`link`)

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| Tạo / idempotent / conflict | `tests/link-cli.test.mjs`, `tests/e2e.test.mjs` | fixture |
| Live link Issue↔session | **Chưa thực hiện** — không có cặp được user/coordinator xác nhận; giữ unmapped | **blocked** |

## MVP-07 — SQLite

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| Schema, idempotent import | `tests/db-*.test.mjs`, `tests/collect.test.mjs` | fixture |
| Read-only report, legacy WAL từ chối | `tests/db-read-only.test.mjs`, `src/db/read-only.ts` | fixture |
| DB ngoài git root | `tests/collect.test.mjs`, `tests/init.test.mjs` | fixture |

Journal: đọc báo cáo dùng read-only; DB tạo bởi `collect` theo implementation đã review (không quảng bá WAL legacy làm mặc định).

## MVP-08 — Báo cáo

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| `report tasks` / `task` / `project` / `unmapped` | `tests/reports-*.test.mjs`, golden fixtures | fixture |
| Cost partition known/unknown | `tests/attribution-integrity.test.mjs`, `tests/e2e.test.mjs` (`buildUsageIntegrityReport`) | fixture |
| Report không mutate DB | `tests/report-cli.test.mjs` | fixture |

## Definition of Done (ánh xạ)

| DoD | Trạng thái self-check | Ghi chú |
| --- | --- | --- |
| P0 + test xác định | **PASS (fixture)** | 242 tests Vitest @ candidate |
| Đọc ≥1 Project thật | **PASS (partial)** | Project #4; scope `read:project` warn |
| Claude/Codex fixture + báo cáo trung thực | **PASS** | Golden + E2E |
| ≥1 link Issue↔session thật + báo cáo | **FAIL / blocked** | Cần quyết định coordinator + user |
| Collect lặp không trùng | **PASS** | E2E collect×2 |
| Pack ngoài repo, không sửa repo đích | **PASS** | test:pack + T40 checksums |
| Không P1/P2 | **PASS** | Scope task |
| Conventional commit validation | **Pending** | Commit `test(mvp): …` cùng candidate |

## Kiểm không xâm lấn (T40)

| Target | HEAD (lúc dispatch) | Git sau lệnh | Checksum AGENTS/CLAUDE/lock |
| --- | --- | --- | --- |
| `ticket-solution` (`Codex-Pro-Integrate`) | `ef1b3a9e…` | Rỗng (`evidence-T40/Codex-Pro-Integrate-git-status-after.txt`) | before=after |
| `orca-task-telemetry/main` | `ed9bdf6b…` | Rỗng | before=after |

Project #4: checksum GraphQL snapshot readonly — `evidence-T40/project4-snapshot-checksum.txt` (không mutate).

## Lệnh kiểm chứng bắt buộc (worker)

```bash
pnpm build && pnpm test && pnpm test:pack
```

Chạy trên candidate; Node 24: `/opt/homebrew/opt/node@24/bin/node scripts/test-pack.mjs`.

## Blocker / việc còn lại

1. **T41 live link:** liệt kê session ứng viên + provenance cho coordinator; không tự map session Orca hiện tại.
2. **Independent review** trên exact validation SHA.
3. **`gh auth refresh -s read:project`** trên máy collect live để giảm partial GitHub.
