# CodeBurn — Codex session fixtures

## Nguồn

| Mục | Giá trị |
| --- | --- |
| Package | `codeburn` **0.9.27** (cùng T03) |
| Cài | `npx --yes codeburn@0.9.27 …` |
| Thu ngày | 2026-10-23 (live worker T04) |
| Lệnh thu | `npx --yes codeburn@0.9.27 sessions --provider codex --period all --format json --no-pager`; export: `export -f json --provider codex --from 2026-10-17 --to 2026-10-17` |

## File

| File | Mô tả |
| --- | --- |
| `session-gpt-small-aggregated.json` | Một row `sessions --format json` (session ngắn) |
| `export-v2-session-row.json` | Một dòng `sessions[]` trong `codeburn.export.v2` |

## Quy tắc redact (giống T03)

| Gốc | Placeholder |
| --- | --- |
| `project` slug (`Users-admin-…`) | `<PROJECT_SLUG>` |
| `Project` đường dẫn tuyệt đối | `<PROJECT_ABSOLUTE_PATH_REDACTED>` |
| `sessionId` | `01a10000-bbbb-4ccc-8ddd-eeeeeeeeee01` (giữ prefix `01a1` minh họa định dạng Codex) |

Không prompt, email, path home thật, credential.

## Đối chiếu token (AC3)

Session live (trước redact ID): `01a14780-fa01-7e01-9f2f-3e890a32da65`.

```sh
npx --yes codeburn@0.9.27 sessions --provider codex --period all --format json --no-pager \
  | jq '.[] | select(.sessionId=="01a14780-fa01-7e01-9f2f-3e890a32da65") | {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, calls, turns}'
```

Live 2026-10-23: `inputTokens=51600`, `outputTokens=2040`, `cacheReadTokens=661504`, `cacheWriteTokens=0`, `cost≈0.190`, `calls=14`, `turns=1` — khớp `session-gpt-small-aggregated.json`.

Tổng bốn bucket: **715 144** (= 51600 + 2040 + 661504 + 0).

Export cùng ngày: `Cost (USD)=0.19` vs `cost=0.1897504…` trong `sessions`.

## grep

```sh
rg -i 'hangndat|@gmail|SideProject|ticket-solution|/Users/admin|prompt|sk-|Bearer' tests/fixtures/codeburn/codex/ || true
```
