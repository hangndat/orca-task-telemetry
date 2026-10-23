# Nguồn và phạm vi chuyển đổi

- Nguồn local: `/Users/admin/SideProject/ticket-solution/main`.
- Source commit tham chiếu: `b2faa48a1ce443c8fc6c849cb74a06a57f8b0c37`.
- Ngày đọc và điều chỉnh: 2026-10-23. Đọc working tree local; SHA ghi mốc tham chiếu, không chứng nhận mọi file local đều sạch.
- Inputs: `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, `.cursor/rules/{git-workflow,orca-agent-routing-core,orca-agent-routing-coordinator,orca-leader-activation,orca-coordinator-mailbox,orca-worktree-hygiene,orca-review-convergence}.mdc`; `docs/agents/{README,context-budget,cost-catalog}.md`, roles và ba templates.

Giữ mô hình coordinator/worker, role/persona, ownership, context budget, hai cost tiers, review độc lập theo exact SHA và findings xuyên các lượt fix. Viết lại role theo CLI/collectors thay vì BE/web/iOS; pin model của project nguồn chỉ là tham khảo, không phải xác nhận tương thích hiện tại.

Không chuyển Project #3, business/tenant/RLS policy, monorepo/pnpm/Turbo, UI/iOS/UAT production, automations, MCP host config, script orchestration/metrics hay upstream agency-agents snapshots. Các role ở đây là hướng dẫn riêng cho telemetry, không trỏ đến upstream files chưa copy. CI của monorepo không được chuyển; workflow ở đây là quy trình làm việc của agents và Git/PR.

Đây là cấu hình contributor của chính repo này. Không phải tính năng cài agent config vào repository người dùng; giới hạn read-only của MVP vẫn nguyên vẹn. Không chỉnh project nguồn, agent config toàn máy, GitHub fields hay Orca runtime.

Validation local không chứng minh dispatch/live integration. Chỉ claim live Orca/Claude/Cursor/GitHub khi có evidence riêng. Cập nhật sau này phải diff và điều chỉnh thủ công, không sync đè toàn bộ từ nguồn.

## Evidence của lần chuyển đổi

- Local: Node.js `v26.11.0`, npm `11.20.0`; `npm test` build thành công và 6/6 tests pass, gồm hook chạy từ cwd khác qua project path có khoảng trắng, output deny hợp lệ và không lộ input.
- JSON settings parse được; relative links trong 23 tài liệu AGENTS/README/roles/templates/rules resolve được; whitespace check pass.
- Chưa validate trên minimum Node 24, chưa chạy Claude/Cursor để chứng minh hook/rules được runtime nạp, chưa dispatch Orca, chưa chạy GitHub CI hoặc independent review. Tests hook là subprocess local, không phải live agent evidence.
- Không thay đổi phân phối package/runtime CLI; không chuyển CI monorepo hoặc claim package foundation/MVP hoàn thành.
