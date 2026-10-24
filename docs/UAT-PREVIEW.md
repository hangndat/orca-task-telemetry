# UAT preview: overhead không cần DB

`preview overhead` cho phép UAT live khi AC3 (định danh endpoint Orca bền vững) chưa có, nên `collect --run` còn bị chặn bởi `orca_source_host_unverified`. Lệnh chỉ đọc, chỉ giữ dữ liệu trong bộ nhớ, **không mở/ghi telemetry SQLite**, không ghi target repo, GitHub Project hay agent config. Đây không phải bằng chứng AC3 và không thay `report overhead`.

```
orca-telemetry preview overhead --run <run-id> --roles <roles.json> [--json]
```

Nguồn: `collectOrcaRunProvenance` (Orca allowlist read-only, 1.4.237) và `codeburn sessions --format json` (0.9.27, chỉ provider có trong roles file; dùng `ORCA_TELEMETRY_CODEBURN` nếu cần). Host luôn là nhãn `local` với `hostIdentity: unverified_endpoint`.

## Roles file (schemaVersion 1)

```json
{"schemaVersion":1,"runId":"<exact --run>","entries":[
  {"role":"coordinator","provider":"claude","sessionId":"<raw CodeBurn session id>"},
  {"role":"worker","provider":"codex","sessionId":"<raw id>","dispatchId":"ctx_..."}
]}
```

- Tối đa 256 KiB, 200 entries, ID 1–256 ký tự không có ký tự điều khiển; khóa lạ bị từ chối. `runId` bắt buộc khớp chính xác `--run` cho cả coordinator và worker, nếu không → `preview_roles_run_mismatch`. `worker` bắt buộc `dispatchId`, `coordinator` không được có.
- Mỗi `(provider, sessionId)` chỉ xuất hiện một lần; lặp/xung đột → `preview_roles_duplicate`. Khớp session là **exact** theo `sessionId` CodeBurn; không suy luận theo thời gian/path/title/Issue. Mapping chỉ do operator cung cấp, chưa chứng minh role ownership (`verification: operator_supplied_unverified`).
- `dispatchId` phải thuộc Run đã được Orca xác minh, nếu không → `preview_dispatch_not_in_run` (fail closed). Run không xác minh được → `preview_run_unverified`.

## Kết quả

- `status`: `preview` khi Orca đầy đủ, mọi session resolved; ngược lại `partial` (Orca incomplete/Dispatch của Task khác thiếu, CodeBurn lỗi, session không tìm thấy). Session resolved vẫn được tính, nhưng role ownership vẫn chưa xác minh.
- `coverage` luôn `unknown`; `runWideOverheadShare`/`runWideOverheadPerWorkerCost` luôn `null` (`coverage_unknown`). `selectedOverheadShare` chỉ mô tả các session đã chọn và là `null` khi thiếu role, cost unknown hoặc mẫu số 0.
- Token theo provider: `tokens` là `null` nếu còn session chưa resolved; `knownTokens` chỉ cộng các session resolved, không đại diện cho toàn bộ provider. Reasoning của Codex có thể `unknown`/null; Claude subagent là session riêng. Cost unknown giữ `null` + `unknownCostSessionCount`, không bị tính là 0.
- `entries[].entryIndex` là vị trí 0-based trong roles file. Raw `sessionId` chỉ là input để khớp trong bộ nhớ, không xuất hiện trong JSON/text/lỗi. Lỗi nguồn chỉ hiện dạng code (`orca.errors[]`, `codeburn.<provider>.errorCode`); không in session row, transcript, spec hay stderr.
