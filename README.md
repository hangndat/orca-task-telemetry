# Orca Task Telemetry

**CLI Node.js đọc GitHub Projects V2, metadata Orca và mức sử dụng Claude Code / Codex (qua agent-top), lưu SQLite cục bộ và báo cáo theo Issue/Project — không sửa repository ứng dụng.**

```text
GitHub Project → GitHub Issue → Orca (read-only) → agent-top sessions → SQLite → báo cáo CLI
```

Trạng thái: **MVP chức năng P0 đã triển khai** (`doctor`, `projects`, `init`, `collect`, `link`, `report`). **V1.1 (#44)** thêm `Issue.parent` trong schema SQLite v2 và `report hierarchy`. **V1.3 (#46)** có liên kết trace thủ công, thu thập lại bằng chứng PR và báo cáo trace; acceptance tích hợp live và review độc lập vẫn riêng. Chưa phát hành npm công khai.

## Điều kiện tiên quyết (đã xác minh trên máy phát triển)

| Thành phần | Yêu cầu | Ghi chú |
| --- | --- | --- |
| Node.js | **≥ 24.0.0** (bắt buộc) | CLI thoát mã 3 khi phiên bản không đạt (`checkNodeVersion`). Trên Node &lt; 24, import `node:sqlite` cũng thất bại trước khi chạy lệnh. |
| pnpm | 10.x (khuyến nghị) | `packageManager` trong `package.json`. |
| GitHub CLI | `gh` đã đăng nhập | Scope **`read:project`** cần cho Project/items; `doctor` cảnh báo nếu thiếu (`gh auth refresh -s read:project`). |
| Orca | CLI đọc-only | `doctor` kiểm tra `--version` (ví dụ 1.4.241 trên môi trường thử). |
| agent-top | **0.27.1** (tùy chọn) | `collect` đọc `sql --json` trên view `counted_sessions` (ADR 0001). Pin binary qua `ORCA_TELEMETRY_AGENT_TOP`. Không gọi `sync`. Không có binary → collect **partial** (exit 5). |

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

Override binary (test/integration): `ORCA_TELEMETRY_GH`, `ORCA_TELEMETRY_ORCA`, `ORCA_TELEMETRY_AGENT_TOP` — chỉ dùng khi kiểm thử; không bắt buộc trong vận hành thường.

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
orca-telemetry trace link-pr --issue OWNER/REPO#123 --pr OWNER/REPO#7 --provider codex --session '<session-uuid>' --json
orca-telemetry trace link-commit --pr OWNER/REPO#7 --sha '<full-40-hex-oid>' --provider codex --session '<session-uuid>' --json
orca-telemetry trace collect --json
orca-telemetry report trace OWNER/REPO#123 --json
```

`report hierarchy` cần `collect` đã ghi `parent` cho mọi Issue trong Project; JSON/text chỉ đọc DB (không ghi GitHub). Parent ngoài Project hiện trong JSON qua `parentStatus: outside_project`, `parentIssueNodeId` và `outsideProjectParentIssueNodeId`; text dùng `owner/repo#number` cho mỗi Issue.

- **`init` / `collect` / `report`**: chỉ đọc GitHub/Orca/agent-top; không commit, không sửa `AGENTS.md`, `.cursor/`, lockfile hay Project fields.
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

Live CodeBurn trước ADR 0001 không chuyển identity. Phải `collect` + `link` lại trên agent-top. Chi tiết lịch sử: [docs/mvp-validation.md](docs/mvp-validation.md).

### Cache, subagent, cost

- Token cache Claude (`cacheRead` / `cacheWrite`) và reasoning Codex được lưu trong snapshot; báo cáo tách provider/model.
- Subagent Claude là **session riêng** (`agent-…`), không gộp vào parent.
- Cost: `estimated_api_equivalent` hoặc `unknown`; báo cáo project/tasks/unmapped phải khớp phân hoạch known/unknown (xem `assertUsageIntegrity` / E2E).

## Kiểm thử

| Lệnh | Phạm vi |
| --- | --- |
| `pnpm test` | Unit + integration fixture (Vitest), gồm `tests/e2e.test.mjs` (stub `gh`/`orca`/`agent-top`). |
| `pnpm test:pack` | Archive, cài prefix tạm, `--help` / `doctor` — **gọi riêng**; smoke V1.3 installed CLI cần chạy thêm. |

Bằng chứng fixture vs live: [docs/mvp-validation.md](docs/mvp-validation.md).

## Giới hạn đã biết

- Không ghi GitHub Project/Issue, không cài agent config trong repo người dùng (xem [BACKLOG.md](BACKLOG.md)).
- Thiếu `read:project` → GitHub collector lỗi; có thể vẫn partial nếu Orca/agent-top ok.
- agent-top không có trên PATH → dùng `ORCA_TELEMETRY_AGENT_TOP` hoặc cài 0.27.1; nếu vẫn thiếu → không import session. Schema v4 xóa snapshot CodeBurn cũ.
- Bằng chứng tích hợp live trên máy dev có thể nằm ngoài repo (ví dụ `/tmp/…`); không thay thế CI — xem matrix trong `docs/mvp-validation.md`.
- Review độc lập @ `818ca30` ghi T41 blocked **trước** link manual; evidence link mới cần **re-review** trên SHA sau docs — không tự gọi MVP hoàn tất.
- Chưa publish npm; không push/PR trong phạm vi worker docs.

## Tài liệu

- [Đặc tả MVP](docs/MVP-SPEC.md) · [V1.1 hierarchy (#44)](docs/V1-HIERARCHY-SPEC.md) · [Kiến trúc](docs/ARCHITECTURE.md) · [Báo cáo validation](docs/mvp-validation.md)
- Contributor agents: [AGENTS.md](AGENTS.md)

## Giấy phép

Chưa chọn.
