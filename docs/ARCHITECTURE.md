# Kiến trúc (MVP dự kiến)

```text
GitHub Projects V2 --(chỉ đọc)--> Collector GitHub
Luồng Orca được giám sát/thủ công --> Collector Orca
Session Claude/Codex từ CodeBurn --> Collector mức sử dụng
                 \                |                /
                 Bản ghi đã chuẩn hóa
                          |
                Đối chiếu đã xác minh
                          |
                    Kho lưu SQLite
                          |
                Báo cáo Issue/Project qua CLI
```

## Ranh giới trách nhiệm giữa các thành phần

- **GitHub**: Là nguồn chuẩn cho định danh Project, repository, Issue và trạng thái lập kế hoạch. Quan hệ Project↔Issue là nhiều-nhiều.
- **Orca**: Metadata về task, dispatch, worker và worktree chỉ được xem là dữ liệu chuẩn khi được cung cấp qua giao diện đã xác minh. Worktree thủ công không đồng nghĩa với việc có worker đang được giám sát và hoạt động.
- **CodeBurn**: Mức sử dụng session chỉ được xem là dữ liệu chuẩn đối với những dữ liệu mà CodeBurn có thể trích xuất một cách kiểm chứng được. Không đánh đồng phí provider thực thu với chi phí ước tính tương đương API.
- **Adapter**: Đối chiếu các định danh và lưu snapshot. Không tự tạo ID thực thi còn thiếu hoặc âm thầm quy thuộc dữ liệu.

## Các bất biến khi tổng hợp mức sử dụng và chi phí

1. Import lặp lại không làm tăng tổng khi snapshot tích lũy của session không thay đổi.
2. Danh tính session có namespace theo provider và nguồn; các provider khác nhau không thể trùng định danh.
3. Không thể đồng thời phân bổ toàn bộ một session cho hai Issue khác nhau.
4. Có thể quy nhiều session khác nhau về một Issue.
5. Định nghĩa token cache/đọc/ghi được giữ riêng theo từng nguồn cho đến khi được xác nhận.
6. `unknown` không phải là `0`, và chi phí API ước tính không phải phí thuê bao thực tế.
7. Báo cáo Project loại bỏ session trùng lặp trong phạm vi Project được chọn.
8. Metadata nguồn và các liên kết đã xác minh được lưu bền vững bên ngoài repository ứng dụng đích.

## Mô hình vận hành MVP

Không có daemon, webhook, dịch vụ từ xa, thao tác sửa đổi GitHub, Claude hook, can thiệp vào agent, phân tích nguồn dữ liệu tùy ý hoặc thay đổi vòng đời thực thi. `collect` phải được gọi tường minh. `link` phải được gọi tường minh và được xác minh.

## Các rủi ro cần làm rõ khi khảo sát

- Phân trang và quyền truy cập GitHub Projects GraphQL.
- Định danh ổn định để đối chiếu dispatch/session của Orca.
- Định dạng JSON của CodeBurn và ngữ nghĩa token tích lũy theo từng provider.
- Cách tổng hợp mức sử dụng subagent tại nguồn.
- Lưu trữ profile cục bộ đa nền tảng và khả năng hỗ trợ SQLite trong Node 24.
