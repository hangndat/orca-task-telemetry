# ADR 0001 — agent-top thay CodeBurn làm usage source of truth

- **Trạng thái:** Accepted
- **Ngày:** 2026-10-27
- **Phiên bản đã verify:** `agent-top` **0.27.1**

## Quyết định

Collector mức sử dụng MVP đọc **agent-top**, không đọc CodeBurn.

User story (Issue ↔ session thủ công, token + chi phí API ước tính, không sửa repo đích) giữ nguyên. `MVP-05` đổi SoT: giao diện JSON đã verify của agent-top, không còn `codeburn sessions`.

## Vì sao

- CodeBurn không có trên máy phát triển; agent-top 0.27.1 đã có `sql --json` (read-only) và hàng `counted_sessions` cumulative.
- Session identity ổn định: `(harness, session_id)` với `harness ∈ {claude, codex, cursor}`.
- Snapshot là tổng tại thời điểm store — upsert, không cộng dồn mỗi `collect`.

## Hợp đồng (không bịa field)

Chỉ đọc các cột đã thấy trên `counted_sessions` / `--schema`:

`harness`, `session_id`, `model`, `project`, `input`, `output`, `cache_read`, `cache_write_5m`, `cache_write_1h`, `cache_write_unsplit`, `cost_usd`, `unpriced_tokens`, `parent_session_id`.

- Lệnh collector: `agent-top --version` và `agent-top sql --json <SELECT allowlist>`.
- **Không** gọi `agent-top sync` (ghi store của tool khác).
- **Không** đọc `agent-top.db` trực tiếp, không parse transcript, không lấy `source_path`/`cwd` đầy đủ vào SQLite OTT.
- Allowlist harness: `claude`, `codex`, `cursor`. Harness khác vẫn bỏ.
- Mỗi hàng = một session (`sessionKey = provider:agent-top:session_id`). `parent_session_id` không gộp token vào parent.
- `cacheWrite` (hợp đồng báo cáo nội bộ) = `cache_write_5m + cache_write_1h + cache_write_unsplit` — tổng bucket **agent-top**, không phải field CodeBurn.
- `unpriced_tokens > 0` hoặc `cost_usd` absent → `cost.kind = unknown` (`unknown` ≠ `$0`).
- **Cursor tokens=0:** vẫn import; `cost.kind = unknown` và `tokenAllocation = unknown` (không coi `$0` / zeros là measured free usage).
- Pin đúng `0.27.1`; lệch version → nguồn unavailable / doctor warn.

## Tương thích

Identity CodeBurn (`*:codeburn:*`) **không** chuyển sang agent-top. Schema v4 siết CHECK `source = 'agent-top'` và xóa snapshot/link usage cũ. Phải `collect` lại rồi `link` lại.

## Hệ quả

- `USAGE_SOURCES = ['agent-top']`; env `ORCA_TELEMETRY_AGENT_TOP`.
- Fixture/live CodeBurn không còn là bằng chứng collector.
- Independent re-review T41 trên SHA CodeBurn **không** kế thừa.

## Addendum — Cursor provider plumbing (2026-10-27)

- Live `agent-top 0.27.1`: `SELECT … WHERE harness='cursor'` → **0 rows**; README: cursor-agent = process table only / tokens not yet.
- OTT vẫn thêm `cursor` vào `USAGE_PROVIDERS`, SQL allowlist, schema v7 CHECK, và `sessionKey` `cursor:agent-top:<id>` để sẵn sàng khi agent-top có hàng.
- Không parse Cursor/Composer local store ngoài agent-top (không có documented JSON SoT trong discovery).
- Schema migration v7 nới CHECK `provider` / `collection_attempts.provider` thêm `'cursor'`.
