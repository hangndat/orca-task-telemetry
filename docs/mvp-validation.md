# Báo cáo kiểm chứng MVP (self-check)

> **Không phải independent PASS.** Reviewer độc lập (Codex, session khác tác giả) phải xác nhận từng gate trên **cùng exact SHA** với evidence dưới đây. Self-check / worker completion **không** được gọi là independent PASS hay “MVP complete”.

> **ADR 0001:** usage SoT là **agent-top 0.27.1**. Bằng chứng live **CodeBurn** (T41 packet @ `818ca30`, Issue #3, 407 sessions) **đã superseded** — không kế thừa thành PASS collector sau thay SoT. Identity `*:codeburn:*` không migrate; phải `collect` + `link` lại trên agent-top.

| Trường | Giá trị |
| --- | --- |
| Evidence SHA (independent review candidate) | `a70ca751e0db62b61e9acd693776556fbe0d017f` (`main`) |
| Implementation base (pre-docs) | `2f58473fb81d9a234f2e057aadbc0cb92804d97f` |
| SoT usage | agent-top **0.27.1** — ADR [0001](adr/0001-agent-top-usage-sot.md); commit `5c41894` |
| Orca pin | **1.4.241** — `caf5c73` |
| Collect Orca runs | **run-list** mặc định (`4bb1d77`); pin tùy chọn `ORCA_TELEMETRY_COLLECT_RUN` |
| Init project URL | board URL / `users\|orgs/…/projects/N` — `2f58473` |
| Live DB home | `/tmp/orca-telemetry-agent-top-home` (local; không phải CI artifact) |
| Self-check author | Docs closeout agent (T40–T43); **không** phải Codex independent |

**Giới hạn provenance:** DB và số liệu live dưới `/tmp/…` chỉ trên máy chạy. Independent reviewer nên tái lập `collect`/`link`/`report` hoặc archive DB nếu cần chain-of-custody ngoài repo.

## Superseded — T41 CodeBurn live (không dùng cho SHA hiện tại)

| Mục | Giá trị cũ (superseded) |
| --- | --- |
| Candidate SHA | `818ca30de1954d72122329d464b974e3b4c9fb83` |
| Usage collector | CodeBurn **0.9.27** via `ORCA_TELEMETRY_CODEBURN` |
| Live sessions | **407**; link Issue **#3** ← Claude `a3df5501-…` |
| Independent @ `818ca30` | **FAIL / blocked live** trước evidence link — `/tmp/orca-telemetry-resume/review-Final-818ca30.md` |
| Verdict sau ADR 0001 | **Không** kế thừa; cần evidence agent-top + **re-review độc lập** trên SHA ≥ `5c41894` (khuyến nghị exact SHA docs này sau commit) |

Artifact lịch sử: `/tmp/orca-telemetry-resume/evidence-T41-codeburn/` (nếu còn trên máy).

---

## MVP-01 — CLI có thể cài đặt

| Kiểm tra | Bằng chứng | Loại | Self-check |
| --- | --- | --- | --- |
| `pnpm pack` + tarball có `dist/cli.js` và bin | `tests/pack.test.mjs`, `scripts/test-pack.mjs` | fixture | PASS |
| Cài prefix tạm, `--help` / `--version` / `doctor` | `pnpm test:pack` | fixture + pack | PASS |
| Node &lt; 24 | `tests/node-version.test.mjs` | fixture | PASS |

## MVP-02 — `init` + profile

| Kiểm tra | Bằng chứng | Loại | Self-check |
| --- | --- | --- | --- |
| Profile ngoài repo, không đổi git tree | `tests/init.test.mjs` | fixture | PASS |
| E2E `init --project 4` | `tests/e2e.test.mjs` | fixture | PASS |
| Board URL / path forms | `2f58473` + `parseProjectUrl` trong `src/commands/init.ts` | fixture + code | PASS |
| Live profile | `/tmp/orca-telemetry-agent-top-home/config.json` → Project #4 | live | PASS |

## MVP-03 — Bộ đọc GitHub Projects

| Kiểm tra | Bằng chứng | Loại | Self-check |
| --- | --- | --- | --- |
| Phân trang items, ID ổn định | `tests/github-items.test.mjs`, `tests/collect.test.mjs` | fixture | PASS |
| Live Project #4 | **103** issues / **103** memberships trong DB live | live | PASS |

## MVP-04 — Orca collector

| Kiểm tra | Bằng chứng | Loại | Self-check |
| --- | --- | --- | --- |
| Read-only status / worker-list / run-list | `tests/orca-adapter.test.mjs`, `src/orca/enumerate.ts` | fixture | PASS |
| Orca không khả dụng → partial | `tests/collect.test.mjs`, `tests/e2e.test.mjs` | fixture | PASS |
| Live executions (run-list mặc định) | **678** rows `executions` @ DB live; freshness `orca=success` | live | PASS |

Pin `ORCA_TELEMETRY_COLLECT_RUN=<run_id>` vẫn hỗ trợ (thu hẹp một run); mặc định **không** cần — xem [discovery.md](discovery.md).

## MVP-05 — Usage collector (agent-top)

| Kiểm tra | Bằng chứng | Loại | Self-check |
| --- | --- | --- | --- |
| Claude + Codex parse từ `sql --json` | `tests/fixtures/agent-top/`, E2E stub agent-top | fixture | PASS |
| Cost unknown / cacheWrite buckets | ADR 0001; `tests/attribution-integrity.test.mjs` | fixture | PASS |
| Live agent-top | **502** `usage_sessions` / snapshots; freshness `agent-top=success`; tool version trong snapshot | live | PASS |

**Không** còn gate CodeBurn trên SHA hiện tại.

## MVP-06 — Ánh xạ session (`link`)

| Kiểm tra | Bằng chứng | Loại | Self-check |
| --- | --- | --- | --- |
| Tạo / idempotent / conflict | `tests/link-cli.test.mjs`, `tests/e2e.test.mjs` | fixture | PASS |
| Live link Issue↔session | `#71` ← `claude:agent-top:3a8a1086-e8aa-42ec-b157-d1eb87522208`; `method=manual`; node `I_kwDOVUhnY88AAAABZZHRuw` | live | PASS |
| Báo cáo khớp agent-top | `report task 71`: input **2**, output **19**, cacheRead **8920**, cacheWrite **16655**; cost `estimated_api_equivalent` **≈ USD 0.068598** — **không** phải hóa đơn | live | PASS |
| Unmapped | **501** sessions unmapped (DB); `report project` `unmappedNotInProjectTotals.sessionCount=501` | live | PASS |
| Orca ↔ agent-top causal join | `orcaReference.status=unknown` trên session mapped | honesty | N/A |

## MVP-07 — SQLite

| Kiểm tra | Bằng chứng | Loại | Self-check |
| --- | --- | --- | --- |
| Schema, idempotent import | `tests/db-*.test.mjs`, `tests/collect.test.mjs` | fixture | PASS |
| Read-only report | `tests/db-read-only.test.mjs` | fixture | PASS |
| Live DB ngoài git root | `/tmp/orca-telemetry-agent-top-home/telemetry.sqlite`; `collection_logs` **14** | live | PASS |

## MVP-08 — Báo cáo

| Kiểm tra | Bằng chứng | Loại | Self-check |
| --- | --- | --- | --- |
| `report tasks` / `task` / `project` / `unmapped` | `tests/reports-*.test.mjs`, golden fixtures | fixture | PASS |
| Cost partition known/unknown | `tests/attribution-integrity.test.mjs` | fixture | PASS |
| Live project sau link | `linkedSessionCount=1`, `issuesInProject=103`, mapped issue **#71** only | live | PASS |

## Definition of Done (self-check ánh xạ)

| DoD | Self-check | Independent | Ghi chú |
| --- | --- | --- | --- |
| P0 + test xác định | **PASS** | **PENDING** | Chạy `pnpm test` trên exact SHA docs |
| Đọc ≥1 Project thật | **PASS** | **PENDING** | Project #4, 103 issues |
| Claude/Codex fixture + báo cáo trung thực | **PASS** | **PENDING** | agent-top fixtures; unmapped cost honesty |
| ≥1 link Issue↔session thật + báo cáo khớp usage SoT | **PASS (self)** | **PENDING** | `#71` ↔ `3a8a1086-…`; **không** claim independent PASS |
| Collect lặp không trùng | **PASS** (fixture + stable live totals quan sát) | **PENDING** | Upsert snapshots |
| Pack ngoài repo, không sửa repo đích | **PASS** (fixture/pack + prior T40) | **PENDING** | Không xâm lấn — tái xác nhận khi re-review |
| Không P1/P2 / không writeback V1.2 | **PASS** | **PENDING** | Scope closeout docs only |
| Conventional commit | **PASS** khi docs commit | — | `docs(mvp): …` |

Chi tiết checklist: [mvp-dod-self-check.md](mvp-dod-self-check.md).

## Lệnh kiểm chứng

```bash
pnpm build && pnpm test && pnpm test:pack
```

Live (máy có `gh` + Orca + agent-top, home ngoài repo):

```bash
export ORCA_TELEMETRY_HOME=/tmp/orca-telemetry-agent-top-home   # hoặc home sạch mới
orca-telemetry collect --json
orca-telemetry report task 71 --json
orca-telemetry report project --json
orca-telemetry report unmapped --json
```

## Việc còn lại (acceptance)

1. **Independent Codex re-review** trên **exact SHA** sau commit docs này — cùng SHA worker evidence; verdict từng gate DoD + security gộp nếu áp dụng.
2. Archive hoặc tái lập `/tmp/orca-telemetry-agent-top-home` nếu cần evidence bền vững.
3. **Không** tuyên bố MVP complete cho đến khi independent review **PASS**.
4. Không merge draft PR writeback (#109 / #111); không triển khai BACKLOG P1–P2.
