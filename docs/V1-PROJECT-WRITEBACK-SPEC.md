# V1.2 — Ghi ngược custom field GitHub Projects V2 (#45)

Story [#45](https://github.com/hangndat/orca-task-telemetry/issues/45) · Epic [#11](https://github.com/hangndat/orca-task-telemetry/issues/11) · Hạng mục P1 trong [BACKLOG.md](../BACKLOG.md). MVP và V1.1 (`report hierarchy`, [#44](V1-HIERARCHY-SPEC.md)) vẫn **chỉ đọc** GitHub trừ lệnh `writeback --apply`. Tài liệu này là **contract đã chốt** (draft SHA `2829e5b07615bcb559a34d8ae0567b47305402f4`); runtime V1.2 tại **`2bad83490c149a11404524152d895710bcad5eb2`** (`feat(writeback): add explicit project field apply flow`).

**Architecture impact: Có** — mở ranh giới tin cậy **ghi ra GitHub** (Projects V2 custom field). Không daemon, không webhook; một lệnh CLI tường minh, opt-in, có dry-run mặc định.

**Acceptance V1.2:** Chưa **PASS** — cần independent security review trên exact SHA code và live `--apply` trên **field NUMBER thử** / item test (không dùng field roadmap kinh doanh như `Wave`). Fixture/stub và live dry-run read-only dưới đây **không** thay hai gate đó.

## Tiêu chí nghiệm thu (contract)

1. **AC1 — API GitHub đã chứng minh:** Trích dẫn tài liệu GitHub chính thống và `gh --help` cục bộ cho liệt kê field / hình dạng mutation; không bịa field GraphQL.
2. **AC2 — CLI:** Dry-run mặc định (chỉ đọc GitHub qua client GraphQL read-only + SQLite cục bộ); ghi live chỉ khi `--apply`; Project cố định theo profile; field **NUMBER**; preview từng item và xác nhận trong cùng process.
3. **AC3 — Ngữ nghĩa chi phí:** Chỉ **estimated API equivalent** (known); unknown và zero-session luôn skip; direct vs inclusive; xung đột remote; lỗi từng phần và idempotency so với remote — đã chốt trong doc (không còn mục owner chưa quyết).
4. **AC4 — Lát cắt:** Chia #45 thành task thực thi có paths, non-goals, checks và **security gate**; không tạo field/Issue trên GitHub và không live apply trong phase planning / task contract này.

---

## AC1 — Nguồn GitHub và `gh` (verified local)

| Nguồn | Mục đích |
| --- | --- |
| [Using the API to manage Projects](https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects) | Scope token: `read:project` (query), **`project`** (query + mutation); `gh auth login --scopes "project"`; mutation `updateProjectV2ItemFieldValue` với `value: { number, … }` cho NUMBER; **không** dùng mutation này cho Assignees/Labels/Milestone/Repository. |
| [GraphQL reference — Projects](https://docs.github.com/en/graphql/reference/projects) | `updateProjectV2ItemFieldValue(input: UpdateProjectV2ItemFieldValueInput!)`; input bắt buộc `projectId`, `itemId`, `fieldId`, `value` (`ProjectV2FieldValue!`). |
| [gh project manual](https://cli.github.com/manual/gh_project) | Lệnh `gh project` yêu cầu scope tối thiểu **`project`** khi ghi; xác minh bằng `gh auth status`; thêm scope: `gh auth refresh -s project`. |

**Máy worker (2026-10-24):**

```text
gh version 2.103.0 (2026-10-21)
```

**Đọc field / item / giá trị (dry-run):** Client GraphQL read-only hiện có (`src/github/client.ts`) — `readProjectItems` paginate `items` và trả `itemId` + nội dung Issue/PR/Draft (query vẫn fetch `fieldValues` nhưng mapper **bỏ** giá trị field); discovery field NUMBER (`dataType`, `id`, `name`) và đọc giá trị NUMBER hiện tại trên item qua adapter `src/github/fields.ts` (`readProjectFields`, `readProjectItemNumberFieldValue`). Validate Issue thuộc Project profile so với `project_memberships`. **Không** gọi mutation/subscription qua client này (guard giữ nguyên).

**Liệt kê field (tham chiếu CLI, không bắt buộc dry-run):** `gh project field-list <number> --owner <login> [--format json]` — help: một field mỗi lần fetch, `--limit` (mặc định 30).

**Sửa giá trị field trên item (write — chỉ `--apply`):** Adapter riêng gọi `gh project item-edit` với node IDs + `project number` + `--owner` từ profile:

- Theo node ID: `--id` (project item), `--field-id`, `--project-id` + `--number <value>`.
- Issue thật: **một field mỗi lần gọi**; V1.2 **không** dùng `--clear`, `--text`, hay tạo field.

**Tạo field:** **Non-goal V1.2** — owner tạo thủ công field NUMBER trên board; không `field-create` trong CLI.

**Scope:** Dry-run chỉ cần **`read:project`** (hoặc tương đương cho query). `--apply` cần scope **`project`** trên token (theo [gh project manual](https://cli.github.com/manual/gh_project)); preflight đọc `gh auth status --json hosts --no-refresh`, xét account `github.com` đang active và fail exit `2` trước preview/write nếu thiếu hoặc không xác minh được scope, kể cả khi không có set dự kiến.

**Ranh giới code:** `collect` / `report` / dry-run **writeback** chỉ đi qua client read-only. Module apply (ví dụ `src/writeback/gh-apply.ts`) subprocess `gh project item-edit`, tách biệt collector.

---

## AC2 — Contract CLI (V1.2 phát hành đầu)

### Lệnh và ranh giới

| Lệnh hiện có | Phân loại |
| --- | --- |
| `report *` | Chỉ đọc SQLite + không gọi mutation GitHub |
| **`writeback`** (mới) | Đọc SQLite + GraphQL read-only; **có thể** gọi `gh project item-edit` khi `--apply` |

```text
orca-telemetry writeback [options]
```

**Mặc định: dry-run** — không gọi `item-edit`; không ghi SQLite/Project/target repo; không yêu cầu scope `project` nếu chỉ query read-only thành công.

| Flag | Bắt buộc | Mô tả |
| --- | --- | --- |
| `--json` | Không | Một object JSON trên stdout (`ok`, `data` hoặc `error`) — giống lệnh khác. |
| `--field <name>` | Có* | Tên custom field trên board profile Project; phải **duy nhất** sau discovery. Trùng tên → exit `2`, thông báo dùng `--field-id`. *Bỏ qua khi `--help`. |
| `--field-id <id>` | Thay thế `--field` | Node ID field — cho script; phải thuộc Project trong profile. |
| `--rollup <direct\|inclusive>` | Không | Nguồn số: **`direct`** (mặc định) hoặc **`inclusive`** (cùng semantics `report hierarchy`). Inclusive **chỉ** khi có `--issue` tường minh (xem AC3). |
| `--issue <selector>` | Không | Giới hạn một hoặc nhiều Issue (`owner/repo#n`, URL, node id). Mặc định: mọi **ISSUE** trong membership Project của profile. **Bắt buộc** khi `--rollup inclusive`. |
| `--apply` | Không | **Opt-in ghi live.** Không flag → `mode: "dry_run"` only. |
| `--yes` | Không | Bỏ prompt TTY khi `--apply`; chỉ hợp lệ sau khi preview được tính lại **trong cùng process** ngay trước apply. |
| `--force-overwrite` | Không | Cho phép ghi khi giá trị remote ≠ giá trị đã tính (xem AC3). |

**Không có trong V1.2 phát hành đầu:** `--project`, `--owner` (Project/owner cố định từ profile `init` của repo hiện tại; thiếu profile → exit `2`), `--include-unknown`, `--clear-empty`, `--preview-digest`, ghi TEXT/SINGLE_SELECT.

**Exit codes:** `0` thành công; `2` validation (field không NUMBER, tên trùng, project không có trong profile, thiếu `--issue` với inclusive, thiếu scope, non-TTY apply không `--yes`); `4` GitHub không khả dụng; `5` **partial** (một số item apply thất bại).

### Validation Project và field

1. Resolve `projectNodeId`, `projectNumber`, `owner` **chỉ** từ profile đã `init` (cùng nguồn `collect`); không override CLI.
2. Discovery field qua GraphQL read-only (hoặc tương đương đã kiểm chứng): tìm theo `--field-id` hoặc tên; **trùng tên → fail**, yêu cầu `--field-id`.
3. **Kiểu field:** chỉ `dataType === NUMBER`. Khác → exit `2`.

4. **Membership (SQLite):** `project_memberships` chỉ lưu `(project_id, issue_node_id)` — **không** lưu `itemId`. Issue trong scope phải có membership cho Project profile (sau `collect`).
5. **`projectItemId`:** Lấy từ **query read-only** danh sách item Project (ví dụ `readProjectItems` / GraphQL `ProjectV2.items`, có `item.id`) trong cùng lần chạy dry-run hoặc apply; map `issueNodeId` → `ProjectV2Item.id`. Không migration DB chỉ để cache item id.

### Preview và xác nhận

**Dry-run output (`--json`):** `kind: "writeback_preview"`, `mode: "dry_run"`, `project`, `field`, `rollup`, `freshness` (từ `collect`), `items[]`:

| Trường | Ý nghĩa |
| --- | --- |
| `issue` | Identity giống `report` (`owner/repo#n`, `issueNodeId`, `url`) |
| `projectItemId` | Node id `ProjectV2Item` (từ query items read-only, sau khi xác nhận membership SQLite) |
| `computed` | `{ knownAmountUsd, sessionCount, rollup }` — nguồn estimated API equivalent |
| `remote` | Giá trị NUMBER hiện tại (read GraphQL), hoặc `null` / absent |
| `proposed` | Số NUMBER sẽ ghi (6 chữ số thập phân USD) hoặc không có khi skip |
| `action` | `set` \| `skip` |
| `skipReason` | `unknown_cost`, `no_usage`, `unsupported_item_type`, `remote_conflict`, `unchanged`, `rounds_to_zero`, … |

**Text mode:** Bảng Issue \| computed \| remote \| proposed \| action; tổng `Would apply N sets, M skips`.

**Inclusive + cảnh báo:** Khi `--rollup inclusive` và `--issue` đã chỉ định, preview phải kèm **warning** rõ: không ghi đồng thời inclusive lên parent và direct lên children trên cùng cột — tránh double-count trên view tổng.

**Apply:**

1. **Luôn** chạy lại logic preview trong **cùng process** ngay trước ghi (không tin digest cross-process).
2. Nếu không `--yes` và stdin là TTY: prompt `Apply N changes to project OWNER/NUMBER field "FIELD"? [y/N]`.
3. Non-TTY mà không `--yes` → exit `2` (không ghi).
4. Từng item: đọc lại remote NUMBER **ngay trước** lần `item-edit`; một invocation / item.
5. **Không** journal SQLite / migration schema cho writeback; idempotency dựa so sánh remote vs computed (xem AC3).

`doctor` (slice sau): cảnh báo nếu user có thể `--apply` mà token thiếu scope `project`.

---

## AC3 — Ngữ nghĩa dữ liệu và edge cases

Bám [ARCHITECTURE.md](ARCHITECTURE.md) và [V1-HIERARCHY-SPEC.md](V1-HIERARCHY-SPEC.md): số ghi là **estimated API equivalent**, **không** billing thật; `unknown` ≠ `0`.

### Known only (NUMBER)

| Tình huống | Hành vi |
| --- | --- |
| Chỉ session/link với cost known (`estimated_api_equivalent`) | Tính `knownAmountUsd`, làm tròn **6 chữ số thập phân USD**, `action: set` nếu không bị skip khác |
| ≥1 session `unknown` trên phạm vi rollup của Issue | **Luôn** `skip`, `skipReason: unknown_cost` (không flag opt-in) |
| Không session linked (`sessionCount === 0`) | `skip`, `no_usage` (không `--clear-empty` V1.2) |
| Known > 0 nhưng sau làm tròn 6 dp = 0 | `skip`, `rounds_to_zero` + precision warning |

### Direct vs inclusive (`--rollup`)

| `rollup` | Nguồn số | Điều kiện |
| --- | --- | --- |
| `direct` (mặc định) | `report task` / aggregate per Issue | Mọi item ISSUE trong scope |
| `inclusive` | `report hierarchy` inclusive cho node | **Bắt buộc** `--issue`; preview warning double-count parent/children |

Contract **không** tự đồng bộ cả board; user chịu trách nhiệm không sum parent inclusive + children direct trên một cột.

### Parent ngoài Project

Giữ V1.1: inclusive không kéo usage từ Issue ngoài membership Project profile.

### Một Project (profile)

Một lần `writeback` = Project trong profile `init` only. Issue trên Project khác: không mirror (**non-goal**). Writeback chỉ item có membership lưu cho Project đó.

### Remote, xung đột, idempotency

| Remote NUMBER | Computed | Hành vi |
| --- | --- | --- |
| absent / null | có giá trị | `set` (khi apply) |
| bằng computed (sau round) | có | `skip`, `unchanged` — không gọi `item-edit` |
| khác computed | có | `skip`, `remote_conflict` trừ `--force-overwrite` → `set` |

Trước mỗi `set`: **đọc lại** remote. GitHub API **không** có compare-and-swap nguyên tử — vẫn có race nếu người khác sửa giữa đọc và ghi (ghi trong bảng limitations).

DB cũ: `freshness` / `collectedAt` cảnh báo trong preview; khuyến nghị `collect` trước `--apply`; không chặn dry-run.

### Partial failure

- Lỗi từng item: `items[].error`, tiếp tục item khác → exit `5` nếu có lỗi apply.
- **Không** rollback GitHub tự động.
- Chạy lại với input và dữ liệu không đổi: item `unchanged` không mutation.

### Loại item Project

**ISSUE** only. **PR** và **DraftIssue**: `skip`, `unsupported_item_type` (không tùy chọn bật V1.2).

### Profile org vs user

Profile hoạt động với Project/user hoặc org qua IDs đã lưu `init`. **Live org-owned Project** chưa có evidence đầy đủ trên worker — gap discovery (xem limitations).

---

## AC4 — Lát cắt thực thi (#45)

| Slice | Paths chính | Non-goals | Checks / gate |
| --- | --- | --- | --- |
| **V1.2-A — Contract + read adapter** | `src/contracts.ts`, `src/github/fields.ts` (mới), tests fixture GraphQL field read | `item-edit`, journal, field-create | Unit: parse field metadata; NUMBER-only validation |
| **V1.2-B — Preview engine** | `src/writeback/preview.ts`, `src/commands/writeback.ts`, `src/commands/router.ts`, `help.ts` | `--apply` | `pnpm test`; JSON `writeback_preview`; parity `report hierarchy` fixture; duplicate field name fail |
| **V1.2-C — Apply adapter** | `src/writeback/gh-apply.ts`, `src/writeback/apply.ts`, `doctor` scope hint | Journal DB; tạo/xóa field; `--project` override | Stub `item-edit`; re-read before write; idempotent re-run; non-TTY without `--yes` → 2 |
| **V1.2-D — Live evidence + security review** | `docs/`, `README.md` (đoạn ngắn), evidence `/tmp` | Sửa target repo; tạo Issue/field GitHub; apply live trong slice docs | **Docs @ `2bad834`:** live dry-run read-only (bảng evidence); security review + live apply field thử — gate còn mở |
| **V1.2-E — Docs BA (contract)** | `docs/V1-PROJECT-WRITEBACK-SPEC.md` | `src/`, tests, lockfile | `git diff --check`; link docs; worker report |

**Phụ thuộc:** V1.1 hierarchy; `collect` membership `(project_id, issue_node_id)`; `readProjectItems` (read GraphQL) cho `itemId`; profile `init`.

---

## Security gate (bắt buộc trước ship)

1. Mutation chỉ qua `writeback --apply` / `gh project item-edit`; không nhúng vào `collect` / `report` / GraphQL client read-only.
2. Token: tách cảnh báo `read:project` vs **`project`**; không lưu token trong repo.
3. Không journal cục bộ bắt buộc V1.2; audit qua log apply + GitHub history (giới hạn đã biết).
4. Không chạy apply trong fixture E2E mặc định; stub `gh` bắt buộc.
5. Independent high-risk review trên SHA code — không thay acceptance task contract doc.

---

## Quyết định đã chốt (từ draft → V1.2)

| ID | Quyết định | Rationale |
| --- | --- | --- |
| O1 | Trùng tên field → **fail**, dùng `--field-id` | Tránh ghi nhầm cột |
| O2 | Làm tròn **6** chữ số thập phân USD | Đủ precision API est.; skip nếu positive → 0 |
| O3 | Không TEXT / không `--include-unknown` | Chỉ NUMBER known; unknown luôn skip |
| O4 | Inclusive chỉ với `--issue` + warning preview | Giảm double-count vô tình |
| O5 | Không `--clear-empty` V1.2 | `no_usage` → skip |
| O6 | PR/Draft **skip** | ISSUE-only writeback |
| O7 | Không `preview-digest` cross-process | Apply luôn re-preview cùng process; `--yes` chỉ sau preview đó |
| O8 | Project/owner từ profile only; org gap live | Đơn giản phát hành đầu; org evidence sau |

---

## Giới hạn đã xác minh (V1.2)

| Giới hạn | Ghi chú |
| --- | --- |
| Race trên giá trị field | Không CAS trên GitHub; re-read trước write giảm nhưng không loại bỏ |
| Org-owned Project live | Profile by ID ok; worker chưa chứng minh đủ org path |
| Một NUMBER field / board | User tạo field thủ công; CLI không tạo field |
| Không billing | Label và docs: estimated API equivalent only |

---

## Non-goals (V1.2)

- Tạo/xóa custom field trên GitHub tự động.
- Ghi TEXT, Status, Assignee, Label, Milestone qua Project API.
- `--include-unknown`, `--clear-empty`, journal/schema migration writeback.
- Override `--project` / `--owner`; đồng bộ nhiều Project; webhook.
- Billing thật, budget alert, ghi repository đích hoặc agent config.
- Sửa Issue `parent` hoặc tự `link` session.

---

## Tham chiếu CLI đọc hiện có (nguồn số)

| Lệnh | Dùng cho writeback |
| --- | --- |
| `report task` | `direct` per Issue |
| `report hierarchy` | `inclusive` khi `--rollup inclusive` + `--issue` |
| `report project` | Kiểm tra dedupe trong Project (không ghi tổng lên field) |
| `collect` | Membership issue↔project, usage, freshness trước apply |

---

## Trạng thái triển khai và evidence (@ `2bad83490c149a11404524152d895710bcad5eb2`)

### Kiểm chứng tự động (fixture / stub — không `item-edit` thật)

| Check | Kết quả |
| --- | --- |
| `pnpm test` | 45 files, **292** tests pass (stub `gh` / Orca / CodeBurn) |
| `pnpm test:pack` | pack + cài prefix tạm + smoke CLI pass |
| Phạm vi | Dry-run preview, apply orchestration, non-TTY/`--yes`, re-read conflict, partial failure, scope hint — **không** mutation GitHub trong CI mặc định |

### Live read-only (worker V1.2-D, 2026-10-24)

Môi trường cô lập: `ORCA_TELEMETRY_HOME=/tmp/orca-telemetry-resume/live-v12` (ngoài git root). Không ghi credentials, prompt hay nội dung repo riêng vào doc.

| Bước | Kết quả |
| --- | --- |
| `init --project` (user Project **#4**) | Thành công; profile lưu node id Project |
| `collect --json` (PATH, không pin) | Exit **5** partial: GitHub **103** issues/memberships; Orca **7** executions; CodeBurn `codeburn_runtime_unavailable`; DB **0** session |
| `collect --json` (pin `ORCA_TELEMETRY_CODEBURN` → binary `codeburn@0.9.27` trong npm cache) | Exit **0**: GitHub **103**; Orca **8** executions; CodeBurn **424** sessions; DB **424** sessions (không phải gap collector lâu dài — thiếu PATH hoặc dùng pin như README) |
| Discovery field NUMBER `Wave` | Node id `PVTF_lAHOAGoDWs4BoZ5mzhm6Ld4` (field roadmap — **không** dùng cho live cost apply) |
| `writeback --field Wave --issue hangndat/orca-task-telemetry#45 --json` (@ `2bad834`, sau collect thành công) | Exit **0**; `kind: writeback_preview`, `mode: dry_run`; item `PVTI_lAHOAGoDWs4BoZ5mzhDBA3g`; `remote: null`; skip **`no_usage`** (chưa `link` session → Issue **#45**, không phải DB trống); **wouldSet 0**; **không** gọi `item-edit` |

**Hệ quả:** Live dry-run chứng minh đọc field + item + membership + preview JSON. Số cost trên #45 vẫn skip vì chưa attribution Issue ↔ session cho issue đó. **Chưa** có live `--apply` evidence; **chưa** thử org-owned Project.

### Gate còn lại

1. **Independent security review** trên SHA `2bad834` (token `project`, không default apply trong automation, ranh giới read-only client).
2. **Live apply** một lần trên field NUMBER **dành cho thử** và item test, sau `collect` + `link` có usage known — ghi lại stdout/redacted JSON, không field kinh doanh.

Báo cáo worker chi tiết: `/tmp/orca-telemetry-resume/worker-V12-D.md`.

---

_Tài liệu contract + evidence docs @ V1.2-D. Implementation code @ `2bad834`; acceptance và security review là gate riêng._
