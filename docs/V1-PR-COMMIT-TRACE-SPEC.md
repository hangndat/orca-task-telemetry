# V1.3 — Truy vết PR và commit đã xác minh

**Trạng thái:** đặc tả để triển khai sau MVP; chưa phải code complete hay acceptance complete. **Baseline:** `main` tại `3c19cd1a9c5fa5e77f6f2e39c71dafa101462322` (2026-10-24). **Nguồn yêu cầu:** [Issue #46](https://github.com/hangndat/orca-task-telemetry/issues/46), `BACKLOG.md` P1. V1.2 [#45](https://github.com/hangndat/orca-task-telemetry/issues/45) / draft PR #109 chưa merge tại thời điểm khảo sát; V1.3 không phụ thuộc writeback.

## Mục tiêu và ranh giới

Người dùng đã `link --issue --provider --session` có thể chủ động gắn **cùng session đó** với một PR và, nếu muốn, một commit trong PR; CLI chỉ nhận liên kết khi GitHub xác minh Issue↔PR và commit↔PR. Báo cáo cho thấy chuỗi bằng chứng `Issue → session → PR → commit`, mức sử dụng và chi phí **ước tính tương đương API** từ snapshot agent-top, kèm thời điểm kiểm tra. GitHub là nguồn chuẩn cho danh tính và quan hệ mã nguồn; Orca chỉ cung cấp metadata thực thi nếu có tham chiếu đã xác minh. Không dùng branch, timestamp, commit message, tên worktree hay Orca reference để âm thầm quy session hoặc suy luận quan hệ GitHub.

Đây là truy vết **provenance**, không phải phân bổ chính xác token cho từng diff/hunk. Một session có thể được người dùng gắn với nhiều PR hoặc commit; cùng snapshot khi đó hiện ở nhiều đường truy vết. Mọi tổng trong một phạm vi phải khử trùng theo `sessionKey`; tổng giữa các PR/commit **không cộng được** để tạo tổng Issue hoặc Project. Session chỉ gắn Issue tiếp tục ở `report task`, không tự xuất hiện như chi phí PR/commit đã quy thuộc.

## Hành vi CLI và contract JSON đề xuất

Các lệnh sau **chưa tồn tại** trên baseline; tên/chữ ký là đề xuất cho V1.3:

```text
orca-telemetry trace link-pr --issue <issue-url> --pr <pr-url> --provider <claude|codex> --session <id> [--json]
orca-telemetry trace link-commit --pr <pr-url> --sha <full-oid> --provider <claude|codex> --session <id> [--json]
orca-telemetry trace collect [--json]
orca-telemetry report trace <issue-url|issue-number> [--json]
```

`link-pr` yêu cầu session đã được link thủ công tới đúng `issueNodeId`; xác minh URL là **PullRequest**, không chỉ là Issue cùng số, và PR `closingIssuesReferences` chứa Issue đó. Quan hệ này chỉ chứng minh GitHub đánh dấu PR **có thể đóng Issue**, không chứng minh PR đã merge hay toàn bộ công việc của Issue nằm trong PR. Nếu PR không có closing reference, trả lỗi `issue_pr_unverified` và hướng dẫn sửa quan hệ trên GitHub rồi thu thập lại; không tự chấp nhận cross-reference, chữ trong body hoặc lựa chọn ngầm. `link-commit` yêu cầu session đã gắn PR, full commit OID hiện trong danh sách commit của PR. Lệnh lặp cùng khóa trả `already_linked`; xung đột session↔Issue hoặc liên kết sai chuỗi trả lỗi có cấu trúc, không ghi một phần. Người dùng có thể gắn nhiều PR/commit một cách tường minh; không có auto-discovery session.

`trace collect` là lần đọc lại các PR đã đăng ký, theo trang đến hết; cập nhật bằng chứng/trạng thái hiện tại và `observedAt`. Nó không thay đổi `session_links` hoặc tổng snapshot agent-top. Trạng thái PR chưa merge/draft vẫn có thể `verified_current` đối với quan hệ GitHub, nhưng báo cáo phải hiển thị `mergedAt: null`, `isDraft` và `state` riêng. Force push có thể làm OID cũ rời danh sách PR: giữ liên kết do người dùng tạo cho audit, chuyển quan hệ commit thành `stale`, không tiếp tục gọi là commit hiện thuộc PR. Nếu GitHub lỗi, thiếu quyền, bị rate limit hoặc chưa duyệt hết trang, đánh dấu `unknown` và giữ `lastVerifiedAt`; không diễn giải kết quả rỗng như không có quan hệ.

Ví dụ **hình dạng**, không phải dữ liệu live hay contract đã triển khai:

```json
{
  "kind": "trace",
  "issue": { "issueNodeId": "<GitHub node ID>", "url": "https://github.com/O/R/issues/46" },
  "issueUsage": { "sessionCount": 1, "cost": { "amountUsd": null, "kind": "unknown" } },
  "pullRequests": [{
    "pullNodeId": "<GitHub node ID>", "url": "https://github.com/O/R/pull/7",
    "state": "OPEN", "isDraft": true, "mergedAt": null,
    "issueRelation": { "status": "verified_current", "source": "closingIssuesReferences", "lastVerifiedAt": "<ISO-8601>" },
    "sessions": [{ "sessionKey": "codex:agent-top:<id>", "linkMethod": "manual", "cost": { "amountUsd": null, "kind": "unknown" }, "orcaReference": { "status": "unknown" } }],
    "usage": { "sessionCount": 1, "cost": { "amountUsd": null, "kind": "unknown" } },
    "commits": [{ "oid": "<full Git commit OID>", "url": "https://github.com/O/R/commit/<oid>", "relation": { "status": "verified_current", "source": "pullRequest.commits", "lastVerifiedAt": "<ISO-8601>" }, "sessionKeys": ["codex:agent-top:<id>"] }]
  }],
  "warnings": ["Các tổng PR/commit có thể lặp cùng session; không cộng chéo phạm vi."]
}
```

| Output field | Nguồn và ngữ nghĩa unknown |
| --- | --- |
| `issue.issueNodeId`, `issue.url` | GitHub Issue đã lưu trong `issues`; nếu không có Issue trong profile/DB thì lỗi, không tạo placeholder. URL/owner có thể đổi khi transfer/rename; node ID là khóa. |
| `issueUsage`, `sessions[].cost`, `usage` | `session_links` + `usage_snapshots`/aggregation hiện có; cost `unknown` dùng `amountUsd: null`, không thay bằng 0. `usage` khử trùng session trong PR; `issueUsage` là toàn Issue, có thể lớn hơn PR. Không biểu diễn actual billing. |
| `pullNodeId`, `url`, `state`, `isDraft`, `mergedAt` | GitHub GraphQL `PullRequest.id/url/state/isDraft/mergedAt`. `mergedAt: null` là chưa có timestamp merge; không suy ra đã bàn giao. Không truy cập được PR → trạng thái kiểm chứng `unknown`, giữ giá trị đã quan sát kèm thời gian và cảnh báo stale. |
| `issueRelation`, `commits[].relation` | GitHub `closingIssuesReferences` và `PullRequest.commits` đã duyệt hết trang; `verified_current` khi match trên lần đọc thành công, `stale` khi lần đọc thành công không còn match, `unknown` khi chưa thể kết luận. `lastVerifiedAt: null` nếu chưa có lần xác minh thành công. `source` là tên query, không phải field tự tạo từ GitHub. |
| `commits[].oid/url` | `PullRequest.commits.nodes[].commit.oid/url` trên lần quan sát; full OID là khóa cùng repository/PR. Link cũ vẫn giữ khi stale; URL có thể không còn truy cập được. |
| `sessions[].sessionKey`, `linkMethod`, `commits[].sessionKeys` | Link do người dùng tạo trong SQLite, namespace `provider:agent-top:id`; không nhận ID Orca làm ID CodeBurn. `sessionKeys: []` nghĩa là commit đã xác minh nhưng chưa được gắn session, không phải chi phí 0. |
| `sessions[].orcaReference` | Giữ contract report hiện tại: `unknown` khi không có mối nối Orca↔CodeBurn đã xác minh. Không tạo field Orca mới từ URL PR/branch. |
| `warnings` | CLI suy từ trạng thái partial/stale/duplicate; mảng rỗng chỉ khi không có cảnh báo, không chứng minh dữ liệu toàn cục đầy đủ. |

Đầu ra lỗi `--json` theo envelope lỗi CLI hiện hành; bổ sung mã phân biệt `not_pull_request`, `issue_pr_unverified`, `commit_pr_unverified`, `trace_auth`, `trace_partial`, `trace_conflict`. Dữ liệu thiếu quyền/không tồn tại có thể cùng trả 404; không khẳng định là đã xóa. Truy vết chỉ là view của link thủ công, không sửa báo cáo V1.2 hay Project field.

## Bằng chứng giao diện và quy tắc xác minh

- Baseline `src/github/identity.ts` giải `repository.issue(number:)` rồi kiểm `repository.pullRequest(number:)` để không nhầm PR với Issue cùng số. V1.3 phải giải **PR qua endpoint PR** (`repository.pullRequest(number:)` hoặc REST `GET /repos/{owner}/{repo}/pulls/{pull_number}`), so `id`, repo, số và URL canonical; không chỉ parse URL. GraphQL live ngày 2026-10-24: Issue #46 `id=I_kwDOVUhnY88AAAABZZGcqw`, PR #109 `id=PR_kwDOVUhnY88AAAABKVjIDw`, `state=OPEN`, `isDraft=true`, `mergedAt=null`. PR #109 có `closingIssuesReferences.nodes=[]`; **không** phải fixture liên kết Issue↔PR thành công.
- [GraphQL `PullRequest.closingIssuesReferences`](https://docs.github.com/en/graphql/reference/pulls) là danh sách Issue *có thể được đóng* bởi PR. Chỉ `Issue.id` trùng node ID sau khi duyệt hết `pageInfo.hasNextPage/endCursor` mới cho `verified_current`. Quan hệ khác như cross-reference không nằm trong chuẩn xác minh V1.3 này. Cross-repo chỉ nhận nếu GitHub trả chính Issue ID; không so số Issue riêng lẻ.
- [GraphQL `PullRequest.commits`](https://docs.github.com/en/graphql/reference/pulls) hoặc [REST list commits on a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#list-commits-on-a-pull-request) cung cấp OID/SHA thuộc PR tại thời điểm đọc. Live PR #109 trả `headRefOid` và 3 commit đầu, `hasNextPage=true`; chưa xác minh toàn bộ danh sách, nên không dùng mẫu này để kết luận một commit vắng mặt. Không dùng `Commit.associatedPullRequests` làm nguồn tổng quát: [GitHub mô tả field này cho merged PR đưa commit vào repository](https://docs.github.com/en/graphql/reference/commits), không bao phủ chắc chắn PR mở.
- [REST Get PR](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request) cần fine-grained `Pull requests: read` **hoặc** `Contents: read`; REST list PR commits cần `Pull requests: read`. Project/Issue GraphQL còn cần quyền truy cập Project/repository theo profile hiện có. Classic/OAuth token và private repo phải kiểm thực tế bằng `gh auth status`/query read-only; không lưu token. Public resource có thể cho phép unauthenticated REST; CLI hiện dùng `gh` auth.
- GraphQL duyệt cursor cho cả `closingIssuesReferences` và `commits` với page size có giới hạn, kiểm `hasNextPage/endCursor`, chặn cursor lặp/response lỗi. REST duyệt `Link`/`gh api --paginate`; [GitHub mặc định có phân trang](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api). Theo [rate limits GraphQL](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api), đọc `rateLimit`/headers và tôn trọng reset, trả partial/unknown khi bị giới hạn; không retry song song vô hạn. Không ghép các trang chưa hoàn chỉnh thành bằng chứng vắng mặt.

**Khoảng trống live:** chưa có PR↔Issue positive fixture trong repo, chưa thử private repo/transfer/rename/force push, chưa xác minh REST response/pagination trực tiếp cho V1.3, và chưa kiểm auth scopes trong nhiều loại token. Các trường/query trên được kiểm bằng GitHub docs và GraphQL read-only của một PR đang mở; không gọi đây là acceptance tích hợp hoàn chỉnh.

## Contract lưu trữ, trust boundary và migration dự kiến

`src/contracts.ts`: thêm `GitHubPullRequest`, `PullCommit`, `TraceRelation` (`verified_current|stale|unknown`, `source`, `lastVerifiedAt`), `SessionPullLink`, `SessionCommitLink`; không sửa `GitHubIssue`, `UsageSnapshot` hoặc `SessionLink` đang dùng. Các node ID và OID là dữ liệu GitHub; `linkMethod=manual` và thời điểm link là dữ liệu CLI; `observedAt` là thời gian thu thập, không phải commit time. Định nghĩa nullable rõ, không dùng số 0 cho chi phí chưa biết.

Migration SQLite phiên bản kế tiếp từ schema baseline v2: bảng `pull_requests` khóa `pull_node_id`, lưu repo canonical/number/url/state/is_draft/merged_at/observed_at; bảng `issue_pull_relations` khóa `(issue_node_id,pull_node_id)` với status/source/last_verified_at; bảng `pull_commits` khóa `(pull_node_id,oid)` với status/last_verified_at/url; bảng `session_pull_links` khóa `(session_key,pull_node_id)` và `session_commit_links` khóa `(session_key,pull_node_id,oid)` với FK và `linked_at`. Chỉ link session đã có `session_links` tới cùng Issue; kiểm này cần transaction/constraint hoặc trigger khi triển khai, không chỉ UI. Lưu quan sát mới bằng upsert theo khóa; không cộng lại token, không xóa audit link khi force push. Migration phải an toàn với DB v1/v2, transaction, backup/rollback theo cơ chế hiện có; schema chính xác chốt ở slice code, đây chưa phải DDL cuối.

Ranh giới: `src/github/*` chỉ query GitHub read-only; `src/orca/*` không lấy PR/commit làm session ID; `src/usage/*` và snapshot hiện có là nguồn duy nhất cho token/cost; `src/db/*` lưu provenance và link do người dùng tạo ngoài target repo; `src/reports/*` join và khử trùng. `trace collect` không gọi writeback GitHub, không ghi target repository hay agent config. V1.2 draft PR #109 không phải dependency runtime.

## AC và ma trận kiểm chứng

| ID | Tình huống / kết quả quan sát được | Fixture/test bắt buộc | Live acceptance riêng |
| --- | --- | --- | --- |
| V13-01 | Issue URL được giải bằng node ID; PR URL phải là PR thật, không nhầm Issue # trùng; repo rename/Issue transfer cập nhật canonical mà giữ identity khi ID không đổi. | Mock GraphQL canonical, redirect/rename/transfer; PR-number-as-Issue bị từ chối. | Query PR/Issue thực tế sau rename/transfer nếu có quyền; nếu thiếu ghi gap. |
| V13-02 | `closingIssuesReferences` chứa đúng Issue ID mới nhận; nhiều PR cho một Issue và nhiều Issue cho một PR không ghi đè; cross-repo so node ID, mapping mơ hồ không tự chọn. | Hai trang closing refs, nhiều PR, cross-repo, empty/partial/ambiguous. | Ít nhất một PR↔Issue positive read-only; PR #109 chỉ là negative live hiện có. |
| V13-03 | `commits` có full OID mới nhận; nhiều commit/PR, duplicate OID, force push chuyển link cũ stale; PR mở/draft hiển thị không merge. | Pagination, repeated OID, force push, unmerged, commit message chứa `#` nhưng không có API relation. | Đọc hết trang commit của một PR thật, kiểm trạng thái open/merged; force push chỉ khi có môi trường test được phép. |
| V13-04 | Link thủ công session→Issue→PR→commit; conflict không ghi một phần, lặp trả `already_linked`; collect lặp giữ row/snapshot/tổng. | SQLite migration v1/v2, FK/transaction, repeated collect, unknown cost, session gắn nhiều đường và dedup trong phạm vi. | Session CodeBurn thật đã link Issue cùng PR positive; nếu không có, ghi rõ thiếu live. |
| V13-05 | Private auth, 403/404, rate limit, trang lỗi, PR/Issue stale/deleted cho `unknown`/partial; không giả là quan hệ âm tính hoặc cost 0. | Mock scopes, 404, 429/GraphQL errors, cursor lặp, stale/deleted. | Private repo/token scope phù hợp nếu có; nếu không, ghi gap. |
| V13-06 | `report trace --json` có nguồn/nullable như bảng trên, totals khử trùng, không cộng PR/commit vào Issue, `orcaReference` unknown khi chưa nối. | Golden fixture JSON/text; kiểm session chưa link không hiện dưới PR. | CLI chạy từ package cài ngoài repo, so với GitHub live + snapshot khi có dữ liệu. |

Mỗi fixture phải ghi rõ dữ liệu đã redact và nguồn; mock/fixture PASS không được gọi là live PASS. Acceptance chỉ hoàn tất khi các gate bắt buộc có evidence và reviewer độc lập kiểm exact SHA, checks, scope và limitations; trường hợp môi trường không cung cấp private/force-push live phải nêu gap thay vì khẳng định đã xác minh.

## Lát cắt, ownership và phụ thuộc

1. **GitHub read-only verification** — owner GitHub collector; `src/github/*`, fixture/test tương ứng. Contract PR/Issue/commit, pagination, auth/rate/partial. Phụ thuộc MVP reader/profile đã có. Conventional commit sau test; independent review exact SHA.
2. **Link và storage** — owner attribution/DB; `src/contracts.ts`, `src/db/*`, `src/attribution/*`, `src/commands/*` liên quan. Migration, manual commands, atomic conflict/idempotency. Phụ thuộc slice 1 và session link MVP. Conventional commit sau test; independent review exact SHA.
3. **Trace report + live validation** — owner report/CLI; `src/reports/*`, `src/commands/*`, docs/fixtures. JSON/text, dedup, partial/stale, package smoke, live evidence. Phụ thuộc hai slice trước. Conventional commit sau test; independent DoD/security review exact SHA. Coordinator giữ root tooling/lockfile/contracts/integration trừ khi giao path rõ.

**Quyết định còn mở trước code:** (a) có hỗ trợ Issue↔PR quan hệ GitHub khác `closingIssuesReferences` hay không và mức tin cậy của từng loại; (b) cho phép nhiều PR/commit mỗi session như đặc tả này hay yêu cầu người dùng chọn một đường chính; (c) khi GitHub đổi relation sau merge, giữ audit link ở trạng thái stale bao lâu; (d) phạm vi repo/fork/private và quyền GraphQL cụ thể cho token triển khai; (e) commit OID SHA-1/SHA-256 và canonical URL khi repo transfer. Không tự giải các câu hỏi này bằng heuristic.

## Ngoài phạm vi

Không tự liên kết session, không chia token theo commit/diff, không suy PR từ branch/commit message, không chấm điểm test/check/CI, không ghi Project field/writeback V1.2, không tạo webhook/server/frontend, không sửa agent config hoặc target repository. Không tuyên bố “delivered” từ PR open/draft, cũng không tuyên bố actual provider billing từ CodeBurn estimate.
