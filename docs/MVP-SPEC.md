# Đặc tả MVP

## User story chính

Là một lập trình viên sử dụng repository GitHub hiện có cùng Orca và Claude Code/Codex, tôi có thể cài đặt một CLI dùng trên toàn hệ thống, chọn một GitHub Project, liên kết tường minh một session thực thi với một GitHub Issue có thật, rồi xem mức sử dụng token và chi phí ước tính tương đương API mà không sửa đổi repository ứng dụng của mình.

## Các tính năng P0

| ID | Tính năng | Tiêu chí nghiệm thu |
|---|---|---|
| MVP-01 | CLI có thể cài đặt | `npm pack`, cài đặt trong môi trường cô lập và `orca-telemetry --help` hoạt động bên ngoài repository mã nguồn. |
| MVP-02 | `init` + profile | Xác định danh tính repository GitHub; chọn GitHub Project; lưu profile trong thư mục dữ liệu người dùng mà không đụng đến các file trong repository. |
| MVP-03 | Bộ đọc GitHub Projects | Đọc các mục trong Project cùng ID ổn định, URL và tiêu đề của Issue được liên kết, có hỗ trợ phân trang. |
| MVP-04 | Orca collector | Đọc worker/task được giám sát và worktree tạo thủ công khi được hỗ trợ, không thay đổi trạng thái. |
| MVP-05 | CodeBurn collector | Đọc dữ liệu mức sử dụng session Claude và Codex đã chuẩn hóa từ các giao diện JSON đã được xác minh. |
| MVP-06 | Ánh xạ session | Lệnh tường minh `link --issue --provider --session` ánh xạ toàn bộ một session vào một GitHub Issue và từ chối các xung đột. |
| MVP-07 | SQLite | Import an toàn, có tính idempotent và quản lý phiên bản schema; không lưu thông tin xác thực hay prompt thô. |
| MVP-08 | Báo cáo | `report tasks`, `report project` và `report unmapped` phân biệt mức sử dụng đã quy thuộc, chưa quy thuộc, ước tính và chưa biết. |

## Các lệnh dự kiến (chưa triển khai)

```bash
orca-telemetry doctor
orca-telemetry init
orca-telemetry projects
orca-telemetry collect
orca-telemetry link --issue <issue-url> --provider <codex|claude> --session <session-id>
orca-telemetry report tasks
orca-telemetry report task <issue-id>
orca-telemetry report project
orca-telemetry report unmapped
```

## Các ràng buộc bảo vệ bắt buộc

- Các tích hợp bên ngoài chỉ được đọc; không sửa đổi GitHub Projects hoặc repository.
- ID session của provider phải có namespace.
- Snapshot tích lũy phải được upsert, không được cộng lặp lại.
- Phải kiểm tra ngữ nghĩa token đầu vào/đọc/ghi cache của Claude trước khi tổng hợp.
- Không suy ra bên phụ trách task chỉ từ timestamp hoặc branch.
- Liên kết session với task phải kèm thông tin nguồn gốc và cơ chế xử lý xung đột.
- Khi collector gặp lỗi hoặc không khả dụng, phải tạo báo cáo một phần kèm thông tin lỗi, không tự tạo dữ liệu.

## Các lát cắt triển khai

1. **Nền tảng:** build, test, pack, install, doctor. (Repository khởi đầu chứa bộ khung nền tảng, chưa phải MVP hoàn chỉnh.)
2. **GitHub:** khởi tạo profile và liệt kê Project/Issue.
3. **Telemetry:** metadata Orca + mức sử dụng Claude/Codex từ CodeBurn → SQLite.
4. **Quy thuộc:** ánh xạ GitHub Issue ↔ session tường minh, đã được xác minh.
5. **Báo cáo và kiểm chứng:** tổng hợp mức sử dụng, chi phí theo Issue và Project, fixture, kiểm tra tích hợp thực tế, tài liệu.

## Tiêu chí hoàn thành (Definition of Done)

- Tất cả tính năng P0 hoạt động và có test cho kết quả xác định.
- Đọc được ít nhất một GitHub Project thực tế nếu có quyền truy cập.
- Việc phân tích dữ liệu Claude và Codex có bằng chứng từ fixture; báo cáo trung thực khi không có agent thực tế để kiểm chứng.
- Minh chứng ít nhất một ánh xạ Issue↔session thực tế cùng báo cáo nếu có dữ liệu.
- Thu thập lặp lại không gây tính trùng.
- Package cài đặt được bên ngoài repository và không thể thay đổi thiết lập hiện có của repository đích.
- Không vô tình triển khai tính năng P1/P2.
- Các test liên quan đều đạt và có conventional commit mang ý nghĩa rõ ràng.
