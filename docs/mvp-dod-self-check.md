# MVP DoD self-check (T43)

> Bản đồ MVP-01..08 + Definition of Done. Đây là **self-check**, không phải independent PASS. Chi tiết evidence: [mvp-validation.md](mvp-validation.md).

| Meta | Giá trị |
| --- | --- |
| Review candidate SHA | `a70ca751e0db62b61e9acd693776556fbe0d017f` |
| Implementation base (pre-docs) | `2f58473fb81d9a234f2e057aadbc0cb92804d97f` |
| SoT usage | agent-top 0.27.1 (ADR 0001) |
| Live home | `/tmp/orca-telemetry-agent-top-home` |
| Independent Codex | **PENDING** |

## MVP-01 … MVP-08

| ID | Tiêu chí (MVP-SPEC) | Self-check | Evidence path / lệnh |
| --- | --- | --- | --- |
| MVP-01 | CLI cài được (`pack` + help ngoài source) | **PASS** | `tests/pack.test.mjs`, `pnpm test:pack` |
| MVP-02 | `init` + profile ngoài repo | **PASS** | `tests/init.test.mjs`; live `…/config.json`; URL forms @ `2f58473` |
| MVP-03 | Đọc GitHub Project items + phân trang | **PASS** | fixtures `tests/github-*.mjs`; live **103** issues |
| MVP-04 | Orca collector read-only | **PASS** | `src/orca/enumerate.ts` run-list; live **678** executions |
| MVP-05 | Usage collector **agent-top** | **PASS** | ADR 0001; fixtures `tests/fixtures/agent-top/`; live **502** sessions |
| MVP-06 | `link` thủ công Issue↔session | **PASS (self)** | `#71` ↔ `3a8a1086-e8aa-42ec-b157-d1eb87522208`; `report task 71` |
| MVP-07 | SQLite idempotent, không credential/prompt | **PASS** | `tests/db-*.test.mjs`; live `telemetry.sqlite` |
| MVP-08 | `report` tasks/project/unmapped + cost honesty | **PASS** | `tests/reports-*.test.mjs`; live linked=1, unmapped=501 |

## Definition of Done checklist

| # | DoD item | Self-check | Independent | Evidence |
| --- | --- | --- | --- | --- |
| 1 | P0 hoạt động + test deterministic | **PASS** | **PENDING** | `pnpm test` trên exact SHA |
| 2 | Đọc ≥1 GitHub Project thật | **PASS** | **PENDING** | Project #4 → 103 issues |
| 3 | Claude/Codex fixture; báo cáo trung thực khi thiếu live | **PASS** | **PENDING** | agent-top fixtures + unknown cost partition |
| 4 | ≥1 link Issue↔session thật + report khớp SoT | **PASS (self)** | **PENDING** | mvp-validation § MVP-06; **không** claim PASS độc lập |
| 5 | Collect lặp không trùng (upsert) | **PASS** | **PENDING** | E2E + live snapshot upsert |
| 6 | Pack ngoài repo; không sửa repo đích | **PASS** | **PENDING** | `pnpm test:pack`; T40 non-invasive (prior) |
| 7 | Không triển khai P1/P2 / V1.2 writeback | **PASS** | **PENDING** | Scope docs; draft PR #109/#111 **không** merge |
| 8 | Test xanh + conventional commit rõ nghĩa | **PASS** khi docs commit | — | `docs(mvp): …` |

## Trạng thái board (E08 closeout)

| Task | Issue | Project Status (mục tiêu closeout) | Ghi chú |
| --- | --- | --- | --- |
| T40 | #102 | Ready / In Progress | Non-invasive evidence prior; independent còn PENDING |
| T41 | #103 | Ready / In Progress | CodeBurn packet **superseded**; agent-top live self-check PASS; independent PENDING |
| T42 | #104 | **Done** nếu README khớp code | agent-top, collect/run-list, init URL, known limits |
| T43 | #105 | Ready / In Progress | Self-check docs này; **chờ** independent review |

## Next step (acceptance)

1. Pin exact SHA sau commit docs trên `main`.
2. Dispatch **independent Codex review** (session ≠ author): exact SHA, scope MVP-01..08 + DoD + security gộp, evidence paths trên.
3. Chỉ khi verdict **PASS** mới coi acceptance complete — **không** gọi MVP complete từ self-check.
