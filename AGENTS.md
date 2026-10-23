# Contributor instructions for coding agents

## Mission

Build `orca-task-telemetry` as a reusable, install-once Node.js/TypeScript CLI that links GitHub Projects V2 work items with Orca execution metadata and CodeBurn usage for Claude Code and Codex.

## Read first

- `docs/MVP-SPEC.md` — bounded scope and Definition of Done.
- `docs/ARCHITECTURE.md` — integration boundaries and trust model.
- `BACKLOG.md` — features explicitly excluded from MVP.

## Engineering rules

- Treat GitHub Projects as the canonical work-management source.
- Use TypeScript strict mode; pin and validate the minimum Node.js runtime.
- Keep one npm package (no monorepo, server, frontend or framework).
- Prefer verified, documented CLI JSON interfaces; inspect versions and `--help` before implementation.
- Never invent Orca, CodeBurn or GitHub data fields.
- Never write to existing target repositories, GitHub Project fields or agent configurations during MVP.
- Preserve session provenance, provider token semantics, unknown values, and idempotent usage snapshots.
- Manual Issue ↔ session linking is sufficient for MVP. Do not silently auto-attribute ambiguous sessions.
- Avoid retries/parallelism that waste AI tokens, and do not dispatch work owned by an existing worker.
- Add tests and create a conventional commit after each validated vertical slice.
- Distinguish fixture-tested behavior from live integration evidence.
- Do not claim a feature is complete unless its acceptance criteria are satisfied.

## Agent setup và workflow

- Hướng dẫn chung: [docs/agents/README.md](docs/agents/README.md); Claude nhập cùng file này qua `CLAUDE.md`, Cursor đọc `.cursor/rules/`.
- Kế hoạch/trạng thái/báo cáo dùng tiếng Việt; giữ nguyên IDs/API/commands. Chỉ đọc thêm role/rules/skills áp dụng, không nạp toàn bộ roster hoặc đọc lại tài liệu chưa đổi trong cùng session.
- Coordinator giữ root tooling, lockfile, contracts và integration trừ khi giao paths rõ. Worker chỉ sửa scope trong Task Spec; không sửa chéo scope để pass build.
- Task Spec có AC/checks, paths/non-goals, `Architecture impact: Có|Không`, Role ID/file, Persona, `Cost tier: cheap|standard`, model đã verify và skills cần nạp. Mẫu tại `docs/agents/templates/`.
- Khi user giao leader/boss/orchestrator/coordinator: đọc `.cursor/rules/orca-leader-activation.mdc`. Task nhỏ làm inline; chỉ dispatch khi task authorize. Chỉ coordinator gốc dùng Orca với skill/guide đúng phiên bản; không dùng native Agent để spawn. Worker/reviewer không spawn con.
- Kiểm ownership/live workers trước dispatch; không tự mở backlog hoặc chạy model đối chứng. Model pin của project nguồn không phải live compatibility evidence của repo này.
- Review acceptance độc lập: reviewer khác session tác giả, exact SHA, scope/checks/evidence/limitations và verdict từng gate. Gộp DoD+security cùng SHA khi áp dụng. Self-check không được gọi là independent PASS.
- Review/fix đọc `.cursor/rules/orca-review-convergence.mdc`: stable finding IDs, tối đa hai lượt fix tự động xuyên session/SHA; checkpoint/chẩn đoán khi không tiến triển, không lặp vô hạn. Không dùng known gap bỏ gate bắt buộc.
- Git/PR theo `.cursor/rules/git-workflow.mdc`: conventional commit sau validate; remote push/PR/merge cần nằm trong quyền task. GitHub Project chỉ đọc trong MVP; không tự cập nhật fields/status.
- Code complete khác acceptance complete và MVP complete. Worker completion không thay review; phân biệt local/CI/fixture/live evidence.
- Đây là contributor setup của chính repo này; không implement tính năng cài/sửa agent config trong target repositories (vẫn thuộc BACKLOG).

## Delivery order

1. Inspect local tools and document relevant compatibility facts in `docs/discovery.md`.
2. Complete package foundation and install test.
3. Implement GitHub Project/Issue reader and `init` profile.
4. Implement Orca/CodeBurn collectors and persistent storage.
5. Add explicit session mapping and Issue-level accounting.
6. Add Task/Project CLI reports, fixtures, and live integration validation.

Do not implement anything in `BACKLOG.md` before the MVP meets Definition of Done.
