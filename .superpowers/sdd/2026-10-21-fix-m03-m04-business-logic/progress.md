# SDD ledger — plan: docs/superpowers/plans/2026-10-21-fix-m03-m04-business-logic.md

Ruling: làm ngay trên branch `fix/auth-rls-runtime` (không worktree) — user yêu cầu bám 100% kế hoạch và commit từng fix vào repo làm việc; worktree sẽ tách commits khỏi nhánh user đang kỳ vọng. — Cost: nhánh chưa merge, review cuối sẽ trên chính nhánh này.

Ruling: curl verification dùng `localhost:5000` (docker-compose.yml map 5000), plan ghi `:3000` là của frontend — sai số ký, giữ ý, đổi port.

Ruling: `docker compose -f docker-compose.dev.yml` chỉ override lệnh, không dựng được riêng; các service container dùng được là `resihub-postgres` (đang healthy). API chạy local bằng `npm run dev --prefix api` khi cần curl.

Task 0 (setup): ensured DB up; env đọc từ `api/.env` (DATABASE_URL localhost:5433).

Pre-flight shared interfaces:
- T1 `isTransitionAllowed/APARTMENT_TRANSITIONS` → T3/T6/T8 consume: tên khớp Produces. OK.
- T8 `GET /api/v1/attachments/:id/view` → T15consume: khớp (T15 chỉ gọi). OK.
- T2 lỗi `FLOOR_MISMATCH`/`ZONE_MISMATCH` → T12 guard zone tái dùng `ZONE_MISMATCH`. OK.
- T4 overlap half-open SQL → T7 (POST) + T8 (re-check): cùng danh sách enum ('DRAFT','PENDING_APPROVAL','ACTIVE','RENEWAL_PENDING'). OK.
- T7 tạo DRAFT + không đụng căn/reservation → T8 activate đọc lại: reservation must HELD; OK.
- T9 SQL flip NOT EXISTS ↔ T5 terminate (MAINTENANCE) + T6 handover: job không đụng MAINTENANCE. OK.
- File dùng chung (apartments.js, contracts.js, tenants.js, buildings.js, BuildingsPage.jsx, ContractsPage.jsx) bị nhiều task sửa tuần tự — sẽ đọc trạng thái hiện hành trước mỗi lần sửa.
Task 1: complete (commits 1f3119f..18b1821, tests: npm test --prefix api -> 6/6 pass; ruling: node --test thay vi node --test test/)
Task 2: complete (verify curl: FLOOR_MISMATCH 400 + status=OCCUPIED -> AVAILABLE + 201 OK; Ruling: login tra accessToken, floors o /:id/floors)
Task 3: complete (commit 75176e8; verify: AVAILABLE->OCCUPIED/RESERVED 409 DIRECT_STATUS_CHANGE_PROHIBITED, OCCUPIED+ACTIVE -> 409, area sodi 409/confirm 200; Ruling: RLS van hoat dung - khi tu INSERT contract bang psql phai gan building_id, neu RLS an HD -> guard khong thay; suite node:test green)
Task 4: complete (verify: API 409 OVERLAP_CONTRACT + conflicts; psql 23P01; half-open 31/12 OK; suite node:test green)
Task 5: complete (verify curl: terminate H� ACTIVE -> contract TERMINATED + apartment MAINTENANCE)
Task 6: complete (verify: handover OK + canh bao deposit, lan 2 -> INVALID_STATUS; UI build pass)
Task 7: complete (verify: POST -> DRAFT, can AVAILABLE gi? nguy�n, 0 deposit; PATCH nh�p OK; non-DRAFT 409 CONTRACT_NOT_EDITABLE; GET multi-status OK)
Task 8: complete (verify T1-T10: MISSING_SIGNED_SCAN / MISSING_IDENTITY_PAPER / convert reservation HELD->CONVERTED + deposit source_reservation_id / apartment flip OCCUPIED-RESERVED / PRICE_NEEDS_APPROVAL commit treo + OWNER approve / attachments view 200 + audit READ / cancel DRAFT; RULING: PRICE_NEEDS_APPROVAL ph?i COMMIT (kh�ng ROLLBACK) � fix trong khi l�m; RULING: approve b? check gi� qua skipPriceCheck)
Task 9: complete (verify 4 steps job: HD qua han EXPIRED, RESERVED->OCCUPIED khi toi han, giu cho qua han EXPIRED, RESERVED->AVAILABLE voi NOT EXISTS - TRAP-01 khong flip lam; Step 1b harden forfeit/refund reservations.js; RULING: fixture SQL de ten ASCII tranh encoding)
Task 10: complete (verify: POST thieu CCCD -> PENDING, duyet thieu CCCD 409 MISSING_IDENTITY_PAPER, approve + CCCD -> APPROVED, dup phone 409 DUPLICATE_PERSON, POST du CCCD -> APPROVED; UI actions + edit modal)
Task 11: complete (verify: dup in org 23505, khac org cho phep, ';' khong ghim)
Task 12: complete (verify: POST zone 201, dup 409 ZONE_EXISTS, ZONE_MISMATCH 400, GET /:id co zones, PATCH INACTIVE, PATCH apartment zone; RLS zone copy tu floor 013)
Task 13: complete (verify: PATCH name/owner hop le, INVALID_OWNER 400, FLOOR_EXISTS 409, PATCH floor name; RULING: building khong co cot updated_at - bo trong UPDATE; GET /owners dat truoc /:id; UI edit modal + floor prompt edit + buildingChanged sync)
Task 14: complete (verify: add 201, reuse person theo S�T (person count=1), OCCUPANT_EXISTS 409, GET, DELETE gi? tenant/person; RULING: audit_log.entity_id l� UUID � kh�ng gh�p chu?i id)
Task 15: complete (verify: upload 201 + file disk + person.id_images marker + attachment row, side sai 400, GET side=front, view manager 200 image/png, RESIDENT 403 FORBIDDEN_ATTACHMENT, audit READ x2; RULING: user_role khong co cot org_id � guard PII dung p.org_id, id_images la cot person khuc tenant)
Task 16: complete (card Ho so cua toi B9 trong nhanh has_contract, user tu /resident/overview: full_name/phone/email/id_number; build pass)
Task 17: complete (C1 amenities that ta AMENITY_LABELS; C2 goi y ZT-102 khi 23505; C3 audit CREATE floor=1; C4 da sua San Task 13 - modal hien Module M03, khong con SYS_ADMIN; C7 RESERVED_APARTMENTS_EXIST khi con HELD, cho phep sau khi xoa; da xoa fixture c7_buildings.sql)
