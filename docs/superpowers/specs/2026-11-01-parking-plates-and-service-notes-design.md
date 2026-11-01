# Thiết kế Tách Biển số xe Bắt buộc cho Dịch vụ Gửi xe & Ghi chú Dịch vụ Tùy chọn

**Ngày:** 2026-11-01  
**Quy mô:** Thay đổi nhỏ gọn (bổ sung 1 cột mảng `vehicle_plates`, chuẩn hóa kiểm tra Backend và đồng bộ UI trên 4 màn hình đăng ký dịch vụ + bản in A4)

## 1. Mục đích & Lý do (Intent & Why)
Hiện tại các biểu mẫu tạo/sửa hợp đồng và đăng ký dịch vụ tiện ích đang dùng chung một ô `"Ghi chú dịch vụ / Biển số xe (tùy chọn)"` cho mọi loại dịch vụ. Cách gộp này gây hai bất cập:
- Với các dịch vụ không phải gửi xe (Internet, Vệ sinh, Phí quản lý...), nhãn `"/ Biển số xe"` gây thừa và khó hiểu cho người nhập.
- Với dịch vụ Gửi xe / Đỗ xe (`category = 'PARKING'`), biển số lại đang là tùy chọn và nằm chung trong `note`, dẫn tới nguy cơ lập hợp đồng / gửi yêu cầu cấp thẻ xe thiếu biển số, lệch số lượng xe đăng ký với số biển số khai báo, hoặc bị mất thông tin biển số khi hủy dịch vụ (do luồng hủy dịch vụ ghi đè lý do hủy vào cột `note`).

## 2. Mục tiêu & Giới hạn (Goals, Non-Goals, Anti-Goals)
- **Mục tiêu (Goals):**
  1. **Dịch vụ Gửi xe / Đỗ xe (`category === 'PARKING'`):** Bắt buộc nhập đủ `N` biển số tương ứng với `Số lượng` xe đăng ký (`Số lượng = 1` hiện 1 ô `Biển số xe *`; `Số lượng >= 2` tự sinh `Biển số xe #1 *`, `Biển số xe #2 *`... tối đa `10` xe/gói), đồng thời có riêng 1 ô `Ghi chú dịch vụ (tùy chọn)` bên dưới.
  2. **Các dịch vụ khác (`category !== 'PARKING'`):** Chỉ hiển thị duy nhất 1 ô `Ghi chú dịch vụ (tùy chọn)` (bỏ hoàn toàn chữ `/ Biển số xe`).
  3. **Đồng bộ toàn tuyến:** Áp dụng thống nhất tại cả 4 màn hình (`ContractsPage.jsx`, `ContractDetailPage.jsx`, `SubscriptionsPage.jsx`, `ServicesTab.jsx`), 3 nhóm API ghi dữ liệu (`contracts.js`, `services.js`, `resident.js`) và mẫu in Hợp đồng A4 (`contractTemplate.js`).
  4. **Lưu trữ tách biệt:** Thêm cột `vehicle_plates TEXT[]` trên bảng `service_subscription` độc lập với `note` để khi chỉnh sửa nháp hoặc hủy dịch vụ không bao giờ làm mất danh sách biển số xe.
- **Không nằm trong phạm vi (Non-Goals):**
  - Không tách bảng thực thể phương tiện (`vehicle`) riêng hay tích hợp phần cứng cổng từ/barrier.
  - Không thay đổi công thức tính tiền định kỳ, đơn giá ưu đãi hợp đồng hay công thức Pro-rata hiện có.
- **Điều cần tránh (Anti-Goals):**
  - Không khóa cứng regex chỉ nhận biển số cơ giới — phải cho phép ghi chuỗi định danh hợp lý như `"Xe đạp"` hoặc `"Chờ bấm biển"` (miễn không rỗng và không trùng lặp giữa các xe trong cùng gói).
  - Không làm hỏng hiển thị hoặc làm lỗi các bản ghi `service_subscription` cũ đã tạo trước khi có cột `vehicle_plates`.

## 3. Ràng buộc kỹ thuật (Constraints)
- PostgreSQL 16 bật Row-Level Security trên `service_subscription` (`025_services_catalog.sql`, `042_idempotency_and_draft_services_rls.sql`).
- Với gói `PARKING`, giới hạn `1 <= quantity <= 10` trên mỗi dòng đăng ký để giao diện lưới 2 cột gọn gàng; mỗi biển số sau khi cắt khoảng trắng dài `2..30` ký tự, không trùng nhau trong cùng một gói đăng ký (so sánh không phân biệt hoa/thường); `note` tối đa `500` ký tự.
- Luồng cập nhật trạng thái / hủy dịch vụ (`PATCH /api/v1/service-subscriptions/:id` và `PATCH /api/v1/resident/services/:id/cancel`) giữ nguyên `vehicle_plates` đã lưu, chỉ cập nhật `status`, `end_date`, `prorata_amount` và `note`.

## 4. Các phương án đã cân nhắc (Approaches)
1. **Phương án 1 — Tách cột `vehicle_plates TEXT[]` riêng trên bảng `service_subscription` *(Đã chọn)*:**
   Thêm cột mảng `vehicle_plates TEXT[] NOT NULL DEFAULT '{}'` bên cạnh cột `note`. Giữ nguyên biển số khi hủy dịch vụ ghi đè `note`, nạp lại chính xác từng ô `#1..#N` khi sửa hợp đồng nháp, hiển thị thẻ biển số và tìm kiếm theo biển số sạch sẽ. Đánh đổi: thêm 1 migration nhỏ (`043`).
2. **Phương án 2 — Không sửa DB, ghép chuỗi biển số và ghi chú vào chung cột `note`:**
   Không cần chạy thêm migration nhưng dễ lỗi khi người dùng gõ ký tự phân cách trong ghi chú và bị ghi đè mất biển số khi cư dân/quản lý nhập lý do hủy dịch vụ vào cột `note`.

**Lý do chọn Phương án 1:** Đảm bảo toàn vẹn dữ liệu biển số xe xuyên suốt vòng đời hợp đồng — đăng ký thêm — hủy dịch vụ mà chi phí thay đổi DB rất nhỏ.

## 5. Chi tiết thiết kế theo quyết định đã chốt

### 5.1. Cơ sở dữ liệu
- Tạo migration `api/src/db/migrations/043_service_subscription_vehicle_plates.sql`:
  - Bổ sung cột `vehicle_plates TEXT[] NOT NULL DEFAULT '{}'` vào bảng `service_subscription`.

### 5.2. Kiểm tra hợp lệ & Lưu trữ ở Backend
- Xây dựng hàm chuẩn hóa dùng chung cho mọi luồng tạo/cập nhật đăng ký dịch vụ:
  - **Khi `service_catalog.category === 'PARKING'`:**
    - Kiểm tra `quantity` là số nguyên trong khoảng `1..10` (vượt quá trả `422 INVALID_SERVICE_QUANTITY`).
    - Yêu cầu `vehicle_plates` là mảng có đúng `quantity` phần tử; từng phần tử sau `trim()` dài `2..30` ký tự (thiếu/rỗng trả `422 VEHICLE_PLATES_REQUIRED`, quá dài/ngắn trả `422 INVALID_VEHICLE_PLATES`).
    - Kiểm tra không trùng nhau giữa các ô trong cùng gói (so sánh chuẩn hóa khoảng trắng + chữ hoa, trùng trả `422 DUPLICATE_VEHICLE_PLATE`).
    - Lưu mảng biển số đã `trim()` vào `vehicle_plates`, lưu ghi chú tùy chọn (tối đa `500` ký tự) vào `note`.
  - **Khi `service_catalog.category !== 'PARKING'`:**
    - Luôn lưu `vehicle_plates = '{}'`, chỉ chuẩn hóa và lưu `note` tùy chọn (tối đa `500` ký tự).
- Áp dụng đồng bộ tại:
  1. `POST /api/v1/contracts` & `PATCH /api/v1/contracts/:id` (`syncDraftContractServicesInTx` trong `api/src/routes/contracts.js`).
  2. `POST /api/v1/service-subscriptions` (`api/src/routes/services.js`).
  3. `POST /api/v1/resident/services` (`api/src/routes/resident.js`).
- **Mẫu in Hợp đồng A4 (`GET /api/v1/contracts/:id/template` & `api/src/services/contractTemplate.js`):**
  - Truy vấn thêm `ss.vehicle_plates` trong `contracts.js`.
  - Trong `buildContractTemplateServiceRows`, trả kèm `vehiclePlates` (mảng chuỗi) bên cạnh `note`; khi kết xuất HTML bảng Điều 5, hiển thị rõ dòng `Biển số: ...` và dòng ghi chú (nếu có), cả hai đều đi qua `escapeTemplateHtml`.

### 5.3. Giao diện Frontend (4 màn hình)
- Dùng chung khối nhập liệu biển số & ghi chú dịch vụ theo `category`:
  - **Khi dịch vụ thuộc nhóm `PARKING`:**
    - Ô `Số lượng` đặt `min="1"` và `max="10"`; khi tăng/giảm số lượng, mảng `vehicle_plates` tự mở rộng hoặc cắt theo đúng số lượng mới (giữ nguyên các biển số đã gõ ở các ô trước).
    - Nếu `Số lượng = 1`: hiển thị 1 ô `Biển số xe` (`required`).
    - Nếu `Số lượng >= 2`: hiển thị lưới 2 cột `Biển số xe #1`, `Biển số xe #2`... (`required`).
    - Kiểm tra tại chỗ trước khi gửi: báo lỗi đỏ ngay dưới ô bị bỏ trống hoặc bị trùng biển số.
    - Bên dưới là 1 ô riêng `Ghi chú dịch vụ (tùy chọn)` (placeholder gợi ý loại xe, màu xe, số thẻ từ, vị trí đỗ).
  - **Khi dịch vụ không thuộc nhóm `PARKING`:**
    - Chỉ hiển thị duy nhất 1 ô `Ghi chú dịch vụ (tùy chọn)`.
- Áp dụng nhập liệu & hiển thị trên 4 màn hình:
  1. **`ContractsPage.jsx`:** Khối chọn dịch vụ đi kèm khi Tạo hợp đồng nháp.
  2. **`ContractDetailPage.jsx`:** Modal *Chỉnh sửa hợp đồng nháp* (nạp lại `vehicle_plates` và `note` hiện có) + cột *Biển số / Ghi chú* ở bảng *Dịch vụ đi kèm theo hợp đồng* (hiển thị badge biển số tách với dòng ghi chú).
  3. **`SubscriptionsPage.jsx`:** Modal *Gán dịch vụ mới cho căn hộ*, hiển thị badge biển số trên bảng quản lý đăng ký dịch vụ và hỗ trợ ô tìm kiếm lọc được theo `vehicle_plates`.
  4. **`ServicesTab.jsx` (Cổng cư dân):** Modal *Đăng ký sử dụng dịch vụ tiện ích* và thẻ dịch vụ đang đăng ký / lịch sử đã hủy.

## 6. Phần để bước lập kế hoạch & thi công quyết định (Left to the Builder)
- Tên module cụ thể cho helper Backend (ví dụ `api/src/services/serviceSubscriptionMeta.js`) và component Frontend tái sử dụng (ví dụ `frontend/src/components/common/ServiceSubscriptionMetaFields.jsx`).
- Chi tiết styling badge hiển thị biển số xe trên các bảng/thẻ và cấu trúc các bài kiểm thử tự động (`node --test`).
