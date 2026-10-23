# Context budget

- Đọc AGENTS.md, task spec và tài liệu cần cho scope. Ba tài liệu Read first ở AGENTS.md là bắt buộc; sau đó chỉ mở section/source liên quan.
- Trong cùng session không đọc lại tài liệu chưa đổi. Chỉ nạp skill áp dụng; không nạp toàn bộ roles hay rules coordinator cho worker.
- Spec dùng paths/links thay vì paste tài liệu; summary khoảng 3 câu, evidence dài để ở artifact an toàn.
- Chạy checks theo tác động và reuse evidence còn hợp lệ với SHA/input rõ ràng. Không chạy lại cùng suite theo từng role; không gọi local evidence là CI/live evidence.
- Khi thiếu tool MCP, dùng rg và đọc source có giới hạn; không bắt cài MCP để làm việc.
- Không dispatch task đang có owner, không chạy model đối chứng khi task không yêu cầu. Lifecycle vài lệnh và docs nhỏ làm inline.
- Token/cache unknown giữ unknown; không suy subscription quota, actual billing hoặc cost riêng task từ account delta.
