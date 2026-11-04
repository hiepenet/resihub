# Thiết kế Tự động Khởi tạo Đồng hồ Điện/Nước khi Hợp đồng ACTIVE & Bộ lọc Căn hộ có Hợp đồng ACTIVE

**Ngày:** 2026-11-05  
**Quy mô:** Thay đổi nhỏ gọn (1 hàm dịch vụ khởi tạo đồng hồ idempotent gắn vào luồng kích hoạt hợp đồng, 1 migration bù dữ liệu hiện có, nâng cấp `GET/POST /api/v1/meters` và thêm bộ lọc trên trang `MeterReadingsPage.jsx`)

## 1. Mục đích & Lý do (Intent & Why)
Hiện tại, khi căn hộ ở tòa mới hoặc căn mới phát sinh hợp đồng hiệu lực (`ACTIVE`) — ví dụ căn `A002` thuộc tòa `VOP-D` — hệ thống chưa tự động sinh cặp đồng hồ Điện (`ELECTRICITY`) và Nước (`WATER`), khiến danh sách trên trang **Chỉ số Điện / Nước** bị trống cho tới khi Quản lý bấm **"+ Khởi tạo đồng hồ"** thủ công cho từng căn. Đồng thời, khi căn hộ đã có đồng hồ lưu lại sau khi hợp đồng cũ kết thúc, Ban Quản Lý cần thêm bộ lọc để xem riêng các đồng hồ thuộc những căn hộ hiện đang có hợp đồng `ACTIVE`.

## 2. Mục tiêu, Giới hạn & Điều cần tránh (Goals, Non-Goals, Anti-Goals)
- **Mục tiêu (Goals):**
  1. Tự động khởi tạo cặp đồng hồ `ELECTRICITY` (`kWh`) và `WATER` (`m³`) cho căn hộ ngay khi hợp đồng của căn hộ đó chuyển sang trạng thái `ACTIVE`.
  2. Chạy migration bù dữ liệu 1 lần cho toàn bộ các căn hộ hiện đang có hợp đồng hiệu lực trong DB nhưng còn thiếu đồng hồ Điện và/hoặc Nước (bao gồm `VOP-D / A002`, các căn thiếu ở `VOP-A`, `RH-THAODIEN`).
  3. Bổ sung bộ lọc theo trạng thái hợp đồng của căn hộ trên API `GET /api/v1/meters` và thanh lọc của `MeterReadingsPage.jsx` để lọc nhanh các đồng hồ thuộc căn hộ đang có hợp đồng `ACTIVE`.
- **Không nằm trong phạm vi (Non-Goals):**
  - Không tự động tạo đồng hồ cho các căn hộ trống (`AVAILABLE`) chưa từng có hợp đồng hiệu lực.
  - Không thay đổi công thức tính tiêu thụ, khóa chỉ số đã lên hóa đơn hay luồng chuyển giao hợp đồng giữa kỳ (M08/M09).
- **Điều cần tránh (Anti-Goals):**
  - Không bao giờ báo lỗi trùng (`23505` / `409 DUPLICATE_METER`) hoặc ghi đè làm mất đồng hồ cũ / lịch sử `meter_reading` khi kích hoạt hợp đồng mới trên căn hộ đã có sẵn đồng hồ.
  - Không làm hỏng thao tác **"+ Khởi tạo đồng hồ"** thủ công nếu Quản lý muốn cập nhật lại `initial_reading` hoặc `unit_price` cho đồng hồ vừa được hệ thống tự tạo nhưng chưa có kỳ ghi chỉ số nào.

## 3. Ràng buộc kỹ thuật (Constraints)
- Bảng `meter` có ràng buộc `UNIQUE (apartment_id, meter_type)` và `UNIQUE (building_id, meter_code)`, đồng thời bật `FORCE ROW LEVEL SECURITY` với policy `rls_meter_modify` chỉ mở cho `MANAGER` của tòa nhà.
- Luồng kích hoạt hợp đồng đi qua cả `MANAGER` (`POST /api/v1/contracts/:id/activate` trên `client`) và `OWNER` (`POST /api/v1/contracts/:id/approve` trên `adminClient`), nên hàm khởi tạo đồng hồ phải tương thích cả hai ngữ cảnh kết nối mà không vướng RLS.
- Đơn giá mặc định khi tự tạo đồng hồ lấy từ `system_setting` (`key = 'billing_config'`: `electricity_default_price` mặc định `3800`, `water_default_price` mặc định `22000`), `initial_reading = 0`.

## 4. Các hướng tiếp cận đã cân nhắc (Approaches)
1. **Phương án 1 — Hàm dịch vụ `ensureApartmentMeters` ở tầng ứng dụng (`contracts.js`) + Migration bù dữ liệu hiện có + Bộ lọc API/UI *(Đã chọn)*:**
   Gọi tự động hàm khởi tạo đồng hồ idempotent tại luồng chuyển hợp đồng sang `ACTIVE` trong `contracts.js`, kết hợp migration bù dữ liệu một lần cho DB hiện tại và thêm bộ lọc trên `meters.js` + `MeterReadingsPage.jsx`. Dễ đọc, dễ kiểm soát ngay cạnh `syncApartmentStatus` và không can thiệp ngầm vào các dữ liệu giả lập chèn SQL thô trong bộ test hóa đơn cũ.
2. **Phương án 2 — Trigger PostgreSQL `AFTER INSERT OR UPDATE OF status ON contract` (`SECURITY DEFINER`) + Bộ lọc API/UI:**
   Tự sinh đồng hồ cho cả câu lệnh SQL chèn thẳng trong DB, nhưng ẩn nghiệp vụ đọc `billing_config` dưới tầng trigger và tự chèn đồng hồ Nước ngoài ý muốn vào các bộ test tích hợp cũ chỉ giả lập riêng đồng hồ Điện.

**Lý do chọn Phương án 1:** Đảm bảo đúng nghiệp vụ trên mọi thao tác kích hoạt/phê duyệt hợp đồng của ứng dụng, an toàn với RLS và giữ tương thích sạch với kiến trúc kiểm thử hiện có.

## 5. Chi tiết thiết kế

### 5.1. Quyết định từ người dùng
- **Thời điểm tự động tạo đồng hồ:** Khi hợp đồng chuyển sang trạng thái `ACTIVE` (kèm bù dữ liệu cho các căn đang có hợp đồng `ACTIVE` hiện hữu nhưng chưa có đồng hồ).
- **Xử lý khi căn hộ đã có đồng hồ:** An toàn tuyệt đối (`ON CONFLICT (apartment_id, meter_type) DO NOTHING`) — giữ nguyên đồng hồ và lịch sử chỉ số đã có, chỉ tạo bổ sung loại đồng hồ (`ELECTRICITY` hoặc `WATER`) còn thiếu.
- **Bộ lọc mới trên danh sách đồng hồ:** Có bộ lọc để lọc các đồng hồ điện/nước thuộc những căn hộ đang có hợp đồng `ACTIVE`.

### 5.2. Đề xuất kỹ thuật mặc định của hệ thống (Calls by Builder — mời bạn kiểm tra)
1. **Mã đồng hồ & giải quyết xung đột mã hiếm gặp *(Đề xuất của hệ thống)*:** Sinh mã mặc định theo chuẩn hiện có `EL-<building_code>-<apartment_code>` và `WT-<building_code>-<apartment_code>`; nếu mã này vô tình đã được gán thủ công cho căn khác trong cùng tòa thì tự gắn hậu tố ngắn từ `apartment_id` để không bao giờ văng lỗi `UNIQUE (building_id, meter_code)`.
2. **Cho phép cập nhật chỉ số đầu kỳ trên đồng hồ tự tạo chưa dùng *(Đề xuất của hệ thống)*:** Trong `POST /api/v1/meters` (`meters.js`), nếu căn hộ đã có đồng hồ cùng loại ở trạng thái chưa phát sinh bất kỳ bản ghi `meter_reading` nào, API sẽ cập nhật `initial_reading`, `unit_price` (và `meter_code` nếu truyền vào) cho đồng hồ đó thay vì trả `409 DUPLICATE_METER`; nếu đồng hồ đã có lịch sử `meter_reading` thì vẫn chặn `409 DUPLICATE_METER` để bảo vệ dữ liệu.
3. **Định nghĩa bộ lọc hợp đồng `ACTIVE` đồng nhất toàn hệ thống *(Đề xuất của hệ thống)*:**
   - API `GET /api/v1/meters` nhận thêm query `active_contract` (`'true'` | `'false'` | bỏ trống = tất cả) và trả kèm cờ `has_active_contract` trên từng dòng đồng hồ.
   - Đồng bộ với `invoices.js` và `apartments.js`, một căn hộ được tính là đang có hợp đồng hiệu lực khi tồn tại hợp đồng có `status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')` (vì hợp đồng đang chờ duyệt gia hạn hoặc chờ duyệt thanh lý vẫn đang có cư dân ở và cần ghi điện nước hàng tháng).
   - Trên `MeterReadingsPage.jsx`, thêm dropdown lọc trạng thái hợp đồng với mặc định là **`Tất cả căn hộ`** (để không ẩn các căn vừa thanh lý đang cần chốt công tơ kỳ cuối) cùng lựa chọn **`Đang có hợp đồng ACTIVE`** và **`Chưa có hợp đồng ACTIVE`**.

## 6. Phần để bước lập kế hoạch & thi công xử lý (Left to the Builder)
- Tổ chức file helper dịch vụ dùng chung (ví dụ trong `api/src/services/meterProvisioning.js`), gắn vào `runActivationSideEffects` và các nhánh khôi phục trạng thái `ACTIVE` trong `contracts.js` + ghi `audit_log` (`AUTO_CREATE_METER`).
- Viết migration `053_auto_provision_meters_for_active_contracts.sql` bù đồng hồ cho các căn đang có hợp đồng hiệu lực trong DB hiện tại.
- Viết bộ test TDD kiểm chứng: kích hoạt hợp đồng mới (cả luồng `MANAGER` `activate` và `OWNER` `approve`), kích hoạt hợp đồng thứ 2 trên căn đã có đồng hồ (không lỗi, không mất chỉ số cũ), cập nhật `initial_reading` khi chưa có `meter_reading`, và lọc `active_contract=true/false`, đồng thời rà soát tương thích các bộ test tích hợp M06/M08/M09 hiện hữu.

