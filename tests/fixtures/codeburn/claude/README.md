# CodeBurn — Claude Code session fixtures

## Nguồn

| Mục | Giá trị |
| --- | --- |
| Package | [`codeburn`](https://www.npmjs.com/package/codeburn) **0.9.27** (`git+https://github.com/getagentseal/codeburn.git`) |
| Cài (ephemeral) | `npx --yes codeburn@0.9.27 …` — không cài global, không sửa shell profile |
| Thu ngày | 2026-10-23 (live trên máy worker T03) |
| Lệnh thu | `npx --yes codeburn@0.9.27 sessions --provider claude --period all --format json --no-pager` và `npx --yes codeburn@0.9.27 export -f json --provider claude --from 2026-09-29 --to 2026-09-29 -o <tmp>` |

## File

| File | Mô tả |
| --- | --- |
| `session-sonnet-aggregated.json` | Một phần tử từ `sessions --format json` (session nhỏ, không `subagents`) |
| `session-with-subagent-aggregated.json` | Session cha + **một** phần tử `subagents[]` (live có 81; fixture chỉ giữ 1 để minh họa shape) |
| `export-v2-session-row.json` | Một dòng từ mảng `sessions` trong export `schema: codeburn.export.v2` |

## Quy tắc làm sạch (AC4)

| Dữ liệu gốc | Thay bằng |
| --- | --- |
| `project` (slug `-Users-…`) | `<PROJECT_SLUG>` |
| Đường dẫn tuyệt đối trong export (`Project`) | `<PROJECT_ABSOLUTE_PATH_REDACTED>` |
| `sessionId` UUID / `agent-…` | `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeee01` / `agent-0000000000000001` |
| `title`, nhánh git, PR, prompt, nội dung file | **Không** đưa vào fixture (`title` giữ `""`) |

Không ghi email, token API, hay tên repo/đường dẫn home thật vào fixture.

## Đối chiếu token (AC3)

**Tiêu chí chọn session trên máy review** (không lưu `sessionId` live trong repo): row Claude có `models` gồm `Sonnet 5`, `calls=16`, `turns=3`, và bốn bucket token khớp `session-sonnet-aggregated.json` (`inputTokens=32`, `outputTokens=4732`, `cacheReadTokens=1252461`, `cacheWriteTokens=48529`). Ngày bắt đầu trong fixture: `2026-09-29` (lọc thêm nếu nhiều candidate).

```sh
FIXTURE=tests/fixtures/codeburn/claude/session-sonnet-aggregated.json
npx --yes codeburn@0.9.27 sessions --provider claude --period all --format json --no-pager \
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

Khi tái hiện thành công, các trường token/`calls`/`turns` phải khớp fixture; `sessionId` in ra chỉ dùng cục bộ, không commit.

Tổng token theo nghĩa CodeBurn (cộng bốn bucket, không double-count): **1 304 754** (= 32 + 4732 + 1252461 + 48529).

Export cùng ngày (cost làm tròn 2 chữ số): `Cost (USD)=0.49` trong `export-v2-session-row.json` tương ứng `cost=0.491992…` từ `sessions`.

## Kiểm tra grep (local)

```sh
rg -i 'hangndat|@gmail|SideProject|prompt|sk-ant|Bearer' tests/fixtures/codeburn/claude/ || true
# Không có đường dẫn home tuyệt đối (macOS) trong JSON/README — kiểm tay hoặc rg tùy biến trên máy review.
```

Kỳ vọng: không match (hoặc chỉ chuỗi placeholder trong README bảng trên).
