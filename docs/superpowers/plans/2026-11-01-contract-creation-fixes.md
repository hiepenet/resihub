# Chuẩn hóa Nghiệp vụ Tạo & Kích hoạt Hợp đồng (M05) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khắc phục triệt để 7 lỗ hổng nghiệp vụ và phân quyền trong luồng Tạo, Chỉnh sửa nháp, Đính kèm bản ký, Phê duyệt lệch khung giá và Kích hoạt hợp đồng (`M05`) theo đúng đặc tả PRD v2.0.

**Architecture:** Đồng bộ phân quyền 3 lớp (UI React → Express RBAC Middleware → PostgreSQL RLS) để đưa `SYS_ADMIN` về đúng vai trò chỉ đọc (`R`) trên Hợp đồng và giao quyền duyệt hợp đồng lệch khung giá (`PENDING_APPROVAL`) cho đúng `OWNER` sở hữu tòa nhà đó (kèm cơ chế dự phòng `SYS_ADMIN` duy nhất khi tòa nhà chưa gắn tài khoản `OWNER`). Mở rộng API `POST/PATCH /api/v1/contracts` để lưu nguyên tử `billing_cycle`, `payment_due_days`, `billing_day` (`1–31`), đăng ký dịch vụ đi kèm (`service_subscription`), đơn giá riêng (`contract_service_price`), hỗ trợ upload/xem scan `PDF`, gửi thông báo đa bên khi kích hoạt và tính toán bảng lịch hóa đơn dự kiến (`invoiceSchedule.js`) không làm nghẽn tiến trình chốt điện/nước hàng tháng.

**Tech Stack:** Node.js (ESM), Express 4, PostgreSQL 16 (Row-Level Security + Exclusion Constraints), `node:test`, React 19, Vite 8, Tailwind CSS, Zustand.

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (Mục 6.2, 13.6, FR-014, FR-020, FR-065, FR-066, AC-009)

## Global Constraints

- **RBAC `SYS_ADMIN` trên Hợp đồng (`M05`, PRD Mục 6.2):** `SYS_ADMIN` chỉ có quyền Xem (`R`) đối với hợp đồng; toàn bộ thao tác tạo nháp, sửa nháp, đính kèm scan, kích hoạt, hủy nháp, thêm/gỡ người ở cùng, gia hạn, chuyển phòng, thanh lý và duyệt phụ lục thuộc về `MANAGER` của tòa nhà được gán.
- **RBAC `OWNER` duyệt lệch khung giá (`FR-014`):** Khi `rent_amount < 0.9 * base_rent`, hợp đồng chuyển sang `PENDING_APPROVAL` và **chỉ `OWNER` sở hữu tòa nhà đó** được gọi `POST /api/v1/contracts/:id/approve` hoặc `POST /api/v1/contracts/:id/reject`. Ngoại lệ duy nhất: nếu tòa nhà chưa gắn `owner_id` hoặc chủ nhà chưa có tài khoản `app_user` `ACTIVE`, cho phép `SYS_ADMIN` duyệt dự phòng để tránh treo hợp đồng.
- **Chu kỳ & Hạn thanh toán (`FR-066`, Mục 13.6):** `billing_cycle IN ('monthly', 'quarterly')`, `billing_day` nguyên trong khoảng `1..31`, `payment_due_days` nguyên trong khoảng `1..60` (mặc định `5`).
- **Chống chồng lấn kỳ hạn (`Rule C1`):** Mọi kiểm tra chồng lấn (`POST /`, `PATCH /:id`, `completeActivation`) phải tính trên tập trạng thái `('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')` với ngày kết thúc hiệu lực `COALESCE(terminated_at, end_date)` theo khoảng nửa mở `[start_date, effective_end_date)`.
- **Đính kèm bản hợp đồng ký (`FR-020`):** Hỗ trợ `image/jpeg`, `image/png` và `application/pdf` (tối đa `10MB` cho scan hợp đồng; giữ nguyên `5MB` và chỉ `JPG/PNG` cho ảnh CCCD/chứng từ khác). File `PDF` bắt buộc kiểm tra magic header `%PDF-`.
- **Dịch vụ đi kèm & Lịch hóa đơn dự kiến (`FR-014`, `FR-065`):** Dịch vụ đăng ký kèm hợp đồng nháp lưu ở `service_subscription` với `status = 'PENDING_APPROVAL'`, tự động chuyển sang `'ACTIVE'` khi hợp đồng `ACTIVE` (hoặc `'CANCELLED'` nếu hủy nháp). Lịch hóa đơn dự kiến được tính động theo kỳ thu (`monthly` / `quarterly`) và đối chiếu với hóa đơn thực tế đã phát hành, tuyệt đối không chèn trước các dòng `invoice` nháp tương lai vào DB để không chặn `generateInvoicesCore` ghi nhận chỉ số điện/nước hàng tháng.

## Review Focus

1. **`OWNER` tòa khác cố tình duyệt/từ chối hợp đồng `PENDING_APPROVAL`:** Khi `owner.vsc@resihub.vn` gọi `POST /api/v1/contracts/:id/approve` hoặc `/reject` trên hợp đồng thuộc tòa `VOP-A`, API phải trả `403` và ghi `ACCESS_DENIED` vào `audit_log` (được kiểm thử tại Task 1).
2. **Tòa nhà chưa gắn chủ sở hữu (`owner_id IS NULL`) có hợp đồng lệch khung giá:** Kích hoạt hợp đồng giảm giá `> 10%` trên tòa `owner_id = NULL` vẫn chuyển sang `PENDING_APPROVAL` an toàn (không lỗi thông báo), cho phép `SYS_ADMIN` duyệt dự phòng (`200`), nhưng trên tòa đã có `OWNER` `ACTIVE` thì cả `SYS_ADMIN` và `MANAGER` đều bị chặn `403 FORBIDDEN_NOT_BUILDING_OWNER` (được kiểm thử tại Task 1).
3. **File giả mạo PDF hoặc vượt dung lượng `10MB` khi upload bản ký (`FR-020`):** Chuỗi `data:application/pdf;base64,...` có nội dung giải mã không bắt đầu bằng `%PDF-` hoặc lớn hơn `10MB` phải bị từ chối `400 VALIDATION_ERROR` trước khi ghi đĩa hay tạo bản ghi `attachment` (được kiểm thử tại Task 3).
4. **Dịch vụ đi kèm (`services[]`) trên hợp đồng `DRAFT` chưa kích hoạt hoặc bị hủy nháp:** Khi hợp đồng còn `DRAFT`, các bản ghi `service_subscription` phải giữ `status = 'PENDING_APPROVAL'`, chuyển sang `'ACTIVE'` ngay khi hợp đồng `ACTIVE`, và chuyển sang `'CANCELLED'` nếu gọi `POST /:id/cancel` (được kiểm thử tại Task 4).
5. **Kẹp ngày cuối tháng khi `billing_day` là `29–31` và chu kỳ `quarterly` trong Lịch hóa đơn dự kiến:** Hợp đồng có `billing_day = 31` đi qua tháng 2 (`2027-02`) phải chốt `issue_date = '2027-02-28'` và `due_date = issue_date + payment_due_days` mà không tràn sang tháng 3 hoặc sinh ngày lỗi (được kiểm thử tại Task 4).

---

## File Structure

### Database & Backend (`api/`)
- **Create:** `api/src/db/migrations/041_contract_owner_price_approval_rls.sql` — Cập nhật PostgreSQL RLS trên bảng `contract` (gỡ quyền ghi thường trực của `SYS_ADMIN`, cấp quyền `UPDATE` có điều kiện cho `OWNER` sở hữu tòa nhà khi `status = 'PENDING_APPROVAL'` chuyển sang `'ACTIVE'` hoặc `'DRAFT'`, và nhánh dự phòng `SYS_ADMIN` khi tòa nhà không có `OWNER` `ACTIVE`).
- **Create:** `api/src/services/invoiceSchedule.js` — Hàm thuần `buildExpectedInvoiceSchedule` tính lịch hóa đơn dự kiến theo `billing_cycle` (`monthly`/`quarterly`), `billing_day` (`1..31`), `payment_due_days`, pro-rata kỳ đầu/cuối, cộng dịch vụ cố định + giá ghi đè `contract_service_price` và khớp nối hóa đơn thực tế.
- **Modify:** `api/src/services/imageUpload.js` — Mở rộng `saveBase64Image` với tùy chọn `allowPdf = false` và `maxBytes = MAX_IMAGE_BYTES`, kiểm tra magic bytes `%PDF-` khi `application/pdf`.
- **Modify:** `api/src/routes/attachments.js:101-110` — Bổ sung header `Content-Disposition: inline` cho tệp `application/pdf`.
- **Modify:** `api/src/server.js:45-47` — Nâng `express.json({ limit: '20mb' })` để tải mượt base64 của file scan PDF tối đa `10MB`.
- **Modify:** `api/src/routes/contracts.js` — Chuẩn hóa RBAC (`SYS_ADMIN` chỉ đọc, `OWNER` duyệt/từ chối lệch khung giá), lưu `billing_cycle` + `payment_due_days` + `billing_day (1..31)`, sửa check chồng lấn `PATCH /:id` thêm `TERMINATION_PENDING`, xử lý `services[]` & `service_prices[]` khi tạo nháp/hủy nháp/kích hoạt, gửi `notification` đa bên và trả `invoice_schedule` + `service_subscriptions` + `has_building_owner`.
- **Create:** `api/test/invoiceSchedule.test.js` — Unit test cho `buildExpectedInvoiceSchedule`.
- **Create:** `api/test/contractCreationFixes.test.js` — Integration test toàn diện cho 7 hạng mục sửa đổi.
- **Modify:** `api/test/fullWebsiteWhiteBlackBox.test.js:994-1025` & `api/test/multiBuildingAndFutureContract.test.js:532-576` — Cập nhật kịch bản test cũ từng giả định "Phương án 2 (`OWNER` bị chặn 403 khi duyệt giá)" sang quy tắc mới (`OWNER` tòa nhà là người duyệt lệch khung giá).

### Frontend (`frontend/`)
- **Modify:** `frontend/src/hooks/usePermission.js` — Tách quyền hợp đồng chuẩn xác: `canCreateContracts: isManager`, `canManageContracts: isManager`, `canApproveContractPrice: isOwner || isSysAdmin`, `canApproveContractAmendments: isManager`, `canTerminateContracts: isManager`.
- **Modify:** `frontend/src/components/ui/FileUpload.jsx` — Hỗ trợ `maxSizeMB` tùy chỉnh, hiển thị thẻ xem trước PDF (`data:application/pdf` hoặc `.pdf`) và export component `AuthPdfViewer` dùng `fetchAuthBlobUrl` + `<iframe>`.
- **Modify:** `frontend/src/pages/admin/contracts/ContractsPage.jsx` — Mở `billing_day` `1–31`, thêm ô `payment_due_days` (mặc định `5`), thêm **Bước 4: Chọn Dịch vụ đi kèm & Đơn giá riêng**, gửi trọn gói trong `POST /api/v1/contracts` (xóa đoạn gọi bù `PATCH` `billing_cycle`), cập nhật cảnh báo lệch giá chờ `OWNER` tòa nhà duyệt.
- **Modify:** `frontend/src/pages/admin/contracts/ContractDetailPage.jsx` — Sửa `canManageOps = isManager`, hiển thị nút Duyệt/Từ chối giá ưu đãi đúng cho `OWNER` (hoặc `SYS_ADMIN` khi `!contract.has_building_owner`), thêm `payment_due_days` & `billing_day (1..31)` ở thẻ Tổng quan + Modal Sửa nháp, hỗ trợ upload & xem trực tiếp file scan `PDF`, và thêm tab **"Lịch hóa đơn dự kiến"** kèm danh sách dịch vụ đăng ký.
- **Create:** `frontend/src/utils/__tests__/contractCreationUi.test.js` — Kiểm thử tĩnh & đơn vị xác nhận phân quyền UI, giới hạn `billing_day = 31`, `payment_due_days`, hỗ trợ `application/pdf`, Bước 4 dịch vụ và tab Lịch hóa đơn dự kiến.

---

### Task 1: Chuẩn hóa Phân quyền `SYS_ADMIN` (Read-Only) & `OWNER` Duyệt Lệch Khung Giá (DB RLS + Backend API)

**Files:**
- Create: `api/src/db/migrations/041_contract_owner_price_approval_rls.sql`
- Modify: `api/src/routes/contracts.js:285,540,664-735,1612,1766,1883,1949-2460,2576,2651,2850,2953`
- Modify: `api/test/fullWebsiteWhiteBlackBox.test.js:994-1025`
- Modify: `api/test/multiBuildingAndFutureContract.test.js:532-576`
- Create: `api/test/contractCreationFixes.test.js`

**Interfaces:**
- Consumes: `getOwnerBuildingIds(userId, orgId)`, `getManagerBuildingIds(userId, orgId)`, `logAccessDenied(req, entity, entityId, reason)` từ `api/src/services/ownerScope.js`.
- Produces:
  - Helper nội bộ `getBuildingActiveOwnerUserIds(buildingId)` trong `api/src/routes/contracts.js` trả về `Promise<string[]>` (danh sách `app_user.id` `ACTIVE` của chủ sở hữu tòa nhà).
  - Trường `has_building_owner: boolean` trong response `GET /api/v1/contracts/:id`.
  - Quy tắc `POST /api/v1/contracts/:id/approve` & `POST /api/v1/contracts/:id/reject`: chỉ `OWNER` sở hữu `contract.building_id` được phép thực thi (nếu `ownerUserIds.length === 0` thì cho phép `SYS_ADMIN` duyệt dự phòng; mọi trường hợp khác trả `403 FORBIDDEN_NOT_BUILDING_OWNER` + ghi `ACCESS_DENIED`).
  - Toàn bộ endpoint tác nghiệp hợp đồng còn lại (`requests/:id/approve|reject`, `terminate`, `terminate/approve|reject`, `service-prices`, `amendments/:versionId/approve|reject`) chỉ nhận `requireRole(['MANAGER'])` (gỡ `'SYS_ADMIN'`).

- [ ] **Step 1: Viết bộ test kiểm chứng phân quyền `SYS_ADMIN` Read-Only và `OWNER` duyệt/từ chối lệch khung giá**

Tạo `api/test/contractCreationFixes.test.js` với subtest đầu tiên kiểm tra:
1. `SYS_ADMIN` bị chặn `403` trên các endpoint tác nghiệp hợp đồng (`POST /api/v1/contracts`, `POST /:id/terminate`, `POST /:id/service-prices`, `POST /:id/approve` khi tòa nhà có `OWNER`).
2. Khi `MANAGER` kích hoạt hợp đồng có `rent_amount < 0.9 * base_rent` trên tòa `VOP-A`, hợp đồng chuyển sang `PENDING_APPROVAL`.
3. `MANAGER` (kể cả quản lý thứ 2 cùng tòa) gọi `POST /:id/approve` hoặc `POST /:id/reject` đều nhận `403`.
4. `OWNER` của tòa khác (`owner.vsc@resihub.vn`) gọi `POST /:id/approve` nhận `403` và sinh bản ghi `ACCESS_DENIED` trong `audit_log` (Review Focus #1).
5. `OWNER` của đúng tòa `VOP-A` (`owner.vop@resihub.vn`) gọi `POST /:id/reject` trả hợp đồng về `DRAFT` (`200`), sau đó trình lại và gọi `POST /:id/approve` chuyển hợp đồng sang `ACTIVE` (`200`), mở sổ `deposit` và đồng bộ trạng thái `apartment`.
6. Trên tòa nhà tạm thời có `owner_id = NULL`, hợp đồng giảm giá vẫn vào `PENDING_APPROVAL` và `SYS_ADMIN` duyệt dự phòng thành công `200` (Review Focus #2).

```javascript
// Trong api/test/contractCreationFixes.test.js
test('Task 1: SYS_ADMIN is R-only on contracts; building OWNER approves/rejects discounted contracts (with ownerless fallback)', async (t) => {
  // Assert SYS_ADMIN -> 403 on POST /:id/service-prices, POST /:id/terminate, and POST /:id/approve (when building has owner)
  // Assert cross-building OWNER (owner.vsc@resihub.vn) -> 403 + ACCESS_DENIED audit_log
  // Assert MANAGER 2 -> 403 on POST /:id/approve & POST /:id/reject
  // Assert VOP OWNER (owner.vop@resihub.vn) -> 200 on POST /:id/reject (-> DRAFT) and 200 on POST /:id/approve (-> ACTIVE + deposit opened)
  // Assert building with owner_id = NULL -> SYS_ADMIN fallback approve returns 200 ACTIVE
});
```

- [ ] **Step 2: Chạy test mới để xác nhận trạng thái FAIL ban đầu**

Run: `cd d:\resihub\api; node --test test/contractCreationFixes.test.js`
Expected: FAIL (`owner.vop@resihub.vn` hiện bị chặn `403` bởi `requireRole(['SYS_ADMIN', 'MANAGER'])` và RLS `031`).

- [ ] **Step 3: Tạo migration `041_contract_owner_price_approval_rls.sql` và chạy migrate**

Tạo `api/src/db/migrations/041_contract_owner_price_approval_rls.sql` cập nhật các policy RLS của nhóm Hợp đồng:
- Gỡ `is_org_admin()` khỏi `rls_contract_insert`, `rls_contract_version_insert`, `rls_contract_version_update`, `rls_contract_request_insert`, `rls_contract_request_update`, `rls_contract_service_price_modify` để khóa chặt `SYS_ADMIN = R` ngay từ tầng DB.
- Cập nhật `rls_contract_update`:

```sql
BEGIN;

DROP POLICY IF EXISTS rls_contract_insert ON contract;
CREATE POLICY rls_contract_insert ON contract FOR INSERT
  WITH CHECK (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_update ON contract;
CREATE POLICY rls_contract_update ON contract FOR UPDATE
  USING (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (
      status = 'PENDING_APPROVAL'
      AND building_id IN (SELECT building_id FROM get_owner_building_ids())
    )
    OR (
      is_org_admin()
      AND status = 'PENDING_APPROVAL'
      AND NOT EXISTS (
        SELECT 1
        FROM building b
        JOIN owner o ON o.id = b.owner_id
        JOIN app_user au ON au.person_id = o.person_id AND au.status = 'ACTIVE'
        WHERE b.id = contract.building_id
      )
    )
  )
  WITH CHECK (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (
      status IN ('ACTIVE', 'DRAFT')
      AND building_id IN (SELECT building_id FROM get_owner_building_ids())
    )
    OR (
      is_org_admin()
      AND status IN ('ACTIVE', 'DRAFT')
    )
  );

DROP POLICY IF EXISTS rls_contract_version_insert ON contract_version;
CREATE POLICY rls_contract_version_insert ON contract_version FOR INSERT
  WITH CHECK (
    contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_contract_version_update ON contract_version;
CREATE POLICY rls_contract_version_update ON contract_version FOR UPDATE
  USING (
    is_manager()
    AND contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    is_manager()
    AND contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_contract_request_insert ON contract_request;
CREATE POLICY rls_contract_request_insert ON contract_request FOR INSERT
  WITH CHECK (
    created_by = get_current_user_id()
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_request_update ON contract_request;
CREATE POLICY rls_contract_request_update ON contract_request FOR UPDATE
  USING (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  WITH CHECK (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_service_price_modify ON contract_service_price;
CREATE POLICY rls_contract_service_price_modify ON contract_service_price FOR ALL
  USING (
    contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

COMMIT;
```

- [ ] **Step 4: Cập nhật RBAC và xử lý transaction duyệt giá của `OWNER` trong `api/src/routes/contracts.js` + cập nhật 2 test hồi quy cũ**

Trong `api/src/routes/contracts.js`:
1. Viết `async function getBuildingActiveOwnerUserIds(buildingId)` truy vấn qua `adminPool`:
   `SELECT au.id FROM building b JOIN owner o ON o.id = b.owner_id JOIN app_user au ON au.person_id = o.person_id WHERE b.id = $1 AND au.status = 'ACTIVE'`.
2. Tại `GET /:id`: trả thêm `has_building_owner: ownerUserIds.length > 0`.
3. Đổi `requireRole(['SYS_ADMIN', 'MANAGER'])` thành `requireRole(['MANAGER'])` trên `POST /requests/:id/approve`, `POST /requests/:id/reject`, `POST /:id/terminate`, `POST /:id/terminate/approve`, `POST /:id/terminate/reject`, `POST /:id/service-prices`, `DELETE /:id/service-prices/:priceId`, `POST /:id/amendments/:versionId/approve`, `POST /:id/amendments/:versionId/reject`.
4. Đổi `POST /:id/approve` và `POST /:id/reject` sang `requireRole(['OWNER', 'SYS_ADMIN'])`:
   - Sau `checkContractAccess(req, id)`, lấy `ownerUserIds = await getBuildingActiveOwnerUserIds(access.contract.building_id)`.
   - Nếu `ownerUserIds.length > 0`: bắt buộc `ownerUserIds.includes(req.user.sub)`; nếu người gọi là `SYS_ADMIN` (hoặc không thuộc `ownerUserIds`), gọi `logAccessDenied` và trả `403 { code: 'FORBIDDEN_NOT_BUILDING_OWNER', message: 'Chỉ Chủ sở hữu (OWNER) của tòa nhà này mới có quyền phê duyệt / từ chối hợp đồng lệch khung giá.' }`.
   - Nếu `ownerUserIds.length === 0`: cho phép `SYS_ADMIN` thực hiện duyệt/từ chối dự phòng.
   - Trong `completeActivation`: khi chạy dưới quyền `OWNER` (`skipPriceCheck: true`), thực hiện `UPDATE contract SET status = 'ACTIVE'` + `INSERT INTO audit_log` trên `client` (được bảo vệ bởi `rls_contract_update` + exclusion constraint) rồi `COMMIT` `client`, sau đó mở kết nối transaction từ `adminPool` để thực thi phần side-effect hệ thống (mở sổ `deposit`, `deposit_transaction`, `reservation = 'CONVERTED'`, `syncApartmentStatus`) để không phải nới lỏng RLS bảng `deposit`/`apartment` cho `OWNER` (nếu side-effect lỗi bất ngờ thì rollback và khôi phục `contract.status = 'PENDING_APPROVAL'`).
   - Cập nhật thông báo `PRICE_NEEDS_APPROVAL` tại `POST /:id/activate`: nêu rõ hợp đồng chuyển sang chờ **Chủ sở hữu tòa nhà (`OWNER`)** phê duyệt.
5. Cập nhật `api/test/fullWebsiteWhiteBlackBox.test.js:994-1025` và `api/test/multiBuildingAndFutureContract.test.js:532-576` để phản ánh quy tắc mới: `mgr2VopA` và `sysAdmin` bị chặn `403` trên tòa `VOP-A`, còn `ownerVop` là người thực hiện `reject` (`-> DRAFT`) và `approve` (`-> ACTIVE`), đồng thời giữ nguyên kiểm tra raw SQL RLS `OWNER` không thể `UPDATE` hợp đồng khi đã `ACTIVE` hay `UPDATE deposit`.

- [ ] **Step 5: Chạy migration và kiểm tra toàn bộ test liên quan**

Run: `cd d:\resihub\api; npm run migrate; node --test test/contractCreationFixes.test.js test/rbacPrdAlignment.test.js test/multiBuildingAndFutureContract.test.js`
Expected: PASS 100%.

- [ ] **Step 6: Commit Task 1**

```bash
git add api/src/db/migrations/041_contract_owner_price_approval_rls.sql api/src/routes/contracts.js api/test/contractCreationFixes.test.js api/test/fullWebsiteWhiteBlackBox.test.js api/test/multiBuildingAndFutureContract.test.js
git commit -m "fix(contracts): align SYS_ADMIN read-only RBAC and assign price-deviation approval to building OWNER"
```

---

### Task 2: Bổ sung `billing_cycle`, `payment_due_days`, Mở Rộng `billing_day` (`1–31`) & Fix Chồng Lấn `TERMINATION_PENDING` khi Sửa Nháp

**Files:**
- Modify: `api/src/routes/contracts.js:746-970,1445-1595,3400-3420`
- Modify: `api/test/contractCreationFixes.test.js`

**Interfaces:**
- Consumes: Bảng `contract` (`billing_cycle`, `billing_day`, `payment_due_days`).
- Produces:
  - `POST /api/v1/contracts` nhận và validate:
    - `billing_cycle`: `'monthly' | 'quarterly'` (mặc định `'monthly'`, sai trả `422 INVALID_BILLING_CYCLE`).
    - `billing_day`: số nguyên `1..31` (mặc định `1`, ngoài khoảng trả `422 INVALID_BILLING_DAY`).
    - `payment_due_days`: số nguyên `1..60` (mặc định `5`, ngoài khoảng trả `422 INVALID_PAYMENT_DUE_DAYS`).
  - `PATCH /api/v1/contracts/:id` nhận và validate tương tự cho `billing_cycle`, `billing_day` (`1..31`), `payment_due_days` (`1..60`), đồng thời kiểm tra chồng lấn bao gồm `'TERMINATION_PENDING'` và `COALESCE(terminated_at, end_date)` (trả `409 OVERLAP_CONTRACT` kèm mảng `conflicts`).

- [ ] **Step 1: Viết các test thất bại cho `billing_cycle`, `payment_due_days`, `billing_day = 31` và chồng lấn `TERMINATION_PENDING` trên `PATCH /:id`**

Thêm subtest `Task 2` vào `api/test/contractCreationFixes.test.js`:
1. `POST /api/v1/contracts` truyền `billing_cycle: 'quarterly'`, `billing_day: 31`, `payment_due_days: 10` -> bản ghi trả về lưu đúng cả 3 trường ngay trong 1 request.
2. `POST /api/v1/contracts` truyền `billing_day: 32` -> trả `422 INVALID_BILLING_DAY`; truyền `payment_due_days: 0` -> trả `422 INVALID_PAYMENT_DUE_DAYS`; truyền `billing_cycle: 'yearly'` -> trả `422 INVALID_BILLING_CYCLE`.
3. Tạo 1 hợp đồng đang ở trạng thái `TERMINATION_PENDING` (hẹn trả phòng `terminated_at = '2027-06-15'`), sau đó tạo hợp đồng nháp `DRAFT` bắt đầu `'2027-06-20'` rồi gọi `PATCH /:id` lùi `start_date` về `'2027-06-10'` -> phải bị chặn `409 OVERLAP_CONTRACT` kèm `conflicts`.
4. `PATCH /:id` cập nhật `payment_due_days: 7`, `billing_day: 30` -> lưu thành công `200`.

- [ ] **Step 2: Chạy test để xác nhận FAIL**

Run: `cd d:\resihub\api; node --test test/contractCreationFixes.test.js`
Expected: FAIL (`billing_cycle` đang trả `'monthly'` ở `POST /`, `payment_due_days` giữ `5`, và `PATCH /:id` lọt qua hợp đồng `TERMINATION_PENDING`).

- [ ] **Step 3: Cài đặt validate + lưu DB ở `POST /`, `PATCH /:id` và bản in A4 `GET /:id/template` trong `api/src/routes/contracts.js`**

1. Viết helper `validateBillingParams({ billing_cycle, billing_day, payment_due_days }, { partial = false } = {})` trả về `{ error }` hoặc `{ billingCycle, billingDay, paymentDueDays }`.
2. Trong `POST /`: destructure thêm `billing_cycle`, `payment_due_days`; gọi `validateBillingParams`; đưa `billing_cycle, billing_day, payment_due_days` vào câu lệnh `INSERT INTO contract`.
3. Trong `PATCH /:id`:
   - Destructure thêm `payment_due_days`; gọi `validateBillingParams(..., { partial: true })`.
   - Cập nhật truy vấn kiểm tra chồng lấn (dòng `1523–1533`) khớp hoàn toàn với `POST /`:
     ```sql
     SELECT c.id, c.start_date, COALESCE(c.terminated_at, c.end_date) AS end_date, p.full_name
     FROM contract c
     LEFT JOIN tenant t ON t.id = c.primary_tenant_id
     LEFT JOIN person p ON p.id = t.person_id
     WHERE c.apartment_id = $1 AND c.id <> $2
       AND c.status IN ('DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
       AND (c.start_date < $4 AND COALESCE(c.terminated_at, c.end_date) > $3)
     ```
   - Thêm `payment_due_days = COALESCE($6, payment_due_days)` vào `UPDATE contract`.
4. Trong `GET /:id/template` (điều khoản thanh toán): hiển thị rõ hạn thanh toán `${c.payment_due_days || 5} ngày kể từ ngày phát hành hóa đơn`.

- [ ] **Step 4: Chạy lại test để xác nhận PASS**

Run: `cd d:\resihub\api; node --test test/contractCreationFixes.test.js`
Expected: PASS cho cả Task 1 và Task 2.

- [ ] **Step 5: Commit Task 2**

```bash
git add api/src/routes/contracts.js api/test/contractCreationFixes.test.js
git commit -m "fix(contracts): persist billing_cycle, payment_due_days, billing_day 1-31 and check TERMINATION_PENDING on draft PATCH"
```

---

### Task 3: Hỗ Trợ Đính Kèm & Xem Bản Ký Hợp Đồng Định Dạng PDF (`FR-020` Backend)

**Files:**
- Modify: `api/src/services/imageUpload.js`
- Modify: `api/src/routes/contracts.js:2510-2544`
- Modify: `api/src/routes/attachments.js:101-110`
- Modify: `api/src/server.js:45-47`
- Modify: `api/test/contractCreationFixes.test.js`

**Interfaces:**
- Consumes: `POST /api/v1/contracts/:id/scan` body `{ image_base64?: string, file_base64?: string }`.
- Produces:
  - `MAX_CONTRACT_SCAN_BYTES = 10 * 1024 * 1024` trong `api/src/services/imageUpload.js`.
  - `saveBase64Image({ imageBase64, folder, entityId, entity, ownerId, req, query, allowPdf = false, maxBytes = MAX_IMAGE_BYTES })`:
    - Khi `allowPdf === false`: giữ nguyên hành vi cũ (chỉ `image/jpeg`, `image/png`, tối đa `5MB`).
    - Khi `allowPdf === true`: chấp nhận `data:image/jpeg;base64,...`, `data:image/png;base64,...`, và `data:application/pdf;base64,...` (tối đa `maxBytes`). Nếu MIME là `application/pdf`, kiểm tra 5 byte đầu của buffer phải bằng `'%PDF-'`, lưu đuôi `.pdf` và `mime = 'application/pdf'`.

- [ ] **Step 1: Viết các test thất bại cho upload & xem bản scan PDF (bao gồm file giả mạo PDF & vượt dung lượng)**

Thêm subtest `Task 3` vào `api/test/contractCreationFixes.test.js`:
1. Upload chuỗi `data:application/pdf;base64,...` hợp lệ (bắt đầu bằng `%PDF-1.4...`) lên `POST /api/v1/contracts/:id/scan` -> trả `201`, `data.mime === 'application/pdf'`, đuôi `.pdf`.
2. Gọi `GET /api/v1/attachments/:attId/view` với token hợp lệ -> trả `200`, `Content-Type` chứa `application/pdf`, `Content-Disposition` chứa `inline`, và ghi `READ` vào `audit_log`.
3. Upload `data:application/pdf;base64,...` nhưng nội dung giải mã là `'HELLO_NOT_A_PDF'` -> trả `400 VALIDATION_ERROR` (Review Focus #3).
4. Upload bản scan vượt quá `10MB` -> trả `400 VALIDATION_ERROR` (Review Focus #3).
5. Các upload không bật `allowPdf` (như ảnh CCCD cư dân) gửi `application/pdf` vẫn bị từ chối `400`.

- [ ] **Step 2: Chạy test để xác nhận FAIL**

Run: `cd d:\resihub\api; node --test test/contractCreationFixes.test.js`
Expected: FAIL (`POST /:id/scan` hiện từ chối `data:application/pdf;base64,...` với `400`).

- [ ] **Step 3: Cập nhật `imageUpload.js`, `contracts.js`, `attachments.js` và `server.js`**

1. Trong `api/src/services/imageUpload.js`:
   - Export `MAX_CONTRACT_SCAN_BYTES = 10 * 1024 * 1024` và regex `SCAN_MIME_RE = /^data:(image\/jpeg|image\/png|application\/pdf);base64,\s*([A-Za-z0-9+/=\r\n]+)$/`.
   - Mở rộng `saveBase64Image` nhận thêm `allowPdf = false, maxBytes = MAX_IMAGE_BYTES`. Nếu `mime === 'application/pdf'`, kiểm tra `bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-'`; nếu sai trả `{ error: { code: 'VALIDATION_ERROR', message: 'Tệp PDF không hợp lệ hoặc bị hỏng.' } }`.
2. Trong `api/src/routes/contracts.js` (`POST /:id/scan`): chấp nhận `req.body.file_base64 || req.body.image_base64`, truyền `allowPdf: true, maxBytes: MAX_CONTRACT_SCAN_BYTES`.
3. Trong `api/src/routes/attachments.js`: khi `att.mime === 'application/pdf'`, đặt `res.setHeader('Content-Disposition', `inline; filename="contract-scan-${att.id.slice(0, 8)}.pdf"`)` trước `res.send(buf)`.
4. Trong `api/src/server.js`: nâng `express.json({ limit: '20mb' })`.

- [ ] **Step 4: Chạy test để xác nhận PASS**

Run: `cd d:\resihub\api; node --test test/contractCreationFixes.test.js`
Expected: PASS (lưu ý nếu server đang chạy nền, khởi động lại server hoặc chạy thêm unit test trực tiếp hàm `saveBase64Image`).

- [ ] **Step 5: Commit Task 3**

```bash
git add api/src/services/imageUpload.js api/src/routes/contracts.js api/src/routes/attachments.js api/src/server.js api/test/contractCreationFixes.test.js
git commit -m "feat(contracts): support PDF upload and authenticated inline viewing for signed contract scans (FR-020)"
```

---

### Task 4: Dịch Vụ Đi Kèm Khi Tạo HĐ (`services[]` & `service_prices[]`), Thông Báo Kích Hoạt & Lịch Hóa Đơn Dự Kiến (`FR-014`, `FR-065`)

**Files:**
- Create: `api/src/services/invoiceSchedule.js`
- Create: `api/test/invoiceSchedule.test.js`
- Modify: `api/src/routes/contracts.js`
- Modify: `api/test/contractCreationFixes.test.js`

**Interfaces:**
- Consumes: `roundVND` từ `api/src/services/pricing.js`; bảng `service_catalog`, `service_subscription`, `contract_service_price`, `contract_version`, `notification`, `invoice`.
- Produces:
  - `buildExpectedInvoiceSchedule({ contract, subscriptions = [], servicePrices = [], existingInvoices = [] })` trong `api/src/services/invoiceSchedule.js` trả về mảng các kỳ thu dự kiến:
    ```javascript
    // Mỗi phần tử:
    {
      index: 1,
      period: '2026-11',
      period_label: '2026-11', // hoặc '2026-11 → 2027-01' nếu quarterly
      from_date: '2026-11-15',
      to_date: '2026-11-30',
      issue_date: '2026-11-30', // kẹp theo số ngày thực của tháng
      due_date: '2026-12-05',   // issue_date + payment_due_days
      is_prorata: true,
      rent_amount: 4533333,
      fixed_service_amount: 304000,
      estimated_total: 4837333,
      actual_invoice: null, // hoặc { id, invoice_code, status, total_amount, paid_amount }
    }
    ```
  - `POST /api/v1/contracts` nhận thêm:
    - `services`: `Array<{ service_id: string, quantity?: number, unit_price?: number, note?: string }>` -> tạo `service_subscription` (`status = 'PENDING_APPROVAL'`) cho dịch vụ cố định/số lượng, và tự động ghi `contract_service_price` nếu `unit_price` khác giá niêm yết danh mục hoặc nếu là dịch vụ `METERED`.
    - `service_prices`: `Array<{ service_code: string, unit_price: number, effective_from?: string }>` -> upsert `contract_service_price`.
  - Khi hủy nháp (`POST /:id/cancel`): cập nhật các `service_subscription` `PENDING_APPROVAL` của hợp đồng sang `'CANCELLED'`.
  - Khi kích hoạt thành công (`completeActivation` ở `/activate` và `/approve`):
    1. Chuyển toàn bộ `service_subscription` `PENDING_APPROVAL` của hợp đồng sang `'ACTIVE'` (tính `prorata_amount` nếu `start_date` giữa tháng).
    2. Khởi tạo bản ghi lịch sử phiên bản gốc `contract_version` (`version_no = 1`, `reason = 'Khởi tạo hợp đồng gốc khi kích hoạt'`) nếu chưa có.
    3. Gửi thông báo (`notification`):
       - Khi vào `PENDING_APPROVAL`: gửi thông báo `CONTRACT_PENDING_APPROVAL` cho các tài khoản `OWNER` `ACTIVE` của tòa nhà.
       - Khi `OWNER` từ chối (`POST /:id/reject`): gửi thông báo `CONTRACT_PRICE_REJECTED` cho các `MANAGER` của tòa nhà.
       - Khi vào `ACTIVE`: gửi thông báo `CONTRACT_ACTIVATED` cho Cư dân chính (+ thành viên ở cùng có tài khoản, kèm hướng dẫn đăng nhập SĐT + OTP trên Cổng cư dân) VÀ gửi thông báo `CONTRACT_BILLING_SCHEDULED` cho các `MANAGER` của tòa nhà (thông tin lịch thu định kỳ mới).
    4. Trả kèm `invoice_schedule` trong JSON phản hồi của `POST /:id/activate`, `POST /:id/approve`, và trả kèm `invoice_schedule` + `service_subscriptions` trong `GET /api/v1/contracts/:id`.

- [ ] **Step 1: Viết unit test `api/test/invoiceSchedule.test.js` và integration test `Task 4` trong `api/test/contractCreationFixes.test.js`**

1. Tạo `api/test/invoiceSchedule.test.js` kiểm tra:
   - Hợp đồng `monthly` bắt đầu giữa tháng (`2026-11-16` -> `2027-02-16`), `billing_day = 31`, `payment_due_days = 7`: kỳ tháng `2026-11` tính đúng pro-rata, kỳ `2027-02` kẹp `issue_date = '2027-02-28'` và `due_date = '2027-03-07'` (Review Focus #5).
   - Hợp đồng `quarterly` (`billing_cycle = 'quarterly'`): gộp đúng từng cụm 3 tháng trong khoảng hiệu lực `[start_date, end_date)` và cộng đúng dịch vụ cố định + đơn giá ghi đè `contract_service_price`.
   - Khớp đúng `actual_invoice` khi truyền danh sách hóa đơn đã sinh.
2. Thêm subtest `Task 4` vào `api/test/contractCreationFixes.test.js` kiểm tra:
   - `POST /api/v1/contracts` kèm `services[]` (VD: Internet + Gửi xe máy với giá riêng) và `service_prices[]` (VD: `ELECTRICITY = 3500`) -> khi còn `DRAFT`, `service_subscription.status === 'PENDING_APPROVAL'` và `generateInvoicesCore` không thu phí nháp; nếu hủy nháp (`POST /:id/cancel`), subscription chuyển sang `'CANCELLED'` (Review Focus #4).
   - Khi kích hoạt hợp đồng sang `ACTIVE`: `service_subscription` chuyển sang `'ACTIVE'`, `contract_version` `version_no = 1` được ghi, `notification` được gửi cho cả Cư dân (`CONTRACT_ACTIVATED`) và `MANAGER` tòa nhà (`CONTRACT_BILLING_SCHEDULED`), và `GET /api/v1/contracts/:id` trả về đầy đủ `service_subscriptions` + `invoice_schedule`.
   - Khi kích hoạt hợp đồng lệch khung giá sang `PENDING_APPROVAL`: `OWNER` của tòa nhà nhận được `notification` `CONTRACT_PENDING_APPROVAL`.

- [ ] **Step 2: Chạy unit test và integration test để xác nhận FAIL**

Run: `cd d:\resihub\api; node --test test/invoiceSchedule.test.js test/contractCreationFixes.test.js`
Expected: FAIL (`Cannot find module '../src/services/invoiceSchedule.js'`).

- [ ] **Step 3: Cài đặt `api/src/services/invoiceSchedule.js` và tích hợp vào `api/src/routes/contracts.js`**

1. Tạo `api/src/services/invoiceSchedule.js` cài đặt hàm thuần `buildExpectedInvoiceSchedule({ contract, subscriptions, servicePrices, existingInvoices })` dùng toán ngày UTC (`YYYY-MM-DD`) không phụ thuộc múi giờ máy chủ:
   - Duyệt từng tháng `YYYY-MM` giao với khoảng nửa mở `[start_date, effective_end_date)` (nhóm theo 1 tháng nếu `monthly`, 3 tháng nếu `quarterly`).
   - Áp dụng đúng thứ tự ưu tiên giá `contract_service_price` -> `service_subscription.unit_price` giống hệt `generateInvoicesCore` trong `api/src/routes/invoices.js`.
   - Kẹp `issue_date` vào `Math.min(billingDay, daysInMonth)` và cộng `payment_due_days` ra `due_date`.
2. Trong `api/src/routes/contracts.js`:
   - Mở rộng `POST /` xử lý mảng `services` và `service_prices` ngay trong cùng transaction tạo hợp đồng nháp.
   - Mở rộng `POST /:id/cancel` hủy các `service_subscription` đang `PENDING_APPROVAL` của hợp đồng nháp.
   - Mở rộng `completeActivation` và `POST /:id/reject`: kích hoạt `service_subscription`, tạo `contract_version` #1, gửi thông báo qua `adminPool` tới `OWNER` / `MANAGER` / `RESIDENT` tương ứng, và tính `invoice_schedule`.
   - Mở rộng `GET /:id`: truy vấn kèm `service_subscriptions`, `contract_service_price`, `invoice` của hợp đồng và trả về `service_subscriptions` + `invoice_schedule`.

- [ ] **Step 4: Chạy lại unit test + integration test để xác nhận PASS**

Run: `cd d:\resihub\api; node --test test/invoiceSchedule.test.js test/contractCreationFixes.test.js`
Expected: PASS 100%.

- [ ] **Step 5: Commit Task 4**

```bash
git add api/src/services/invoiceSchedule.js api/test/invoiceSchedule.test.js api/src/routes/contracts.js api/test/contractCreationFixes.test.js
git commit -m "feat(contracts): add inline contract services, activation notifications, and expected invoice schedule"
```

---

### Task 5: Cập Nhật Giao Diện Quản Trị Hợp Đồng (RBAC, Bước 4 Dịch Vụ, `payment_due_days` & `billing_day` `1–31`, Xem PDF Scan & Tab Lịch Hóa Đơn Dự Kiến)

**Files:**
- Modify: `frontend/src/hooks/usePermission.js`
- Modify: `frontend/src/components/ui/FileUpload.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractsPage.jsx`
- Modify: `frontend/src/pages/admin/contracts/ContractDetailPage.jsx`
- Create: `frontend/src/utils/__tests__/contractCreationUi.test.js`

**Interfaces:**
- Consumes:
  - `servicesService.listCatalog()` từ `frontend/src/services/services.service.js`.
  - Payload mở rộng của `POST /api/v1/contracts`, `PATCH /api/v1/contracts/:id`, `POST /api/v1/contracts/:id/scan` và dữ liệu `service_subscriptions`, `invoice_schedule`, `has_building_owner` từ `GET /api/v1/contracts/:id`.
- Produces:
  - `usePermission()` trả về:
    - `canCreateContracts: isManager`
    - `canManageContracts: isManager`
    - `canApproveContractPrice: isOwner || isSysAdmin`
    - `canApproveContractAmendments: isManager`
    - `canApproveContracts: isManager` (dùng cho duyệt đề nghị cư dân / phụ lục nội bộ)
    - `canTerminateContracts: isManager`
  - `AuthPdfViewer({ src, title, className })` trong `frontend/src/components/ui/FileUpload.jsx`.

- [ ] **Step 1: Viết bộ kiểm thử giao diện `frontend/src/utils/__tests__/contractCreationUi.test.js`**

Kiểm tra các bất biến của 7 hạng mục trên tầng Frontend:
1. `usePermission.js` đặt `canCreateContracts: isManager` và `canTerminateContracts: isManager` (không cấp nhầm cho `isSysAdmin`), đồng thời có `canApproveContractPrice` cho `isOwner`.
2. `ContractsPage.jsx` không còn gọi bù `contractsService.update(created.id, { billing_cycle })`, hỗ trợ `max="31"` cho `billing_day`, có ô `payment_due_days`, và tải `servicesService.listCatalog` để hiển thị Bước 4 chọn dịch vụ đi kèm & đơn giá riêng (`services` + `service_prices`).
3. `FileUpload.jsx` hỗ trợ xử lý xem trước `application/pdf` và prop `maxSizeMB`.
4. `ContractDetailPage.jsx` đặt `canManageOps = isManager`, hỗ trợ `accept="image/jpeg,image/png,application/pdf"`, hiển thị `payment_due_days`, mở `billing_day` tới `31`, và có tab `schedule` hiển thị `invoice_schedule` (`Lịch hóa đơn dự kiến`).

- [ ] **Step 2: Chạy test frontend để xác nhận FAIL**

Run: `cd d:\resihub\frontend; node --test src/utils/__tests__/contractCreationUi.test.js`
Expected: FAIL.

- [ ] **Step 3: Cập nhật `usePermission.js`, `FileUpload.jsx`, `ContractsPage.jsx` và `ContractDetailPage.jsx`**

1. **`frontend/src/hooks/usePermission.js`:** Cập nhật các cờ quyền hợp đồng theo đúng đặc tả ở mục Interfaces.
2. **`frontend/src/components/ui/FileUpload.jsx`:**
   - Thêm prop `maxSizeMB = 5` (thông báo lỗi động theo `maxSizeMB` và loại tệp).
   - Khi phần tử trong `files` là PDF (`String(item).startsWith('data:application/pdf')` hoặc `.endsWith('.pdf')`), hiển thị ô biểu tượng `FileText` + nhãn `PDF` thay vì `<AuthImage />`.
   - Export thêm `AuthPdfViewer({ src, title = 'Bản scan PDF', className = '' })` dùng `fetchAuthBlobUrl(src)` để render `<iframe src={blobUrl} title={title} className={className} />` kèm nút mở tab mới.
3. **`frontend/src/pages/admin/contracts/ContractsPage.jsx`:**
   - Trong `createForm`: thêm `payment_due_days: '5'`; mở `billing_day` lên `min="1" max="31"` (`Math.min(31, Math.max(1, ...))`).
   - Xóa khối `contractsService.update(created.id, { billing_cycle })` và gửi trực tiếp `billing_cycle`, `payment_due_days`, `services`, `service_prices` trong `contractsService.create(payload)`.
   - Khi mở modal tạo hợp đồng (`handleOpenCreate`): gọi thêm `servicesService.listCatalog()` để lấy danh mục dịch vụ đang hoạt động.
   - Bổ sung khối UI **Bước 4: Dịch vụ đi kèm & Đơn giá riêng (`FR-014` / `FR-065`)**:
     - Danh sách dịch vụ định kỳ (`FIXED` / `QUANTITY`): checkbox chọn đăng ký, ô số lượng (với `QUANTITY` như gửi xe máy/ô tô), ô đơn giá áp dụng (mặc định lấy giá danh mục, nếu sửa khác giá gốc sẽ tự động lưu cả đơn giá riêng hợp đồng).
     - Hai ô tùy chọn ghi đè đơn giá **Điện (`ELECTRICITY`)** và **Nước (`WATER`)** theo hợp đồng (để trống nếu dùng biểu phí tiêu chuẩn của tòa nhà).
   - Cập nhật hộp cảnh báo lệch khung giá (`< 90%` giá niêm yết): ghi rõ hợp đồng sẽ chờ **Chủ sở hữu tòa nhà (`OWNER`)** phê duyệt.
4. **`frontend/src/pages/admin/contracts/ContractDetailPage.jsx`:**
   - Đổi `const canManageOps = isManager;` (thay vì `isSysAdmin || isManager`).
   - Tách điều kiện hiển thị nút duyệt giá ưu đãi: `const canApprovePrice = isOwner || (isSysAdmin && contract?.has_building_owner === false);`.
   - Đổi điều kiện duyệt phụ lục sang `canApproveContractAmendments` (`isManager` + Four-eyes).
   - Hiển thị `Hạn thanh toán: {contract.payment_due_days || 5} ngày sau phát hành` trên thẻ Tổng quan; bổ sung ô `payment_due_days` và nâng `billing_day` `max="31"` trong Modal Sửa hợp đồng nháp.
   - Nâng cấp mục **Bản scan hợp đồng ký kết**: truyền `accept="image/jpeg,image/png,application/pdf"` và `maxSizeMB={10}` vào `<FileUpload />`; phân biệt tệp `att.mime === 'application/pdf'` để render thẻ PDF và mở `AuthPdfViewer` trong Modal xem trước.
   - Thêm Tab **`schedule` (`Lịch hóa đơn dự kiến`)** hiển thị bảng tổng hợp các kỳ thu dự kiến từ `contract.invoice_schedule` (Kỳ thu, Ngày chốt dự kiến, Hạn thanh toán, Tiền thuê, Phí dịch vụ cố định, Tổng tạm tính chưa gồm điện/nước, và liên kết sang Hóa đơn thực tế nếu kỳ đó đã phát hành) cùng danh sách `service_subscriptions` đang gắn với hợp đồng.

- [ ] **Step 4: Chạy test frontend, lint, build và chạy toàn bộ test suite hai đầu**

Run:
1. `cd d:\resihub\frontend; node --test src/utils/__tests__/*.test.js`
2. `cd d:\resihub\frontend; npm run lint; npm run build`
3. `cd d:\resihub\api; npm test`
Expected: Tất cả unit test, integration test, linter và production build đều PASS 0 lỗi.

- [ ] **Step 5: Commit Task 5**

```bash
git add frontend/src/hooks/usePermission.js frontend/src/components/ui/FileUpload.jsx frontend/src/pages/admin/contracts/ContractsPage.jsx frontend/src/pages/admin/contracts/ContractDetailPage.jsx frontend/src/utils/__tests__/contractCreationUi.test.js
git commit -m "feat(frontend): align contract RBAC, add step 4 services, PDF scan viewer, billing config, and invoice schedule tab"
```

