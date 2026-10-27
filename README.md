# Orca Task Telemetry

**CLI Node.js đọc GitHub Projects V2, metadata Orca và mức sử dụng Claude Code / Codex / Cursor (qua agent-top), lưu SQLite cục bộ và báo cáo theo Issue/Project — không sửa repository ứng dụng.**

```text
GitHub Project → GitHub Issue → Orca (read-only) → agent-top sessions → SQLite → báo cáo CLI
```

Trạng thái: **MVP chức năng P0 đã triển khai** (`doctor`, `projects`, `init`, `collect`, `link`, `report`). **V1.1 (#44)** thêm `Issue.parent` trong schema SQLite v2 và `report hierarchy`. **V1.2 (#45)** thêm `writeback` (dry-run mặc định, `--apply` opt-in) — contract: [docs/V1-PROJECT-WRITEBACK-SPEC.md](docs/V1-PROJECT-WRITEBACK-SPEC.md). **V1.3 (#46)** có liên kết trace thủ công, thu thập lại bằng chứng PR và báo cáo trace. Chưa phát hành npm công khai.

## Điều kiện tiên quyết (đã xác minh trên máy phát triển)

| Thành phần | Yêu cầu | Ghi chú |
| --- | --- | --- |
| Node.js | **≥ 24.0.0** (bắt buộc) | CLI thoát mã 3 khi phiên bản không đạt (`checkNodeVersion`). Trên Node &lt; 24, import `node:sqlite` cũng thất bại trước khi chạy lệnh. |
| pnpm | 10.x (khuyến nghị) | `packageManager` trong `package.json`. |
| GitHub CLI | `gh` đã đăng nhập | **`read:project`** cho `collect` / `writeback` dry-run; scope **`project`** chỉ khi `writeback --apply` (`gh auth refresh -s project`). `doctor` cảnh báo nếu thiếu `read:project`. |
| Orca | CLI đọc-only **1.4.241** (đã verify) | `doctor` kiểm tra `--version`. `collect` enumerates runs qua **`run-list`** rồi `worker-list` (mặc định). Pin một run (tùy chọn): `ORCA_TELEMETRY_COLLECT_RUN=<run_id>`. |
| agent-top | **0.27.1** (tùy chọn cho usage) | `collect` đọc `sql --json` trên view `counted_sessions` harness `claude`/`codex`/`cursor` (ADR 0001). Pin binary: `ORCA_TELEMETRY_AGENT_TOP`. **Không** gọi `sync`. Thiếu binary → collect **partial** (exit 5), không import session. Live 0.27.1 thường **0 hàng cursor** (process table only). |

Chi tiết lệnh và schema: [docs/discovery.md](docs/discovery.md).

## Cài đặt và phát triển

```bash
corepack enable
pnpm install
pnpm build
pnpm test          # build + vitest (fixture)
pnpm test:pack     # pack tarball, cài prefix tạm, smoke CLI ngoài source
node dist/cli.js --help
node dist/cli.js doctor
node dist/cli.js doctor --json
```

Sau `pnpm pack`, cài tarball vào prefix sạch (xem `scripts/test-pack.mjs`). Bin: **`orca-telemetry`** → `dist/cli.js`.

## Dữ liệu cục bộ (ngoài repository Git)

| Biến / đường dẫn | Mục đích |
| --- | --- |
| `ORCA_TELEMETRY_HOME` | Thư mục gốc profile + SQLite (mặc định dưới home người dùng). **Không** được nằm trong git root của repo đích. |
| `config.json` | Profile repository ↔ GitHub Project. |
| `telemetry.sqlite` | DB telemetry (schema có version; đọc báo cáo qua kết nối read-only). |

Override binary (test/integration): `ORCA_TELEMETRY_GH`, `ORCA_TELEMETRY_ORCA`, `ORCA_TELEMETRY_AGENT_TOP`. Thu hẹp Orca collect (tùy chọn): `ORCA_TELEMETRY_COLLECT_RUN` — mặc định **không** set (dùng run-list).

## Quy trình MVP (repository ứng dụng)

Chạy trong thư mục git của repo cần theo dõi (ví dụ `ticket-solution`), với `ORCA_TELEMETRY_HOME` trỏ tới thư mục **bên ngoài** repo:

```bash
export ORCA_TELEMETRY_HOME=/path/to/telemetry-home-outside-repo

orca-telemetry doctor
orca-telemetry projects --json
# init --project chấp nhận: số (4), users|orgs/OWNER/projects/N, hoặc URL github.com
#   …/users|orgs/OWNER/projects/N[/views/N] (query string bị bỏ qua)
orca-telemetry init --project https://github.com/users/OWNER/projects/4 --json
orca-telemetry collect --json
# (tùy chọn) ORCA_TELEMETRY_COLLECT_RUN=run_<hex> orca-telemetry collect --json
orca-telemetry link --issue OWNER/REPO#123 --provider claude --session '<session-uuid>' --json
# provider cũng chấp nhận: codex | cursor
orca-telemetry report tasks --json
orca-telemetry report task OWNER/REPO#123 --json
orca-telemetry report project --json
orca-telemetry report hierarchy --json
orca-telemetry report unmapped --json
orca-telemetry trace link-pr --issue OWNER/REPO#123 --pr OWNER/REPO#7 --provider codex --session '<session-uuid>' --json
orca-telemetry trace link-commit --pr OWNER/REPO#7 --sha '<full-40-hex-oid>' --provider codex --session '<session-uuid>' --json
orca-telemetry trace collect --json
orca-telemetry report trace OWNER/REPO#123 --json
```

`report hierarchy` cần `collect` đã ghi `parent` cho mọi Issue trong Project; JSON/text chỉ đọc DB (không ghi GitHub). Parent ngoài Project hiện trong JSON qua `parentStatus: outside_project`, `parentIssueNodeId` và `outsideProjectParentIssueNodeId`; text dùng `owner/repo#number` cho mỗi Issue.

### Writeback Project field (V1.2, #45)

Ghi **estimated API equivalent** (known only) lên custom field **NUMBER** đã tạo trên board; Project/owner **chỉ** từ profile `init` (không `--project` / `--owner`). Chạy `collect` trước để có membership và usage.

```bash
# Dry-run (mặc định): GraphQL read-only + SQLite — không gọi item-edit
orca-telemetry writeback --field "Cost USD" --json
orca-telemetry writeback --field-id PVTF_… --issue hangndat/orca-task-telemetry#45 --json

# Inclusive rollup: bắt buộc --issue (cùng semantics report hierarchy)
orca-telemetry writeback --field "Cost USD" --rollup inclusive --issue OWNER/REPO#123 --json

# Live (opt-in): cần scope project; non-TTY bắt buộc --yes
orca-telemetry writeback --field "Cost USD" --apply --yes --json
```

| Hành vi | Ghi chú |
| --- | --- |
| Mặc định | `mode: dry_run` — preview `kind: writeback_preview`; không mutation GitHub |
| `--apply` / `--yes` | Ghi qua `gh project item-edit`; `--yes` chỉ sau preview **cùng process**; TTY hỏi xác nhận nếu thiếu `--yes` |
| Apply scope | Trước preview/write, CLI kiểm tra account `github.com` đang active bằng `gh auth status --json hosts --no-refresh`; thiếu `project` hoặc không xác minh được → exit `2`, kể cả khi không có set dự kiến. `doctor` báo riêng scope đọc và scope apply, gợi ý `gh auth refresh -s project`. |
| `--force-overwrite` | Ghi khi remote NUMBER ≠ computed; không flag → `skip` `remote_conflict` |
| Cost | Chỉ **estimated API equivalent**; session `unknown` → `skip` `unknown_cost`; không session → `no_usage` |
| Field | Owner tạo field NUMBER trên board; tên trùng → exit `2`, dùng `--field-id` |
| Race | GitHub không CAS nguyên tử; CLI re-read trước write nhưng không loại bỏ xung đột đồng thời |
| Timeout | Lần `item-edit` timeout/overflow luôn là item failure; trạng thái remote có thể chưa rõ, cần đọc lại field trước khi retry thủ công. |

- **`init` / `collect` / `report` / `writeback` (không `--apply`)**: chỉ đọc GitHub/Orca/agent-top; không gọi mutation Project; không commit repo ứng dụng, không sửa `AGENTS.md`, `.cursor/`, lockfile hay agent config.
- **`link`**: ghi ánh xạ Issue ↔ session trong DB cục bộ; từ chối xung đột (`attribution_link_conflict`).
- **`collect` lần 2**: upsert idempotent — tổng usage trong báo cáo không đổi (đã kiểm bằng fixture E2E).

### PR và commit trace (V1.3)

`trace link-pr` yêu cầu session đã được gắn thủ công vào Issue, và GitHub `closingIssuesReferences` chứa đúng Issue node ID sau khi đọc hết trang. `trace link-commit` yêu cầu link PR trước đó và full OID hiện trong `PullRequest.commits`. Link chỉ ghi vào SQLite cục bộ; không tự suy session từ branch, timestamp hay commit message. Một session có thể được gắn vào nhiều PR hoặc commit khi người dùng chủ động chọn từng đường.

`trace collect` đọc tuần tự mỗi PR node ID đã lưu đúng một lần, cập nhật metadata và trạng thái quan hệ Issue/commit. Đọc đầy đủ có thể chuyển quan hệ thành `stale`; lỗi quyền, rate limit hoặc trang chưa hoàn chỉnh chuyển thành `unknown` và giữ `lastVerifiedAt` cùng link audit. Không gọi GitHub write API, không thay session link hoặc snapshot agent-top. JSON trả `pulls`, số PR đã xác minh/chưa rõ và `exitCode`; mã 4 khi mọi PR lỗi, 5 khi một phần lỗi, 0 khi thành công hoặc chưa lưu PR nào.

`report trace <issue-url|issue-number|node-id> [--json]` chỉ đọc SQLite cục bộ. `issueSessions` và `issueUsage` gồm mọi session đã link với Issue; mỗi PR chỉ gồm session được link thủ công với PR đó, mỗi commit chỉ gồm link commit thủ công. Totals khử trùng theo session trong từng phạm vi; **không cộng các PR/commit để ra tổng Issue**. JSON giữ `cost.amountUsd: null`/`kind: unknown` khi thiếu snapshot hoặc agent-top chưa biết cost; `knownAmountUsd` chỉ là phần ước tính đã biết. Cost `estimated_api_equivalent` không phải billing thực tế. `orcaReference: unknown` khi chưa xác minh nối Orca↔agent-top. Trạng thái quan hệ phản ánh lần đọc hết trang, **không** chứng minh snapshot GitHub nguyên tử tại một thời điểm. Text in cảnh báo stale/unknown và giới hạn cộng tổng.

### Exit codes và JSON

| Exit | Ý nghĩa |
| --- | --- |
| 0 | Thành công |
| 1 | Lỗi nội bộ |
| 2 | Usage / validation |
| 3 | Môi trường (Node &lt; 24) |
| 4 | Nguồn ngoài không khả dụng (toàn phần) |
| 5 | Thu thập **partial** (một số nguồn lỗi, vẫn có dữ liệu) |

`--json`: một object JSON trên stdout (`ok` + `data` hoặc `error`). `ORCA_TELEMETRY_DEBUG=1` in stack trace lỗi không mong đợi.

### Ánh xạ session thủ công

Chỉ liên kết khi bạn **chủ đích** chọn cặp Issue + `provider` + `session` (`session_id` agent-top). Không tự suy session từ `projectHint`, branch hay timestamp. Gợi ý lệnh: `report unmapped`.

Một phiên agent-top có thể gồm nhiều task hoặc repo trong lịch sử chat. Khi bạn map **toàn bộ** session vào một Issue, `report task` phản ánh **tổng** token/cost của session đó cho Issue — CLI **không** chia nhỏ usage trong cùng session giữa nhiều Issue. Cost trong báo cáo là `estimated_api_equivalent`, **không** phải hóa đơn billing.

Live CodeBurn trước ADR 0001 **đã superseded** — identity không chuyển. Phải `collect` + `link` lại trên agent-top. Self-check + giới hạn: [docs/mvp-validation.md](docs/mvp-validation.md); DoD map: [docs/mvp-dod-self-check.md](docs/mvp-dod-self-check.md). **Independent Codex review: PASS** trên SHA `5b464e3` — [docs/reviews/mvp-5b464e3.md](docs/reviews/mvp-5b464e3.md). Live evidence `/tmp/…` là DB local được bảo toàn, không phải CI artifact.

### Cache, subagent, cost

- Token cache Claude (`cacheRead` / `cacheWrite`) và reasoning Codex được lưu trong snapshot; báo cáo tách provider/model.
- Subagent Claude là **session riêng** (`agent-…`), không gộp vào parent.
- Cursor: cùng cột token agent-top đã verify; hàng tokens=0 → cost/`tokenAllocation` **unknown** (không coi zeros là free usage đo được). Live agent-top 0.27.1 thường chưa sync cursor vào SQL — xem [docs/discovery.md](docs/discovery.md).
- Cost: `estimated_api_equivalent` hoặc `unknown`; báo cáo project/tasks/unmapped phải khớp phân hoạch known/unknown (xem `assertUsageIntegrity` / E2E). `unknown` ≠ `0`.

## Kiểm thử

| Lệnh | Phạm vi |
| --- | --- |
| `pnpm test` | Unit + integration fixture (Vitest), gồm `tests/e2e.test.mjs` (stub `gh`/`orca`/`agent-top`). |
| `pnpm test:pack` | Archive, cài prefix tạm, `--help` / `doctor` — **gọi riêng**; smoke V1.3 installed CLI cần chạy thêm. |

Bằng chứng fixture vs live: [docs/mvp-validation.md](docs/mvp-validation.md).

## Giới hạn đã biết

- `writeback` không `--apply` thì không ghi Project; `--apply` chỉ ghi NUMBER field đã chọn (opt-in). Không cài agent config trong repo người dùng (xem [BACKLOG.md](BACKLOG.md)).
- Thiếu `read:project` → GitHub collector lỗi; có thể vẫn partial nếu Orca/agent-top ok.
- agent-top không có trên PATH → dùng `ORCA_TELEMETRY_AGENT_TOP` hoặc cài 0.27.1; nếu vẫn thiếu → không import session. Schema v4 xóa snapshot CodeBurn cũ; v7 nới provider CHECK thêm `cursor`.
- Cursor usage phụ thuộc agent-top sync vào `counted_sessions`; 0.27.1: process table only → OTT import 0 session live cho đến khi agent-top có hàng.
- Bằng chứng tích hợp live trên máy dev có thể nằm ngoài repo (ví dụ `/tmp/…`); không thay thế CI — xem matrix trong `docs/mvp-validation.md`.
- Evidence CodeBurn @ `818ca30` / Issue #3 **superseded** sau ADR 0001. Live agent-top: Issue **#71** ↔ session `3a8a1086-…` (DB `/tmp/orca-telemetry-agent-top-home`). Independent acceptance **PASS** @ `5b464e3` ([docs/reviews/mvp-5b464e3.md](docs/reviews/mvp-5b464e3.md)); live `/tmp` không thay CI chain-of-custody.
- Chưa publish npm công khai.

## Tài liệu

- [Đặc tả MVP](docs/MVP-SPEC.md) · [V1.1 hierarchy (#44)](docs/V1-HIERARCHY-SPEC.md) · [V1.2 writeback (#45)](docs/V1-PROJECT-WRITEBACK-SPEC.md) · [V1.3 PR/commit trace (#46)](docs/V1-PR-COMMIT-TRACE-SPEC.md) · [Kiến trúc](docs/ARCHITECTURE.md) · [Validation self-check](docs/mvp-validation.md) · [DoD self-check](docs/mvp-dod-self-check.md) · [ADR 0001 agent-top](docs/adr/0001-agent-top-usage-sot.md)
- Contributor agents: [AGENTS.md](AGENTS.md)

## Giấy phép

Chưa chọn.
