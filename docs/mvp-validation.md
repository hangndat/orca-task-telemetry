# Báo cáo kiểm chứng MVP (self-check)

> **ADR 0001:** collector usage đã chuyển sang agent-top. Bằng chứng live CodeBurn @ `818ca30` **không** áp dụng cho SHA sau thay SoT. Cần collect/link/re-review mới.

> **Không phải independent PASS.** Reviewer độc lập phải xác nhận từng gate trên **cùng exact SHA** với worker report. Review gộp trước link @ `818ca30de1954d72122329d464b974e3b4c9fb83` (`/tmp/orca-telemetry-resume/review-Final-818ca30.md`) ghi **T41 FAIL / blocked live** — **không** được kế thừa thành PASS sau bằng chứng link mới; cần **re-review độc lập** trên SHA sau commit docs live evidence.

| Trường | Giá trị |
| --- | --- |
| Implementation base (review runtime) | `340cf9a7788a43b48fea23527a25fe2ee3f1bb19` |
| Validation candidate (fixture suite) | `818ca30de1954d72122329d464b974e3b4c9fb83` |
| Live link + CodeBurn evidence (local `/tmp`) | Sau `818ca30`; xem worker report `worker-Validation-Live-Docs.md` |
| Self-check author | Worker T38–T43 + live docs (Orca dispatch) |

**Giới hạn provenance:** Artifact trong `/tmp/orca-telemetry-resume/` là bằng chứng cục bộ trên máy chạy, **không** phải CI artifact bền vững; coordinator/reviewer cần tái lập hoặc archive nếu muốn chain-of-custody ngoài repo.

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
| Live Project #4 (đọc) | Collect GitHub **ok**, **103** issues / memberships — `evidence-T41-codeburn/summary.json`, `post-link-verification.json` (recollect) | live |
| `doctor` scope `read:project` | Cảnh báo khi token thiếu scope; **collect GitHub vẫn ok** trong run live T41 — không coi là bắt buộc refresh scope cho gate này | live partial |

## MVP-04 — Orca collector

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| Read-only status / worker-list | `tests/orca-adapter.test.mjs`, E2E stub | fixture |
| Orca không khả dụng → partial | `tests/collect.test.mjs`, `tests/e2e.test.mjs` | fixture |
| Live Orca executions | Với `ORCA_TELEMETRY_COLLECT_RUN=run_1a060327fe49`: **59** supervised executions, ổn định qua collect lặp — `mapping-decision-packet.md`, `post-link-verification.json` | live |

## MVP-05 — CodeBurn collector

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| Claude + Codex parse, subagent tách session | `tests/codeburn-claude.test.mjs`, `tests/e2e.test.mjs` | fixture |
| Cost unknown | `tests/fixtures/codeburn/synthetic-codex-missing-cost.json` trong E2E | fixture |
| Live CodeBurn pin **0.9.27** | Binary qua `ORCA_TELEMETRY_CODEBURN` (npm cache, **không** cài global PATH); collect **ok**, **407** sessions — `summary.json` | live |
| Unmapped trước link | **406** sau link; trước link **407** (Claude **312**, Codex **95** trong unmapped — packet) | live |

## MVP-06 — Ánh xạ session (`link`)

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| Tạo / idempotent / conflict | `tests/link-cli.test.mjs`, `tests/e2e.test.mjs` | fixture |
| Live link Issue↔session (user authority) | User chọn **toàn bộ** session Claude `a3df5501-4411-43db-9b37-70507f3a2121` → `hangndat/orca-task-telemetry#3`; `link` **một lần**: `outcome=created`, `method=manual`, node `I_kwDOVUhnY88AAAABZZE2rQ` — `post-link-verification.json`, `mapping-decision-packet.md` | live |
| Báo cáo khớp CodeBurn | `report task` **1** session mapped; token buckets input **262**, output **221303**, cacheRead **31083833**, cacheWrite **365901**; cost `estimated_api_equivalent` **USD 13.5710826** — **không** phải hóa đơn thực tế | live |
| Phạm vi attribution | Session **đa nhiệm** (title CodeBurn “Kế hoạch Orca Task Telemetry”); user gán **cumulative** session cho Issue #3 — báo cáo **không** phân tách usage trong session theo nhiều Issue/task | live limitation |
| Orca ↔ CodeBurn causal join | **Không** khẳng định auto-join; tham chiếu Orca cho session CodeBurn này vẫn **unknown** | honesty |

## MVP-07 — SQLite

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| Schema, idempotent import | `tests/db-*.test.mjs`, `tests/collect.test.mjs` | fixture |
| Read-only report, legacy WAL từ chối | `tests/db-read-only.test.mjs`, `src/db/read-only.ts` | fixture |
| DB ngoài git root | `tests/collect.test.mjs`, `tests/init.test.mjs` | fixture |
| Collect lặp live | `issues=103`, `sessions=407`, `executions=59` ổn định; `collectionLogs` **append** (3→10→16 trong packet) | live |

Journal: đọc báo cáo dùng read-only; `post-link-verification.json` xác nhận `report` **không** đổi byte DB.

## MVP-08 — Báo cáo

| Kiểm tra | Bằng chứng | Loại |
| --- | --- | --- |
| `report tasks` / `task` / `project` / `unmapped` | `tests/reports-*.test.mjs`, golden fixtures | fixture |
| Cost partition known/unknown | `tests/attribution-integrity.test.mjs`, `tests/e2e.test.mjs` | fixture |
| Report không mutate DB | `tests/report-cli.test.mjs`; live `reportNoDatabaseByteChange` | fixture + live |
| Project totals sau link | `linkedSessionCount=1`, known cost khớp session mapped — `post-link-verification.json` | live |

## Definition of Done (ánh xạ)

| DoD | Trạng thái self-check | Ghi chú |
| --- | --- | --- |
| P0 + test xác định | **PASS (fixture)** | 242 tests @ `818ca30` (reviewer archive) |
| Đọc ≥1 Project thật | **PASS (live)** | Project #4, 103 issues |
| Claude/Codex fixture + báo cáo trung thực | **PASS** | Golden + E2E + live unmapped/mapped |
| ≥1 link Issue↔session thật + báo cáo khớp CodeBurn | **PASS (self-check live)** / **pending independent** | Link manual @ Issue #3; reviewer `818ca30` **FAIL** trước evidence — **chưa** re-review |
| Collect lặp không trùng | **PASS** | E2E + live stable totals |
| Pack ngoài repo, không sửa repo đích | **PASS** | test:pack + T40; target git clean trong T41 packet |
| Không P1/P2 | **PASS** | Scope task |
| Conventional commit validation | **PASS** @ `818ca30`; docs live commit riêng | `test(mvp): …` + `docs(mvp): …` |

## Kiểm không xâm lấn (T40)

| Target | HEAD (lúc dispatch) | Git sau lệnh | Checksum AGENTS/CLAUDE/lock |
| --- | --- | --- | --- |
| `ticket-solution` (`Codex-Pro-Integrate`) | `ef1b3a9e…` | Rỗng (`evidence-T40/Codex-Pro-Integrate-git-status-after.txt`) | before=after |
| `orca-task-telemetry/main` | `ed9bdf6b…` | Rỗng | before=after |

T41 live: `post-link-verification.json` — target git **clean** trước/sau collect và link.

Project #4: checksum GraphQL snapshot readonly — `evidence-T40/project4-snapshot-checksum.txt` (không mutate).

## T41 — ma trận tóm tắt (self-check)

| Gate | Trước link @ `818ca30` (independent) | Sau live evidence (self-check) |
| --- | --- | --- |
| GitHub Project read | PASS partial (103 issues) | PASS live |
| Orca collect | 0 executions (run không pin) | **59** executions (`run_1a060327fe49`) |
| CodeBurn collect | FAIL PATH absent | PASS pin 0.9.27 via env |
| Manual link | FAIL | PASS user-chosen Issue #3 + session UUID |
| Independent verdict | **FAIL / blocked** | **Pending** re-review cùng SHA docs |

## Lệnh kiểm chứng bắt buộc (worker)

```bash
pnpm build && pnpm test && pnpm test:pack
```

Chạy trên candidate docs; Node 24: `/opt/homebrew/opt/node@24/bin/node scripts/test-pack.mjs`.

## Việc còn lại

1. **Independent re-review** trên exact SHA sau commit `docs(mvp): record live integration and manual attribution evidence` (gồm T41 live).
2. Archive hoặc tái lập `/tmp/orca-telemetry-resume/evidence-T41-codeburn/` nếu cần evidence bền vững ngoài máy local.
3. Tùy chọn: `gh auth refresh -s read:project` để giảm `doctor` warn — **không** blocking cho collect đã chứng minh.
