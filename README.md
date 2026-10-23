# Orca Task Telemetry

**CLI Node.js đọc GitHub Projects V2, metadata Orca và mức sử dụng Claude Code / Codex (qua CodeBurn), lưu SQLite cục bộ và báo cáo theo Issue/Project — không sửa repository ứng dụng.**

```text
GitHub Project → GitHub Issue → Orca (read-only) → CodeBurn sessions → SQLite → báo cáo CLI
```

Trạng thái: **MVP chức năng P0 đã triển khai** (`doctor`, `projects`, `init`, `collect`, `link`, `report`). Chưa phát hành npm công khai; chưa được reviewer độc lập ký nhận MVP hoàn tất.

## Điều kiện tiên quyết (đã xác minh trên máy phát triển)

| Thành phần | Yêu cầu | Ghi chú |
| --- | --- | --- |
| Node.js | **≥ 24.0.0** (bắt buộc) | CLI thoát mã 3 khi phiên bản không đạt (`checkNodeVersion`). Trên Node &lt; 24, import `node:sqlite` cũng thất bại trước khi chạy lệnh. |
| pnpm | 10.x (khuyến nghị) | `packageManager` trong `package.json`. |
| GitHub CLI | `gh` đã đăng nhập | Scope **`read:project`** cần cho Project/items; `doctor` cảnh báo nếu thiếu (`gh auth refresh -s read:project`). |
| Orca | CLI đọc-only | `doctor` kiểm tra `--version` (ví dụ 1.4.237 trên môi trường thử). |
| CodeBurn | `codeburn@0.9.27` (tùy chọn) | `collect` đọc `sessions --provider claude|codex --format json`. Không có binary → collect **partial** (exit 5), nguồn khác vẫn ghi DB. |

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
orca-telemetry report unmapped --json
```

- **`init` / `collect` / `report`**: chỉ đọc GitHub/Orca/CodeBurn; không commit, không sửa `AGENTS.md`, `.cursor/`, lockfile hay Project fields.
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

Chỉ liên kết khi bạn **chủ đích** chọn cặp Issue + `provider` + `session` (UUID CodeBurn). Không tự suy session từ timestamp hay branch. Gợi ý lệnh: `report unmapped`.

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
- CodeBurn không có trên PATH → không import session; báo cáo chỉ phản ánh dữ liệu đã collect.
- Chưa publish npm; không tuyên bố “MVP complete” cho đến khi review độc lập trên cùng candidate SHA.

## Tài liệu

- [Đặc tả MVP](docs/MVP-SPEC.md) · [Kiến trúc](docs/ARCHITECTURE.md) · [Báo cáo validation](docs/mvp-validation.md)
- Contributor agents: [AGENTS.md](AGENTS.md)

## Giấy phép

Chưa chọn.
