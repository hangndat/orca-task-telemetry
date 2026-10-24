# Khảo sát khả năng tương thích

## V1.3 — GitHub PR/commit trace (2026-10-24 Asia/Manila)

- `gh --version`: **2.103.0** (build 2026-10-21). `gh api graphql --help` xác nhận endpoint GraphQL và `--input -`; adapter dùng client read-only hiện có. [GitHub GraphQL PullRequest](https://docs.github.com/en/graphql/reference/pulls) ghi `closingIssuesReferences` và `commits` là connection; [rate limit docs](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) ghi `rateLimit.remaining/resetAt` và giới hạn truy vấn. Không dùng `Commit.associatedPullRequests` để suy PR đang mở ([docs](https://docs.github.com/en/graphql/reference/commits)).
- **API nội bộ slice này:** `parsePullRef`, `resolvePullRequest`, `readPullTrace` ở `src/github/pull-trace.ts`. `readPullTrace` nhận URL đã parse hoặc `pullNodeId` (refresh sau rename/transfer), cùng `issueNodeIds`/full commit OIDs; trả `pull`, `observedAt`, `status`, tập node IDs/OIDs đã duyệt hết, relations theo target và `errorCode`. `pullNodeId` là khóa bền; URL/repository/number do GitHub trả là canonical. `status=verified_current` chỉ sau cả hai connection và lần đọc lại node cuối đều thành công; `headRefOid` được so trước/sau để phát hiện force push trong lúc phân trang. Target vắng sau lần đọc hoàn chỉnh có relation `stale`; lần đầu link phải diễn giải là unverified. `unknown` luôn có tập kết quả `null` và `lastVerifiedAt:null`; storage tương lai phải giữ thời điểm đã verify trước đó, không dùng null này để xóa audit. GitHub không cấp snapshot transaction cho nhiều query, nên thay đổi closing reference xảy ra đúng giữa các trang vẫn là giới hạn nhất quán.
- **GraphQL đặc điểm live:** Query chung `repository.pullRequest(number:)` và `repository.issue(number:)` cho một số PR trả `errors: NOT_FOUND` ở nhánh Issue dù PR có thật, làm client từ chối partial response. Adapter hỏi PR riêng; chỉ hỏi Issue riêng khi PR query không giải được để phân biệt sai loại. Không thể phân biệt chắc chắn 404, private permission và xóa; các trường hợp đó là `unknown`. Ref cũ sau transfer/rename chỉ hoạt động nếu GitHub vẫn giải được qua owner/repo cũ; refresh bằng node ID đã lưu là đường an toàn hơn, nhưng chưa thử transfer/rename live.
- **Live positive, chỉ trên repo public mẫu `cli/cli` (không phải Project telemetry):** `cli/cli#14796` trả PR node `PR_kwDODKw3uc8AAAABKNrOOQ`, `MERGED`, `isDraft=false`, `mergedAt=2026-10-23T10:09:35Z`. Issue #14256 có node `I_kwDODKw3uc8AAAABOH-b9A`; adapter `readPullTrace` trả `verified_current` cho closing reference và OID `a58710a33eecbc0646116c0fa396b0860b63034d` trong 2 commit sau khi duyệt hết trang, kiểm lại sau thay đổi `headRefOid` lúc 2026-10-23T20:23:07Z (UTC).
- **Live negative trên repo dự án:** PR #109 node `PR_kwDOVUhnY88AAAABKVjIDw` là `OPEN`, `isDraft=true`, `mergedAt=null`; Issue #46 node `I_kwDOVUhnY88AAAABZZGcqw` vắng trong `closingIssuesReferences` đã duyệt hết, 10 commit đã đọc hết. Adapter trả relation `stale` (ý nghĩa lần đầu: không đủ điều kiện link) lúc 2026-10-23T20:22:11Z UTC. Không coi PR #109 là positive Issue↔PR.
- **Fixture:** `tests/pull-trace.test.mjs` dùng stub GraphQL tổng hợp, không chứa token/prompt; kiểm canonical, phân trang, duplicate, cursor loop/cap, bad shape, partial GraphQL, 404/permission, PR-number-as-Issue. `pnpm test` chạy toàn suite. Chưa có live private/token-scope variant, rename/transfer, force push hoặc liên kết session/SQLite/report; slice storage/CLI và independent acceptance vẫn chờ.

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

## GitHub Projects V2

### Cài đặt và xác thực (AC1)

| Mục | Giá trị |
| --- | --- |
| CLI | **gh 2.103.0** (2026-10-21) |
| Account live | `hangndat` (active) |
| Token scopes quan sát (`gh auth status`) | `gist`, **`project`**, `read:org`, **`repo`**, `workflow` |
| Scope tài liệu GitHub cho đọc Projects V2 | **`read:project`** (đọc item/field) + **`repo`** khi Issue/PR thuộc **repository private** (project #4 `public: false`, repo private) |

**Lệnh xác minh (read-only, live 2026-10-23):**

```sh
gh --version
gh auth status
gh project view 4 --owner hangndat --format json
gh project list --owner hangndat --limit 5 --format json
gh api graphql -f query='…'   # xem query đầy đủ bên dưới
```

**Thiếu scope (không tái hiện bằng `gh auth refresh` trên worker — quan sát coordinator / lịch sử task):**

| Kênh | Hình dạng lỗi |
| --- | --- |
| GraphQL (`gh api graphql`) | `errors[].extensions.type` = **`INSUFFICIENT_SCOPES`**; `message` yêu cầu scope **`read:project`** |
| REST / `gh project list` | Thông báo thiếu **`read:project`**, gợi ý `gh auth refresh -s read:project` |

Trên token hiện tại, scope OAuth hiển thị là `project` (không phải chuỗi `read:project`); GraphQL/REST vẫn chấp nhận đọc project #4 sau khi user cấp scope project.

Fixture: `tests/fixtures/github/` (README: nguồn, redact, gaps).

### GraphQL — project và items (AC2)

**Project node ID** (user project #4): `PVT_kwHOAGoDWs4BoZ5m` — lấy từ `gh project view 4 --owner hangndat --format json` → field `id`, hoặc `user.projectsV2` / `repository.projectsV2`.

**1) Project của owner (`user.projectsV2`):**

```graphql
query {
  user(login: "hangndat") {
    projectsV2(first: 10) {
      nodes { id number title url }
    }
  }
}
```

(`viewer { projectsV2 … }` tương đương khi login `hangndat`.)

**2) Project liên kết repository (`repository.projectsV2`):**

```graphql
query {
  repository(owner: "hangndat", name: "orca-task-telemetry") {
    issueTypes(first: 10) { totalCount nodes { id name } }
    projectsV2(first: 10) {
      nodes { id number title }
    }
  }
}
```

Live: `issueTypes` = **`null`** (repo user-owned); `projectsV2.nodes` chứa project #4. Nếu query `issueTypes { id }` không có `first`/`last`, API trả lỗi `MISSING_PAGINATION_BOUNDARIES`.

**3) Items + field values + rate limit (query chính cho MVP-03):**

```graphql
query ProjectItems($id: ID!, $after: String) {
  rateLimit { cost remaining resetAt }
  node(id: $id) {
    ... on ProjectV2 {
      id
      number
      title
      items(first: 100, after: $after) {
        totalCount
        pageInfo {
          hasNextPage
          endCursor
          hasPreviousPage
          startCursor
        }
        nodes {
          id
          type
          content {
            __typename
            ... on Issue {
              id
              number
              title
              url
              state
              repository { nameWithOwner }
            }
            ... on PullRequest {
              number
              title
              url
              state
              repository { nameWithOwner }
            }
            ... on DraftIssue {
              title
              body
            }
          }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldTextValue {
                text
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldIterationValue {
                title
                startDate
                duration
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldRepositoryValue {
                repository { nameWithOwner }
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}
```

**Chạy (page 1):**

```sh
gh api graphql -f query=@query.graphql -f id='PVT_kwHOAGoDWs4BoZ5m'
```

**Chạy (page 2):** thêm `-f after='<endCursor từ pageInfo page 1>'`.

**Org project:** `organization(login:).projectsV2` — **chưa xác minh live** trên worker (chỉ user project #4).

### Phân trang (AC3)

Project #4: `items.totalCount` = **103**.

| Trang | `first` | `after` | `nodes` | `pageInfo.hasNextPage` | `pageInfo.endCursor` (live) |
| --- | --- | --- | --- | --- | --- |
| 1 | 100 | _(none)_ | 100 | `true` | `Y3Vyc29yOnYyOpKrMDAwMDAwMDAuMDHOEMED2Q==` |
| 2 | 100 | cursor trang 1 | 3 | `false` | `Y3Vyc29yOnYyOpK5MDAwMDAwMDAuMDA5NzA4NzM3ODY0MDc3Ns4QwQPn` |

- `hasPreviousPage` = `false` trang 1, `true` trang 2.
- Thứ tự `nodes[].id`: **ổn định** giữa hai query liên tiếp (so sánh 100 id, live 2026-10-23).
- Fixture: `project-items-page1.json` (rút 2 node, giữ `pageInfo`/`rateLimit`), `project-items-page2.json` (3 node đầy đủ).

### Rate limit (AC4)

Trong cùng query `ProjectItems`, field `rateLimit` trên response GraphQL (không cần header riêng):

| Lần gọi | `cost` | `remaining` (mẫu) | `resetAt` (mẫu) |
| --- | --- | --- | --- |
| Page 1 items | 1 | 4956 | `2026-10-23T15:33:22Z` |
| Page 2 items | 1 | 4884 | `2026-10-23T15:31:54Z` |

`cost` = **1** cho mỗi request items như trên; `remaining` giảm theo từng query.

### Nullable và khác biệt content (AC5)

| Trường / tình huống | Nullable / hành vi | Evidence |
| --- | --- | --- |
| `ProjectV2Item.type` | Enum string, live: `"ISSUE"` | `project-items-page1.json` |
| `content` union | `__typename` = `Issue` \| `PullRequest` \| `DraftIssue` | Issue: fixture; PR/Draft: **gap** (project #4 toàn Issue) |
| `Issue.number`, `url`, `repository` | Có trên Issue | fixture |
| `DraftIssue` | **Không** có `number` / `url` trong schema GraphQL (chỉ `title`, `body`) | GraphQL schema; **chưa có fixture** |
| `PullRequest` | Có `number`, `url`, `state`, `repository` | **gap** trên project #4 |
| `fieldValues` / `ProjectV2ItemFieldTextValue.text` | Có (vd field `Title`) | fixture |
| `ProjectV2ItemFieldSingleSelectValue.name` | Có (vd `Status`, `Priority`) | fixture |
| `ProjectV2ItemFieldNumberValue.number` | Có (vd `Wave`) | fixture |
| `ProjectV2ItemFieldRepositoryValue.repository` | Có khi query fragment `repository { nameWithOwner }` | fixture (sau bổ sung fragment) |
| `ProjectV2ItemFieldIterationValue` | Có trên project có iteration field | **gap** trên project #4 |
| `repository.issueTypes` | **`null`** (repo cá nhân) | live query 2026-10-23 |
| Issue đã xóa / repo không quyền | GitHub có thể trả nội dung redacted (`REDACTED` trong docs GitHub) | **gap** — chưa có item mẫu |

### Gaps tóm tắt

| Gap | Ghi chú |
| --- | --- |
| Fixture `PullRequest` / `DraftIssue` | Project #4 không chứa item loại này |
| `ProjectV2ItemFieldIterationValue` | Không xuất hiện trên 103 item live |
| `organization.projectsV2` | Chưa chạy live |
| `REDACTED` content | Chưa quan sát |
| `read:project` vs scope `project` trên token | Hiển thị OAuth khác message lỗi khi thiếu quyền |

## Orca CLI

### Cài đặt và phạm vi (AC1)

| Mục | Giá trị |
| --- | --- |
| Binary | `/Applications/Orca.app/Contents/Resources/bin/orca` |
| Phiên bản live | **1.4.237** (`orca --version`, `status --json` → `runtime.appVersion`) |
| Mục tiêu MVP | Metadata **chỉ-đọc** cho Run / Task / Dispatch / supervised worker / worktree / reference |

Fixture: `tests/fixtures/orca/` (README + JSON đã redact).

### Bảng lệnh — read vs mutate (theo `--help`, AC1)

| Lệnh | `--json` | Phân loại | Ghi chú collector |
| --- | --- | --- | --- |
| `orca --version` | — | read | Phiên bản CLI |
| `orca status` | có | read | App/runtime readiness; `caller.orcaSessionId` khi agent chạy trong Orca session |
| `orca agent-context` | có | read | Schema registry; **không cần app chạy** |
| `orca worktree list` | có | read | Liệt kê worktree Orca-managed (đa host) |
| `orca worktree show` | có | read | Chi tiết một worktree (`--worktree` selector) |
| `orca worktree current` | có | read | Worktree cho cwd hiện tại |
| `orca worktree ps` | có | read | Tóm tắt orchestration theo worktree |
| `orca worktree create` / `set` / `rm` | — | **mutate** | Không chạy |
| `orca repo list` | có | read | Repo đăng ký trong Orca |
| `orca repo show` | có | read | Metadata một repo |
| `orca repo add` / `set` / `set-base-ref` / `search-refs` | một số có `--json` | add/set = **mutate**; `search-refs` | **Chưa xác minh** `search-refs` — không chạy |
| `orca project list` | có | read | Durable projects |
| `orca project setups` / `setup-*` | — | **mutate** | Không chạy |
| `orca reference list` | có | read | Issue/PR gắn workspace |
| `orca reference find` | có | read | Tìm workspace theo URL issue (full `https://…`) |
| `orca reference add` / `remove` | — | **mutate** | Không chạy |
| `orca orchestration run-list` | có | read | Danh sách Run |
| `orca orchestration run-show` | có | read | `--id <run_id>` (không dùng positional) |
| `orca orchestration run-current` | có | read | Run gắn coordinator terminal |
| `orca orchestration task-list` | có | read | Cần `--run <run_id>` khi terminal không bind Run; `--brief` cắt spec |
| `orca orchestration worker-list` | có | read | Accounting terminal; filter `--run`, `--terminal-state` |
| `orca orchestration worker-show` | có | read | `--dispatch <dispatch_id>` |
| `orca orchestration dispatch-show` | có | read | `--task <task_id>`; **không** dùng `--preamble` trong collector (tránh spec đầy đủ) |
| `orca orchestration send` / `check` / `reply` / `ask` | — | **mutate** / mailbox | **Cấm** collector (kể cả `check`) |
| `orca orchestration worker-start` / `stop` / `abandon` / `release` / `retain` / `worker-read` | — | **mutate** / IO | Không chạy |
| `orca orchestration task-create` / `task-update` / `dispatch` | — | **mutate** | Không chạy |
| `orca orchestration run-create` / `run-use` / `reset` | — | **mutate** | Không chạy |
| `orca orchestration gate-list` | có | **chưa xác minh** | Help chỉ nói “List” — worker không chạy |
| `orca orchestration inbox` | có | **chưa xác minh** | Help “Show messages” — worker không chạy |

### JSON mẫu (AC2)

| Artifact | Fixture | Live lệnh |
| --- | --- | --- |
| Run supervised | `run-show.json` | `run-show --id run_1a060327fe49` |
| Task (spec cắt) | `task-supervised-brief.json` | `task-list --run run_1a060327fe49 --brief` |
| Dispatch settled | `dispatch-show.json`, `worker-show-settled.json` | `dispatch-show --task …`; `worker-show --dispatch ctx_005f2513ac06` |
| Worker accounting | `worker-list-snippet.json` | `worker-list --run run_1a060327fe49` |
| Worktree thủ công | `worktree-manual-show.json`, `worktree-manual-ps-row.json` | `worktree show` + `worktree ps` trên worktree `<OTHER_REPO>` (placeholder) |
| Reference / issue link | `reference-list-empty.json`, `reference-find-no-match.json` | Foundation chưa gắn reference; find #64 trả `matches: []` |
| Runtime | `status-trimmed.json`, `agent-context-snippets.json` | `status --json`; mẫu từ `agent-context --json` |

### ID ổn định và liên kết (AC3)

| ID / trường | Mẫu / format | Nullable | Liên kết |
| --- | --- | --- | --- |
| `run_id` / `runId` | `run_<hex>` | Không trên Run | Cha của tasks/dispatches |
| `task_id` / `taskId` | `task_<hex>` | Không trên Task | `dispatch-show`, `worker-show` |
| `dispatch_id` / `dispatchId` | `ctx_<hex>` | Không trên Dispatch | `worker-show`, `worker-list` |
| `agentTerminalHandle` / `assignee_handle` | `term_<uuid>` | Có khi chưa gán terminal | Cùng dispatch |
| `worktreeId` / `workspace.id` | `{repoId}::{absolutePath}` | — | `worker.resource.worktreeId` ↔ `terminal.worktreeId` |
| `repoId` | UUID | Không trên worktree row | Tiền tố của `worktreeId` |
| `hostId` / `executionHostId` | `local` (mẫu) | — | `hostScope.kind` |
| `runtimeId` | UUID trong `_meta` / `runtimeEpoch` | Có khi runtime unreachable | Phiên runtime Orca |
| `process_incarnation` / `processIncarnation` | `worktreeId@@…:incarnationUuid` | Có | Gắn terminal/process với worktree |
| `creator_orca_session_id` | `claude_<uuid>` (Orca coordinator session) | Có trên worker assignee | **Không** phải Claude Code/Codex usage `sessionId` |
| `projection.provider` | `{ id: "cursor", model: null }` hoặc `null` | Thường null khi settled | Provider IDE, không UUID session |
| `terminal.agentIdentity` | `"cursor"` | Có | Agent product, không session UUID |

**Provider session ID (Claude/Codex UUID):** trên các lệnh read-only đã chạy, **không** thấy field export Claude Code / Codex `sessionId`. `worker-show` settled: `projection.provider: null`, `setup.reason: agent_without_structured_session`. **Gap** cho MVP parser nếu cần map usage CodeBurn ↔ Orca dispatch.

### Runtime không khả dụng (AC4)

| Nguồn | Hành vi |
| --- | --- |
| `agent-context --help` | “Pure local read … **works without a running Orca app**” |
| `status --json` (live) | `app.running`, `runtime.reachable`, `runtime.state` (`ready` khi app mở) |
| `orchestration task-list` không bind Run | Lỗi `run_required` (“No Run is bound…”) — **không** tắt app để thử |

**Gap:** message/exit khi Orca desktop **tắt hẳn** chưa quan sát trên worker (theo task). Collector nên coi `status --json` + `runtime.reachable` là gate trước orchestration queries.

### Allowlist đề xuất cho collector (AC5 — T18)

Chỉ các argv sau (cùng binary `orca`, tùy chọn `--json`, `--pairing-code` / `--environment` khi cần remote):

1. `orca --version`
2. `orca status` `[--json]`
3. `orca agent-context` `[--json]`
4. `orca worktree list` `[--json]` `[--repo …]` `[--limit …]`
5. `orca worktree show --worktree <selector>` `[--json]`
6. `orca worktree current` `[--json]`
7. `orca worktree ps` `[--json]` `[--limit …]`
8. `orca repo list` `[--json]`
9. `orca repo show --repo <selector>` `[--json]`
10. `orca project list` `[--json]`
11. `orca reference list --worktree <selector>` `[--json]`
12. `orca reference find --query <https-url>` `[--json]` `[--worktree|--repo …]` `[--limit …]`
13. `orca orchestration run-list` `[--json]` `[--limit …]` `[--cursor …]`
14. `orca orchestration run-show --id <run_id>` `[--json]`
15. `orca orchestration run-current` `[--json]`
16. `orca orchestration task-list --run <run_id>` `[--json]` `[--brief]` `[--status …]`
17. `orca orchestration worker-list` `[--json]` `[--run <run_id>]` `[--terminal-state …]` `[--limit …]`
18. `orca orchestration worker-show --dispatch <dispatch_id>` `[--json]`
19. `orca orchestration dispatch-show --task <task_id>` `[--json]` (không `--preamble`)

**Cấm tuyệt đối:** mọi subcommand không có trong danh sách; đặc biệt `orchestration send|check|reply|ask`, `worker-start|stop|…`, `task-create|update`, `dispatch`, `run-create|run-use|reset`, `worktree create|set|rm`, `reference add|remove`, `repo add|set`, `gate-*`, `inbox`, `terminal *`, `agent launch`, v.v.

### Gaps (AC5)

| Gap | Ghi chú |
| --- | --- |
| Provider usage `sessionId` | Không có trong JSON read-only đã thử |
| `gate-list`, `inbox`, `repo search-refs` | Chưa phân loại/chạy |
| Runtime app stopped | Chưa quan sát lỗi cụ thể |
| `reference find` bare issue key | Help: cần full URL; `#64` shorthand không hợp lệ |
| Task `spec` đầy đủ | Chỉ qua `task-list` không `--brief` — tránh trong collector |

### V1.4 — kiểm tra lại provenance Run (Orca 1.4.237, 2026-10-24)

- `orca --version` trả `1.4.237`. Help thực tế xác nhận `run-show --id`, `task-list --run --brief`, `dispatch-show --task` (không `--preamble`) và `worker-list --run --limit <1-100> --cursor`; cả bốn hỗ trợ `--json`. `task-list` không công bố cursor.
- Live read trên Run `run_fc4dc513b317`: `run-show.result.run.id`; `task-list.result.tasks[]`, `count`, `spec_truncated: true` ở từng Task do `--brief`; `dispatch-show.result.dispatch` có `run_id`, `task_id`, `host_scope` JSON `hostId`; `worker-list` có `scope.run/source=flag`, `page.{limit,total,hasMore,nextCursor}`, `projection.host.id`. `--limit 2` trả `hasMore: true` và cursor. Không lưu nội dung `spec`, `result`, `objective`, preview, hash hoặc receipt trong adapter V1.4.
- `spec_truncated: true` chỉ cắt **nội dung spec**, không chứng minh danh sách Task bị cắt. Adapter yêu cầu `count === tasks.length`, không có marker truncation cấp danh sách; trường hợp thiếu count/marker bất thường là `partial`. Worker pagination bị chặn ở 100 trang và 10.000 rows; cursor lặp, trang lỗi, tổng số không khớp là `partial`.
- `run-show` không có host. Host được chọn tường minh cho nguồn CLI local, rồi đối chiếu với `dispatch.host_scope.hostId` và `worker.projection.host.id`; Run rỗng không đủ chứng cứ host nên `partial`. `runtimeId` chỉ định danh runtime, không dùng làm host key. Chưa kiểm remote selector/host nhiều máy; adapter này không đưa remote vào DB và integration thuộc coordinator.
- Chạy trực tiếp adapter đọc Run live trên host local: `complete=true`, 7 Task, 7 Dispatch, 7 worker, 1 trang, không có error code tại thời điểm kiểm. Đây chỉ là chứng cứ Orca metadata; không xác minh liên kết CodeBurn session, không có DB/CLI integration và không thay volume fixture.

## Contracts & boundaries

Module: `src/contracts.ts` (T05). Unknown trong contract luôn là `null` (không dùng `0` hay `""` thay unknown). Trường optional/thiếu ở nguồn → `T | null` và phải có key (collector gán `null`).

### Định danh

| Contract field | Nguồn (lệnh + trường + fixture) | Nullable | Ghi chú |
| --- | --- | --- | --- |
| `sessionKey` | `codeburn sessions --format json` → `sessionId` + `provider`; hàm `sessionKey(provider,'codeburn',sessionId)` | Không | Namespace `<provider>:codeburn:<rawId>`; `claude` vs `codex` cùng UUID vẫn khác key |
| `UsageSession.rawId` | Cùng `sessionId` row (cha hoặc phần tử `subagents[]`) | Không | Subagent: `agent-…` trong `session-with-subagent-aggregated.json` |
| `UsageSession.provider` | Row `provider` (`"claude"` \| `"codex"`) | Không | Fixture Claude/Codex |
| `UsageSession.source` | Hằng `codeburn` (MVP) | Không | Không có field trong JSON — do collector gán |
| `executionKey` | `orcaExecutionKey(hostId, rawId)`; `hostId` từ `dispatch.host_scope` / `hostScope` JSON `hostId` (`local` trong `dispatch-show.json`); `rawId` = `dispatch.id` (`ctx_…`) hoặc `worktreeId` (`worker.resource.worktreeId`, discovery § Orca) | Không | `orca:<hostId>:<rawId>`; `rawId` worktree có `::` — parser chỉ tách sau segment `hostId` thứ hai |
| `Execution.runId` | `dispatch-show` → `run_id`; `run-show` → `runId` | Có nếu thiếu trong payload | Fixture `run-show.json` |
| `Execution.taskId` | `dispatch-show` → `task_id` | Có nếu thiếu | `dispatch-show.json` |
| `Execution.dispatchId` | `dispatch-show` → `id` (`ctx_…`) | Có khi chỉ có worktree | `worker-show-settled.json` |
| `GitHubIssue.issueNodeId` | GraphQL `Issue.id` (node ID) | Không khi content là Issue | Query MVP chưa fetch `Issue.id` trong fixture items — **gap**; key SessionLink vẫn là node ID khi collector bổ sung fragment |
| `GitHubIssue.repository.nameWithOwner` | `content.repository.nameWithOwner` | Không trên Issue | `project-items-page1.json` |
| `GitHubIssue.number` | `content.number` | Không trên Issue; **không** invent cho DraftIssue | Fixture Issue |
| `GitHubIssue.url` | `content.url` | Không trên Issue; absent trên DraftIssue | GraphQL schema discovery § GitHub |
| `GitHubIssue.title` | `content.title` | Không | Fixture |
| `GitHubIssue.state` | `content.state` | Không trên Issue | Fixture `OPEN` |
| `ProjectItem.projectId` | `node(id).id` project (`PVT_…`) | Không | `project-items-page1.json` `data.node.id` |
| `ProjectItem.itemId` | `items.nodes[].id` (`PVTI_…`) | Không | Fixture |
| `ProjectItem.contentType` | Map `type` + `content.__typename` → `Issue` \| `PullRequest` \| `DraftIssue` \| `Redacted` | Không | Live `ISSUE` + `Issue`; PR/Draft/Redacted **gap** fixture |
| `ProjectItem.issue` | Chỉ khi `contentType === 'Issue'` và có `issueNodeId` | `null` cho PR/Draft/Redacted | DraftIssue: không tạo `number`/`url` giả |

### Usage snapshot & token

| Contract field | Nguồn | Nullable | Ghi chú |
| --- | --- | --- | --- |
| `UsageSnapshot.sessionKey` | Cùng `sessionKey` của session | Không | Định danh snapshot = session; lần thu sau **thay thế** (upsert), không cộng |
| `UsageSnapshot.observedAt` | Thời điểm collector chạy (ISO 8601) | Không | Không có trong CodeBurn row — metadata thu |
| `tokens` (Claude) | `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens` | Số ≥0 từ nguồn; không gộp cache vào input | `session-sonnet-aggregated.json` |
| `tokens` (Codex) | Cùng bốn bucket + `reasoning` | `reasoning` luôn `null` khi chỉ đọc `sessions` JSON | `session-gpt-small-aggregated.json`; `reasoningTokens` chỉ trong `audit` (gap per-session) |
| `Cost.amountUsd` | Row `cost` khi map được | `null` khi unknown | Float CodeBurn; không phải hóa đơn |
| `Cost.kind` | `isEstimated` + semantics discovery | `'unknown'` khi không phân loại được | Live toàn `isEstimated: false` → `'estimated_api_equivalent'`; chưa thấy `true` |
| `Cost.source` | Collector biết `codeburn@0.9.27` | `null` nếu chưa ghi version | Không có field trong session JSON |

**Subagent (Claude):** policy `CLAUDE_SUBAGENT_POLICY = separate_session_per_row` — mỗi object trong `subagents[]` là session tích lũy riêng; row cha **không** chứa token subagent (bằng chứng `calls` cha ≠ tổng con). Collector emit một snapshot per row; báo cáo Issue cộng theo **distinct `sessionKey`**, không auto-roll subagent vào cha.

### SessionLink

| Contract field | Nguồn | Nullable | Ghi chú |
| --- | --- | --- | --- |
| `sessionKey` | Usage session đã chuẩn hóa | Không | |
| `issueNodeId` | GitHub `Issue.id` user chọn | Không | Một session tối đa một Issue (architecture invariant 3) |
| `method` | Luôn `'manual'` (MVP) | Không | CLI `link` tường minh |
| `linkedAt` | Thời điểm link (ISO) | Không | |
| `linkedBy` | Operator (string) nếu có | `null` | MVP chưa xác minh field Orca/GitHub |

### Khả năng còn thiếu (unknown-capable)

| Khả năng | Lý do |
| --- | --- |
| `Issue.id` trong project items query hiện tại | Fixture chỉ có `content.number`; collector GitHub cần fragment bổ sung |
| `isEstimated: true` / `estimatedCost` semantics | Chưa quan sát live (mục CodeBurn) |
| Codex `reasoning` per session | Chỉ `audit`, không `sessions` JSON |
| Orca ↔ CodeBurn `sessionId` | Không field usage UUID trong JSON Orca read-only |
| `PullRequest` / `DraftIssue` / `Redacted` project items | Không fixture; DraftIssue không có `number`/`url` |
| `Cost.kind === 'unknown'` khi nào | Cần rule collector khi thiếu `cost` hoặc `isEstimated` không map |

### Ranh giới tin cậy

- **CodeBurn `sessions`:** tin cậy cho token buckets và `cost` ước tính local; không coi là billing thực.
- **GitHub GraphQL:** tin cậy cho membership và Issue metadata đã query; field values tùy project schema.
- **Orca orchestration read-only:** tin cậy cho `run_id` / `task_id` / `dispatch_id` / worktree khi `runtime.reachable`; không chứa Claude/Codex usage UUID.
- **Contract module:** không I/O; adapter (E05+) chịu trách nhiệm map và gán `null`.

### Câu hỏi mở

1. Khi `isEstimated` thành `true`, `amountUsd` lấy từ `cost` hay `estimatedCost`?
2. Báo cáo Project: nếu user chỉ link session cha, subagent `agent-…` có hiển thị unlinked usage hay bị loại?
3. `Issue.id` lấy từ query items (thêm field) hay query Issue riêng theo `number`?
4. `linkedBy` có chuẩn hóa từ `gh auth status` login / Orca handle hay luôn `null` trong MVP?

## SQLite — telemetry store (T26)

| Mục | Giá trị |
| --- | --- |
| Driver | `node:sqlite` (`DatabaseSync`) — không thêm native npm dependency |
| Node runtime | `package.json` `engines.node >= 24.0.0` |
| Xác minh Node 24 (minimum) | `npx --yes node@24.0.0 tests/helpers/node24-sqlite-smoke.mjs` (2026-10-24): **OK**; `ExperimentalWarning: SQLite is an experimental feature` |
| Xác minh Node 24 (patch) | `npx --yes node@24.11.0` cùng smoke script — **OK**; cùng experimental warning |
| Xác minh Node hiện tại | `node -e "import('node:sqlite')…"` trên v26.11.0 — **OK** (cùng experimental warning) |
| Đường dẫn DB | `resolveAppPaths().dbPath` → `<appHome>/telemetry.sqlite` (T10); test dùng path tạm explicit |
| PRAGMA | `foreign_keys=ON`, `journal_mode=WAL`, schema `PRAGMA user_version` (v1) |
| Quyền file (POSIX) | Thư mục DB `0700` (best-effort), file `0600` sau open; không chmod thư mục cha tùy ý |
| Ranh giới path | Từ chối symlink DB/parent; từ chối DB nằm trong git root đích khi `gitRoot` được truyền |
| Đóng gói | `pnpm pack` / `test:pack` không kéo binary SQLite ngoài — dùng built-in Node 24+ |

**Không lưu:** prompt thô, transcript, credential, stderr/token provider, hay whole JSON nguồn — chỉ cột allowlisted trong migration v1 (`src/db/migrations/v1.ts`).

**Import idempotent (T28):** mỗi nguồn một transaction; snapshot tích lũy thay thế khi `observedAt` mới hơn; cùng `observedAt` + payload khác → `db_snapshot_conflict`; `collection_logs` append mỗi lượt (message sanitized).
