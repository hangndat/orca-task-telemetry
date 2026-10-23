# Orca Task Telemetry

**CLI Node.js đọc GitHub Projects V2, metadata Orca và mức sử dụng Claude Code / Codex (qua CodeBurn), lưu SQLite cục bộ và báo cáo theo Issue/Project — không sửa repository ứng dụng.**

```text
GitHub Project → GitHub Issue → Orca (read-only) → CodeBurn sessions → SQLite → báo cáo CLI
```

Trạng thái: **MVP chức năng P0 đã triển khai** (`doctor`, `projects`, `init`, `collect`, `link`, `report`). **V1.1 (#44)** thêm `Issue.parent` và `report hierarchy`. **V1.2 (#45)** thêm `writeback` (dry-run mặc định, `--apply` opt-in) — contract: [docs/V1-PROJECT-WRITEBACK-SPEC.md](docs/V1-PROJECT-WRITEBACK-SPEC.md); chưa gọi V1.2 acceptance hoàn tất (security review + live apply trên field thử). Chưa publish npm công khai.

## Điều kiện tiên quyết (đã xác minh trên máy phát triển)

| Thành phần | Yêu cầu | Ghi chú |
| --- | --- | --- |
| Node.js | **≥ 24.0.0** (bắt buộc) | CLI thoát mã 3 khi phiên bản không đạt (`checkNodeVersion`). Trên Node &lt; 24, import `node:sqlite` cũng thất bại trước khi chạy lệnh. |
| pnpm | 10.x (khuyến nghị) | `packageManager` trong `package.json`. |
| GitHub CLI | `gh` đã đăng nhập | **`read:project`** cho `collect` / `writeback` dry-run; scope **`project`** chỉ khi `writeback --apply` (`gh auth refresh -s project`). |
| Orca | CLI đọc-only | `doctor` kiểm tra `--version` (ví dụ 1.4.237 trên môi trường thử). |
| CodeBurn | `codeburn@0.9.27` (tùy chọn) | `collect` đọc `sessions --provider claude|codex --format json`. Có thể chỉ định binary pin qua `ORCA_TELEMETRY_CODEBURN` (ví dụ bản trong npm cache) khi **không** cài global. Không có binary → collect **partial** (exit 5), nguồn khác vẫn ghi DB. |

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

Override binary (test/integration): `ORCA_TELEMETRY_GH`, `ORCA_TELEMETRY_ORCA`, `ORCA_TELEMETRY_CODEBURN` — chỉ dùng khi kiểm thử; không bắt buộc trong vận hành thường.

## Quy trình MVP (repository ứng dụng)

Chạy trong thư mục git của repo cần theo dõi (ví dụ `ticket-solution`), với `ORCA_TELEMETRY_HOME` trỏ tới thư mục **bên ngoài** repo:

```bash
export ORCA_TELEMETRY_HOME=/path/to/telemetry-home-outside-repo

orca-telemetry doctor
orca-telemetry projects --json
orca-telemetry init --project https://github.com/users/OWNER/projects/4 --json
orca-telemetry collect --json
orca-telemetry link --issue OWNER/REPO#123 --provider codex --session '<session-uuid>' --json
orca-telemetry report tasks --json
orca-telemetry report task OWNER/REPO#123 --json
orca-telemetry report project --json
orca-telemetry report hierarchy --json
orca-telemetry report unmapped --json
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

- **`init` / `collect` / `report` / `writeback` (không `--apply`)**: không gọi mutation Project; không commit repo ứng dụng, không sửa agent config.
- **`link`**: ghi ánh xạ Issue ↔ session trong DB cục bộ; từ chối xung đột (`attribution_link_conflict`).
- **`collect` lần 2**: upsert idempotent — tổng usage trong báo cáo không đổi (đã kiểm bằng fixture E2E).

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

Chỉ liên kết khi bạn **chủ đích** chọn cặp Issue + `provider` + `session` (UUID CodeBurn). Không tự suy session từ `projectHint`, branch hay timestamp. Gợi ý lệnh: `report unmapped`.

Một phiên CodeBurn có thể gồm nhiều task hoặc repo trong lịch sử chat. Khi bạn map **toàn bộ** session vào một Issue, `report task` phản ánh **tổng** token/cost của session đó cho Issue — CLI **không** chia nhỏ usage trong cùng session giữa nhiều Issue. Cost trong báo cáo là `estimated_api_equivalent`, **không** phải hóa đơn billing.

Ví dụ đã kiểm chứng (live, local evidence): user gán session Claude `a3df5501-4411-43db-9b37-70507f3a2121` → `hangndat/orca-task-telemetry#3` một lần (`method=manual`); `report unmapped` giảm 407→406; `report task` khớp bucket token CodeBurn. Chi tiết: [docs/mvp-validation.md](docs/mvp-validation.md).

### Cache, subagent, cost

- Token cache Claude (`cacheRead` / `cacheWrite`) và reasoning Codex được lưu trong snapshot; báo cáo tách provider/model.
- Subagent Claude là **session riêng** (`agent-…`), không gộp vào parent.
- Cost: `estimated_api_equivalent` hoặc `unknown`; báo cáo project/tasks/unmapped phải khớp phân hoạch known/unknown (xem `assertUsageIntegrity` / E2E).

## Kiểm thử

| Lệnh | Phạm vi |
| --- | --- |
| `pnpm test` | Unit + integration fixture (Vitest), gồm `tests/e2e.test.mjs` (stub `gh`/`orca`/`codeburn`). |
| `pnpm test:pack` | Archive, cài prefix tạm, `--help` / `doctor` — **gọi riêng**; không chạy trong `pnpm test`. |

Bằng chứng fixture vs live: [docs/mvp-validation.md](docs/mvp-validation.md).

## Giới hạn đã biết

- Không ghi GitHub Project/Issue, không cài agent config trong repo người dùng (xem [BACKLOG.md](BACKLOG.md)).
- Thiếu `read:project` → GitHub collector lỗi; có thể vẫn partial nếu Orca/CodeBurn ok.
- CodeBurn không có trên PATH → dùng `ORCA_TELEMETRY_CODEBURN` hoặc cài binary; nếu vẫn thiếu → không import session.
- Bằng chứng tích hợp live trên máy dev có thể nằm ngoài repo (ví dụ `/tmp/…`); không thay thế CI — xem matrix trong `docs/mvp-validation.md`.
- Review độc lập @ `818ca30` ghi T41 blocked **trước** link manual; evidence link mới cần **re-review** trên SHA sau docs — không tự gọi MVP hoàn tất.
- Chưa publish npm; không push/PR trong phạm vi worker docs.

## Tài liệu

- [Đặc tả MVP](docs/MVP-SPEC.md) · [V1.1 hierarchy (#44)](docs/V1-HIERARCHY-SPEC.md) · [V1.2 writeback (#45)](docs/V1-PROJECT-WRITEBACK-SPEC.md) · [Kiến trúc](docs/ARCHITECTURE.md) · [Báo cáo validation](docs/mvp-validation.md)
- Contributor agents: [AGENTS.md](AGENTS.md)

## Giấy phép

Chưa chọn.
