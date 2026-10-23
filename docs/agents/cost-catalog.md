# Routing và cost tier

Coordinator xử lý phân việc/quyết định; Composer xử lý implementation có AC rõ; reviewer DoD/security dùng Codex trong session độc lập với tác giả. Codex implementation worker chỉ khi cần reasoning có lý do. User chỉ định agent/model thì ưu tiên chỉ định đó. Role, persona, provider và cost tier là bốn khái niệm riêng.

| Tier | Khi dùng | Routing tham khảo |
| --- | --- | --- |
| cheap | Docs, tooling hẹp, thu evidence, revalidate nhỏ | Inline trước; Composer worker nếu cần dispatch |
| standard | Feature, contract/storage, review runtime/security | Composer cho implementation; Codex cho reviewer |

Project nguồn pin `composer-2.5`, không dùng `composer-2.5-fast`; đây là dữ kiện nguồn, chưa validate runtime trong repo này. Không copy ngoại lệ Codex/quota của tài khoản nguồn. Không thêm tier heavy hoặc tự nâng model vì role quan trọng.

Trước spawn phải đọc guide Orca theo phiên bản host, kiểm executable/provider version + help và model catalog được host hỗ trợ. Chốt model/effort khả dụng, ghi requested/effective và lý do trong evidence. Không đoán flag/JSON field; nếu không quan sát được effective model thì ghi unknown, không gọi requested là effective. Không inherit UI/auto ngầm; pin bị reject thì refresh catalog và ghi limitation trước fallback trong budget.

Mặc định tối đa một implementation worker và một reviewer Codex live, trên paths không xung đột; review một artifact đã chốt SHA. Chỉ định Codex cho reviewer không cấp quyền mở thêm Codex implementation worker khi allowance chưa rõ. Chỉ tăng concurrency khi có nhu cầu và budget được giao. Không suy allowance từ tokens hoặc coi account delta là giá riêng task.

Không có preflight/spawn/telemetry helper được port ở slice này. Dùng CLI đã verify và evidence thủ công; không gọi scripts từ ticket-solution hay khẳng định setup đã có live receipt.
