# V1.1 — Roll-up chi phí theo sub-issue (#44)

MVP đã đạt DoD tại `71ef95e3dbee70d994b542c2c8c18be3ccc46814`. Story [#44](https://github.com/hangndat/orca-task-telemetry/issues/44) dùng quan hệ `Issue.parent` của GitHub làm nguồn chuẩn; tiêu đề, số Issue, branch và thời gian không tạo cạnh cha-con.

## Tiêu chí nghiệm thu

1. `collect` đọc `parent.id` cho từng Issue trong Project. `null` xóa quan hệ cũ; lỗi JSON/ID không hợp lệ làm GitHub source fail trước khi import. Việc `link` chỉ biết Issue identity không xóa parent đã thu thập.
2. Migration schema v1 → v2 giữ nguyên Issue, membership, session, link và snapshot. Thu thập lại cùng dữ liệu không nhân bản; membership của Project được thay bằng snapshot mới, kể cả Project rỗng.
3. `report hierarchy` chỉ dùng Issue thuộc Project hiện chọn. Mỗi node có cost trực tiếp và lũy kế; số session/cost unknown giữ nguyên. Một session chỉ tính một lần trên đường từ Task lên Story/Epic. Parent ngoài Project tạo root có `outsideProjectParentIssueNodeId`, không kéo usage ngoài Project vào.
4. Chu trình trong dữ liệu cục bộ bị từ chối rõ ràng. Tổng lũy kế các root bằng tổng Project; unmapped không được cộng. Báo cáo JSON và text chỉ đọc DB, không viết GitHub hay repository đích.
5. Test fixture bao phủ ba cấp, nhiều Project, unknown cost, parent đổi/xóa, import lặp, migration v1, cycle và CLI. Live probe dùng GitHub read-only để xác nhận `parent` thật; phân biệt bằng chứng live và fixture.

## Task slices

| Task | Paths chính | Check |
| --- | --- | --- |
| V1.1-A — Parent + storage | `src/contracts.ts`, `src/github/items.ts`, `src/db/`, `src/commands/collect.ts`, fixtures/tests liên quan | `pnpm test` |
| V1.1-B — Roll-up + CLI | `src/reports/`, `src/commands/{report,router,help}.ts`, tests | `pnpm test`, `pnpm test:pack` |
| V1.1-C — Tài liệu + live evidence | `README.md`, docs, local evidence | independent Codex review exact SHA |

Architecture impact: **Có** — thêm parent relation trong SQLite v2 và báo cáo Project hierarchy. Root coordinator giữ contracts/schema/integration. Ngoài phạm vi: ghi ngược GitHub, tự liên kết session, dùng dependency `blocked by`, tính phí billing, mở rộng ngoài Project.
