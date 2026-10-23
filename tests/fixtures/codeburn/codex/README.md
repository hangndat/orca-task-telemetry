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
| `project` slug (vd `Users-<user>-<repo-slug>`) | `<PROJECT_SLUG>` |
| `Project` đường dẫn tuyệt đối | `<PROJECT_ABSOLUTE_PATH_REDACTED>` |
| `sessionId` | `01a10000-bbbb-4ccc-8ddd-eeeeeeeeee01` (giữ prefix `01a1` minh họa định dạng Codex) |

Không prompt, email, path home thật, credential.

## Đối chiếu token (AC3)

**Tiêu chí chọn session:** `provider=codex`, `models` gồm `GPT-6.1 Sol`, `calls=14`, `turns=1`, bốn bucket khớp `session-gpt-small-aggregated.json` (`inputTokens=51600`, `outputTokens=2040`, `cacheReadTokens=661504`, `cacheWriteTokens=0`). Ngày trong fixture: `2026-10-17`.

```sh
FIXTURE=tests/fixtures/codeburn/codex/session-gpt-small-aggregated.json
npx --yes codeburn@0.9.27 sessions --provider codex --period all --format json --no-pager \
  | jq --slurpfile exp "$FIXTURE" '
      .[] | select(
        .inputTokens==$exp[0].inputTokens
        and .outputTokens==$exp[0].outputTokens
        and .cacheReadTokens==$exp[0].cacheReadTokens
        and .cacheWriteTokens==$exp[0].cacheWriteTokens
        and .calls==$exp[0].calls
        and .turns==$exp[0].turns
      ) | {sessionId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, calls, turns}'
```

Khớp fixture khi các bucket và `calls`/`turns` trùng; `sessionId` chỉ in local.

Tổng bốn bucket: **715 144** (= 51600 + 2040 + 661504 + 0).

Export cùng ngày: `Cost (USD)=0.19` vs `cost=0.1897504…` trong `sessions`.

## grep

```sh
rg -i 'hangndat|@gmail|SideProject|ticket-solution|prompt|sk-|Bearer' tests/fixtures/codeburn/codex/ || true
# Không có đường dẫn home tuyệt đối trong JSON/README — kiểm tay hoặc rg tùy biến trên máy review.
```
