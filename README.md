# Orca Task Telemetry

**Phân tích chi phí lập trình AI cho Orca, Claude Code và Codex, lấy GitHub Projects làm trung tâm.**

> **Trạng thái: bộ khung nền tảng — chưa có collector telemetry hoạt động.** CLI hiện hỗ trợ `--help`, `--version` và `doctor`. Các lệnh tích hợp liệt kê bên dưới là mục tiêu triển khai, chưa phải tính năng đã hoàn thành.

## Mục tiêu

Cài đặt một CLI trên toàn hệ thống, sau đó quy mức sử dụng session Claude Code / Codex về GitHub Issue trong các repository hiện có mà không thay đổi mã ứng dụng hoặc cấu hình agent.

```text
GitHub Project -> GitHub Issue -> Thực thi Orca -> Session của provider -> Mức sử dụng từ CodeBurn -> SQLite -> Báo cáo CLI
```

GitHub là nguồn dữ liệu chuẩn cho Issue và việc lập kế hoạch Project; Orca cung cấp metadata thực thi; CodeBurn cung cấp mức sử dụng session. MVP đầu tiên sử dụng liên kết session với Issue tường minh, đã được xác minh khi không có định danh chính xác.

## Điều kiện tiên quyết

- Node.js 24+
- npm hoặc pnpm
- GitHub CLI (`gh`) và quyền truy cập GitHub Projects V2, dành cho tích hợp sau này
- Orca và CodeBurn, dành cho thực thi cục bộ và thu thập token sau này

## Phát triển cục bộ

```bash
corepack enable
pnpm install
pnpm build
pnpm test
node dist/cli.js --help
node dist/cli.js doctor
pnpm pack
```

npm package sẽ cung cấp lệnh `orca-telemetry` qua entry point `bin`. Sau khi được triển khai và đóng gói, bạn có thể cài đặt tarball trên toàn hệ thống hoặc cài đặt từ Git. Package dùng trong production phải hoạt động bên ngoài thư mục mã nguồn hiện tại.

## Exit codes & JSON output

| Exit | Ý nghĩa |
| --- | --- |
| 0 | Thành công |
| 1 | Lỗi nội bộ không mong đợi |
| 2 | Usage (`usage_error`, `unknown_command`, `not_implemented`, tham số sai) |
| 3 | Môi trường (ví dụ Node.js không đạt yêu cầu) |
| 4 | Nguồn ngoài không khả dụng (toàn phần) |
| 5 | Một phần nguồn lỗi, vẫn có kết quả một phần |

Với `--json`, stdout chỉ có một object: thành công `{"ok":true,"data":...}`, lỗi `{"ok":false,"error":{"code","message","hint"?}}`. Không JSON: lỗi in ra stderr dạng `error: …` và tùy chọn `hint: …`. Đặt `ORCA_TELEMETRY_DEBUG=1` để in stack trace lỗi không mong đợi ra stderr.

## Contributor agents

Setup chung cho Codex, Claude và Cursor nằm ở [AGENTS.md](AGENTS.md) và [agent workflow](docs/agents/README.md): role/persona theo scope CLI, mẫu giao việc, review độc lập theo SHA và giới hạn vòng fix. Bộ hướng dẫn được điều chỉnh từ `ticket-solution`; xem [provenance và giới hạn validation](docs/agents/PROVENANCE.md).

Cấu hình này chỉ dành cho contributor của repo; telemetry CLI không cài/sửa agent setup trong repository người dùng.

## Cách sử dụng MVP dự kiến (CHƯA TRIỂN KHAI)

```bash
cd /path/to/ticket-solution
orca-telemetry init
orca-telemetry collect
orca-telemetry link --issue https://github.com/OWNER/REPO/issues/123 --provider codex --session SESSION_ID
orca-telemetry report tasks
orca-telemetry report project
orca-telemetry report unmapped
```

Các lệnh này minh họa giao diện sẽ triển khai, chưa phải hướng dẫn có thể chạy được với bộ khung hiện tại.

## Định nghĩa MVP

Lát cắt đầu tiên được kiểm chứng phải ánh xạ **một GitHub Issue có thật** với **một session Claude Code hoặc Codex có thật**, đồng thời hiển thị mức sử dụng token cùng nguồn gốc quy thuộc rõ ràng. Khi làm việc với nhiều repository, không được thay đổi `AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`, `.cursor/` hoặc dependency ứng dụng của các repository đó.

Xem [đặc tả MVP](docs/MVP-SPEC.md), [kiến trúc](docs/ARCHITECTURE.md) và [backlog](BACKLOG.md).

## Tạo repository GitHub của bạn

Sau khi giải nén bộ khung này, xác thực GitHub CLI (`gh auth login`) và chạy:

```bash
bash scripts/publish-github.sh
```

Script khởi tạo repository Git (nếu cần), tạo một commit cho bộ khung, tạo `hangndat/orca-task-telemetry` dưới dạng repository **private** và push `main`. Để chủ động tạo repository công khai, sử dụng `VISIBILITY=public bash scripts/publish-github.sh`.

Dự án này độc lập với `ticket-solution`. Không commit secret, log session cục bộ, cơ sở dữ liệu telemetry hoặc mã nguồn ứng dụng từ các dự án khác.

## Giấy phép

Chưa chọn. Cần chọn giấy phép trước khi phân phối công khai.
