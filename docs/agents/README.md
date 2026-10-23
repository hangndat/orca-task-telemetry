# Agents và workflow

Bộ hướng dẫn được điều chỉnh từ `ticket-solution` cho một package Node.js/TypeScript. Xem [nguồn và phạm vi](PROVENANCE.md). `AGENTS.md`, MVP spec và architecture của project này là nguồn ưu tiên; role không được mở rộng MVP.

## Bắt đầu

- Codex đọc [AGENTS.md](../../AGENTS.md); Claude dùng [CLAUDE.md](../../CLAUDE.md) để nhập cùng hướng dẫn; Cursor dùng `.cursor/rules/`.
- Task nhỏ: thực hiện inline trong scope, không tạo Run/worker chỉ để sửa vài file.
- Khi được giao làm leader/coordinator: đọc [leader activation](../../.cursor/rules/orca-leader-activation.mdc). Chỉ dispatch khi task cho phép; dùng skill `orchestration` và guide đúng phiên bản host.
- Worker/reviewer đọc spec, role và rules áp dụng; không đọc toàn bộ catalog/rules coordinator, không spawn con.
- Trạng thái, kế hoạch và báo cáo dùng tiếng Việt, giữ nguyên IDs/API/commands.

## Ownership và persona

| Role ID | Persona / label | Scope mặc định |
| --- | --- | --- |
| coordinator | Coordinator | Root tooling, dependencies/lockfile, contracts, integration, phân quyền paths |
| product-ba | Kazu · ba | AC, scope và docs trong MVP |
| architect | Dexter · arch | Contract, storage/trust boundaries và handoff trong docs |
| cli | Gonic, Colin · cli | CLI và tests được giao |
| collectors | Remy, Monica · collect | Adapters GitHub/Orca/CodeBurn và fixtures được giao |
| reviewer-dod | James · dod | Nghiệm thu độc lập trên exact SHA |
| reviewer-security | James · sec | Review độc lập secrets, subprocess, storage, external mutation |
| dod+sec | James · dod+sec | Một reviewer, chung evidence, verdict DoD/security riêng |

Mỗi worker chỉ sở hữu paths trong Task Spec, không phải toàn bộ scope của role. Khi paths chưa tồn tại, coordinator chốt tên trước dispatch; không tự dựng monorepo hoặc sửa chéo scope để build pass. Persona là nhãn, không chứng minh reviewer độc lập: session reviewer phải khác session tác giả. Chọn persona chưa live cho role; không đổi tên worker đang chạy.

Role files: [BA](roles/product-ba.md), [architect](roles/architect.md), [CLI](roles/cli.md), [collectors](roles/collectors.md), [DoD](roles/reviewer-dod.md), [security](roles/reviewer-security.md), [gộp](roles/reviewer-merged.md).

## Workflow

1. Chọn vertical slice theo thứ tự trong AGENTS.md; chốt AC, paths, ngoài phạm vi, checks và architecture impact bằng [Task Spec](templates/task-spec.md).
2. Kiểm ownership hiện có trước dispatch. Chỉ coordinator gốc dùng Orca; kiểm phiên bản, help và guide trước lệnh. Task độc lập mới được chạy song song; không lấy task có worker đang giữ.
3. Implement và chạy checks phù hợp. Tạo conventional commit cho slice đã validate. Bàn giao [worker report](templates/worker-report.md) với SHA, checks và hạn chế.
4. Review độc lập bằng [review spec](templates/review.md). Cùng SHA cần DoD/security thì gộp một session. Không tự nhận local self-check là independent PASS.
5. Fix/revalidate theo [review convergence](../../.cursor/rules/orca-review-convergence.mdc); không kế thừa PASS khi SHA đổi.
6. Push/PR/merge chỉ khi task đã authorize; áp dụng [git workflow](../../.cursor/rules/git-workflow.mdc). Hoàn thành task không đồng nghĩa hoàn thành MVP.

## Context và chi phí

Đọc [context budget](context-budget.md) và [cost catalog](cost-catalog.md) khi dispatch. Không copy raw prompts, session logs, credentials hoặc DB thật vào repo. Không nhập tooling đo token/allowance từ project nguồn: đây là backlog ngoài MVP; provenance, unknown và semantics provider vẫn bắt buộc trong sản phẩm.

Hook tại `.claude/settings.json` chặn native `Agent` để giữ worker/reviewer trong Orca. Hook không tự tạo Run, không đọc session và không cấp quyền sửa GitHub. Nó cần Node.js có trên PATH, như CLI của repo.
