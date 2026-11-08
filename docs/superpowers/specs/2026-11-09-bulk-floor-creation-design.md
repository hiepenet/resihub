# Thiết kế Chức năng Thêm Tầng Hàng Loạt (Bulk Floor Creation)

**Ngày:** 2026-11-09  
**Quy mô:** Thay đổi nhỏ gọn (1 helper thuần sinh/chuẩn hóa dải tầng, 1 endpoint `POST /api/v1/buildings/:id/floors/bulk` tuân thủ RLS + audit, và nâng cấp Modal Thêm tầng sang 2 chế độ Đơn lẻ / Hàng loạt dùng chung cho Sơ đồ tầng & Chi tiết tòa nhà — không cần migration DB)

## 1. Mục đích & Lý do (Intent & Why)
Hiện tại, khi thiết lập cấu trúc tòa nhà mới (FR-007 / NV-04), Quản lý chỉ có thể tạo từng tầng một qua `POST /api/v1/buildings/:id/floors`. Với tòa nhà có 10–30 tầng (kèm tầng hầm, tầng trệt), việc lặp lại thao tác này hàng chục lần gây mất thời gian trước khi có thể sử dụng tính năng tạo căn hộ hàng loạt (`BulkApartmentModal`). Chức năng thêm tầng hàng loạt giúp khởi tạo toàn bộ dải tầng trong một thao tác duy nhất nhưng vẫn linh hoạt với các đặc thù thực tế (bỏ tầng `0` giữa hầm và tầng `1`, né tầng `4`/`13`, đặt tên `Tầng 12A`, hoặc thêm tầng bổ sung vào tòa đã có sẵn một số tầng).

## 2. Mục tiêu, Giới hạn & Điều cần tránh (Goals, Non-Goals, Anti-Goals)
- **Mục tiêu (Goals):**
  1. Cung cấp endpoint `POST /api/v1/buildings/:id/floors/bulk` cho `SYS_ADMIN` và `MANAGER` được phân công tòa nhà, hỗ trợ xem trước (`dry_run: true`) và lưu nguyên tử all-or-nothing trong một transaction RLS kèm ghi `audit_log` cho từng tầng.
  2. Nâng cấp Modal **Thêm tầng** thành 2 tab **Từng tầng** và **Hàng loạt**: nhập dải `Từ tầng` → `Đến tầng`, tùy chỉnh tiền tố tên, bật/tắt tầng `0`, tự bỏ qua tầng đã tồn tại, bỏ tick từng tầng lẻ và sửa trực tiếp tên hiển thị từng tầng trước khi tạo.
  3. Bổ sung điểm mở nhanh tại màn hình trống (`EmptyState`) của `FloorPlanView` và tại khu vực **Danh sách tầng** trong `BuildingDetailPage` (tab Danh sách Khu), đồng bộ làm mới dữ liệu/cache sau khi tạo.
- **Không nằm trong phạm vi (Non-Goals):**
  - Không thay đổi cấu trúc bảng `floor` hay thêm bảng mới trong PostgreSQL.
  - Không thêm bước tạo tầng vào form khởi tạo tòa nhà mới tại `BuildingsPage.jsx`.
  - Không gộp việc sinh căn hộ vào cùng API tạo tầng (sinh căn hộ tiếp tục dùng `BulkApartmentModal`).
- **Điều cần tránh (Anti-Goals):**
  - Không chèn dở dang một phần danh sách tầng khi có lỗi hoặc xung đột (`UNIQUE (building_id, level)`).
  - Không đặt thêm một nút tên "Tạo hàng loạt" thứ hai ngay cạnh nút tạo căn hộ hàng loạt trên thanh công cụ gây nhầm lẫn cho người vận hành.

## 3. Ràng buộc kỹ thuật (Constraints)
- Bảng `floor` có ràng buộc `UNIQUE (building_id, level)`, `level INTEGER NOT NULL`, `name TEXT` và bật `FORCE ROW LEVEL SECURITY` (`rls_floor_insert` cho `SYS_ADMIN` và `MANAGER` có `user_role` trên tòa nhà).
- Phân quyền chuẩn PRD Mục 6.2 & AC-019.1: kiểm tra tồn tại tòa nhà theo `org_id` (`404`) trước, sau đó kiểm tra quyền quản lý tòa nhà (`403 ACCESS_DENIED` + `logAccessDenied`), rồi mới kiểm tra dữ liệu đầu vào (`422`).
- Giới hạn an toàn cho mỗi lần gọi: tối đa `100` tầng/lần, `level` là số nguyên trong khoảng `-10..200`, `name` tối đa `100` ký tự, không trùng `level` ngay bên trong cùng một payload.
- Giữ nguyên API đơn lẻ `POST /api/v1/buildings/:id/floors` để tương thích ngược hoàn toàn với mã nguồn và các bộ test hiện có.

## 4. Các hướng tiếp cận đã cân nhắc (Approaches)
1. **Hướng 1 — Tích hợp chế độ "Từng tầng / Hàng loạt" kèm bảng xem trước trong Modal Thêm tầng + API `POST /api/v1/buildings/:id/floors/bulk` *(Đã chọn)*:**
   Giữ gọn thanh công cụ hiện tại, cho phép sinh dải tầng linh hoạt, bỏ chọn hoặc đổi tên từng tầng ngay trên bảng xem trước và lưu nguyên tử qua API bulk riêng. Xử lý trọn vẹn các tình huống thực tế của chung cư Việt Nam mà không làm nặng form tạo tòa nhà.
2. **Hướng 2 — Hướng 1 + Khởi tạo nhanh số tầng ngay trong form Tạo tòa nhà mới (`BuildingsPage.jsx`):**
   Giảm được 1 bước khi tạo tòa mới từ đầu nhưng làm dài thêm modal khởi tạo tòa nhà (vốn đã có xác thực Chủ đầu tư + VietQR) và phải can thiệp vào `POST /api/v1/buildings`.
3. **Hướng 3 — Nhập 2 ô `Từ tầng` – `Đến tầng` tối giản, tạo thẳng không qua bảng xem trước:**
   Ít mã nguồn nhất nhưng cứng nhắc khi cần bỏ tầng `0`, né tầng `13`, đặt tên `Tầng 12A` hoặc thêm tầng bổ sung quanh các tầng đã tồn tại.

**Lý do chọn Hướng 1:** Cân bằng tốt nhất giữa sự gọn gàng trên giao diện, tính linh hoạt nghiệp vụ thực tế và sự đồng nhất kiến trúc với `BulkApartmentModal`.

## 5. Chi tiết thiết kế

### 5.1. Quyết định từ người dùng
- Giữ nút **Thêm tầng** làm điểm vào chính trên `FloorPlanView` (bổ sung nút mở tại `EmptyState` khi tòa chưa có tầng và tại khu vực Danh sách tầng ở `BuildingDetailPage`).
- Trong modal **Thêm tầng**, cung cấp 2 tab chuyển đổi: **Từng tầng** và **Hàng loạt** có danh sách xem trước, hỗ trợ bỏ chọn tầng bất kỳ và sửa tên hiển thị từng dòng trước khi bấm lưu.
- Backend xử lý qua `POST /api/v1/buildings/:id/floors/bulk` trong một transaction RLS và ghi `audit_log`.

### 5.2. Đề xuất kỹ thuật mặc định của hệ thống (Calls by Builder — mời bạn kiểm tra)
1. **Quy tắc đặt tên mặc định cho từng tầng *(Đề xuất của hệ thống)*:** Đồng bộ với logic đơn lẻ hiện tại trong `buildings.js`:
   - `level < 0`: `Tầng hầm B${Math.abs(level)}` (ví dụ `-1` → `Tầng hầm B1`, `-2` → `Tầng hầm B2`).
   - `level === 0`: `Tầng Trệt`.
   - `level > 0`: `${namePrefix}${level}` với tiền tố mặc định `"Tầng "` (ví dụ `Tầng 1`, `Tầng 2`...; quản lý có thể đổi tiền tố chung hoặc sửa riêng ô tên của bất kỳ dòng nào như tầng `13` → `Tầng 12A`).
2. **Gợi ý mặc định thông minh khi mở tab Hàng loạt *(Đề xuất của hệ thống)*:**
   - Nếu tòa chưa có tầng nào: gợi ý `Từ tầng = 1`, `Đến tầng = 5`.
   - Nếu tòa đã có tầng (ví dụ cao nhất là tầng `5`): tự gợi ý nối tiếp `Từ tầng = 6`, `Đến tầng = 10`.
   - Khi dải tầng đi từ âm sang dương (`fromLevel < 0 && toLevel > 0`), hiển thị checkbox **"Bao gồm Tầng Trệt (0)"** mặc định **tắt** (do đa số tòa nhà đi từ `B1` lên thẳng `Tầng 1`), quản lý có thể bật lại chỉ bằng 1 click.
   - Checkbox **"Tự động bỏ qua tầng đã tồn tại"** mặc định **bật**: các tầng đã có trong tòa sẽ được đánh dấu *"Đã có — sẽ bỏ qua"* và chỉ những tầng mới được chọn mới gửi lên tạo; nếu người dùng tắt tùy chọn này thì tầng trùng sẽ báo đỏ xung đột.
3. **Hợp đồng dữ liệu API `POST /api/v1/buildings/:id/floors/bulk` *(Đề xuất của hệ thống)*:**
   - Payload nhận `floors: Array<{ level: number, name?: string }>` (hoặc `from_level`, `to_level` để API tự bung dải khi gọi trực tiếp), kèm `skip_existing?: boolean` (mặc định `false` ở mức API để an toàn chặt chẽ) và `dry_run?: boolean`.
   - Khi `dry_run: true`: trả `200 { data, conflicts, skipped, total, valid }` và tuyệt đối không ghi DB.
   - Khi `dry_run: false`: nếu `skip_existing: false` và có tầng trùng thì trả `409 FLOOR_EXISTS` kèm `conflicts`; nếu hợp lệ thì chèn toàn bộ tầng cần tạo trong `BEGIN ... COMMIT` qua `getUserClient(req)`, ghi 1 dòng `audit_log` (`action = 'CREATE'`, `entity = 'floor'`) cho mỗi tầng mới và trả `201 { message, created_count, skipped_count, data }`.

## 6. Phần để bước lập kế hoạch & thi công xử lý (Left to the Builder)
- Xây dựng module thuần `api/src/services/floorBulk.js` (sinh dải tầng, đặt tên mặc định, kiểm tra hợp lệ & phát hiện trùng trong payload) kèm unit test `api/test/floorBulk.test.js`.
- Cài đặt route `POST /api/v1/buildings/:id/floors/bulk` trong `api/src/routes/buildings.js` (đặt trước hoặc tách rõ với `/:id/floors/:floor_id`) kèm integration test `api/test/floorBulkCreate.test.js` kiểm tra RBAC, IDOR, `dry_run`, trùng lặp, `skip_existing`, rollback và `audit_log`.
- Bổ sung `previewFloorsBulk` / `createFloorsBulk` trong `frontend/src/services/buildings.service.js`, tách component `FloorModal.jsx` phục vụ cả `FloorPlanPage.jsx` và `BuildingDetailPage.jsx`, và đảm bảo làm mới cache (`force: true` + sự kiện `resihub:buildings-updated` để cập nhật tổng số tầng trên danh sách tòa nhà).

