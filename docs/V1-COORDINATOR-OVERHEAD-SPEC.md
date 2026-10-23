# V1.4 — Chi phí điều phối của coordinator (Issue #47)

**Trạng thái:** đặc tả P1 để review; chưa cho phép triển khai. **Baseline:** `main` tại `3c19cd1a9c5fa5e77f6f2e39c71dafa101462322` (V1.1). V1.2 #45 và V1.3 #46 còn ở bản nháp/chưa merge; mọi phụ thuộc vào hai bản đó phải được đối chiếu lại sau merge, không giả định contract của chúng. MVP đã có independent PASS theo artifact `/tmp/orca-telemetry-resume/review-Live-Final-71ef95e.md`; tài liệu này không đổi Definition of Done của MVP.

**Role/owner đặc tả:** `product-ba`, `docs/agents/roles/product-ba.md`; Persona Kazu. **Architecture impact:** Có — thêm liên kết có provenance và phép tổng hợp theo Orca Run. **Cost tier:** standard. **Phạm vi thay đổi hiện tại:** chỉ file này.

## Mục đích và hành vi người dùng (AC1)

Một developer chọn **một Orca Run** đã thu thập, gắn tường minh các session CodeBurn với vai trò `coordinator` của Run hoặc `worker` của một Dispatch thuộc Run, rồi xem phần mức sử dụng dành cho điều phối. Run là phạm vi đo; Issue GitHub vẫn là nguồn chuẩn cho công việc và liên kết Issue↔session vẫn là thao tác riêng của MVP. Session chưa gắn vai trò ở trạng thái **chưa phân loại**, dù đã link Issue; vì không có khóa Orca↔CodeBurn chung, không thể đếm chắc có bao nhiêu session chưa phân loại thuộc Run. Session gắn vai trò nhưng chưa link Issue vẫn được tính vào Run; không âm thầm gán vào Issue từ Task title, `reference`, path, branch hay thời gian.

**Định nghĩa số liệu theo một Run R, trên snapshot CodeBurn mới nhất của mỗi `sessionKey`:**

- `coordinatorUsage`: tổng bốn bucket `input`, `output`, `cacheRead`, `cacheWrite` **theo provider** của các session có một liên kết `coordinator → R` đã xác minh thủ công. Codex `reasoning` chỉ hiển thị riêng nếu có giá trị per-session đã xác minh; `null` không thành 0. Không gộp token các provider thành một số “token” duy nhất.
- `workerUsage`: cùng cách tính cho các session có một liên kết `worker → dispatchId` mà Dispatch thuộc R. Mỗi Dispatch có thể có nhiều session; mỗi Run có nhiều Dispatch. Số session và số Dispatch riêng biệt phải hiện cạnh tổng, để người dùng thấy độ phủ.
- `coordinatorCostUsd` và `workerCostUsd`: tổng **ước tính tương đương API** (`cost.kind = estimated_api_equivalent`, `amountUsd` hữu hạn) theo hai vai trò. Đây không phải phí thuê bao, hóa đơn thực thu, hay chi phí thời gian vận hành Orca. `knownCostUsd` và `unknownCostSessionCount` luôn đi cùng nhau; thiếu cost là `unknown`, còn giá trị 0 được nguồn xác nhận mới là `$0.00`.
- `overheadShare`: `coordinatorCostUsd / (coordinatorCostUsd + workerCostUsd)` chỉ được xuất khi **mọi session đã phân loại trong Run có cost biết được**, tổng mẫu số > 0, lần collect Orca và CodeBurn gần nhất đều thành công trong 24 giờ trước thời điểm report, và không có session liên kết vai trò thiếu snapshot. Nếu không, trả `null` cùng lý do (`unknown_cost`, `zero_denominator`, `missing_snapshot`, `partial_source` hoặc `stale_source`; ưu tiên theo thứ tự vừa liệt kê khi nhiều lý do). Tỷ lệ này chỉ mô tả phần chi phí điều phối trong **tập session được gắn**, không chứng minh đã thu đủ mọi session của Run. Luôn hiển thị `classifiedSessionCount`, `coverage: unknown` và `unclassifiedSessionCount: null`; không gọi tỷ lệ là toàn bộ chi phí Run.
- `overheadPerWorkerCost` là phép chia tùy chọn `coordinatorCostUsd / workerCostUsd` với cùng điều kiện, thêm điều kiện `workerCostUsd > 0`. Không dùng tỷ lệ này làm chỉ số mặc định; tránh hiểu “overhead” là token lãng phí.

Một session chỉ thuộc **một vai trò trong một Run/Dispatch** ở một thời điểm; một `sessionKey` không thể đồng thời vào hai tập hoặc hai Run. Re-collect snapshot tích lũy là upsert, không cộng delta. Project/Issue report hiện tại vẫn tính distinct `sessionKey` theo `SessionLink`; phân vai Run không tạo thêm một lần tính vào tổng Issue/Project. Claude `subagents[]` là các session riêng theo `CLAUDE_SUBAGENT_POLICY`; không tự sao chép vai trò hay Issue link từ cha xuống con. Nếu operator muốn tính session con, cần xác nhận liên kết riêng. Cost/usage trong `report task` có thể giao với coordinator và worker; báo cáo V1.4 phân tách theo Run, không cộng nó vào tổng Issue như một khoản mới.

## Bằng chứng nguồn và giới hạn liên kết (AC2)

Baseline kiểm chứng trong `docs/discovery.md` (Orca 1.4.237, CodeBurn 0.9.27), `tests/fixtures/orca/`, `tests/fixtures/codeburn/` và parser hiện tại:

| Nguồn/lệnh JSON đã xác minh | Trường hữu ích | Điều xác nhận được / giới hạn |
| --- | --- | --- |
| `orca orchestration run-show --id <run_id> --json` | `result.run.id`, `coordinator_handle` | ID Run ổn định; fixture `coordinator_handle: null`, nên không coi handle là danh tính session. |
| `orca orchestration task-list --run <run_id> --brief --json` | `data.id`, `run_id`, `parent_id` | Liên hệ Task↔Run; `parent_id` là cây Task, **không** là session cha hoặc coordinator. |
| `orca orchestration dispatch-show --task <task_id> --json` | `result.dispatch.id`, `run_id`, `task_id`, `host_scope`, `creator_orca_session_id`, `creator_dispatch_id`, `retry_of_dispatch_id`, `assignee_orca_session_id`, `depth` | Liên hệ Dispatch↔Run/Task; creator có thể là Orca session của coordinator nhưng **không** là CodeBurn `sessionId`. Các trường creator/retry/assignee nullable; không suy ra vai trò usage từ đó. |
| `orca orchestration worker-list --run <run_id> --json` / `worker-show --dispatch <dispatch_id> --json` | `dispatchId`, `runId`, `taskId`, `agentTerminalHandle`, `worktreeId`, `projection.role`, `projection.parent`, `projection.provider` | Nhận diện worker Dispatch. `projection.provider.id` là sản phẩm agent (ví dụ `cursor`), `projection.parent` có thể null; không phải provider/session usage. `worker-show` có thể chứa preview/terminal data, collector chỉ allowlist metadata. |
| `orca status --json` | `caller.orcaSessionId`, `runtime.reachable` | Caller trong invocation hiện tại và readiness; không chứng minh caller là coordinator của mọi Run, cũng không nối được với CodeBurn. |
| `codeburn sessions --provider claude|codex --period all --format json --no-pager` | `sessionId`, `provider`, bốn token bucket, `cost`, `isEstimated`, `subagents[]` cho Claude | ID và snapshot tích lũy per-session; không có `runId`, `dispatchId`, Orca session ID hay role. `project`/thời gian không được dùng để đoán Run. Codex không có `reasoningTokens` per-session trong lệnh này. |

`orca orchestration ... --help` xác nhận các selector `--id`, `--task`, `--dispatch` và `--json`; `docs/discovery.md` ghi rõ allowlist chỉ đọc. Trước implementation cần chạy lại `--version`/`--help` trên môi trường dùng thật và khóa version, vì shape CLI có thể đổi. **Khoảng trống chặn tự động hóa:** chưa có khóa chung Orca↔CodeBurn trong JSON đã xác minh. Do đó V1.4 dùng operator xác nhận bằng `sessionKey` của CodeBurn và `runId`/`dispatchId` của Orca; không dùng fuzzy match thời gian, path, branch, title, model, `creator_orca_session_id`, hay `assignee_orca_session_id`. Nếu sau này xuất hiện ID chung đã kiểm chứng, thiết kế lại với evidence và review riêng.

## Luồng dữ liệu và đề xuất contract (AC3)

1. `collect` chỉ đọc metadata Orca và CodeBurn như MVP, giữ `Execution` theo `orca:<hostId>:<dispatchId>` và snapshot theo `<provider>:codeburn:<rawId>`. Mở rộng allowlist Orca để lưu quan hệ Run/Dispatch có kiểm tra và provenance nguồn; không lưu whole JSON, preview, prompt hay credential. Không cần tự đọc transcript.
2. Lệnh mới **đề xuất** `orca-telemetry link-role --run <run-id> --role coordinator --provider <claude|codex> --session <raw-session-id>` và `... --role worker --dispatch <dispatch-id> ...` ghi liên kết sau khi xác minh session đã tồn tại và Run/Dispatch thuộc dữ liệu Orca đã thu. Worker link chỉ nhận Dispatch duy nhất trong dữ liệu; nếu ID trùng giữa host, phải chọn `--host <host-id>` tường minh hoặc từ chối. Run được suy từ Dispatch đã xác minh ở nhánh worker; không nhận `--run` mâu thuẫn. Cho phép `unlink-role` tường minh để sửa sai, có audit provenance; không tái phân vai ngầm khi re-collect. Đây là **CLI đề xuất**, chưa có trong baseline.
3. Migration kế tiếp **đề xuất** bảng `orca_runs(run_id, observed_at, source_version, ...)`, `orca_dispatches(host_id, dispatch_id, run_id, task_id, retry_of_dispatch_id nullable, creator_dispatch_id nullable, observed_at, ...)`, `session_role_links(session_key PRIMARY KEY, role, run_id, host_id nullable, dispatch_id nullable, method='manual', linked_at, linked_by nullable, evidence_note nullable)`. FK/constraint bảo đảm `worker` có Dispatch trong Run, `coordinator` có Run và không có Dispatch; uniqueness theo `session_key` ngăn double count. Khóa Dispatch phải gồm host để tránh đụng ID giữa môi trường; migration cụ thể phải xem lại DB v1/v2 và thứ tự merge V1.2/V1.3. Chỉ lưu metadata allowlist và note ngắn đã sanitize, không lưu bằng chứng chứa dữ liệu riêng tư. `session_links` Issue hiện hữu không đổi.
4. Aggregate đọc trong một read transaction hiện có; nhóm distinct `sessionKey` theo role, kiểm tra snapshot, cost kind, freshness của `collection_logs`, rồi xuất `report overhead --run <run-id> [--format json]`. JSON có `runId`, `sourceStatus`, `coverage`, `coordinator`, `workers`, `overheadShare`, `overheadShareUnknownReason`; text hiển thị số biết được cùng số unknown. Không cộng raw token giữa Claude/Codex; các bucket giữ nhãn provider. Báo cáo không trả ratio khi lần collect gần nhất của một nguồn thất bại/không có hoặc quá 24 giờ. `success` chỉ xác nhận lệnh collect hoàn tất, không chứng minh đã phát hiện mọi session của Run.

**Phân định:** V1.4 hỗ trợ **chi phí coordinator vs worker đã liên kết thủ công theo Run**, kể cả nhiều worker và nhiều Dispatch. Không tuyên bố tính được chi phí retry lãng phí, dispatch trùng, hiệu suất worker, thời gian chờ, chi phí lương/thuê bao, hay phân bổ coordinator cho từng Issue. `retry_of_dispatch_id` chỉ là provenance để hiển thị/kiểm tra, không tự loại hoặc tự cộng thêm session. Các chủ đề này cần spec và evidence riêng dù cùng dòng P1 trong `BACKLOG.md`.

## Ma trận nghiệm thu và bằng chứng

| ID | Tình huống và kết quả bắt buộc | Fixture/check xác định | Live evidence cần có |
| --- | --- | --- | --- |
| V14-01 | Một Run, một coordinator, hai worker thuộc hai Dispatch: đúng tổng theo provider, cost, `overheadShare`, số session/Dispatch. | SQLite fixture + CLI JSON/text golden; phép tính tay độc lập. | Run thật + ba session CodeBurn được operator xác nhận; lưu IDs đã redact và lệnh/check, không lộ transcript. |
| V14-02 | Thiếu `coordinator_handle`, `creator_*`, `projection.parent` hoặc worker chưa có Dispatch/session: `unknown`/unclassified, không tự link; liên kết worker sai Run bị từ chối. | Fixture null/partial Orca, command error; DB không đổi khi lỗi. | Mẫu Orca live có nullable field (nếu có); nếu không có, ghi gap. |
| V14-03 | Cùng session link hai vai trò/Run hoặc collect lặp: conflict có thông tin sửa, một snapshot và một lần tính; Claude parent/subagent tách riêng. | Constraint + upsert + fixture subagent; re-collect hai lần. | Thu lại cùng session thật, so tổng và row count trước/sau. |
| V14-04 | Multi-worker, retry chain, overlapping session timestamps: chỉ cộng các `sessionKey` được link duy nhất; retry metadata không tạo chi phí “waste” và timestamp không tạo link. | Fixture Run có 3+ Dispatch, `retry_of_dispatch_id`, cùng khoảng thời gian. | Nếu live không có retry/overlap, ghi fixture-only. |
| V14-05 | Cost 0 biết được khác `null`; thiếu cost, thiếu snapshot, source failed/partial/stale → số biết được + unknown count, ratio `null` với reason. | Fixture đầy đủ trạng thái; test mốc 24 giờ bằng clock cố định. | Thử nguồn không khả dụng trong môi trường kiểm soát; không phá dữ liệu thật. |
| V14-06 | Nhiều session/Dispatch và nhiều Run, dữ liệu lớn: đúng dedup, không N+1 CLI/SQL, phân trang/limit đã xác minh, không retry AI tốn phí. | Fixture ít nhất 1.000 session / 100 Dispatch, benchmark có ngưỡng thời gian và số query được chốt trước code. | Chạy đọc một Run thật với thời gian/row count; không tuyên bố đạt tải production từ fixture. |
| V14-07 | Issue-link độc lập role-link; không tự quy Issue, Project totals không đổi khi chỉ thêm role link; reporter read-only. | So sánh report task/project trước/sau trên cùng DB; kiểm no writes/no repo edits. | Kiểm một Issue-link thật nếu có quyền; ghi rõ không có nếu thiếu dữ liệu. |

**Gate nghiệm thu:** test fixture không thay bằng live evidence. Khi không có session coordinator thật có thể đối chiếu với CodeBurn, V1.4 chỉ được đánh dấu code complete/fixture verified, **chưa acceptance complete**. Independent reviewer khác tác giả đánh giá exact SHA, từng AC, source evidence, schema/trust boundary, privacy và limitations; self-check không phải independent PASS. Báo cáo partial phải nói rõ nguồn nào thất bại và thời điểm snapshot.

## Lát cắt, phụ thuộc và ownership (AC4)

| Slice | Đầu ra dự kiến / owner | Paths dự kiến và checks |
| --- | --- | --- |
| 0. Chốt spec | `product-ba` + coordinator/reviewer | Review ngưỡng stale 24 giờ và chính sách `coverage: unknown`, chốt evidence liên kết live; xác nhận các spec V1.2/#45, V1.3/#46 đã merge hay chưa. **Không code trước gate này.** |
| 1. Orca provenance | Coordinator giữ contracts/integration; worker collector chỉ paths được giao | `src/orca/*`, `src/contracts.ts`, `src/db/migrations/*`, `src/db/repository.ts`; fixture Orca nullable/multi-dispatch, test parser/DB. Kiểm help/version thực tế trước khi mở rộng parser. |
| 2. Role link | Coordinator giữ CLI/DB contract; worker attribution chỉ paths được giao | `src/commands/*`, `src/db/*`, `src/attribution/*`; kiểm FK, conflict, unlink audit, không suy Issue, re-collect idempotent. |
| 3. Report + live | Reporter owner theo Task Spec, coordinator tích hợp | `src/reports/*`, `tests/*`, docs CLI; golden JSON/text, matrix trên, live Run/CodeBurn evidence và limitations. Conventional commit sau mỗi slice đã kiểm chứng, review độc lập exact SHA trước claim acceptance. |

**Dependencies thực:** MVP `collect`, `link`, SQLite và report hiện hữu trên `main`; Orca runtime reachable, CLI JSON/version đã xác minh, CodeBurn session rows, một Run/Dispatch thật và operator có thể nhận diện session coordinator/worker. Không phụ thuộc API chưa merge của V1.2/V1.3. Nếu Run không có session coordinator nhận diện được, vẫn có thể phát hành report trung thực với `unknown` nhưng không thể hoàn tất live AC V14-01.

**Non-goals:** tự động mapping Orca↔CodeBurn hoặc Issue, hook/daemon, GitHub Project writeback, chỉnh agent config/repository đích, server/frontend, phí billing thực, ước lượng waste/retry từ thời lượng, phân bổ coordinator cost cho Issue/Epic. CLI `collect` vẫn explicit và đọc nguồn ngoài ở chế độ read-only. Không sửa runtime, lockfile, GitHub/Project hay agent config trong slice đặc tả này.

## Quyết định còn mở trước implementation

1. **Completeness:** hiện không có cách xác nhận CodeBurn/Orca đã phát hiện đủ mọi session của Run; owner coordinator + product-ba. Chính sách V1.4 là `coverage: unknown` dù hai lần collect thành công; thay đổi điều này cần nguồn/AC mới.
2. **Liên kết live:** cách operator chứng minh một CodeBurn `sessionId` thật là coordinator/worker của Run/Dispatch mà không dùng timestamp/path suy diễn; owner coordinator/collector. Nếu không có bằng chứng đối chiếu, giữ manual provenance và gap live.
3. **Schema merge:** version migration kế tiếp và tương tác V1.2/V1.3 sau merge; owner coordinator giữ lockfile/contracts/DB.
4. **Volume gate:** ngưỡng thời gian/query cho fixture 1.000 session và giới hạn Orca pagination; owner coordinator + reporter, chốt trước code.

## Nguồn kiểm tra

- [Issue #47](https://github.com/hangndat/orca-task-telemetry/issues/47), [MVP](MVP-SPEC.md), [kiến trúc](ARCHITECTURE.md), [discovery](discovery.md), [backlog](../BACKLOG.md).
- Contract hiện tại: `src/contracts.ts`, `src/orca/workers.ts`, `src/orca/normalize.ts`, `src/codeburn/claude.ts`, `src/codeburn/codex.ts`, `src/db/migrations/v1.ts`, `src/db/migrations/v2.ts`, `src/attribution/aggregate.ts`, `src/reports/tasks.ts`, `src/reports/unmapped.ts` trên baseline SHA ở đầu tài liệu.
