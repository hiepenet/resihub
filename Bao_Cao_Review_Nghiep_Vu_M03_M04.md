# Báo cáo Review nghiệp vụ — M03 Bất động sản & M04 Hồ sơ cư dân

> **Phạm vi:** CRUD Tòa nhà / Khu / Tầng / Căn hộ · Sơ đồ trạng thái căn hộ · Hồ sơ cư dân
> **Căn cứ:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md`
> **Code đối chiếu:** `api/src/` (migrations + routes) và `frontend/src/`
> **Ngày lập:** 21/10/2026

---

## PHẦN 1 — PHÂN TÍCH NGHIỆP VỤ THEO PRD v2.0

### 1.1. CRUD Tòa nhà / Khu / Tầng / Căn hộ (M03 — FR-007, FR-008, FR-009, FR-010)

**Cây cấu trúc PRD:** `Tổ chức → Tòa nhà → Khu/Block → Tầng → Căn hộ`

| Yếu tố | Quy tắc nghiệp vụ PRD |
|---|---|
| **Tòa nhà** | Mã định danh duy nhất trong tổ chức; gắn `owner` (chủ sở hữu — FR-070, 5–7 tòa thuê lại); trạng thái ACTIVE/INACTIVE; chứa tài khoản nhận tiền (cá nhân → hộ kinh doanh); điều khoản thuê lại |
| **Khu/Block** | Màn hình riêng trong sitemap admin (mục 8.2: "Tòa nhà · Khu/Block · Tầng · Căn hộ") |
| **Tầng** | Cây cấu trúc, mã định danh duy nhất theo tòa (FR-007) |
| **Căn hộ** | `code` unique **theo tòa** (13.3); dữ liệu vào: `building_id, floor_id, code, area_m2, type, bedrooms, base_rent, amenities[], note`; tạo xong → **AVAILABLE** (FR-008 luồng chính) |
| **Ngoại lệ FR-008** | Mã căn trùng → chặn + *gợi ý mã kế tiếp*; **xóa căn đang có HĐ hiệu lực → chặn, chỉ cho INACTIVE**; sửa diện tích khi đang có HĐ → cảnh báo + audit |
| **Phân quyền (6.2)** | MANAGER: **CRU** (giới hạn tòa được gán); OWNER: **R**; RESIDENT: R (căn của mình); SYS_ADMIN: CRUD |
| **Cross-cutting (mục 9)** | Tìm kiếm, bộ lọc, phân trang, xuất CSV, lịch sử/audit tab, ghi chú nội bộ |

### 1.2. Sơ đồ trạng thái căn hộ (FR-010)

```
                    ┌──────────────┐  khách đặt giữ chỗ (FR-067)
   (khởi tạo) ────► │  AVAILABLE   │ ◄──── quá hạn giữ chỗ / hủy (hoàn hoặc mất cọc)
                    └──────┬───────┘ ◄──── hết hạn hợp đồng, sau khi BÀN GIAO (mục 7.5)
                           │ ký hợp đồng ACTIVE (FR-014)
              ┌────────────┼────────────┐
              ▼            │            ▼
        ┌───────────┐      │      ┌──────────────┐
        │ RESERVED  │      └────► │  OCCUPIED    │ ── chấm dứt HĐ + bàn giao ──► về AVAILABLE
        └───────────┘             └──────────────┘
        (khóa căn,                    ▲
         hết hạn →                    │ bảo trì định kỳ / sự cố
         EXPIRED trả căn)        ┌──────────────┐     ┌──────────────┐
                                 │ MAINTENANCE  │ ──► │  INACTIVE    │  (rút khỏi khai thác,
                                 └──────────────┘     └──────────────┘   không tính lấp đầy)

Trạng thái chuẩn FR-008: AVAILABLE · RESERVED · OCCUPIED · MAINTENANCE · INACTIVE
```

Quy tắc chuyển trạng thái **khóa chặt với vòng đời hợp đồng**: căn chỉ OCCUPIED khi HĐ ACTIVE; căn chỉ về AVAILABLE **sau khi bàn giao** (7.5); RESERVED chỉ sinh ra từ cọc giữ chỗ và tự trả AVAILABLE khi hết hạn/hủy. Ràng buộc nền tảng: **một căn không được có 2 HĐ chồng lấn kỳ hạn** — PRD 13.3 yêu cầu chặn bằng **Exclusion constraint ở tầng DB**, không chỉ ở ứng dụng.

### 1.3. Hồ sơ cư dân (M04 — FR-011, FR-012, FR-021)

- **Cấu trúc dữ liệu**: `person` (PII: tên, SĐT, email, ngày sinh, CCCD, ảnh giấy tờ) làm nền cho `tenant` (`type: primary/occupant`, `status: PENDING/APPROVED/REJECTED/MOVED_OUT`); thành viên hộ gắn với hợp đồng qua `contract_occupant.relationship`.
- **FR-011**: MANAGER tạo hồ sơ (CRU) — thông tin cá nhân, giấy tờ, quan hệ.
- **FR-012**: cư dân tự khai từ cổng → trạng thái **PENDING → BQL duyệt (APPROVED/REJECTED)**.
- **FR-021**: trùng SĐT **hoặc CCCD** → chặn tạo mới, hiển thị bản ghi trùng, hợp nhất có audit. DB phải có unique `person(org_id, phone)` **và** `person(org_id, id_number)` khi không null (13.3).
- **PII (17.1)**: STAFF không được thấy CCCD (chỉ tên + SĐT trong phạm vi work order); che một phần trên UI; RLS ở PostgreSQL.

---

## PHẦN 2 — ĐỐI CHIẾU CODE vs PRD (những điểm ĐÃ ĐÚNG)

| # | Điểm đạt | Bằng chứng |
|---|---|---|
| 1 | DB statuses căn hộ khớp 100% PRD: `AVAILABLE/RESERVED/OCCUPIED/MAINTENANCE/INACTIVE` | `003_real_estate.sql:37-38` |
| 2 | Tiền lưu BIGINT VND nguyên, không float; `UNIQUE(building_id, code)`; `CHECK(end_date > start_date)` | `003_real_estate.sql`, `005_contracts.sql:27` |
| 3 | RBAC khớp ma trận 6.2: MANAGER CRU, OWNER R, RESIDENT bị chặn admin route | `buildings.js`, `apartments.js`, `router/index.jsx` |
| 4 | RLS FORCE ROW LEVEL SECURITY + policy tách SELECT/INSERT/UPDATE/DELETE, helper default-deny | `010`, `013_rls_fixes.sql` (NFR-008) |
| 5 | FR-010 sơ đồ trạng thái theo tầng: lưới màu 5 trạng thái + legend + click mở panel chi tiết | `BuildingsPage.jsx:560-650` |
| 6 | Luồng giữ chỗ đúng nhánh: chỉ giữ chỗ căn AVAILABLE → RESERVED; hủy/hoàn trả AVAILABLE | `reservations.js:95-101, 229-232, 282-285` |
| 7 | Chặn INACTIVE tòa khi còn HĐ ACTIVE | `buildings.js:308-320` |
| 8 | Audit log cho create/update tòa + căn hộ; check mã tòa realtime | `buildings.js:238-242`, `apartments.js:115-119` |
| 9 | STAFF bị chặn khỏi route cư dân (bảo vệ PII); UI che CCCD theo vai trò | `tenants.js:12,51`, `TenantsPage.jsx:119` |
| 10 | Quy tắc 4 mắt "người lập ≠ người duyệt" đã hiện diện ở cọc | `deposits.js` |

---

## PHẦN 3 — SAI NGHIỆP VỤ & THIẾU SÓT (xếp theo mức độ)

### 🔴 Nhóm A — SAI NGHIỆP VỤ, cần sửa trước khi chạy dữ liệu thật

**A1. Chấm dứt hợp đồng → căn hộ nhảy AVAILABLE ngay lập tức — SAI theo PRD 7.5**
- **Chỗ sai**: `contracts.js:275-279` — khi terminate, `UPDATE apartment SET status='AVAILABLE'` ngay.
- **Vì sao sai**: PRD 7.5 quy định rõ *"căn hộ về AVAILABLE chỉ sau khi bàn giao"*. Thực tế chấm dứt HĐ chưa xong chuỗi tất toán (FR-024: chốt chỉ số cuối → hóa đơn cuối kỳ → tất toán cọc). Với code hiện tại: cọc vẫn HELD, hóa đơn cuối chưa phát hành mà căn đã hiện **"🟢 Có sẵn"** và cho khách khác đặt cọc giữ chỗ ngay → nguy cơ 2 bên cùng đòi quyền ở, tranh chấp cọc.
- **Giải pháp** (diff nhỏ nhất): terminate → chuyển căn sang `MAINTENANCE` (ý nghĩa "khóa, dọn dẹp, chờ tất toán"); chỉ về `AVAILABLE` sau bước bàn giao/tất toán hoàn tất. Thêm guard: chặn terminate khi `deposit.status = 'HELD'` chưa mở tất toán (hoặc cảnh báo rõ).

**A2. Sơ đồ trạng thái căn hộ không có máy trạng thái — API cho đặt status tùy ý, kể cả OCCUPIED → AVAILABLE khi còn hợp đồng**
- **Chỗ sai**: `apartments.js:135-189` — PATCH nhận `status` không validate; không có check hợp đồng ACTIVE; không có bảng chuyển đổi hợp lệ; DB cũng không có trigger.
- **Vì sao sai**: MANAGER chủ tay sửa căn đang thuê thành "Có sẵn" → căn trống trong báo cáo lấp đầy (KPI G7/RP-03 sai), cho khách đặt giữ chỗ lên căn có người → đúng tình huống tranh chấp PRD hướng đến giải quyết.
- **Giải pháp**: whitelist transition `AVAILABLE↔RESERVED↔OCCUPIED`, `AVAILABLE↔MAINTENANCE↔INACTIVE`; chặn rời OCCUPIED khi tồn tại `contract.status='ACTIVE'` (bắt đi qua terminate). 1 hàm guard ~15 dòng dùng chung cho POST/PATCH.

**A3. Tạo hợp đồng không kiểm tra trạng thái căn hộ + bỏ DRAFT, nhảy thẳng ACTIVE**
- **Chỗ sai**: `contracts.js:113-231` — POST `/contracts` không kiểm tra `apartment.status`; chèn thẳng `status='ACTIVE'`; set `OCCUPIED` ngay cả khi `start_date` trong tương lai.
- **Vì sao sai**: (1) FR-014 điều kiện trước: căn phải ở **AVAILABLE/RESERVED** — hiện có thể ký hợp đồng lên căn MAINTENANCE/INACTIVE; (2) FR-014 luồng chính: lưu **DRAFT** → tải bản ký → **ACTIVE**, căn mới OCCUPIED — code bỏ toàn bộ DRAFT/PENDING_APPROVAL dù DB enum có sẵn; căn hiển thị "Đang thuê" trước cả khi khách vào ở (nên là RESERVED cho đến ngày bắt đầu).
- **Giải pháp**: thêm check `status IN ('AVAILABLE','RESERVED')` trước khi insert; nếu `start_date > hôm nay` → giữ căn RESERVED (hoặc thêm trạng thái HĐ theo ngày hiệu lực). Vấn đề DRAFT→ACTIVE: chủ động chốt giản lược hay làm đủ (endpoint `/contracts/:id/activate` theo thiết kế API 14.3) — cần quyết định của bạn.

**A4. Overlap check dùng trạng thái không tồn tại + thiếu Exclusion constraint ở DB**
- **Chỗ sai**: `contracts.js:164` — `status IN ('ACTIVE', 'PENDING')`: enum hợp đồng là `DRAFT/PENDING_APPROVAL/ACTIVE/RENEWAL_PENDING/EXPIRED/TERMINATED/CANCELLED` (005_contracts.sql:16-20), không có `'PENDING'`. Điều kiện luôn loại DRAFT/PENDING_APPROVAL/RENEWAL_PENDING.
- **Vì sao sai**: hiện chưa lộ vì mọi HĐ đều được tạo ACTIVE ngay (A3), nhưng đây là bẫy ngầm: khi nào bật luồng DRAFT thì 2 HĐ nháp chồng lấn sẽ không bị chặn. PRD 13.3 còn yêu cầu **Exclusion constraint `apartment_id + daterange` ở tầng DB** — DB hiện chỉ có CHECK, không có ràng buộc chống chồng lấn → 2 request đồng thời có thể vượt qua check ở ứng dụng.
- **Giải pháp**: sửa điều kiện thành `status IN ('DRAFT','PENDING_APPROVAL','ACTIVE','RENEWAL_PENDING')`; thêm ràng buộc DB: `EXCLUDE USING gist (apartment_id WITH =, daterange(start_date, end_date) WITH &&) WHERE (status IN ('ACTIVE','RENEWAL_PENDING'))`.

**A5. Luồng cọc giữ chỗ đứt gãy — "chuyển thành cọc hợp đồng" (FR-067) không tồn tại trong thực tế**
- **Chỗ sai** (3 mảnh):
  1. `reservations.js:155-196` — `/reservations/:id/convert` chỉ đổi status reservation thành CONVERTED, **không tạo deposit, không gắn `deposit.source_reservation_id`** (cột có sẵn trong `006_deposits.sql:6` nhưng không code nào từng set — đã grep toàn repo).
  2. `ContractsPage.jsx:79` — form lập hợp đồng chỉ load căn `status=AVAILABLE` → **căn RESERVED (khách đã cọc giữ chỗ) không thể chọn để ký hợp đồng từ UI**; endpoint convert không được gọi ở bất kỳ đâu trong frontend.
  3. `hold_until` không bao giờ được đối chiếu với ngày hiện tại ở bất kỳ job/endpoint nào → reservation kẹt HELD vĩnh viễn, căn kẹt RESERVED vĩnh viễn.
- **Vì sao sai**: FR-067 chốt: *"Khi ký hợp đồng → cọc giữ chỗ **chuyển thành** cọc hợp đồng; khách hủy hoặc **quá hạn** → chính sách mất cọc/hoàn cọc"*. Cả 3 nhánh đều đứt.
- **Giải pháp**: trong POST `/contracts` (khi căn RESERVED): UPDATE reservation → CONVERTED + INSERT deposit với `source_reservation_id` trong cùng transaction; UI cho chọn căn AVAILABLE + RESERVED; thêm cron hằng ngày: `hold_until < today AND status='HELD'` → EXPIRED + trả căn AVAILABLE (theo chính sách mất/hoàn cọc cần chủ đầu tư chốt — câu hỏi mở số 6 mục 23).

**A6. FR-012 thiếu nửa sau — hồ sơ cư dân tự khai PENDING không bao giờ được duyệt**
- **Chỗ sai**: `resident.js:191-258` tạo tenant PENDING, nhưng **không tồn tại endpoint nào UPDATE tenant status** (grep toàn repo chỉ thấy `approved_by` ở deposits.js); `TenantsPage.jsx` không có nút duyệt/từ chối.
- **Vì sao sai**: FR-012 quy định vòng đời `PENDING → APPROVED/REJECTED` bởi BQL. Hồ sơ kẹt PENDING vĩnh viễn → không bao giờ ký được hợp đồng (FR-014 điều kiện trước: cư dân đại diện phải APPROVED).
- **Giải pháp**: thêm `PATCH /api/v1/tenants/:id/status` (MANAGER, body `{status, reason}`) + 2 nút Duyệt/Từ chối trên hàng của TenantsPage. ~30 dòng.

**A7. FR-021 xử lý trùng cư dân sai so với PRD**
- **Chỗ sai**:
  1. `002_organization_users.sql:43` — `person` chỉ có `UNIQUE(org_id, phone)`, **thiếu unique theo `id_number`** (PRD 13.3 quy định rõ).
  2. `tenants.js:112-124` — POST chỉ khớp theo phone; **CCCD trùng + SĐT khác → tạo person trùng CCCD** thoải mái.
  3. Khi trùng SĐT: tự dùng lại person cũ **không đối chiếu tên/CCCD, không ghi audit "hợp nhất"**; tenant hiện tại có thể tạo 2 lần cùng type='primary' cho 1 person (không unique `tenant(person_id, org_id, type)`).
- **Vì sao sai**: FR-021: *"Chặn tạo mới, hiển thị bản ghi trùng, cho phép hợp nhất **có audit**"*. UI (`TenantsPage.jsx:205-213`) chỉ cảnh báo rồi vẫn cho tạo — người vận hành không có cách chặn.
- **Giải pháp**: thêm `CREATE UNIQUE INDEX ... ON person(org_id, id_number) WHERE id_number IS NOT NULL`; POST check cả phone + id_number; khi trùng → trả 409 kèm bản ghi trùng và cho người dùng xác nhận "gắn vào hồ sơ có sẵn" (ghi audit) thay vì tạo tenant mới.

**A8. Hồ sơ cư dân thiếu chữ U (CRU)**
- **Chỗ sai**: `tenants.js` chỉ có GET/POST; `TenantsPage.jsx` không có sửa. Không có cách sửa tên/email/CCCD/dob, không có cách chuyển MOVED_OUT.
- **Vì sao sai**: ma trận 6.2 — MANAGER **CRU** trên cư dân; FR-011 là "hồ sơ cư dân & thành viên hộ" với quyền CRU.
- **Giải pháp**: `PATCH /api/v1/tenants/:id` cập nhật person + tenant.status, ghi audit trước/sau (mẫu đã có sẵn ở apartments PATCH).

**A9. Cho phép sửa `area_m2` căn hộ đang thuê mà không có guard cảnh báo**
- **Chỗ sai**: `apartments.js:157-175` — UPDATE `area_m2` trực tiếp, không kiểm tra hợp đồng ACTIVE, không trả cảnh báo về client (audit được ghi nhưng PRD yêu cầu *cảnh báo + audit*).
- **Vì sao sai**: FR-008 luồng ngoại lệ: *"Sửa diện tích khi đang có hợp đồng → cảnh báo ảnh hưởng cách tính phí, ghi audit"*.
- **Ghi chú**: với mô hình giá hiện tại (thuê theo `contract.rent_amount`, dịch vụ ghi đè theo hợp đồng — FR-065), diện tích chưa trực tiếp dẫn tới sai tiền; tác động thật là thấp hơn mức "sai nghiệp vụ chặn dữ liệu". Nhưng quy tắc cảnh báo là cam kết PRD, giữ nguyên.
- **Giải pháp**: trong PATCH, nếu căn đang có HĐ ACTIVE và payload có `area_m2` → yêu cầu client gửi `confirm_recalculate_fees: true` (hiện ConfirmDialog cảnh báo), không có cờ → trả 409 `AREA_CHANGE_REQUIRES_CONFIRM`. Audit log đã ghi sẵn trước/sau.

### 🟡 Nhóm B — THIẾU CHỨC NĂNG theo phạm vi nhiệm vụ

**B1. Thiếu toàn bộ tầng "Khu/Block"** — PRD mục 8.2 và nhiệm vụ đều nêu Tòa → **Khu** → Tầng → Căn hộ. DB/API/UI không có bảng `zone` nào. → Thêm bảng `zone (id, org_id, building_id, code, name)` + `floor.zone_id` + filter theo khu ở floor-map; hoặc nếu chủ đích giản lược cho 1 tòa 50 căn thì **cập nhật PRD/sitemap** để không ai coi là lỗi sau này. Cần bạn chốt hướng.

**B2. Trạng thái MAINTENANCE & INACTIVE là "chữ chết"** — DB và legend màu có, nhưng:
- Panel chi tiết căn (`BuildingsPage.jsx:713-760`) chỉ có nút giữ chỗ/hủy giữ chỗ — **không có thao tác nào đưa căn vào MAINTENANCE/INACTIVE**;
- Không endpoint riêng, chỉ PATCH chung nhận status mà UI không gọi.
→ Bổ sung 2 action "Bảo trì / Ngừng kinh doanh (và quay lại)" trong panel, đi qua guard ở A2.

**B3. Thiếu Update tòa nhà và Update tầng**
- `buildings.js` chỉ có `PATCH /:id/status` — không sửa được name/address/owner/payment_account (CRU thiếu U); tầng chỉ có POST + GET — không sửa được level/name.
- Bonus bug: `buildings.js:163` nhận `owner_id` không validate `owner.org_id = org` (FK chỉ kiểm tra tồn tại → có thể gắn owner của tổ chức khác).
- *(Bổ sung từ review vòng 2)*: form tạo tòa chưa có ô chọn `owner_id`; `lease_terms` chỉ ghi được lúc tạo, không xem/sửa sau đó. **Building Switcher đã tồn tại** trên TopBar (`TopBar.jsx:22-25, 47-51, 88-94, 182` — persist localStorage + phát event `buildingChanged`), nhưng các trang con **chưa lắng nghe event này** (VD `ContractsPage.jsx:68` tự load building đầu tiên, bỏ qua ngữ cảnh đã chọn) → switcher hiện chỉ là decor.
→ Thêm PATCH `/buildings/:id` (generic) và `PATCH /buildings/:id/floors/:floor_id`; validate owner theo org; các trang admin lắng nghe `buildingChanged` để đồng bộ ngữ cảnh tòa.

**B4. Tạo căn hộ nhận `status` từ client + không validate tầng thuộc tòa**
- `apartments.js:73,108` — chấp nhận `status` bất kỳ từ payload (FR-008: tạo xong luôn AVAILABLE); `floor_id` **không kiểm tra thuộc cùng building** → căn tòa A gắn tầng tòa B, sơ đồ tầng hiển thị sai.
→ Bỏ `status` khỏi payload (hard-code AVAILABLE), JOIN floor để xác thực `floor.building_id = building_id` (~5 dòng).

**B5. Không có job hết hạn hợp đồng + cảnh báo 60/30/15 (FR-018, P0)** — hợp đồng hết `end_date` vẫn đứng ACTIVE vĩnh viễn, căn vẫn OCCUPIED. → Cron hằng ngày: HĐ quá hạn → EXPIRED; sinh thông báo mốc 60/30/15. (Thuộc chuỗi job 12.4, chưa có khung Worker nào trong repo.)

**B6. Thiếu giao diện và API quản lý Thành viên cùng ở (Occupants) trong hộ** *(bổ sung từ review vòng 2)*
- **Chỗ sai**: bảng `contract_occupant` (có cột `relationship`) tồn tại nhưng **chỉ được tham chiếu đúng 1 lần** trong toàn bộ API (`tenants.js:74`, dùng để lọc danh sách) — không có CRUD endpoint, không có UI. `TenantsPage.jsx` là bảng phẳng, không xem được thành viên theo căn hộ/hợp đồng, không có form khai báo người ở cùng đi kèm khách thuê chính.
- **Vì sao sai**: PRD 13.2 — tenant `type: primary/occupant`, quan hệ n-n với contract qua `contract_occupant.relationship`; FR-011 là "Hồ sơ cư dân **& thành viên hộ**"; RESIDENT được khai báo thành viên hộ mà mình (6.2).
- **Giải pháp**: `GET /api/v1/contracts/:id/occupants` + `POST` thêm occupant (tái dùng POST /tenants với type=occupant rồi insert `contract_occupant`), hiển thị danh sách thành viên trong tab chi tiết Hợp đồng.

**B7. Thiếu lưu trữ Giấy tờ tùy thân & ảnh CCCD (`person.id_images[]`)** *(bổ sung từ review vòng 2)*
- **Chỗ sai**: cột `person.id_images TEXT[]` (002:40) và bảng `attachment` (007) tồn tại nhưng **không route upload nào tồn tại** — form tạo cư dân chỉ có input text (full_name, phone, id_number, email).
- **Vì sao sai**: PRD 13.2 định nghĩa `id_images[]` là PII mức cao (13.5: bucket riêng, phân quyền chặt, audit truy cập); FR-011 nêu "giấy tờ"; AI-01 (trích xuất CCCD) dựa trên ảnh này.
- **Giải pháp**: endpoint upload ảnh CCCD (mặt trước/sau) gắn vào `attachment(owner_entity='person')`, cập nhật `person.id_images`; bắt buộc ghi audit mỗi lần xem/tải tệp (17.1 #5). AI-01 OCR để sau (MVP chấp nhận nhập tay — đúng ưu tiên của PRD).

**B8. Chưa cụ thể hóa cơ chế Bàn giao: MAINTENANCE → AVAILABLE** *(bổ sung từ review vòng 2)*
- **Chỗ sai**: báo cáo vòng 1 (mục A1) đề xuất terminate → MAINTENANCE nhưng **chưa chỉ rõ cơ chế nào đưa căn quay lại AVAILABLE** — chu trình bị hở một nửa.
- **Vì sao sai**: PRD 7.4/7.5 — căn về AVAILABLE sau khi hoàn tất kiểm tra căn hộ + bàn giao; nếu không có thao tác "bàn giao" thì căn sẽ kẹt MAINTENANCE vĩnh viễn, tệ không kém kẹt OCCUPIED.
- **Giải pháp**: thêm endpoint `PATCH /api/v1/apartments/:id/handover` (MANAGER): guard yêu cầu `status = 'MAINTENANCE'` **và** không còn HĐ ACTIVE → chuyển AVAILABLE + ghi audit; hiển thị nút "Xác nhận bàn giao & nghiệm thu phòng" trong Panel chi tiết căn hộ (đi qua guard máy trạng thái ở A2).

**B9. Cổng cư dân thiếu màn hình Hồ sơ cá nhân tự phục vụ (P8 — mục 8.1)** *(bổ sung từ review vòng 2)*
- **Chỗ sai**: `ResidentPortalPage.jsx` có luồng nộp hồ sơ nhận nhà (FR-012) nhưng **không có form xem/cập nhật thông tin cá nhân**; `resident.js` không có endpoint PATCH profile.
- **Vì sao sai**: PRD 8.1 liệt kê trang P8 "Hồ sơ cá nhân"; ma trận 6.2 cho RESIDENT: **RU (của mình)** — R có (GET /overview trả person), U thiếu.
- **Giải pháp**: `PATCH /api/v1/resident/profile` (email, dob; SĐT/CCCD đổi phải theo quy trình xác minh 14.2) + một form "Hồ sơ cá nhân" trên portal.

### 🟢 Nhóm C — Lỗi nhỏ / lint nghiệp vụ

| # | Vấn đề | Vị trí | Giải pháp |
|---|---|---|---|
| C1 | Panel chi tiết căn hộ hiển thị **amenities cứng** (Wifi/Điều hòa/Nóng lạnh/Khóa từ) — không đọc `apt.amenities` → dữ liệu giả trên UI | `BuildingsPage.jsx:701-709` | Render từ `selectedApartment.amenities` (JSONB) |
| C2 | FR-008 yêu cầu "chặn trùng mã + **gợi ý mã kế tiếp**" — hiện chỉ 409 từ `23505`, không gợi ý | `apartments.js:123-125` | Query max code theo tầng, gợi ý trong error message |
| C3 | Tầng không ghi audit_log (FR-006 áp mọi thay đổi dữ liệu) | `buildings.js:446-465` | Thêm 1 INSERT audit sau khi tạo tầng |
| C4 | Modal tạo tòa ghi "Actor: SYS_ADMIN" — vai trò này đã bị xóa (`012_remove_deprecated_roles.sql`) | `BuildingsPage.jsx:773` | Sửa chữ "Actor: MANAGER" |
| C5 | Nút "xóa tầng" trong UI là code chết (`isSysAdmin` luôn false) + endpoint DELETE tầng luôn 403 dù tầng rỗng | `BuildingsPage.jsx:602-610`, `buildings.js:478-504` | Cả hai nhất quán với MANAGER=CRU; nếu giữ quyết định bỏ SYS_ADMIN → ghi rõ trong PRD; nếu không, cho phép delete tầng **rỗng** |
| C6 | FR-009 tạo căn hộ hàng loạt theo mẫu tầng (P1) chưa có | — | Backlog Phase sau, đúng priority |
| C7 | Deactivate tòa không kiểm tra căn RESERVED đang giữ chỗ | `buildings.js:308-320` | Thêm đếm reservation HELD, chặn tương tự HĐ ACTIVE |
| C9 | Thiếu tính năng xuất danh sách cư dân phục vụ khai báo tạm trú (17.1 #8) | `tenants.js` | *(Chấp nhận có điều kiện)* Thêm nút Export CSV từ danh sách cư dân. **Lưu ý**: PRD ghi rõ mục này "có thể hỗ trợ — *cần xác nhận yêu cầu cụ thể*", chưa phải cam kết MVP; và mẫu khai báo cần trường `quê quán/hộ khẩu` mà `person` hiện chưa có. → Chốt phạm vi trước khi làm, không gánh nợ schema ảo |

---

## PHẦN 4 — KẾT LUẬN & THỨ TỰ XỬ LÝ ĐỀ XUẤT

Code đạt khung sườn tốt (RLS, RBAC, audit, sơ đồ tầng đúng hình dạng FR-010), nhưng **nghiệp vụ vòng đời căn hộ chưa "khóa" với vòng đời hợp đồng** — đây là phần cốt lõi nhất của M03 theo PRD. Thứ tự sửa hiệu quả nhất:

1. **A2 + B4** (guard máy trạng thái + validate tầng + bỏ status payload) — 1 hàm guard dùng chung, chặn toàn bộ lỗi tự tay đổi trạng thái.
2. **A1 + B8 + A5 + A3** (terminate → MAINTENANCE + handover endpoint; guard cảnh báo area_m2; check trạng thái căn khi ký HĐ) — khóa chuỗi AVAILABLE→RESERVED→OCCUPIED→bàn giao→AVAILABLE.
3. **A4 + A6 + A7** (overlap đúng enum + exclusion constraint; duyệt hồ sơ PENDING; unique CCCD).
4. **A8 + A9 + B3 + B6** (bổ sung chữ U cho cư dân, tòa/tầng; quản lý occupant).
5. **B1** (Khu/Block) — cần bạn chốt: làm hay giản lược và cập nhật PRD.
6. **B7 + B9** (upload CCCD + hồ sơ cá nhân portal).
7. Nhóm C — dọn trong 1 lượt.

### Các điểm cần chốt với chủ đầu tư / PM trước khi sửa

| Câu hỏi | Ảnh hưởng |
|---|---|
| B1: Làm Khu/Block hay giản lược (1 tòa → không cần khu)? | Quyết định có tạo bảng `zone` hay không |
| A3: Hợp đồng cần DRAFT → ký → ACTIVE đầy đủ, hay giữ giản lược tạo là ACTIVE ngay? | Ảnh hưởng luồng lập HĐ và overlap check |
| A5: Chính sách khi hết hạn giữ chỗ: mất toàn bộ / mất một phần / hoàn? (Câu hỏi mở #6 — mục 23 PRD) | Cron hết hạn giữ chỗ |
| A1: Sau chấm dứt HĐ, căn chuyển MAINTENANCE chờ bàn giao — bước bàn giao cần làm dưới dạng gì (nút xác nhận, biên bản)? | State machine + audit |

---

## PHỤ LỤC — THẨM ĐỊNH 8 GÓP Ý REVIEW VÒNG 2

Mỗi góp ý đã được kiểm chứng trực tiếp trên code trước khi chấp nhận/từ chối.

| Góp ý | Kết luận | Bằng chứng kiểm chứng |
|---|---|---|
| **1. Thiếu quản lý Thành viên hộ (Occupants)** | ✅ **CHẤP NHẬN** → đã thêm B6 | Grep toàn repo: `contract_occupant` chỉ xuất hiện đúng 1 lần (`tenants.js:74`, lọc danh sách). Không CRUD endpoint, không UI. Bảng tồn tại từ `005_contracts.sql:41-47`. Góp ý chính xác. |
| **2. Thiếu upload ảnh CCCD / quản lý PII** | ✅ **CHẤP NHẬN** → đã thêm B7 | `person.id_images TEXT[]` (002:40) và bảng `attachment` (007) tồn tại nhưng không route upload nào trong `api/src/routes`. Góp ý chính xác. Lưu ý: AI-01 OCR là MVP nhưng luồng upload + audit xem/tải là điều kiện cần. |
| **3. Thiếu Hồ sơ cá nhân trên Cổng cư dân (P8)** | ✅ **CHẤP NHẬN** → đã thêm B9 | `ResidentPortalPage.jsx` không có `api.patch/put` nào; `resident.js` không có PATCH profile. RBAC 6.2 cho RESIDENT "RU (của mình)" — R có, U thiếu. Góp ý chính xác. |
| **4. Bàn giao MAINTENANCE → AVAILABLE chưa cụ thể** | ✅ **CHẤP NHẬN** (đúng là hở của báo cáo vòng 1) → đã thêm B8 | Báo cáo vòng 1 nêu "chỉ về AVAILABLE sau bàn giao" nhưng chưa định nghĩa thao tác bàn giao. Bổ sung endpoint `handover` + nút trong panel — chu trình khép kín. |
| **5. Guard cảnh báo sửa `area_m2`** | ✅ **CHẤP NHẬN** → đã thêm A9 | `apartments.js:157-175` UPDATE thẳng, không check HĐ ACTIVE, không cảnh báo (có ghi audit). Báo cáo vòng 1 trích đúng quy tắc ở mục 1.1 nhưng sót khỏi danh sách lỗi — là thiếu sót thật của báo cáo. Ghi chú thêm: với giá theo hợp đồng (FR-065), tác động tiền hiện tại thấp, mức độ là "cảnh báo" chứ không phải "sai tiền". |
| **6. Thiếu Building Switcher + cấu hình FR-070** | ⚠️ **HỢP LÝ MỘT PHẦN** → đã gộp vào B3 | **Phần sai của góp ý**: Building Switcher **đã tồn tại** trên TopBar (`TopBar.jsx:22-25, 47-51, 88-94, 182`, persist localStorage, phát event `buildingChanged`). **Phần đúng**: các trang con chưa lắng nghe event (ContractsPage tự load building đầu tiên); form chưa có ô chọn owner; lease_terms không xem/sửa sau khi tạo. Đã cập nhật B3 phản ánh đúng cả hai. |
| **7. Sơ đồ căn hộ vi phạm WCAG (chỉ dùng màu)** | ❌ **TỪ CHỐI** | Góp ý đọc nhầm code. Mỗi ô căn hộ **đã chứa `StatusBadge`** với nhãn chữ + dot (`BuildingsPage.jsx:635`: `<StatusBadge status={apt.status} size="sm" />` — hiển thị "Có sẵn"/"Đang thuê"/"Đã cọc giữ chỗ"/"Bảo trì"/"Không kinh doanh"). Trạng thái đã được truyền đạt bằng văn bản, không chỉ màu → **đáp ứng** PRD 16.4 "không dùng riêng màu để truyền đạt trạng thái". Không cần bổ sung gì. |
| **8. Xuất danh sách khai báo tạm trú** | ⚠️ **CHẤP NHẬN CÓ ĐIỀU KIỆN** → đã thêm C9 | PRD 17.1 #8 ghi rõ đây là "có thể hỗ trợ — *cần xác nhận yêu cầu cụ thể*", không phải cam kết MVP. Cross-cutting "xuất CSV/Excel" (mục 9) hỗ trợ việc này. Thiếu trường dữ liệu (`quê quán`) trong `person` — nếu làm phải mở rộng schema. → Đưa vào backlog với điều kiện chốt phạm vi, không xếp P0. |

**Tổng kết:** 5 góp ý chấp nhận nguyên văn (1, 2, 3, 4, 5) · 1 góp ý hợp lý một phần, đã điều chỉnh lại bằng chứng (6) · 1 góp ý chấp nhận có điều kiện (8) · 1 góp ý từ chối vì không đúng với code thực tế (7). Báo cáo vòng 1 giữ nguyên kết luận chính; các mục mới A9, B6–B9, C9 đã được tích hợp vào Nhóm tương ứng và thứ tự xử lý ở Phần 4.
