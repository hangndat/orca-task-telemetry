# MVP DoD self-check (T43)

> Bản đồ MVP-01..08 + Definition of Done. Self-check vẫn là evidence định hướng; **independent PASS** đã ghi tại [reviews/mvp-5b464e3.md](reviews/mvp-5b464e3.md). Chi tiết evidence self-check: [mvp-validation.md](mvp-validation.md).

| Meta | Giá trị |
| --- | --- |
| Independent review SHA | `5b464e3f201aeacec1a43cb6ea7e93fbcc954e5f` |
| Independent verdict | **PASS** — [mvp-5b464e3.md](reviews/mvp-5b464e3.md) |
| Self-check evidence SHA (pre-review docs) | `a70ca751e0db62b61e9acd693776556fbe0d017f` |
| Implementation base (pre-docs) | `2f58473fb81d9a234f2e057aadbc0cb92804d97f` |
| SoT usage | agent-top 0.27.1 (ADR 0001) |
| Live home | `/tmp/orca-telemetry-agent-top-home` (local; không phải CI artifact) |

## MVP-01 … MVP-08

| ID | Tiêu chí (MVP-SPEC) | Self-check | Independent (`5b464e3`) | Evidence path / lệnh |
| --- | --- | --- | --- | --- |
| MVP-01 | CLI cài được (`pack` + help ngoài source) | **PASS** | **PASS** | `tests/pack.test.mjs`, `pnpm test:pack` |
| MVP-02 | `init` + profile ngoài repo | **PASS** | **PASS** | `tests/init.test.mjs`; live `…/config.json`; URL forms @ `2f58473` |
| MVP-03 | Đọc GitHub Project items + phân trang | **PASS** | **PASS** | fixtures `tests/github-*.mjs`; live **103** issues |
| MVP-04 | Orca collector read-only | **PASS** | **PASS** | `src/orca/enumerate.ts` run-list; live **678** executions |
| MVP-05 | Usage collector **agent-top** | **PASS** | **PASS** | ADR 0001; fixtures `tests/fixtures/agent-top/`; live **502** sessions |
| MVP-06 | `link` thủ công Issue↔session | **PASS (self)** | **PASS** | `#71` ↔ `3a8a1086-e8aa-42ec-b157-d1eb87522208`; `report task 71` |
| MVP-07 | SQLite idempotent, không credential/prompt | **PASS** | **PASS** | `tests/db-*.test.mjs`; live `telemetry.sqlite` |
| MVP-08 | `report` tasks/project/unmapped + cost honesty | **PASS** | **PASS** | `tests/reports-*.test.mjs`; live linked=1, unmapped=501 |

## Definition of Done checklist

| # | DoD item | Self-check | Independent (`5b464e3`) | Evidence |
| --- | --- | --- | --- | --- |
| 1 | P0 hoạt động + test deterministic | **PASS** | **PASS** | `pnpm test` — 285 tests trên review SHA |
| 2 | Đọc ≥1 GitHub Project thật | **PASS** | **PASS** | Project #4 → 103 issues (live DB bảo toàn) |
| 3 | Claude/Codex fixture; báo cáo trung thực khi thiếu live | **PASS** | **PASS** | agent-top fixtures + unknown cost partition |
| 4 | ≥1 link Issue↔session thật + report khớp SoT | **PASS (self)** | **PASS** | mvp-validation § MVP-06; review xác nhận live report |
| 5 | Collect lặp không trùng (upsert) | **PASS** | **PASS** | E2E + live snapshot upsert (502/502) |
| 6 | Pack ngoài repo; không sửa repo đích | **PASS** | **PASS** | `pnpm test:pack`; T40 non-invasive (prior) |
| 7 | Không triển khai P1/P2 / V1.2 writeback | **PASS** | **PASS** | Scope docs; draft PR #109/#111 **không** merge |
| 8 | Test xanh + conventional commit rõ nghĩa | **PASS** | **PASS** | Conventional subjects; tests xanh trên review SHA |

## Trạng thái board (E08 closeout)

| Task | Issue | Project Status | Ghi chú |
| --- | --- | --- | --- |
| T40 | #102 | **Done** | Non-invasive evidence; independent PASS @ `5b464e3` |
| T41 | #103 | **Done** | CodeBurn packet **superseded**; agent-top live + independent PASS |
| T42 | #104 | **Done** | README khớp code (agent-top, collect/run-list, known limits) |
| T43 | #105 | **Done** | Self-check + independent PASS recorded |
| S08.3 | #42 | **Done** | Validation non-invasive complete |
| S08.4 | #43 | **Done** | Docs handover complete |
| E08 | #10 | **Done** | All children Done; MVP acceptance closing gate PASS |

## Acceptance

- **Acceptance complete** trên exact SHA `5b464e3` với overall verdict **PASS** ([mvp-5b464e3.md](reviews/mvp-5b464e3.md)).
- MVP P0 **code-complete** trước gate; closing gate DoD+security đã đóng.
- **Giới hạn live:** evidence `/tmp/orca-telemetry-agent-top-home` là DB local được bảo toàn; không phải CI artifact / chain-of-custody ngoài máy (xem review Limitations).
- Tip `main` sau review có thể chứa process wording (ví dụ `adfe5f3`); verdict độc lập neo tại `5b464e3`.
- Không merge draft writeback (#109 / #111); V1.2/V1.4 và BACKLOG V2 ngoài scope closeout này.
