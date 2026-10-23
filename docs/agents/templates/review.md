# Review spec và báo cáo

Coordinator điền spec ngắn rồi gửi riêng spec + paths/evidence; reviewer không phải đọc template trống.

```text
Review only: <Task/Issue/PR, paths>; mode <initial|revalidate>.
Base → head: <full SHAs>; prior review SHA/report: <nếu có>.
Role/file + persona: <dod|sec|dod+sec>; session khác implementer: <IDs>.
Architecture impact: <Có|Không>; AC/decisions: <IDs + links>.
Checks/evidence: <commands, SHA/input, local/CI/fixture/live, limitations>.
Revalidate: <findings mở, diff/vùng regression>; fix <n/2>.
Output: <artifact được giao hoặc comment chỉ khi task authorize>.
Không sửa source; gửi worker_done theo preamble thật nếu là Orca worker.
```

Reviewer ghi ≤3 câu tóm tắt, exact SHA, scope và verdict từng gate. Checks phân biệt đã chạy, reuse, chưa chạy, blocked; không coi fixture như live integration.

| ID / loại | Mức độ / chặn + lý do | AC, path:dòng / bằng chứng | Điều kiện đóng / trạng thái / SHA |
| --- | --- | --- | --- |
| F01 | <blocker/should-fix/nit; Có/Không> | <expected/actual, tái hiện/source> | <check; mới/mở/đã xác minh> |

Không tạo finding nếu không có. Ghi limitations, owner và bước tiếp; không PASS khi thiếu independence, exact SHA hoặc acceptance bắt buộc. Findings đóng chỉ cite ID/report trước. Đọc review-convergence khi review/fix.
