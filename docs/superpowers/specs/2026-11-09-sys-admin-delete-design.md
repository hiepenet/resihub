# Thiết kế Hoàn thiện Chức năng Xóa (Delete) cho Vai trò SYS_ADMIN trên 4 Phân hệ

**Ngày:** 2026-11-09  
**Quy mô:** Hạng mục liên phân hệ (1 migration RLS mở/siết chính sách xóa đồng bộ PRD, bổ sung/nâng cấp API `DELETE` trên 5 route Backend kèm kiểm tra lịch sử + dọn `person` mồ côi + `audit_log`, và gắn giao diện Xóa/Khôi phục mặc định có hộp thoại xác nhận cho `SYS_ADMIN` trên 4 phân hệ Frontend)

## 1. Mục đích & Lý do (Intent & Why)
Theo ma trận phân quyền tại PRD v2.0 (Mục 6.2), vai trò `SYS_ADMIN` có toàn quyền `CRUD` trên 4 phân hệ cấu hình và danh mục nền tảng:
1. **Tòa / Khu / Tầng / Căn hộ (`M03`)**
2. **Cư dân & hồ sơ (`M04`)**
3. **Người dùng & phân quyền (`M01`)**
4. **Cấu hình hệ thống & tích hợp (`M01` / `M13` / `M15`)**

Hiện tại:
- Phân hệ **Bất động sản** đã có đủ 4 API `DELETE` ở Backend và hàm gọi ở `buildings.service.js`, nhưng trên giao diện mới gắn nút Xóa cho **Khu (`zone`)**, còn thiếu nút Xóa cho **Tòa (`building`)**, **Tầng (`floor`)** và **Căn hộ (`apartment`)** (đồng thời API xóa căn hộ cần kiểm tra thêm hóa đơn/chỉ số/yêu cầu kỹ thuật để không vướng khóa ngoại hoặc mất dữ liệu vận hành).
- Ba phân hệ **Cư dân & hồ sơ**, **Người dùng & phân quyền**, **Cấu hình hệ thống & tích hợp** chưa có API `DELETE` lẫn nút thao tác trên UI (riêng `zalo_group` còn đang chặn `DELETE` trong RLS và chưa mở quyền ghi cho `SYS_ADMIN`).

Khi vận hành thực tế, `SYS_ADMIN` thường cần xóa sạch các bản ghi khởi tạo nhầm (tòa/tầng/phòng tạo sai mã, hồ sơ cư dân hoặc tài khoản nhân sự nhập nhầm SĐT/CCCD/Email, nhóm Zalo gắn nhầm phòng, hoặc nhóm cấu hình muốn đưa về mặc định) để giải phóng các ràng buộc duy nhất (`UNIQUE` mã, SĐT, CCCD, Email) mà không làm ảnh hưởng đến dữ liệu tài chính – kiểm toán đã phát sinh.

## 2. Mục tiêu, Giới hạn & Điều cần tránh (Goals, Non-Goals, Anti-Goals)
- **Mục tiêu (Goals):**
  1. **Tòa / Khu / Tầng / Căn hộ**: Bổ sung kiểm tra lịch sử vận hành đầy đủ cho `DELETE /api/v1/apartments/:id` và `DELETE /api/v1/buildings/:id`, gắn nút Xóa kèm `ConfirmDialog` cho `SYS_ADMIN` đối với **Tòa trống**, **Tầng trống** và **Căn hộ chưa phát sinh lịch sử** trên `BuildingsPage`, `BuildingDetailPage`, `FloorPlanPage` và `ApartmentDetailPage`.
  2. **Cư dân & hồ sơ**: Cung cấp `DELETE /api/v1/tenants/:id` và `DELETE /api/v1/tenants/:id/id-images/:attachment_id` cho `SYS_ADMIN` để xóa hồ sơ cư dân chưa phát sinh nghiệp vụ và xóa ảnh CCCD tải nhầm; tự động dọn bản ghi `person` (cùng ảnh đính kèm) **chỉ khi** `person` không còn gắn với `tenant`, `app_user` hoặc `owner` nào khác; gắn nút Xóa trên `TenantsPage` và `TenantDetailPage`.
  3. **Người dùng & phân quyền**: Cung cấp `DELETE /api/v1/admin/users/:id` cho `SYS_ADMIN` (chặn tự xóa chính mình, chặn xóa `SYS_ADMIN` hoạt động cuối cùng, chặn xóa người dùng đã phát sinh lịch sử nghiệp vụ hoặc đang sở hữu tòa nhà); tự động dọn `owner` rỗng và `person` mồ côi để giải phóng Email/SĐT/CCCD; gắn nút Xóa trên `UsersPage`.
  4. **Cấu hình hệ thống & tích hợp**:
     - Cung cấp `DELETE /api/v1/settings/:key` cho `SYS_ADMIN` để xóa bản ghi cấu hình tùy chỉnh, khôi phục về mặc định chuẩn của hệ thống kèm nút **"Khôi phục mặc định"** trên `SettingsPage` và tab Cấu hình của `UsersPage`.
     - Mở RLS và RBAC trên `zalo_group` cho `SYS_ADMIN`, bổ sung `DELETE /api/v1/zalo-groups/:id` và gắn nút Xóa nhóm Zalo cho `SYS_ADMIN` trên tab Danh bạ Nhóm Zalo (`NotificationsPage`).
  5. Mọi thao tác xóa thành công đều ghi `audit_log` đầy đủ (`before` snapshot) và mọi truy cập trái quyền từ vai trò khác đều trả `403` kèm `logAccessDenied` (theo PRD Mục 6.2 & AC-019.1).
- **Không nằm trong phạm vi (Non-Goals):**
  - Không cho phép xóa nhật ký bất biến `audit_log` hay lịch sử gợi ý AI `ai_suggestion` (`REVOKE DELETE` theo PRD 14.3 & M15 — việc tắt AI tiếp tục dùng kill-switch `ai_config.enabled`).
  - Không thay đổi sang mô hình xóa mềm (`deleted_at`) vì hệ thống đã có sẵn các trạng thái nghiệp vụ tường minh (`INACTIVE`, `SUSPENDED`, `REJECTED`, `MERGED`, `is_active = false`).
  - Không mở quyền `DELETE` cho `MANAGER`, `OWNER` hoặc `RESIDENT` trên các phân hệ này.
- **Điều cần tránh (Anti-Goals):**
  - Tuyệt đối không xóa thẳng `person` trước khi kiểm tra liên kết chéo (`person` dùng chung cho cả `tenant`, `app_user` và `owner` với khóa ngoại `ON DELETE CASCADE` xuống `tenant`/`app_user` và `NO ACTION` từ `owner`).
  - Tuyệt đối không cho phép xóa bản ghi đã gắn với hợp đồng, hóa đơn, thanh toán, công nợ, tiền cọc hoặc nhật ký phê duyệt tài chính.
  - Không làm hỏng các mã lỗi/HTTP status hiện có của các API xóa tòa, tầng, khu đang được kiểm thử tự động.

## 3. Ràng buộc kỹ thuật (Constraints)
- **Quan hệ khóa ngoại thực tế trong PostgreSQL:**
  - `tenant.person_id -> person(id) ON DELETE CASCADE`, `app_user.person_id -> person(id) ON DELETE CASCADE`, nhưng `owner.person_id -> person(id) ON DELETE NO ACTION` và `building.owner_id -> owner(id) ON DELETE SET NULL`. Do đó khi dọn `person` mồ côi của tài khoản `OWNER` tạo nhầm (chưa gán tòa nào), phải xóa dòng `owner` không gắn tòa trước rồi mới xóa `person`.
  - `apartment` có `contract.apartment_id ON DELETE RESTRICT`, `invoice.apartment_id ON DELETE RESTRICT`, trong khi `meter`, `meter_reading`, `reservation`, `service_request`, `service_subscription`, `zalo_group` là `ON DELETE CASCADE`. Một căn hộ mới tạo có thể đã được hệ thống tự khởi tạo 2 công tơ `meter` mặc định (`ELECTRICITY`, `WATER`) chưa có `meter_reading` — trường hợp này vẫn phải cho phép xóa căn hộ, nhưng nếu đã có `meter_reading`, `invoice`, `service_request`, `service_subscription` thực tế, `contract` hoặc `reservation` thì phải chặn `409 APARTMENT_HAS_HISTORY`.
- **Chính sách FORCE ROW LEVEL SECURITY (`resihub_app`):**
  - `zalo_group` hiện có `rls_zalo_group_delete USING (FALSE)` và `rls_zalo_group_insert` / `rls_zalo_group_update` mới mở cho `is_manager()`. Cần migration `011` mở cho `is_org_admin()` trong phạm vi `org_id = get_current_user_org_id()`.
  - `meter` hiện chỉ có `rls_meter_modify` cho `is_manager()`; cần bổ sung `rls_meter_delete` cho `is_org_admin()` để cascade xóa công tơ rỗng khi xóa căn hộ không bao giờ vướng RLS.
  - `floor` hiện có `rls_floor_delete` mở cho cả `get_user_assigned_buildings()`; cần siết lại chỉ `is_org_admin()` đúng ma trận PRD 6.2 (`MANAGER` chỉ có `CRU`).
- **Thứ tự kiểm tra bảo mật chuẩn dự án:** Kiểm tra tồn tại bản ghi theo `org_id` (`404 NOT_FOUND` để chống dò ID chéo tổ chức) -> kiểm tra vai trò `SYS_ADMIN` (`403 DELETE_PROHIBITED` / `ACCESS_DENIED` + `logAccessDenied`) -> kiểm tra điều kiện ràng buộc dữ liệu (`400` / `409`) -> thực thi trong transaction + ghi `audit_log`.

## 4. Các hướng tiếp cận đã cân nhắc (Approaches)
1. **Hướng 1 — Xóa cứng có điều kiện (Guarded Hard Delete) + Dọn `person` mồ côi thông minh *(Đã chọn)*:**
   Chỉ cho phép xóa vĩnh viễn các bản ghi tạo nhầm / chưa phát sinh lịch sử nghiệp vụ, tự động dọn `person` (và `owner` rỗng / file đính kèm) khi không còn vai trò nào tham chiếu để giải phóng SĐT/CCCD/Email; nếu đã có lịch sử thì trả lỗi chặn rõ lý do để quản trị viên dùng cơ chế **Ngừng khai thác (`INACTIVE`)** hoặc **Tạm khóa (`SUSPENDED`)** tách biệt.
2. **Hướng 2 — Xóa kết hợp gợi ý chuyển trạng thái ngay trong hộp thoại (Hybrid Delete + Quick Deactivate):**
   Giữ nguyên quy tắc Backend của Hướng 1 nhưng gắn thêm nút chuyển nhanh sang `INACTIVE` / `SUSPENDED` ngay trong hộp thoại báo lỗi xóa trên UI. Tiện hơn đôi chút khi thao tác nhầm trên dữ liệu cũ nhưng làm phức tạp luồng modal và dễ gây nhầm lẫn giữa "Xóa vĩnh viễn" và "Tạm khóa".
3. **Hướng 3 — Xóa mềm toàn bộ bằng cột `deleted_at` (Soft Delete):**
   Ẩn mọi bản ghi khỏi danh sách kể cả khi đã có giao dịch, nhưng chồng chéo với các trạng thái nghiệp vụ sẵn có và buộc phải sửa hàng loạt câu truy vấn cùng toàn bộ `UNIQUE INDEX` (`phone`, `id_number`, `email`, `code`).

**Lý do chọn Hướng 1:** Người dùng đã chọn Hướng 1 vì an toàn tuyệt đối cho sổ sách tài chính & dấu vết kiểm toán, giải phóng sạch dữ liệu trùng khi nhập nhầm, không làm phình schema, và đồng nhất 100% với kiến trúc xóa Khu/Tòa hiện có của ResiHub.

## 5. Chi tiết thiết kế

### 5.1. Quyết định từ người dùng
- Triển khai đầy đủ chức năng **Delete** cho `SYS_ADMIN` trên cả 4 phân hệ còn thiếu.
- Áp dụng **Hướng 1 (Guarded Hard Delete)**: xóa cứng khi chưa phát sinh lịch sử nghiệp vụ (kèm dọn `person` mồ côi an toàn và ghi `audit_log`), chặn xóa khi đã có dữ liệu lịch sử và giữ tách biệt với các thao tác khóa / ngừng khai thác hiện hữu.

### 5.2. Đặc tả chi tiết theo từng phân hệ & Đề xuất kỹ thuật mặc định (Calls by Builder)

#### A. Migration Database (`api/src/db/migrations/005_rls_enable_and_policies.sql`)
- **`zalo_group`**:
  - Cập nhật `rls_zalo_group_insert` và `rls_zalo_group_update`: cho phép `((SELECT is_org_admin()) AND org_id = (SELECT get_current_user_org_id()))` bên cạnh quyền hiện có của `MANAGER` trên tòa được gán.
  - Cập nhật `rls_zalo_group_delete`: đổi từ `USING (FALSE)` sang `USING ((SELECT is_org_admin()) AND org_id = (SELECT get_current_user_org_id()))`.
- **`meter`**:
  - Bổ sung `rls_meter_delete` (`FOR DELETE USING ((SELECT is_org_admin()) AND org_id = (SELECT get_current_user_org_id()))`).
- **`floor`**:
  - Siết `rls_floor_delete` chỉ cho phép `(SELECT is_org_admin())` trên tòa thuộc `get_current_user_org_id()` để đồng bộ tuyệt đối với PRD 6.2.

#### B. Phân hệ 1 — Tòa / Khu / Tầng / Căn hộ (`M03`)
1. **Backend (`api/src/routes/buildings.js`, `api/src/routes/apartments.js`)**:
   - `DELETE /api/v1/buildings/:id`: Giữ mã `400 BUILDING_NOT_EMPTY` để tương thích ngược, mở rộng kiểm tra rỗng *(Đề xuất của hệ thống)* gồm `apartment`, `floor`, `zone`, `contract`, `reservation`, `invoice`, `service_request`, `announcement`, `ai_suggestion`, `zalo_group`, và `service_catalog` gắn tòa (đảm bảo tuyệt đối không để `ON DELETE CASCADE` xóa ngầm lịch sử `ai_suggestion` bất biến hoặc danh mục dịch vụ/nhóm Zalo riêng của tòa).
   - `DELETE /api/v1/buildings/:id/floors/:floor_id`: Giữ nguyên logic kiểm tra `SYS_ADMIN`, `0` căn hộ (`400 FLOOR_HAS_APARTMENTS`) và `audit_log`.
   - `DELETE /api/v1/apartments/:id`:
     - Kiểm tra căn hộ tồn tại thuộc `req.user.org_id` trước (`404 NOT_FOUND`), sau đó mới kiểm tra `SYS_ADMIN` (`403 DELETE_PROHIBITED` + `logAccessDenied`).
     - Mở rộng kiểm tra lịch sử *(Đề xuất của hệ thống)*: chặn `409 APARTMENT_HAS_HISTORY` nếu căn hộ đã có bất kỳ bản ghi nào trong `contract`, `reservation`, `invoice`, `meter_reading`, `service_request` hoặc `service_subscription`. (Nếu căn hộ chỉ mới có công tơ `meter` mặc định chưa ghi số lần nào thì cho phép xóa sạch).
2. **Frontend (`BuildingsPage.jsx`, `BuildingDetailPage.jsx`, `FloorPlanPage.jsx`, `ApartmentDetailPage.jsx`)**:
   - **Tòa nhà**: Hiển thị nút **Xóa** (chỉ khi `canManageBuildings` / `isSysAdmin`) tại cột thao tác `BuildingsPage.jsx` và thanh tiêu đề `BuildingDetailPage.jsx`. Nút chỉ bật khi tòa chưa có khu, tầng hay căn hộ (`total_apartments === 0 && floor_count === 0 && zone_count === 0`; nếu có dữ liệu thì disable kèm tooltip giải thích *"Chỉ xóa được tòa nhà trống chưa có khu, tầng hoặc căn hộ"* — các phụ thuộc sâu hơn như `ai_suggestion` / `service_catalog` nếu có sẽ được Backend trả thông báo rõ ràng). Khi xóa thành công: xóa khỏi `buildingStore` nếu đang được chọn, làm mới cache + phát sự kiện `resihub:buildings-updated`, điều hướng về `/admin/buildings`.
   - **Tầng**: Hiển thị nút **Xóa** bên cạnh từng tầng tại khu vực Danh sách tầng trong `BuildingDetailPage.jsx` và trên thanh tiêu đề mỗi tầng tại `FloorPlanPage.jsx` (chỉ hiển thị cho `canManageBuildings`; disable kèm tooltip nếu tầng đang có căn hộ `apartment_count > 0`). Xác nhận qua `ConfirmDialog`, gọi `buildingsService.deleteFloor`, làm mới sơ đồ tầng & thông tin tòa nhà.
   - **Căn hộ**: Hiển thị nút **Xóa căn hộ** trên thanh công cụ `ApartmentDetailPage.jsx` (chỉ cho `canManageBuildings`, disable nếu trạng thái đang `OCCUPIED` / `RESERVED`). Xác nhận qua `ConfirmDialog`, gọi `buildingsService.deleteApartment`, làm mới cache và quay lại sơ đồ tầng của tòa nhà.

#### C. Phân hệ 2 — Cư dân & Hồ sơ (`M04`)
1. **Backend (`api/src/routes/tenants.js`)**:
   - **`DELETE /api/v1/tenants/:id`**:
     - Kiểm tra `tenant` thuộc `req.user.org_id` (`404 NOT_FOUND`).
     - Nếu không phải `SYS_ADMIN`: ghi `logAccessDenied` và trả `403 { code: 'DELETE_PROHIBITED', message: '...' }`.
     - Kiểm tra lịch sử *(Đề xuất của hệ thống)*: trả `409 TENANT_HAS_HISTORY` nếu:
       - `tenant.id` xuất hiện trong `contract` (`primary_tenant_id`), `contract_occupant`, `invoice`, `payment`, `receivable`, `credit_balance`, hoặc `service_request`, **hoặc**
       - Số điện thoại `person.phone` của hồ sơ này đã có bản ghi giữ chỗ trong `reservation` (`WHERE org_id = $1 AND phone = person.phone`, vì `reservation` liên kết với cư dân qua SĐT).
     - Xử lý tài khoản `RESIDENT` tự động sinh kèm và dọn `person` mồ côi trong transaction `BEGIN ... COMMIT` *(Đề xuất của hệ thống)*:
       1. `DELETE FROM tenant WHERE id = $1 AND org_id = $2 RETURNING *`.
       2. Do khi tạo cư dân hệ thống luôn tự gọi `ensureResidentAccount(person_id)` tạo sẵn `app_user` + `user_role(RESIDENT)`, nếu sau khi xóa `tenant` mà `person_id` **không** còn `tenant` nào khác và **không** có dòng `owner`, hệ thống kiểm tra `app_user` gắn với `person_id`:
          - Nếu `app_user` đó **chỉ** mang vai trò `RESIDENT` (không có vai trò nội bộ `SYS_ADMIN` / `OWNER` / `MANAGER`) **và** chưa phát sinh bất kỳ dấu vết nào trong `audit_log` hay bảng nghiệp vụ (theo cùng bộ kiểm tra ở mục D), hệ thống tự động xóa luôn `app_user` đó để tiến tới dọn sạch `person`.
          - Nếu `person_id` còn gắn với tài khoản nội bộ hoặc `app_user` đã có dấu vết `audit_log`, giữ nguyên `app_user` và `person`.
       3. Khi `person_id` đã hoàn toàn không còn `tenant`, `app_user` và `owner` nào tham chiếu: truy vấn danh sách `attachment` (`owner_entity = 'person' AND owner_id = person_id`), xóa các dòng `attachment` đó và xóa dòng `person` (giải phóng trọn vẹn SĐT / CCCD / Email bị nhập nhầm chỉ trong 1 thao tác).
       4. Ghi `audit_log` (`action = 'DELETE'`, `entity = 'tenant'`, `entity_id = id`, `before = { ...tenantSnapshot, resident_user_deleted: boolean, person_deleted: boolean }`).
     - Sau khi `COMMIT`: xóa file vật lý trong `uploads/` tương ứng các `attachment` đã dọn (best-effort, bỏ qua nếu file không tồn tại).
   - **`DELETE /api/v1/tenants/:id/id-images/:attachment_id`**:
     - Chỉ `SYS_ADMIN` (`403 DELETE_PROHIBITED` + `logAccessDenied` với vai trò khác).
     - Kiểm tra `tenant` thuộc `org_id` và `attachment` thuộc `owner_entity = 'person' AND owner_id = tenant.person_id` (`404 NOT_FOUND` nếu không khớp).
     - Trong transaction: gỡ phần tử JSON có `attachmentId` tương ứng khỏi mảng `person.id_images`, xóa dòng `attachment`, ghi `audit_log` (`action = 'DELETE'`, `entity = 'attachment'`, `entity_id = attachment_id`, `before = attSnapshot`), sau đó xóa file vật lý dưới `UPLOADS_ROOT`.
2. **Frontend (`tenants.service.js`, `TenantsPage.jsx`, `TenantDetailPage.jsx`)**:
   - Bổ sung `tenantsService.remove(id)` và `tenantsService.deleteIdImage(id, attachmentId)` (kèm `invalidateCacheByPrefix('tenants')` và `invalidateCacheByPrefix('users')` khi xóa hồ sơ).
   - Trên `TenantsPage.jsx` và `TenantDetailPage.jsx`: hiển thị nút **Xóa** / **Xóa hồ sơ** cho `isSysAdmin` (disable kèm tooltip nếu cư dân đang có hợp đồng hiệu lực), xác nhận qua `ConfirmDialog`.
   - Trên `TenantDetailPage.jsx` (khu vực Ảnh giấy tờ tùy thân CCCD): hiển thị nút **Xóa ảnh** nhỏ gọn trên từng mặt ảnh đã tải lên cho `isSysAdmin`, xác nhận qua `ConfirmDialog`.

#### D. Phân hệ 3 — Người dùng & Phân quyền (`M01`)
1. **Backend (`api/src/routes/admin/users.js`)**:
   - **`DELETE /api/v1/admin/users/:id`** (`authenticateToken`, chỉ `SYS_ADMIN`; nếu vai trò khác gọi trả `403` + `logAccessDenied`):
     - Kiểm tra `app_user` thuộc `req.user.org_id` (`404 NOT_FOUND`).
     - Chặn tự xóa chính mình: `id === req.user.sub` -> `409 SELF_DELETE_PROHIBITED`.
     - Chặn xóa `SYS_ADMIN` hoạt động cuối cùng của tổ chức: nếu tài khoản đích có role `SYS_ADMIN` và `status = 'ACTIVE'`, kiểm tra còn ít nhất 1 `app_user` `ACTIVE` khác có role `SYS_ADMIN` trong cùng `org_id`; nếu không -> `409 LAST_SYS_ADMIN_PROHIBITED`.
     - Kiểm tra lịch sử vận hành & tính bất biến `audit_log` *(Đề xuất của hệ thống)*: giữ nguyên tuyệt đối trigger `prevent_audit_log_modification()` (PRD 14.3 / FR-007) và trả `409 USER_HAS_HISTORY` (hướng dẫn dùng **Khóa tài khoản `SUSPENDED`**) nếu:
       - `person_id` của user đang đứng tên `owner` được gán cho bất kỳ `building` nào (`building.owner_id`), **hoặc**
       - Tài khoản có vai trò `RESIDENT` và số điện thoại `person.phone` đang gắn với bản ghi giữ chỗ `reservation` trong tổ chức, **hoặc**
       - `user.id` xuất hiện ở bất kỳ dòng nào của `audit_log` (`actor_id = id` — lưu ý đăng nhập thông thường không ghi `audit_log`, nên tài khoản mới tạo dù đã đăng nhập thử vẫn xóa được; nếu đã thực hiện thao tác có ghi `audit_log` thì chặn `409` thay vì chạm vào trigger bất biến của `audit_log`), **hoặc**
       - `user.id` xuất hiện ở các cột tác nhân nghiệp vụ của `contract` (`created_by`, `approved_by`), `contract_version` (`approved_by`), `contract_request` (`created_by`, `approved_by`), `reservation` (`created_by`, `confirmed_by`), `deposit_transaction` (`created_by`, `approved_by`), `invoice` (`created_by`, `issued_by`), `invoice_adjustment` (`created_by`, `updated_by`, `approved_by`), `payment` (`reported_by`, `confirmed_by`), `credit_balance` (`created_by`, `updated_by`), `meter_reading` (`recorded_by`, `confirmed_by`), `service_subscription` (`requested_by`, `approved_by`), `service_request` (`created_by`, `assigned_to`, `resolved_by`), `announcement` (`created_by`, `manual_sent_by`), `system_setting` (`updated_by`), `zalo_group` (`created_by`), `ai_suggestion` (`created_by`, `reviewed_by`), `attachment` (`uploaded_by`), `tenant` (`created_by`), hoặc `person` khác (`created_by` với `person.id <> cur.person_id`).
     - Trong transaction `BEGIN ... COMMIT`:
       1. `DELETE FROM app_user WHERE id = $1 RETURNING *` (tự động cascade `user_role`, `notification`, `idempotency_key`).
       2. Kiểm tra `person_id`: nếu `person_id` vẫn còn hồ sơ `tenant` thì giữ nguyên `tenant` và `person` (chỉ xóa tài khoản đăng nhập); nếu **không** còn `app_user` nào khác và **không** còn `tenant` nào tham chiếu tới `person_id`, đồng thời các dòng `owner` (nếu có) của `person_id` không gắn với tòa nhà nào -> `DELETE FROM owner WHERE person_id = $1 AND org_id = $2`, xóa `attachment` của `person` (nếu có), sau đó `DELETE FROM person WHERE id = $1`.
       3. Ghi `audit_log` (`action = 'DELETE_USER'`, `entity = 'app_user'`, `entity_id = id`, `before = { ...userSnapshot, person_deleted: boolean }`).
   - **Bảo vệ khi cập nhật phân quyền (`PATCH /api/v1/admin/users/:id` & `UsersPage.jsx`)**:
     - Cho phép gỡ hết các dòng vai trò phụ hoặc gỡ vai trò tòa nhà trong modal phân quyền, nhưng Backend chặn `409` nếu `SYS_ADMIN` tự gỡ quyền `SYS_ADMIN` của chính mình hoặc làm mất `SYS_ADMIN` hoạt động cuối cùng của tổ chức.
2. **Frontend (`users.service.js`, `UsersPage.jsx`)**:
   - Bổ sung `usersService.remove(id)`.
   - Tại cột Thao tác trên bảng tài khoản của `UsersPage.jsx`, thêm nút **Xóa** (`Trash2`, chỉ hiển thị cho `canManageUsers`, disable với chính tài khoản đang đăng nhập `isSelf`), mở `ConfirmDialog` trước khi xóa.

#### E. Phân hệ 4 — Cấu hình hệ thống & Tích hợp (`M01` / `M13` / `M15`)
1. **Khôi phục mặc định Cấu hình hệ thống (`system_setting`)**:
   - **Backend (`api/src/routes/settings.js`)**:
     - Khai báo hằng số mặc định chuẩn `DEFAULT_SYSTEM_SETTINGS` khớp với `008_seeds.sql` cho 6 khóa hợp lệ: `billing_config`, `sla_config`, `contact_config`, `approval_config`, `reservation_cancel_policy`, `ai_config`.
     - Thêm `DELETE /api/v1/settings/:key` (`authenticateToken`, chỉ `SYS_ADMIN`; trả `403` + `logAccessDenied` nếu không phải `SYS_ADMIN`):
       - Kiểm tra `:key` thuộc danh sách 6 khóa hợp lệ (`400 INVALID_SETTING_KEY` nếu sai).
       - Đọc giá trị cũ `before`, thực thi `DELETE FROM system_setting WHERE org_id = $1 AND key = $2` qua RLS `pool`, ghi `audit_log` (`action = 'RESET_SETTING'`, `entity = 'system_setting'`, `entity_id = orgId`, `before = { key, value: prevValue }`, `after = { key, reset_to_default: true, default_value: DEFAULT_SYSTEM_SETTINGS[key] }`).
       - Trả về `200` kèm `default_value: DEFAULT_SYSTEM_SETTINGS[key]` và bản đồ cấu hình hiện hành của tổ chức.
   - **Frontend (`users.service.js`, `SettingsPage.jsx`, `UsersPage.jsx`)**:
     - Bổ sung `usersService.resetSetting(key)` gọi `DELETE /api/v1/settings/:key` (kèm xóa cache `settings` và `reservations` nếu khóa là `reservation_cancel_policy`).
     - Gắn nút **"Khôi phục mặc định"** (nhỏ gọn trên `CardHeader` của từng thẻ cấu hình: `ai_config`, `approval_config`, `billing_config`, `sla_config`, `contact_config`, và `reservation_cancel_policy`) trên `SettingsPage.jsx` và các thẻ tương ứng ở tab Cấu hình của `UsersPage.jsx`, xác nhận qua `ConfirmDialog`.
2. **Quản lý & Xóa Nhóm Zalo tích hợp (`zalo_group`)**:
   - **Backend (`api/src/routes/zalo-groups.js`)**:
     - Mở `POST /api/v1/zalo-groups` và `PUT /api/v1/zalo-groups/:id` cho `['SYS_ADMIN', 'MANAGER']` (đồng bộ với RLS mới ở mục A; `MANAGER` vẫn bị kiểm tra chặt theo tòa được phân công, `SYS_ADMIN` quản lý toàn tổ chức).
     - Bổ sung `DELETE /api/v1/zalo-groups/:id`:
       - Kiểm tra nhóm Zalo tồn tại thuộc `req.user.org_id` (`404 NOT_FOUND`).
       - Chỉ `SYS_ADMIN` được phép xóa (`403 DELETE_PROHIBITED` + `logAccessDenied` nếu là `MANAGER`, `OWNER` hay `RESIDENT`).
       - Thực thi `DELETE FROM zalo_group WHERE id = $1 AND org_id = $2 RETURNING *` qua `getUserClient(req)` (RLS), ghi `audit_log` (`action = 'DELETE'`, `entity = 'zalo_group'`, `entity_id = id`, `before = snapshot`) và trả `200`. (Lịch sử thông báo cũ trong `announcement.manual_sent_groups` lưu JSONB độc lập nên hoàn toàn không bị ảnh hưởng).
   - **Frontend (`usePermission.js`, `announcements.service.js`, `NotificationsPage.jsx`)**:
     - Bổ sung quyền `canManageZaloGroups: isSysAdmin || isManager` và `canDeleteZaloGroups: isSysAdmin` trong `usePermission.js`; thêm `announcementsService.deleteZaloGroup(id)`.
     - Trên tab `zalo_groups` của `NotificationsPage.jsx`: mở nút Thêm/Chỉnh sửa nhóm Zalo theo `canManageZaloGroups` (thay vì `canSendNotifications` vốn chỉ cho `MANAGER`), và gắn nút **Xóa** (kèm `ConfirmDialog`) cho `canDeleteZaloGroups` (`SYS_ADMIN`).

## 6. Phần để bước lập kế hoạch & thi công xử lý (Left to the Builder)
- Hợp nhất và chạy chính sách RLS trong `api/src/db/migrations/005_rls_enable_and_policies.sql`.
- Cài đặt các route Backend (`buildings.js`, `apartments.js`, `tenants.js`, `admin/users.js`, `settings.js`, `zalo-groups.js`) và tách helper kiểm tra lịch sử / dọn `person` mồ côi dùng chung để code sạch, dễ test.
- Cập nhật các service Frontend (`buildings.service.js`, `tenants.service.js`, `users.service.js`, `announcements.service.js`), hook `usePermission.js` và các trang quản trị kèm đồng bộ xóa cache (`invalidateCacheByPrefix`).
- Viết bộ integration test Backend toàn diện (`api/test/sysAdminDelete.test.js`) bao phủ cả 4 phân hệ: RBAC (`403` cho `MANAGER`/`OWNER`/`RESIDENT` + `ACCESS_DENIED`/`DELETE_PROHIBITED`), chống IDOR chéo tổ chức (`404`), chặn xóa khi có lịch sử (`400`/`409`), bảo toàn `person` dùng chung vs dọn sạch `person` mồ côi, khôi phục mặc định `system_setting`, xóa `zalo_group` qua RLS và xác nhận ghi nhận `audit_log`, đồng thời chạy `vite build` / kiểm tra toàn bộ test hiện hữu không hồi quy.

