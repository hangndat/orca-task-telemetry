# Khảo sát khả năng tương thích

> Chờ phiên triển khai đầu tiên. Dự án chưa xác minh Orca, CodeBurn, schema GitHub Projects hoặc định dạng dữ liệu mức sử dụng của provider.

Với mỗi tích hợp, ghi lại:

- Phiên bản đã cài đặt và cú pháp lệnh (từ `--help`).
- Đầu ra mẫu đã loại bỏ thông tin nhạy cảm / nguồn gốc fixture.
- ID ổn định và các trường có thể nhận giá trị null.
- Scope xác thực và giới hạn khả năng hỗ trợ.
- Các khác biệt đã biết về schema/phiên bản.
- Chính xác những test đã chạy và bằng chứng kiểm chứng thực tế.

Không đưa thông tin xác thực thô, bản ghi prompt hoặc nội dung repository riêng tư vào tài liệu này.

## CodeBurn — Claude Code

### Cài đặt và phiên bản (AC1)

| Mục | Giá trị |
| --- | --- |
| Nguồn | npm [`codeburn@0.9.27`](https://www.npmjs.com/package/codeburn/v/0.9.27), repo [getagentseal/codeburn](https://github.com/getagentseal/codeburn) |
| Bin | `codeburn` (qua `npx --yes codeburn@0.9.27`) |
| Node | README package yêu cầu Node ≥ 22 |

**Lệnh xác minh (read-only, live 2026-10-23):**

```sh
npx --yes codeburn@0.9.27 --version
# → 0.9.27

npx --yes codeburn@0.9.27 --help
# → subcommands: export, sessions, doctor, audit, …

npx --yes codeburn@0.9.27 doctor --provider claude --json
# → providers[0].status "ok", candidatesFound > 0, parseVersion chuỗi parser Claude (không ghi đường dẫn home vào doc)
```

**Export JSON session / usage (lệnh chính cho MVP parser):**

```sh
# Per-session aggregates (khuyến nghị cho E05)
npx --yes codeburn@0.9.27 sessions --provider claude --period all --format json --no-pager

# Tùy chọn: phân đoạn theo ngày/category/branch (JSON object contributions.segments[])
npx --yes codeburn@0.9.27 sessions --provider claude --period all --format json --contributions --no-pager

# Báo cáo kỳ + bảng sessions (schema export v2, khóa human-readable)
npx --yes codeburn@0.9.27 export -f json --provider claude --from YYYY-MM-DD --to YYYY-MM-DD -o /tmp/codeburn-export.json
```

`export` in ra `schema: "codeburn.export.v2"`; `sessions --format json` in ra **mảng JSON** các object session (camelCase).

Fixture đã làm sạch: `tests/fixtures/codeburn/claude/` (README ghi nguồn, đối chiếu token, quy tắc redact).

### Trường `sessions --format json` (AC2)

Một row = **một session Claude Code**, số token **tích lũy toàn session** (sum qua các API call trong session), không phải từng message.

| Trường | Ý nghĩa | Nullable / ghi chú | Evidence |
| --- | --- | --- | --- |
| `sessionId` | ID session Claude Code (UUID) hoặc `agent-…` cho subagent | Không null | `session-sonnet-aggregated.json` |
| `title` | Tiêu đề session | Có thể `""` | fixture |
| `project` | Slug thư mục làm việc (dạng `-Users-…-repo`) | Không null; **redact** trong fixture | fixture → `<PROJECT_SLUG>` |
| `projectId` | Chỉ khi `--contributions` | Thường thiếu nếu không flag | gap nếu không bật flag |
| `provider` | `"claude"` | Không null | fixture |
| `models` | Tên hiển thị model (vd `Sonnet 5`) | Mảng, ≥1 khi có usage | fixture |
| `inputTokens` | Input tokens (non-cache) | Số nguyên ≥0 | fixture + live jq AC3 |
| `outputTokens` | Output tokens | Số nguyên ≥0 | fixture |
| `cacheReadTokens` | Cache read (từ raw `cacheReadInputTokens`) | Số nguyên ≥0 | `audit --format json` map |
| `cacheWriteTokens` | Cache creation (từ raw `cacheCreationInputTokens`) | Số nguyên ≥0 | audit |
| `calls` | Số API call | Số nguyên | fixture |
| `turns` | Số “edit turns” / turn Claude Code | Số nguyên | fixture |
| `cost` | Chi phí USD gán cho session | float; làm tròn khác trong export | fixture |
| `savingsUSD` | Tiết kiệm (model-savings) | 0 nếu không dùng | fixture |
| `estimatedCost` | Trường phụ | Live luôn `0` khi `isEstimated: false` | gap semantics |
| `isEstimated` | Cost có phải ước tính | Live quan sát: `false` cho mọi session | gap: chưa thấy `true` |
| `startedAt` / `endedAt` | ISO 8601 UTC | Không null khi session kết thúc | fixture |
| `durationMs` | `endedAt - startedAt` | ms | fixture |
| `subagents` | Mảng session con (cùng shape, `sessionId` `agent-…`) | **Nullable** — chỉ session cha | `session-with-subagent-aggregated.json` |

**Subagent:** CodeBurn gắn usage subagent vào mảng `subagents` trên session **cha**; mỗi phần tử là aggregate riêng (token/cost không cộng ngầm vào cha — cha có tổng riêng, live: cha `calls=6196` vs subagent `calls=33`). Parser E05 cần quyết định double-count khi roll-up Issue.

**`--contributions`:** `contributions` là object `{ "segments": [ … ] }`. Mỗi segment: `day`, `category`, `branch`, `prs`, `models`, `modelUsage`, token/cost **cho segment** (có thể thiếu cache buckets trong segment — chỉ thấy `inputTokens`/`outputTokens` trong sample). **Không** đưa `branch`/PR vào fixture; dùng flag khi cần phân rã theo ngày.

**Export v2 `sessions[]`:** khóa khác (`"Session ID"`, `"Cost (USD)"`, `model` API id vd `claude-sonnet-5`). Không có cache token trên row session. Evidence: `export-v2-session-row.json`.

### Chi phí: ước tính vs thực (AC5)

- CodeBurn **không** lấy hóa đơn Anthropic; `cost` = **ước tính local** từ bảng giá token (`codeburn audit --format json` → `rates.*CostPerToken`, `cost.recomputedTotalUSD` vs `attributedCostUSD`).
- README/help: `price-override`, `model-flat-rate`, `proxy-path` có thể đổi cách hiển thị; mặc định đọc log usage Claude Code local.
- `isEstimated` / `estimatedCost`: có trong schema session; trên máy thu mọi session `isEstimated: false`, `estimatedCost: 0` — **chưa xác minh** khi nào thành `true`.

### Gaps (AC5)

| Gap | Ghi chú |
| --- | --- |
| Per-message JSON export | Chỉ thấy aggregate session (+ optional `contributions.segments`); không có file JSON per message qua CLI đã thử |
| `isEstimated: true` | Chưa quan sát trên dữ liệu live |
| `estimatedCost` vs `cost` | Luôn 0 khi `isEstimated: false`; semantics khi true chưa có evidence |
| `projectId` | Chỉ xuất hiện với `--contributions`; chưa document giá trị mẫu trong fixture |
| Roll-up token cha + subagents | Quan sát cấu trúc lồng; quy tắc tổng hợp cho báo cáo Issue chưa do CodeBurn ghi — cần quyết định E05 |
| Codex / provider khác | Ngoài phạm vi T03 |

## CodeBurn — Codex

### Cài đặt và lệnh (AC1)

Cùng package **0.9.27** và `npx --yes codeburn@0.9.27` như mục Claude Code. Filter provider: `--provider codex` (có trong `sessions`, `export`, `audit`, `doctor --provider codex`).

```sh
npx --yes codeburn@0.9.27 doctor --provider codex --json
# → status "ok", candidatesFound > 0 (live: 86 sessions); không ghi probePaths/CODEX_HOME vào doc

npx --yes codeburn@0.9.27 sessions --provider codex --period all --format json --no-pager

npx --yes codeburn@0.9.27 export -f json --provider codex --from YYYY-MM-DD --to YYYY-MM-DD -o /tmp/codeburn-codex.json

npx --yes codeburn@0.9.27 audit --provider codex --from YYYY-MM-DD --to YYYY-MM-DD --format json
# → raw token fields + reasoningTokens (theo kỳ/model, không per-session trong output này)
```

Fixture: `tests/fixtures/codeburn/codex/`.

### Trường `sessions --format json` (AC2)

Cùng **shape camelCase** với Claude (`sessionId`, `inputTokens`, …). Một row = **tích lũy cả session Codex** (sum API calls).

| Trường | Ý nghĩa Codex | Nullable / ghi chú | Evidence |
| --- | --- | --- | --- |
| `sessionId` | ID session Codex (UUID chuỗi hex) | Không null | `session-gpt-small-aggregated.json` |
| `provider` | `"codex"` | Không null | fixture |
| `project` | Slug cwd (vd `Users-<user>-<repo-slug>`, **không** có `-` đầu như nhiều row Claude) | Redact fixture | fixture |
| `models` | Display name (vd `GPT-6.1 Sol`) | Mảng | fixture |
| `inputTokens` | Input billed bucket trong UI CodeBurn | Không gồm `cacheReadTokens` (bucket riêng) | fixture + audit `displayed` |
| `outputTokens` | Output tokens | | fixture |
| `cacheReadTokens` | Đọc cache (raw `cacheReadInputTokens`) | | fixture |
| `cacheWriteTokens` | Cache creation | Live quan sát **0** trên mọi session Codex thu | fixture |
| `calls` / `turns` | API calls / turns | | fixture |
| `cost` | USD ước tính local | `isEstimated: false` trên mẫu | fixture |
| `subagents` | — | **Không có** trên 86 session live (khác Claude) | live jq count 0 |

**Cached input vs input (AC2):** `codeburn audit --format json` cho Codex có `raw.cachedInputTokens` và `raw.cacheReadInputTokens` **cùng giá trị** trên mẫu; `displayed` chỉ tách `inputTokens` và `cacheReadTokens` (không trùng lặp số trong hai cột displayed). **Không** coi `cacheReadTokens` là tập con được cộng vào `inputTokens` trong `sessions` JSON.

**Reasoning tokens:** có trong `audit` → `raw.reasoningTokens`, **không** có field tương ứng trên object `sessions --format json` (gap cho parser chỉ đọc sessions).

### Session ID và namespace (AC4)

| | Claude Code | Codex |
| --- | --- | --- |
| Định dạng | UUID RFC (`8-4-4-4-12` hex) hoặc `agent-<hex>` cho subagent | UUID hex (`8-4-4-4-12`); mẫu live hay bắt đầu `01a1…` |
| Prefix namespace | `agent-` = subagent Claude | Không thấy prefix `agent-`; không có mảng `subagents` |
| Gợi ý E05 | Phân biệt cha/con qua `subagents[]` | Phân biệt qua `provider: "codex"` + pattern ID; không lồng subagent trong export đã thử |

### Chi phí

Giống Claude: **ước tính** từ bảng giá CodeBurn (`audit` → `rates`, `cost.recomputedTotalUSD`), không phải hóa đơn OpenAI. Codex có thêm `longContextTier` / `flex` trong `rates` (chỉ thấy trong `audit`, chưa map per-session).

### Gaps (AC5)

| Gap | Ghi chú |
| --- | --- |
| `reasoningTokens` per session | Chỉ thấy trong `audit` theo model/kỳ, không trong `sessions` JSON |
| `cacheWriteTokens` > 0 | Chưa quan sát trên Codex live |
| `subagents` / fork sessions | 0 session có `subagents`; fork/replay có trong parseVersion string — chưa có fixture |
| Per-message JSON | Giống Claude — chỉ aggregate (+ optional `--contributions`) |
| `isEstimated: true` | Chưa quan sát |
