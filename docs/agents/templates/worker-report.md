# Worker report

<Tối đa ba câu: thay đổi trong scope, kết quả checks, phần thiếu và bước tiếp theo.>

- Task / dispatch: <IDs thật hoặc local-only>
- Base → head: <full SHA>; working tree: <sạch/dirty>
- Paths: <paths thay đổi>
- Code complete: <Có/Không>; acceptance complete: <Có/Không>; MVP DoD: <chưa đánh giá hoặc evidence đầy đủ>

| Check | SHA / input | Kết quả | Evidence / loại |
| --- | --- | --- | --- |
| <command + cwd> | <SHA hoặc dirty input> | <PASS/FAIL/chưa chạy/bị chặn> | <path; local/CI/fixture/live> |

- Findings: <ID ổn định, đã sửa/đợi xác minh; không có thì ghi Không>
- Limitations: <gates thiếu, unknown và owner>
- Checkpoint: <fix n/2, quyết định đã chốt, bước tiếp>
- Worker done không chứng minh independent review, merge hay MVP hoàn thành.
