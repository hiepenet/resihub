# Bộ ảnh CCCD mô phỏng phục vụ kiểm thử AI OCR (`CCCD_EXTRACT`)

> **Lưu ý:** Toàn bộ hình ảnh trong thư mục này là **dữ liệu giả lập phục vụ kiểm thử phần mềm** (`SAMPLE DATA - FOR QA TESTING ONLY`), không phải giấy tờ thật.

## Luồng nghiệp vụ được kiểm thử
- **API:** `POST /api/v1/ai/extract` (`document_type: "CCCD"`, `privacy_acknowledged: true`, tối đa 2 file ảnh PNG/JPEG/WEBP)
- **Giao diện:** `Quản lý Cư dân` (`TenantsPage.jsx`) -> `+ Thêm cư dân` -> tải ảnh **Mặt trước** / **Mặt sau** -> bấm trích xuất bằng AI.
- **Trường trích xuất (`CCCD_EXTRACT`):** `full_name`, `id_number`, `dob` (`YYYY-MM-DD`), `issue_date` (`YYYY-MM-DD`), `permanent_address`.

## Danh sách bộ mẫu kiểm thử

| Bộ test | File ảnh | Kịch bản kiểm thử | Kết quả kỳ vọng |
|---|---|---|---|
| **Bộ 1** (Chuẩn 2 mặt - Nam, Hà Nội) | `cccd_01_nguyen_minh_quan_front.png`<br>`cccd_01_nguyen_minh_quan_back.png` | Upload đủ 2 ô **Mặt trước** + **Mặt sau** (Happy path) | `full_name`: `NGUYỄN MINH QUÂN`<br>`id_number`: `001096884512`<br>`dob`: `1996-08-15`<br>`issue_date`: `2022-05-20`<br>`permanent_address`: `Số 24 Phố Lý Thường Kiệt, Phường Phan Chu Trinh, Quận Hoàn Kiếm, Thành phố Hà Nội` |
| **Bộ 2** (Chuẩn 2 mặt - Nữ 200x, TP.HCM) | `cccd_02_tran_ngoc_bao_anh_front.png`<br>`cccd_02_tran_ngoc_bao_anh_back.png` | Upload đủ 2 ô **Mặt trước** + **Mặt sau** với đầu mã `0793` (nữ sinh thế kỷ 21) | `full_name`: `TRẦN NGỌC BẢO ANH`<br>`id_number`: `079301772945`<br>`dob`: `2001-11-04`<br>`issue_date`: `2023-09-12`<br>`permanent_address`: `128A Nguyễn Thị Minh Khai, Phường Võ Thị Sáu, Quận 3, Thành phố Hồ Chí Minh` |
| **Bộ 3** (Ảnh gộp 2 mặt trong 1 file - Đà Nẵng) | `cccd_03_le_hoang_nam_2mat.png` | Chỉ upload **1 ảnh duy nhất** chứa cả mặt trước và mặt sau ghép dọc | `full_name`: `LÊ HOÀNG NAM`<br>`id_number`: `048094663108`<br>`dob`: `1994-03-22`<br>`issue_date`: `2021-07-18`<br>`permanent_address`: `45 Nguyễn Văn Linh, Phường Bình Hiên, Quận Hải Châu, Thành phố Đà Nẵng` |
| **Bộ 4** (Kiểm tra trùng số CCCD realtime `checkDup`) | `cccd_04_duplicate_test_front.png` | Upload 1 ảnh mặt trước có `id_number` trùng với cư dân đã có sẵn trong DB seed | AI điền `id_number`: `079206291644`, sau 400ms UI gọi `/tenants/check-dup` và hiển thị cảnh báo trùng hồ sơ cư dân (`Nguyễn Đa Tòa Nhà`) |
| **Bộ 5** (Ảnh mờ + lóa đèn flash - Negative test) | `cccd_05_blurry_glare_test.png` | Kiểm thử chống bịa số (`anti-hallucination` / `LOW_CONFIDENCE_EXTRACTION`) khi vùng số CCCD & ngày sinh bị lóa trắng | AI trả `null` hoặc confidence thấp ở các trường bị che khuất (`id_number`, `dob`), hiển thị cảnh báo độ tin cậy thấp hoặc yêu cầu nhập tay thay vì tự đoán số |

