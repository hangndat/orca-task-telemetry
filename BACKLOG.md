# Backlog trì hoãn — NGOÀI MVP

Chỉ triển khai sau khi đáp ứng các tiêu chí nghiệm thu MVP.

## P1 — Các tính năng hữu ích cho bản phát hành tiếp theo

- Tổng hợp đầy đủ chi phí theo Epic → Story → Task.
- Ghi ngược vào custom field của GitHub Projects V2 khi người dùng chủ động bật, có chế độ dry-run.
- Đối chiếu trạng thái PR/commit/test đã được xác minh.
- Tự động đối chiếu session khi có độ tin cậy cao; yêu cầu phê duyệt tường minh với các trường hợp mơ hồ.
- Phân tích chi phí phụ trội của coordinator, retry, dispatch trùng lặp và lãng phí token.
- Cảnh báo ngân sách ở cấp Task/Story/Epic.
- Tích hợp tùy chọn với hướng dẫn agent (AGENTS.md / CLAUDE.md), không ghi đè.
- Phân tích token cache chuyên sâu hơn và xu hướng lịch sử.

## P2 — Mở rộng sản phẩm ở quy mô lớn hơn

- MCP server, TUI phong phú hoặc dashboard web.
- Giám sát thời gian thực, tích hợp GitHub webhook và Actions.
- Lưu trữ đa người dùng/trên cloud, thu thập session agent qua SSH.
- Giới hạn ngân sách cứng hoặc chấm dứt agent (phải được người dùng chủ động bật một cách tường minh).
- Tối ưu hóa model bằng AI, OpenTelemetry/Prometheus/Grafana.
- Bổ sung provider (OpenCode, v.v.), phát hành lên npm và cung cấp SaaS được lưu trữ, vận hành sẵn.
