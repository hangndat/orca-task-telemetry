# V1.2 — Ghi ngược custom field GitHub Projects V2 (#45)

Story [#45](https://github.com/hangndat/orca-task-telemetry/issues/45) · Epic [#11](https://github.com/hangndat/orca-task-telemetry/issues/11) · Hạng mục P1 trong [BACKLOG.md](../BACKLOG.md). MVP và V1.1 (`report hierarchy`, [#44](V1-HIERARCHY-SPEC.md)) vẫn **chỉ đọc** GitHub; tài liệu này là **contract thử nghiệm** trước mọi thay đổi runtime.

**Architecture impact: Có** — mở ranh giới tin cậy **ghi ra GitHub** (Projects V2 custom field). Không daemon, không webhook; một lệnh CLI tường minh, opt-in, có dry-run mặc định.

## Tiêu chí nghiệm thu (contract)

1. **AC1 — API GitHub đã chứng minh:** Trích dẫn tài liệu GitHub chính thống và `gh --help` cục bộ cho liệt kê field / hình dạng mutation; không bịa field GraphQL.
2. **AC2 — CLI:** Dry-run mặc định (chỉ đọc GitHub + DB cục bộ); ghi live chỉ khi opt-in; chọn Project và field có kiểm tra kiểu; preview từng item và semantics xác nhận.
3. **AC3 — Ngữ nghĩa chi phí:** Hành vi cho known vs unknown/estimated, direct vs inclusive hierarchy, nhiều Project, xung đột/dữ liệu cũ, lỗi từng phần và idempotency — hoặc ghi rõ **quyết định owner chưa chốt**.
4. **AC4 — Lát cắt:** Chia #45 thành task thực thi có paths, non-goals, checks và **security gate**; không sửa Issue/Project trên GitHub trong phase planning.

---

## AC1 — Nguồn GitHub và `gh` (verified local)

| Nguồn | Mục đích |
| --- | --- |
| [Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) | Scope token: `read:project` (query), **`project`** (query + mutation); `gh auth login --scopes "project"`; mutation `updateProjectV2ItemFieldValue` với `value: { text \| number \| date \| singleSelectOptionId }`; **không** dùng mutation này cho Assignees/Labels/Milestone/Repository. |
| [GraphQL reference — Projects](https://docs.github.com/en/graphql/reference/projects) | `updateProjectV2ItemFieldValue(input: UpdateProjectV2ItemFieldValueInput!)`; input bắt buộc `projectId`, `itemId`, `fieldId`, `value` (`ProjectV2FieldValue!`). |
| [gh project manual](https://cli.github.com/manual/gh_project) | Lệnh `gh project` yêu cầu scope tối thiểu **`project`**; xác minh bằng `gh auth status`; thêm scope: `gh auth refresh -s project`. |

**Máy worker (2026-10-24):**

```text
gh version 2.103.0 (2026-10-21)
```

**Liệt kê field (read):** `gh project field-list <number> --owner <login> [--format json]` — help: một field mỗi lần fetch, `--limit` (mặc định 30).

**Sửa giá trị field trên item (write path đề xuất cho implementation):** `gh project item-edit` — help xác nhận:

- Chọn item: `--url <issue-or-pr-url>` + project `number` + `--owner` (owner Project, có thể khác owner repo).
- Theo tên: `--field <name>` + `--value` (single-select: tên option).
- Theo node ID: `--id`, `--field-id`, `--project-id` + một trong `--text`, `--number`, `--date`, `--single-select-option-id`, hoặc `--clear`.
- Issue/PR thật: **một field mỗi lần gọi**; xóa giá trị: `--clear`.

**Tạo field (ngoài phạm vi MVP writeback — owner tooling):** `gh project field-create` — `--data-type` ∈ `{TEXT|SINGLE_SELECT|DATE|NUMBER}`.

**Scope quan sát trên worker:** `gh auth status` → token `hangndat` có `project` (đủ cho mutation qua CLI nếu user đã refresh; `read:project` alone không đủ — theo docs GitHub ở trên).

Implementation **không** gọi GraphQL thô trừ khi `gh project item-edit` không đủ (ví dụ multi-select); ưu tiên subprocess `gh` đã pin trong discovery.

**Ranh giới code hiện tại:** `src/github/client.ts` từ chối bất kỳ chuỗi GraphQL chứa `mutation` / `subscription` (read-only collector). Slice apply **không** nới guard đó; module write riêng (ví dụ `src/writeback/gh-apply.ts`) gọi `gh project item-edit` hoặc adapter tách biệt, trong khi `collect` / `report` vẫn chỉ đi qua client read-only.

---

## AC2 — Contract CLI đề xuất

### Lệnh và ranh giới

| Lệnh hiện có | Phân loại |
| --- | --- |
| `report *` | Chỉ đọc SQLite + không gọi mutation GitHub |
| **`writeback`** (mới) | Đọc SQLite + **có thể** gọi `gh project item-edit` khi apply |

```text
orca-telemetry writeback [options]
```

**Mặc định: dry-run** — không gọi `item-edit`; có thể gọi `field-list` / `item-list` (read) để validate và lấy giá trị remote hiện tại cho diff.

| Flag | Bắt buộc | Mô tả |
| --- | --- | --- |
| `--json` | Không | Một object JSON trên stdout (`ok`, `data` hoặc `error`) — giống lệnh khác. |
| `--project <n\|url\|node-id>` | Không* | Project GitHub V2. *Mặc định: Project trong profile `init` của repo hiện tại; nếu không có profile → lỗi validation (exit 2). |
| `--owner <login>` | Không | Owner Project; mặc định từ profile hoặc parse URL. |
| `--field <name>` | Có (khi không `--help`) | Tên custom field trên board; phải tồn tại sau `field-list`. |
| `--field-id <id>` | Thay thế `--field` | Node ID field — cho script; phải khớp `--project`. |
| `--rollup <direct\|inclusive>` | Không | Nguồn số ghi: **direct** (chi phí session gắn Issue đó) hoặc **inclusive** (cộng con trong Project, cùng semantics `report hierarchy`). Mặc định: **`direct`**. |
| `--issue <selector>` | Không | Giới hạn một hoặc nhiều Issue (`owner/repo#n`, URL, node id); mặc định: mọi Issue **ISSUE** trong membership Project (bỏ Draft/PR nếu không được owner bật — xem AC3). |
| `--apply` | Không | **Opt-in ghi live.** Không có flag này → `mode: "dry_run"` only. |
| `--yes` | Không | Bỏ prompt TTY khi `--apply`; chỉ hợp lệ sau preview thành công trong **cùng process** hoặc với `--preview-digest <sha256>` (implementation). |
| `--force-overwrite` | Không | Cho phép ghi khi giá trị remote ≠ giá trị đã tính và ≠ last-applied journal (xem AC3). |
| `--include-unknown` | Không | Cho phép ghi cột NUMBER khi vẫn còn session `cost_kind=unknown` (mặc định: **skip** item đó). |

**Exit codes (giữ tinh thần MVP):** `0` thành công; `2` validation (field sai kiểu, project không khớp profile, thiếu scope); `4` GitHub không khả dụng; `5` **partial** (một số item apply thất bại, item khác ok).

### Validation Project và field

1. Resolve `projectNodeId`, `projectNumber`, `owner` — cùng nguồn với `init` / `collect` (profile + optional override).
2. `gh project field-list` → tìm field theo tên hoặc id; lỗi rõ nếu trùng tên (owner quyết định: refuse vs disambiguate — **chưa chốt**, xem cuối doc).
3. **Kiểu field được hỗ trợ v1 writeback:**

| `dataType` (field-list / GraphQL) | Ghi cost | Ghi chú |
| --- | --- | --- |
| `NUMBER` | `knownAmountUsd` (USD, 2–4 chữ số thập phân — **owner chốt precision**) | Khuyến nghị cho board |
| `TEXT` | Chuỗi có prefix semantics, ví dụ `~$12.34 est` hoặc `unknown (2 sessions)` | Khi cần hiển thị unknown |
| `DATE`, `SINGLE_SELECT`, `ITERATION` | **Từ chối** exit 2 trừ slice mở rộng sau | Không map cost mặc định |

4. Mỗi Issue trong preview phải có `projectItemId` (từ collect / `item-list`) để map sang `item-edit --url`.

### Preview và xác nhận

**Dry-run output (`--json`):** `kind: "writeback_preview"`, `mode: "dry_run"`, `project`, `field`, `rollup`, `freshness` (từ `collect`), `items[]` mỗi phần tử:

| Trường | Ý nghĩa |
| --- | --- |
| `issue` | Identity giống `report` (`owner/repo#n`, `issueNodeId`, `url`) |
| `projectItemId` | Node id item trên Project |
| `computed` | `{ knownAmountUsd, unknownSessionCount, sessionCount, rollup }` |
| `remote` | Giá trị field hiện tại trên GitHub (read), hoặc `null` / `missing` |
| `proposed` | Giá trị sẽ ghi (number hoặc text) |
| `action` | `set` \| `clear` \| `skip` |
| `skipReason` | Ví dụ `unknown_cost`, `no_usage`, `unsupported_item_type`, `stale_remote`, `unchanged` |

**Text mode (non-JSON):** Bảng Issue | computed | remote | proposed | action; dòng tổng `Would apply N sets, M skips`.

**Apply:**

1. Chạy cùng logic preview trong memory.
2. Nếu không `--yes` và TTY: prompt `Apply N changes to project OWNER/NUMBER field "FIELD"? [y/N]`.
3. Từng item: một lần `gh project item-edit` (phù hợp help: một field / invocation).
4. Ghi **journal cục bộ** (SQLite hoặc file trong `ORCA_TELEMETRY_HOME`, slice implementation) — `lastAppliedDigest`, timestamp, `projectItemId`, `fieldId`, `value` — để idempotency và audit.

`doctor` (slice sau): cảnh báo **fail** nếu `--apply` được yêu cầu mà token thiếu scope `project` (theo [gh project manual](https://cli.github.com/manual/gh_project)).

---

## AC3 — Ngữ nghĩa dữ liệu và edge cases

Bám [ARCHITECTURE.md](ARCHITECTURE.md) và [V1-HIERARCHY-SPEC.md](V1-HIERARCHY-SPEC.md): `estimated_api_equivalent` ≠ billing; `unknown` ≠ `0`.

### Known vs unknown / estimated

| Tình huống | Hành vi đề xuất |
| --- | --- |
| Chỉ `estimated_api_equivalent` | Ghi `knownAmountUsd` (NUMBER) hoặc text định dạng est. |
| Có ≥1 session `unknown` trên Issue (direct) hoặc trong cây inclusive | **Mặc định:** `action: skip`, `skipReason: unknown_cost`. Với `--include-unknown`: NUMBER chỉ ghi phần known; TEXT có thể ghi `partial` — **owner chốt format TEXT**. |
| Không session linked | `skip`, `no_usage`; tùy chọn future `--clear-empty` (**chưa trong v1 contract**) |

### Direct vs inclusive (`--rollup`)

| `rollup` | Nguồn số | Ghi chú |
| --- | --- | --- |
| `direct` | `report task` / aggregate per Issue | Phù hợp Task trên board |
| `inclusive` | `report hierarchy` `inclusive` cho node | Story/Epic hiển thị tổng cây trong Project; session chỉ tính một lần trên đường lên (đã kiểm chứng V1.1) |

**Không** ghi rollup inclusive lên Issue con **đồng thời** ghi direct lên parent trừ khi user chạy hai lệnh có chủ đích — contract không tự đồng bộ “cả board”; tránh double-count trên view tổng.

### Parent ngoài Project

Giữ ranh giới V1.1: inclusive của root có `outside_project` parent **không** kéo usage ngoài Project vào. Writeback dùng cùng engine hierarchy; không thêm usage từ Issue không thuộc membership Project đích.

### Nhiều Project (membership nhiều-nhiều)

- Một lần `writeback` = ** một** `projectId` (profile hoặc `--project`).
- Cùng Issue trên Project khác: field độc lập; không mirror tự động (**non-goal**).
- Collect đã snapshot membership theo Project; writeback chỉ item thuộc Project chọn.

### Stale / xung đột

| Loại | Phát hiện | Hành vi |
| --- | --- | --- |
| DB cũ | `freshness` / `collectedAt` cũ hơn ngưỡng | Cảnh báo trong preview; không chặn dry-run; **khuyến nghị** `collect` trước `--apply` |
| Remote ≠ computed | Đọc field trước apply | `skip` + `stale_remote` trừ `--force-overwrite` |
| Remote = computed (đã ghi) | So sánh journal + remote | `action: skip`, `unchanged` — idempotent success |
| User sửa tay trên GitHub sau lần apply | Journal khác remote | Coi là `stale_remote` |

### Partial failure và idempotency

- Lỗi từng item (quyền, rate limit, item archived): ghi vào `items[].error`, tiếp tục item khác → exit `5` nếu có bất kỳ lỗi apply.
- Gọi lại với cùng input và dữ liệu không đổi: item đã `unchanged` không gọi `item-edit`.
- **Không** rollback GitHub tự động khi lỗi giữa chừng (owner chấp nhận best-effort; journal ghi item đã thành công).

### Loại item Project

MVP writeback: **`ISSUE` content only** (cùng eligibility `collect` / attribution). PR và DraftIssue: **skip** `unsupported_item_type` trừ owner mở scope sau.

---

## AC4 — Lát cắt thực thi (#45)

| Slice | Paths chính | Non-goals | Checks / gate |
| --- | --- | --- | --- |
| **V1.2-A — Contract + read adapter** | `src/contracts.ts`, `src/github/fields.ts` (mới), tests fixture `gh` field-list | `item-edit`, journal | Unit: parse field-list JSON; validation kiểu |
| **V1.2-B — Preview engine** | `src/writeback/preview.ts`, `src/commands/writeback.ts`, `src/commands/router.ts`, `help.ts` | `--apply` | `pnpm test`; JSON schema `writeback_preview`; parity với `report hierarchy` trên fixture |
| **V1.2-C — Apply + journal** | `src/writeback/apply.ts`, `src/db/` migration journal, `doctor` scope | Tạo/xóa field GitHub; multi-project sync | Fixture stub `item-edit`; idempotent re-run test |
| **V1.2-D — Live evidence + security review** | `docs/`, `README.md` (một đoạn), evidence `/tmp` | Sửa target repo; GitHub issue comments | **Security gate:** independent review exact SHA — token `project`, no default apply in CI, journal audit; live dry-run trên Project read-only trước, apply chỉ field thử trên item test |
| **V1.2-E — Docs BA (task hiện tại)** | `docs/V1-PROJECT-WRITEBACK-SPEC.md` only | `src/`, tests, lockfile | `git diff --check`; link docs HTTP 200; worker report |

**Phụ thuộc:** V1.1 hierarchy đã có (`report hierarchy`); `collect` membership + parent; profile `init`.

---

## Security gate (bắt buộc trước ship)

1. Mutation chỉ qua `writeback --apply`; không nhúng vào `collect` / `report`.
2. Token: tách cảnh báo `read:project` vs **`project`**; không lưu token trong repo.
3. Journal cục bộ: ai apply, giá trị cũ/mới (redact nếu TEXT dài).
4. Không chạy apply trong fixture E2E mặc định; stub `gh` bắt buộc.
5. Independent high-risk review (Codex hoặc reviewer được chỉ định) trên SHA có code — **không** thay acceptance của task planning này.

---

## Quyết định owner chưa chốt

| ID | Câu hỏi | Gợi ý mặc định (có thể bác) |
| --- | --- | --- |
| O1 | Field trùng tên trên Project? | Fail validation, bắt `--field-id` |
| O2 | NUMBER: làm tròn bao nhiêu chữ số? | 2 decimal USD |
| O3 | TEXT khi `--include-unknown`? | `~$X.XX + N unknown` |
| O4 | Ghi inclusive lên Epic trong khi Task cũng có cột cost? | Document-only; user tự chọn field/rollup |
| O5 | `--clear` khi `no_usage`? | Không v1; slice sau |
| O6 | PR/Draft trên board? | Skip v1 |
| O7 | `preview-digest` cross-process cho `--yes`? | Có, để script an toàn |
| O8 | Org-owned Project vs user Project? | Cùng `owner` flag; test live org **gap** discovery |

---

## Non-goals (V1.2)

- Tạo/xóa custom field trên GitHub tự động.
- Ghi Status, Assignee, Label, Milestone qua Project API.
- Đồng bộ nhiều Project hoặc webhook real-time.
- Billing thật, budget alert, ghi vào repository đích hoặc agent config.
- Sửa Issue `parent` hoặc tự `link` session.

---

## Tham chiếu CLI đọc hiện có (nguồn số)

| Lệnh | Dùng cho writeback |
| --- | --- |
| `report task` | `direct` per Issue |
| `report hierarchy` | `inclusive` / cấu trúc parent |
| `report project` | Kiểm tra tổng dedupe trong Project (không ghi tổng lên một field mặc định) |
| `collect` | Bắt buộc trước apply nếu freshness cảnh báo |

---

_Tài liệu planning @ base `3c19cd1a9c5fa5e77f6f2e39c71dafa101462322`. Acceptance implementation và security review là gate riêng._
