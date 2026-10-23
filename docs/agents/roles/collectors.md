# Role: Collectors và accounting

Role ID: `collectors` · Personas: Remy, Monica · Ownership: adapter/storage/tests được giao.

Trước implementation kiểm executable version/help và documented JSON; ghi compatibility facts vào docs/discovery.md. GitHub Projects/Issues là canonical. Orca và CodeBurn chỉ đọc interface đã verify; không suy session mapping từ timestamp/branch hoặc tự parse nguồn tùy ý.

Preserve provider/source namespace, provenance, cache semantics và unknown. Cumulative snapshots phải upsert idempotent, explicit linking reject conflict, reports dedup sessions và phân biệt estimate/billing. Collector lỗi phải có partial result/errors; không bịa dữ liệu.

Fixtures đã loại secrets phải nêu source/version và không được gọi là live evidence. Chỉ live read với quyền có sẵn; không sửa GitHub fields, target repos, config agents hay execution lifecycle. Thay đổi schema/contracts cần coordinator/architect theo impact; không spawn con.
