# Independent V1 acceptance review — `c9ae71c`

## Kết luận

- **Reviewed SHA:** `c9ae71c98e7ff87314227cc988514cae951d70ec`
- **Scope:** V1.1–V1.9; writeback PR #112, coordinator overhead PR #113, diagnostics/suggest-links PR #114; DoD và security boundary liên quan.
- **Overall verdict:** **FAIL**
- **Tóm tắt:** Code build và toàn bộ 438 tests hiện có đều xanh; writeback giữ dry-run mặc định và chỉ mutation khi `--apply`, collectors vẫn read-only, usage source là `agent-top`, role-link giữ provenance thủ công, fixture scan không thấy secret. V1 chưa acceptance complete vì blocker định danh endpoint V1.4 vẫn mở, làm `collect --run` không thể lưu provenance; V1.9 còn thiếu test cho trust boundary `suggest-links apply`.

## Checks đã chạy

| Check | Kết quả | Loại evidence |
| --- | --- | --- |
| `git fetch origin && git rev-parse origin/main && git rev-parse HEAD` | cùng exact SHA `c9ae71c98e7ff87314227cc988514cae951d70ec` | remote + local |
| `pnpm test` | **57 files / 438 tests PASS**, 19.86s | local + fixture |
| `pnpm test:pack` | `pack/install isolation: OK` | local package/install |
| `git diff --check` | PASS | local |
| `gh auth status` | active account `hangndat`; scope có `project` | live environment |
| `gh project field-list 4 --owner hangndat --format json` | đọc live thành công; Project #4 không có field NUMBER thử được dành riêng cho acceptance; `Wave` không được phép dùng theo contract | live read-only |
| PR/Issue evidence | PR #112–#114 merged; Epic #11 và Story #44–#52 đã đóng/Done nhưng không có independent review comment hoặc live acceptance evidence trên #45–#47 | GitHub read-only |
| Fixture secret scan | không thấy token/key/private-key theo các pattern `gh*`, `github_pat_*`, Bearer, AWS, OpenAI, PEM | fixture |
| Source security spot-check | writeback dry-run mặc định; `--yes` chỉ hợp lệ cùng `--apply`; apply re-read remote từng item, argv không shell, timeout/buffer bound và redact lỗi; GraphQL collector từ chối mutation/subscription; Orca/agent-top dùng allowlist read-only | source |

## Verdict theo slice

| Slice | Verdict | Evidence / lý do |
| --- | --- | --- |
| V1.1 hierarchy | **PASS** | Storage/migration, hierarchy roll-up, cycle/dedup và CLI tests xanh; spec ghi live read-only Project #4 và parent evidence. |
| V1.2 writeback | **BLOCKED** | Source/security review trên SHA này không thấy mutation ngoài `writeback --apply`; fixture apply/idempotency/fail-closed xanh. Gate live `--apply` trên field NUMBER thử chưa có và Project #4 không có field test phù hợp; không dùng `Wave`. |
| V1.3 trace | **BLOCKED** | Fixture và package-installed trace tests xanh; spec vẫn ghi thiếu positive live PR↔Issue/session chain, private/rename/force-push evidence. Fixture không thay live gate. |
| V1.4 coordinator overhead | **FAIL** | **F01** vẫn mở: endpoint source identity chưa được chứng minh; `collect --run` luôn partial và không persist `orca_runs`/scoped provenance. Live coordinator + hai worker sessions cũng chưa có. |
| V1.5 retries | **BLOCKED** | Report calculation fixture PASS, nhưng live Run provenance đầu vào không thể được collect/persist khi F01 còn mở. |
| V1.6 duplicates | **BLOCKED** | Report calculation fixture PASS, nhưng live Run provenance đầu vào không thể được collect/persist khi F01 còn mở. |
| V1.7 waste | **PASS** | Chỉ đọc linked snapshots/token buckets đã lưu, không invent provider fields; deterministic fixture PASS. Live behavior chưa được chạy lại trong review này. |
| V1.8 budget | **PASS** | Limit do operator truyền, không tạo GitHub field hoặc hard enforcement; hierarchy fixture PASS. Live behavior chưa được chạy lại trong review này. |
| V1.9 suggest-links | **FAIL** | Suggestion ambiguous giữ `needs_approval` và source yêu cầu exact selectors + `--yes`, nhưng **F02**: không có test cho nhánh apply/trust boundary. |

## Security boundary

| Boundary | Verdict | Evidence |
| --- | --- | --- |
| Writeback opt-in | **PASS (source/fixture)** | Không `--apply` chỉ preview; non-TTY apply cần `--yes`; scope preflight; re-read trước từng write; chỉ NUMBER argv. Live mutation gate vẫn BLOCKED. |
| Collectors read-only | **PASS** | GitHub client chặn mutation/subscription; Orca và agent-top adapters dùng command/query allowlist; write adapter tách riêng. |
| Usage source | **PASS** | Session keys và fixtures dùng `provider:agent-top:*`; collection pin/validate agent-top source. |
| Role-link provenance | **PASS (fail-closed)** | Manual bounded evidence, verifier hash/audit, exact host/run/dispatch selectors và FK; không tự quy Issue/session. F01 ngăn persistence khi host source chưa verified. |
| Secrets | **PASS** | Fixture scan không thấy credential-shaped secret; subprocess errors được redact/bound. |

## Findings

| ID / loại | Mức độ / chặn + lý do | AC, path:dòng / bằng chứng | Điều kiện đóng / trạng thái / SHA |
| --- | --- | --- | --- |
| **F01 / contract+code** | **blocker; Có** — không có durable endpoint identity nên V1.4 và live input V1.5–V1.6 không thể acceptance complete | V1.4 AC3/gate; `docs/V1-COORDINATOR-OVERHEAD-SPEC.md:3-5,111,138`; `src/commands/collect.ts:308,327,349`; `tests/collect-run.test.mjs` xác nhận `orca_source_host_unverified` và 0 rows ở `orca_runs`, `orca_tasks`, `orca_dispatches`, `scoped_executions` | Giữ stable ID từ review/spec trước. Cần source identity đáp ứng AC3, fixture collision/clone, persist+journal đúng scope, live Run evidence và independent re-review exact SHA. **Mở tại `c9ae71c`.** |
| **F02 / evidence+security** | **blocker; Có** — V1.9 ghi `session_links`; thiếu test khiến opt-in/ambiguity/exact-selector/idempotency chưa có regression gate | V1.9 command contract trong `docs/V1-DIAGNOSTICS-SPEC.md`; `src/commands/suggest-links.ts`; `tests/v1-diagnostics.test.mjs` chỉ test suggestion generation; search tests không có `suggest-links apply`, `suggest_apply_requires_yes` hoặc `suggest_apply_not_ready` | Thêm CLI/integration tests chứng minh: thiếu `--yes` không ghi; ambiguous/not-ready bị từ chối; exact ready pair mới ghi; rerun idempotent; không mutation GitHub. Re-run full suite và independent revalidate exact SHA. **Mới, bỏ sót test tại `c9ae71c`.** |

## Limitations và bước tiếp

- Không chạy live `writeback --apply`: Project #4 không có field NUMBER thử được dành riêng; contract cấm dùng field roadmap `Wave`.
- Không tạo PR↔Issue positive relation, private repo case, force-push case hay role-link live chỉ để đóng review.
- Không chạy lại external collectors có side effect; review dùng source, fixture và GitHub read-only evidence.
- GitHub Project/Issue trạng thái Done/Closed không thay independent acceptance; do overall FAIL, review này không cập nhật docs thành “V1 complete”, không comment Epic #11 và không đóng/mở lại validation issue.
- Owner feature cần xử lý tối đa các finding trên; reviewer revalidate diff từ `c9ae71c` sang exact fix SHA. Không bắt đầu V2 dựa trên artifact này.
