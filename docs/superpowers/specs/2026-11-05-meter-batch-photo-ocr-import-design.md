# Thiết kế Tính năng Import Hàng loạt Chỉ số Điện/Nước từ Ảnh Chụp bằng AI OCR (`AI-02`)

**Ngày:** 2026-11-05  
**Phân hệ:** `M08` (Chỉ số & Tiêu thụ Điện/Nước) + `M15` (AI Gateway — `AI-02`)  
**Vai trò sử dụng:** `MANAGER` (Quản lý tòa nhà được phân công phạm vi quản lý)

---

## 1. Mục tiêu & Lý do (Intent & Why)

Nhân viên kỹ thuật/quản lý tòa nhà thường chụp hàng loạt ảnh mặt đồng hồ điện/nước của các căn hộ trong kỳ chốt sổ và đặt tên file theo mã phòng (ví dụ `A1001_dien.jpg`, `A1001_nuoc.jpg`, hoặc `A1001 (1).jpg`). Việc phải mở từng dòng công tơ và tải từng ảnh đơn lẻ tốn nhiều thao tác lặp lại.

Tính năng **Import Hàng loạt Ảnh Công Tơ bằng AI (`Batch Photo AI-02`)** cho phép Quản lý kéo-thả tối đa **30 ảnh/lần**, tự động nhận diện phòng từ tên file kết hợp AI đọc chỉ số + phân biệt mặt đồng hồ Điện (`kWh`) / Nước (`m³`), đối soát toàn bộ kết quả trên một bảng xem trước trực quan và lưu/chốt hàng loạt kèm ảnh đối chứng cho hóa đơn cư dân.

---

## 2. Goals, Non-Goals & Anti-Goals

- **Goals:**
  1. Chọn phạm vi **1 Tòa nhà cụ thể** và **Kỳ chốt (`YYYY-MM`)** ngay trong Modal Import (tự lấy tòa nhà đang chọn trên TopBar nếu có; bắt buộc chọn nếu TopBar đang để *"Tất cả tòa nhà"*).
  2. Ghép công tơ thông minh từ **tên file ảnh** không phân biệt hoa/thường/dấu (`EL-VOP-A-A1001.jpg`, `A1001_dien.jpg`, `A1001-nuoc.png`, `A1001_E.jpg`, `A1001_W.jpg`).
  3. Trường hợp tên file chỉ chứa mã phòng mà thiếu loại đồng hồ (`A1001 (1).jpg`, `A1001 (2).jpg`), AI tự nhận diện thêm `detected_meter_type` (`ELECTRICITY` | `WATER`) từ mặt đồng hồ để gắn đúng công tơ Điện hoặc Nước của phòng đó.
  4. Trường hợp tên file gõ nhầm mã phòng hoặc trùng 2 ảnh vào cùng 1 công tơ, vẫn cho phép chọn/đổi công tơ bằng ô `Select` ngay trên dòng đối soát mà không cần đổi tên file tải lại.
  5. Chạy hàng đợi giới hạn **2 ảnh song song** kèm nén ảnh phía client, thanh tiến trình trực tiếp và nút **Thử lại AI** riêng cho từng ảnh bị lỗi mạng/timeout/mờ.
  6. Tuân thủ nghiêm ngặt quy tắc **"AI đề xuất, người quyết định"** (`PRD 12.1`, `AC-014.1`, `AC-014.2`) và kiểm soát biến động `>30%` (`FR-031`), khóa dòng đã lập hóa đơn (`is_billed`), liên kết `ai_suggestion_id` + lưu ảnh đối chứng khi bấm **Lưu nháp** hoặc **Lưu & Chốt các dòng hợp lệ**.

- **Non-Goals:**
  - Không thay đổi công thức tính hóa đơn bậc thang/đơn giá của `M09`.
  - Không cho phép `SYS_ADMIN`, `OWNER` hay `RESIDENT` gọi API ghi chỉ số hoặc OCR công tơ (`PRD 6.2`: chỉ `MANAGER`).

- **Anti-Goals:**
  - Tuyệt đối **không tự động ghi vào bảng `meter_reading`** ngay khi AI vừa đọc xong ảnh mà chưa có thao tác bấm Lưu/Chốt của Quản lý (`AC-014.2`).
  - Không để 1 ảnh mờ/lỗi hoặc 1 công tơ đã khóa hóa đơn làm hỏng/rollback các ảnh hợp lệ khác trong lô.
  - Không để mã phòng ngắn (`A10`, `A100`) khớp nhầm vào tên file của mã phòng dài hơn (`A1001_dien.jpg`).

---

## 3. Các Phương án Đã Cân nhắc (Approaches Considered)

1. **Phương án 1 — Xuất/Nhập file Excel/CSV có bước Preview:** Tốt khi dữ liệu đã nhập sẵn ra bảng tính, nhưng không đính kèm được ảnh chụp mặt đồng hồ đối chứng và vẫn phải gõ tay con số từ ảnh vào Excel.
2. **Phương án 2 — Copy/Paste bảng tính đổ thẳng vào bảng nháp màn hình chính:** Nhanh với dữ liệu text nhỏ, nhưng phụ thuộc bộ lọc hiện tại và không xử lý luồng ảnh công tơ.
3. **Phương án 3 (Đã chọn) — Import Hàng loạt Ảnh Chụp Công Tơ bằng AI OCR (`Batch Photo AI-02`) ghép phòng qua tên file + Bảng Đối soát trong Modal:** Giải quyết trọn vẹn cả khâu đọc số tự động lẫn đính kèm ảnh chứng từ công tơ trên hóa đơn, vẫn cho chỉnh tay linh hoạt trước khi lưu.

---

## 4. Thiết kế Kỹ thuật Chi tiết

### 4.1. Mở rộng Backend `AI-02` (`api/src/services/aiRules.js`, `aiGateway.js`, `routes/ai.js`, `rateLimiter.js`)
- **Schema Gemini `METER_OCR`:** Bổ sung trường tùy chọn `detected_meter_type` (`'ELECTRICITY' | 'WATER'`, `nullable: true`) vào `responseSchema` và `postValidateMeterOcr`. Nếu đã biết trước `meter.meter_type` mà `detected_meter_type` khác loại (ví dụ ảnh đồng hồ nước đặt tên nhầm `_dien`), gắn cảnh báo `'METER_TYPE_MISMATCH'` và `needsHumanReview = true`.
- **Hỗ trợ 3 chế độ đầu vào trên `POST /api/v1/ai/meter-ocr`:**
  1. Có `meter_id` (tương thích ngược 100% với luồng đơn lẻ hiện hữu và khi tên file khớp chính xác cả phòng + loại đồng hồ).
  2. Không có `meter_id`, có `building_id` + `apartment_id` (khi tên file khớp phòng `A1001` nhưng chưa rõ Điện hay Nước): kiểm tra quyền `MANAGER` trên `building_id`, gọi Gemini đọc `{ reading, detected_meter_type, confidence, reason }`, tự động tra cứu công tơ `(apartment_id, detected_meter_type)` (hoặc công tơ duy nhất nếu căn chỉ có 1 công tơ) để tính `previous_value`, `estimated_consumption`, cảnh báo `>30%`, lưu `ai_suggestion` và trả về `resolved_meter_id`, `resolved_meter_code`, `detected_meter_type`.
  3. Không có `meter_id` và `apartment_id`, chỉ có `building_id` (tên file chưa khớp phòng nào): kiểm tra quyền `MANAGER` trên `building_id`, gọi Gemini đọc `{ reading, detected_meter_type, confidence, reason }`, lưu `ai_suggestion` theo `(org_id, building_id)` để khi Quản lý chọn công tơ bằng `Select` trên giao diện sẽ có sẵn ngay chỉ số AI + `suggestion_id` không cần gọi lại Gemini.
- **Rate Limiter:** Nâng `aiRateLimiter` từ `20` lên `60` lượt/phút/người dùng để lô tối đa 30 ảnh hoạt động mượt mà trong 1 phiên.

### 4.2. Quy tắc Đọc Tên File & Hàng đợi Phía Frontend (`meterBatchPhotoHelpers.js` & `MeterBatchPhotoImportModal.jsx`)
- **Giới hạn lô:** Tối đa `30` ảnh mỗi lần chọn/kéo-thả (`image/jpeg`, `image/png`, `image/webp`), tự nén qua `compressImageFileToDataUri`.
- **Thuật toán khớp tên file (`matchMeterFromFilename`):**
  1. Khớp ưu tiên `meter_code` dài nhất trước theo ranh giới ký tự chữ-số (`(?<![A-Z0-9])...(?![A-Z0-9])`).
  2. Khớp `apartment_code` dài nhất trước theo ranh giới ký tự chữ-số (`A1001` kiểm tra trước `A100`, `A10`), kết hợp từ khóa loại đồng hồ (`dien|electric|electricity|kwh|el|e` -> `ELECTRICITY`; `nuoc|water|m3|wt|w` -> `WATER`).
  3. Nếu chỉ khớp `apartment_code` mà không có từ khóa loại -> đánh dấu `APARTMENT_ONLY` để gửi `{ building_id, apartment_id }` cho AI tự phân định Điện/Nước.
- **Kiểm증 dòng đối soát trước khi Lưu:**
  - Chặn trùng công tơ (`DUPLICATE_METER_TARGET`) nếu 2 ảnh trong cùng lô trỏ vào cùng 1 `meter_id`.
  - Đánh dấu khóa (`LOCKED_BILLED`) nếu đợt hợp đồng mục tiêu của công tơ đã lập hóa đơn phát hành (`isMeterRowLockedForEdit`).
  - Tính tức thời `consumption`, `diffPct` (`>30%`), `estimatedAmount` ngay khi AI trả kết quả hoặc khi Quản lý đổi công tơ / sửa chỉ số / nhập ghi chú giải trình.
  - Hai nút hành động cuối Modal: **`Lưu nháp hợp lệ (N)`** (`DRAFT`) và **`Lưu & Chốt hợp lệ (N)`** (`CONFIRMED`, tự giữ `FLAGGED` hoặc nhắc nhập ghi chú cho dòng bất thường, bỏ qua dòng lỗi/trống/đã khóa).
