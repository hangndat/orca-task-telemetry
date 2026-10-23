# Task Spec

Điền trước dispatch, xóa placeholder không áp dụng; dẫn path thay vì paste toàn bộ docs.

- Task / Issue / PR: <ID thật hoặc local-only>
- Kết quả: <hành vi cần đạt; MVP capability liên quan>
- Owner / paths được sửa: <một scope rõ>
- Ngoài phạm vi: <paths/features/quyền không được đổi>
- Base SHA: <full SHA>; review head: <exact SHA khi có>
- Architecture impact: Có | Không — <lý do, contract/handoff>
- Role ID / file: <docs/agents/roles/...>
- Persona / display-name / task-title: <persona · label — task tóm tắt tiếng Việt>
- Agent / model / effort / Cost tier: <cheap|standard; verify host trước spawn>
- Skills cần nạp: <tên + mục đích hoặc Không>
- Inputs / dependencies: <sections/contracts/artifacts thật>

| AC | Hành vi quan sát được | Check / evidence |
| --- | --- | --- |
| AC1 | <kỳ vọng> | <lệnh, cwd, fixture/live, môi trường> |
| AC2 | <lỗi/edge case> | <cách xác minh> |

- Read-only boundaries: <GitHub/Orca/target repos; không external mutation>
- Fix: <0|1|2 / 2>; findings đang mở: <IDs hoặc Không>
- Điểm dừng: <thiếu contract/quyền/evidence; checkpoint coordinator>
- Bàn giao: SHA, checks, limitations theo worker-report; worker_done theo preamble thật nếu là Orca worker. Không paste raw prompts/tokens credentials/log thật.
