# Hướng dẫn đóng góp dành cho coding agent

## Mục tiêu

Xây dựng `orca-task-telemetry` thành một CLI Node.js/TypeScript có thể tái sử dụng, chỉ cần cài đặt một lần, liên kết các mục công việc trong GitHub Projects V2 với metadata thực thi của Orca và mức sử dụng Claude Code, Codex do CodeBurn cung cấp.

## Đọc trước

- `docs/MVP-SPEC.md` — phạm vi giới hạn và Definition of Done.
- `docs/ARCHITECTURE.md` — ranh giới tích hợp và mô hình tin cậy.
- `BACKLOG.md` — các tính năng được xác định rõ là ngoài phạm vi MVP.

## Quy tắc kỹ thuật

- Xem GitHub Projects là nguồn dữ liệu chuẩn để quản lý công việc.
- Sử dụng TypeScript strict mode; chốt và kiểm tra phiên bản Node.js runtime tối thiểu.
- Chỉ duy trì một npm package (không có monorepo, server, frontend hay framework).
- Ưu tiên các giao diện CLI JSON đã được xác minh và có tài liệu; kiểm tra phiên bản và `--help` trước khi triển khai.
- Không tự đặt ra các trường dữ liệu của Orca, CodeBurn hoặc GitHub.
- Không ghi vào các repository đích hiện có, các trường của GitHub Project hoặc cấu hình agent trong giai đoạn MVP.
- Bảo toàn nguồn gốc session, ngữ nghĩa token của từng provider, các giá trị chưa biết và tính idempotent của snapshot mức sử dụng.
- Liên kết Issue ↔ session thủ công là đủ cho MVP. Không âm thầm tự quy các session chưa rõ thuộc về Issue nào.
- Tránh retry hoặc xử lý song song gây lãng phí token AI; không giao lại công việc đã có worker phụ trách.
- Bổ sung test và tạo conventional commit sau mỗi vertical slice đã được kiểm chứng.
- Phân biệt hành vi đã kiểm thử bằng fixture với bằng chứng tích hợp thực tế.
- Không tuyên bố một tính năng đã hoàn thành khi chưa đáp ứng các tiêu chí nghiệm thu.

## Agent setup và workflow

- Hướng dẫn chung: [docs/agents/README.md](docs/agents/README.md); Claude nhập cùng file này qua `CLAUDE.md`, Cursor đọc `.cursor/rules/`.
- Kế hoạch/trạng thái/báo cáo dùng tiếng Việt; giữ nguyên IDs/API/commands. Chỉ đọc thêm role/rules/skills áp dụng, không nạp toàn bộ roster hoặc đọc lại tài liệu chưa đổi trong cùng session.
- Coordinator giữ root tooling, lockfile, contracts và integration trừ khi giao paths rõ. Worker chỉ sửa scope trong Task Spec; không sửa chéo scope để pass build.
- Task Spec có AC/checks, paths/non-goals, `Architecture impact: Có|Không`, Role ID/file, Persona, `Cost tier: cheap|standard`, model đã verify và skills cần nạp. Mẫu tại `docs/agents/templates/`.
- Khi user giao leader/boss/orchestrator/coordinator: đọc `.cursor/rules/orca-leader-activation.mdc`. Task nhỏ làm inline; chỉ dispatch khi task authorize. Chỉ coordinator gốc dùng Orca với skill/guide đúng phiên bản; không dùng native Agent để spawn. Worker/reviewer không spawn con.
- Kiểm ownership/live workers trước dispatch; không tự mở backlog hoặc chạy model đối chứng. Model pin của project nguồn không phải live compatibility evidence của repo này.
- Review acceptance độc lập: reviewer khác session tác giả, exact SHA, scope/checks/evidence/limitations và verdict từng gate. Gộp DoD+security cùng SHA khi áp dụng. Self-check không được gọi là independent PASS.
- Review/fix đọc `.cursor/rules/orca-review-convergence.mdc`: stable finding IDs, tối đa hai lượt fix tự động xuyên session/SHA; checkpoint/chẩn đoán khi không tiến triển, không lặp vô hạn. Không dùng known gap bỏ gate bắt buộc.
- Git/PR theo `.cursor/rules/git-workflow.mdc`: conventional commit sau validate; remote push/PR/merge cần nằm trong quyền task. GitHub Project chỉ đọc trong MVP; không tự cập nhật fields/status.
- Code complete khác acceptance complete và MVP complete. Worker completion không thay review; phân biệt local/CI/fixture/live evidence.
- Đây là contributor setup của chính repo này; không implement tính năng cài/sửa agent config trong target repositories (vẫn thuộc BACKLOG).

## Thứ tự triển khai

1. Kiểm tra các công cụ cục bộ và ghi lại thông tin tương thích liên quan trong `docs/discovery.md`.
2. Hoàn thiện nền tảng package và kiểm thử cài đặt.
3. Triển khai bộ đọc GitHub Project/Issue và khởi tạo profile bằng `init`.
4. Triển khai collector Orca/CodeBurn và cơ chế lưu trữ bền vững.
5. Bổ sung ánh xạ session tường minh và tổng hợp mức sử dụng, chi phí theo Issue.
6. Bổ sung báo cáo Task/Project qua CLI, fixture và kiểm chứng tích hợp thực tế.

Không triển khai bất kỳ nội dung nào trong `BACKLOG.md` trước khi MVP đáp ứng Definition of Done.
