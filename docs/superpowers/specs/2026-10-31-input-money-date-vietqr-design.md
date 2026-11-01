# Thiết kế Chuẩn hóa Ô nhập tiền, Khoảng thời gian & Dropdown Ngân hàng VietQR

**Ngày:** 2026-10-31  
**Quy mô:** Thay đổi vừa gọn (chuẩn hóa UI & kiểm tra dữ liệu đầu vào trên các form hiện có)

## 1. Mục đích & Lý do (Intent & Why)
Người vận hành và cư dân trên ResiHub thường xuyên nhập số tiền lớn (hàng trăm nghìn đến hàng chục triệu đồng), chọn kỳ hạn thuê/giữ chỗ/lọc dữ liệu, và chọn ngân hàng thanh toán/hoàn cọc. Việc chuẩn hóa giúp:
- Nhìn rõ ngay hàng nghìn/triệu (`100.000`, `1.000.000`) khi gõ, tránh nhầm thiếu hoặc thừa số `0`.
- Ngăn chặn triệt để việc chọn "ngày sau < ngày trước" hoặc chọn ngày bắt đầu hợp đồng/giữ chỗ đè lên kỳ căn hộ đang được thuê.
- Chuẩn hóa tên, mã, BIN và logo ngân hàng theo danh mục VietQR trên toàn bộ hệ thống.

## 2. Mục tiêu & Giới hạn (Goals, Non-Goals, Anti-Goals)
- **Mục tiêu (Goals):**
  1. Định dạng trực tiếp dấu chấm phân cách hàng nghìn (`100.000`, `1.000.000`, hỗ trợ số âm `-200.000` nơi cần giảm trừ) trên toàn bộ 19 ô nhập tiền thuộc 12 màn hình.
  2. Tự động gợi ý ngày bắt đầu hợp đồng / giữ chỗ nhảy ra ngoài khoảng thời gian căn hộ đang được thuê hoặc giữ chỗ (ví dụ hôm nay `31/10/2026`, căn đang thuê `01/10/2026 -> 01/12/2026` thì gợi ý từ `02/12/2026`).
  3. Chặn chọn ngày sau nhỏ hơn ngày trước theo ngữ cảnh: luôn khóa `min` trên lịch của ô "ngày sau"; tự đồng bộ `Đến ngày = Từ ngày` ở bộ lọc tức thời; giữ nguyên giá trị cũ kèm báo lỗi đỏ dưới ô và chặn Lưu ở các form nghiệp vụ.
  4. Đồng bộ toàn bộ chỗ chọn ngân hàng dùng dropdown lấy danh sách từ VietQR (kèm danh mục dự phòng đầy đủ khi mất kết nối ngoài).
- **Không nằm trong phạm vi (Non-Goals):**
  - Không thay đổi cấu trúc bảng cơ sở dữ liệu PostgreSQL hay định dạng số nguyên tiền tệ gửi lên API.
  - Không định dạng dấu chấm hàng nghìn cho các ô số không phải tiền (số tầng, diện tích `m²`, số phòng ngủ, chỉ số công tơ điện/nước `kWh`/`m³`, số lượng dịch vụ, số ngày/giờ SLA, phần trăm `%`).
- **Điều cần tránh (Anti-Goals):**
  - Không tự ý sửa ngầm ngày kết thúc hợp đồng khi người dùng lỡ đổi ngày bắt đầu vượt quá ngày kết thúc (tránh lưu nhầm kỳ hạn sai).
  - Không làm nhảy con trỏ về cuối dòng khi người dùng sửa chữ số ở giữa ô tiền.

## 3. Ràng buộc kỹ thuật (Constraints)
- Frontend React 19 + TailwindCSS không cài thêm thư viện ngoài; tận dụng [`Input.jsx`](../../../frontend/src/components/ui/Input.jsx) và [`Select.jsx`](../../../frontend/src/components/ui/Select.jsx) sẵn có.
- Các phép tính trực tiếp trên form (`Number(amount)`, tính Pro-rata, cảnh báo giá ưu đãi `< 90%`) đang kỳ vọng chuỗi số sạch (`"100000"`, `"-200000"`).
- API giữ chỗ (`reservations.js`) yêu cầu `hold_until > hold_from`, tối đa `30` ngày, và không chồng lấn cả hợp đồng lẫn phiếu giữ chỗ `HELD` khác. API hợp đồng (`contracts.js`) yêu cầu `end_date > start_date` và không chồng lấn các hợp đồng `DRAFT`, `PENDING_APPROVAL`, `ACTIVE`, `RENEWAL_PENDING`, `TERMINATION_PENDING`.

## 4. Các hướng tiếp cận đã cân nhắc (Approaches)
1. **Hướng 1 — Bộ Component & Utility dùng chung trên nền `<Input type="date">` chuẩn *(Đã chọn)*:**
   Xây dựng `MoneyInput`, `BankSelect` (`useVietQrBanks`), và `dateRange` utils dùng chung; giữ `<Input type="date">` chuẩn kết hợp gợi ý ngày trống đầu tiên, khóa `min`/`max` và báo lỗi đỏ khi xung đột. Gọn nhẹ, gõ phím nhanh, đồng nhất giao diện hiện có.
2. **Hướng 2 — Dựng Custom Calendar Popover riêng:**
   Thay `<Input type="date">` bằng lịch tự vẽ để gạch xám từng khoảng ngày bận xen kẽ ở tương lai xa ngay trên lưới lịch. Trực quan hơn với lịch xen kẽ phức tạp nhưng nặng code UI và mất thao tác gõ bàn phím bản địa.

**Lý do chọn Hướng 1:** Giải quyết trọn vẹn bài toán thực tế (tự động nhảy qua kỳ đang bận + khóa `min` + báo đỏ khi chọn trùng khoảng bận tương lai) với trải nghiệm nhập liệu mượt và ít rủi ro phát sinh lỗi giao diện nhất.

## 5. Chi tiết thiết kế theo quyết định đã chốt

### 5.1. Ô nhập tiền (`frontend/src/components/ui/MoneyInput.jsx`)
- Bọc trên `Input` với `type="text"`, `inputMode="numeric"`.
- Hiển thị giá trị có dấu `.` ngăn cách mỗi 3 chữ số (`100.000`, `1.000.000`).
- Hỗ trợ prop `allowNegative = false` (bật `true` cho ô điều chỉnh hóa đơn tại `InvoiceDetailPage.jsx` để nhập `-200.000`).
- Khi người dùng gõ/xóa/dán: lọc ký tự hợp lệ, giữ vị trí con trỏ tương ứng với số chữ số phía trước con trỏ, và phát sự kiện `onChange({ target: { value: rawDigits, name } })` với `rawDigits` là chuỗi số sạch (`""`, `"0"`, `"100000"`, `"-200000"`).
- Áp dụng trên toàn bộ **19 ô nhập tiền** tại 12 file:
  - `ApartmentDetailPage.jsx` (`base_rent`)
  - `FloorPlanPage.jsx` (`aptForm.base_rent`, `resForm.hold_amount`)
  - `ContractsPage.jsx` (`createForm.rent_amount`, `createForm.deposit_amount`)
  - `ContractDetailPage.jsx` (`editDraftForm.rent_amount`, `editDraftForm.deposit_amount`, `renewForm.rent_amount`, `renewForm.deposit_amount`, `amendForm.rent_amount`, `amendForm.deposit_amount`, `transferForm.new_rent_amount`, `spForm.unit_price`)
  - `DepositsPage.jsx` (`collectForm.amount`, `deductionItems[].amount`)
  - `InvoiceDetailPage.jsx` (`adjustForm.adjustment_amount` có `allowNegative`, `payForm.amount`)
  - `PaymentsPage.jsx` (`createForm.amount`)
  - `ServiceCatalogPage.jsx` (`form.unit_price`)
  - `MeterReadingsPage.jsx` (`createForm.unit_price`)
  - `SettingsPage.jsx` & `UsersPage.jsx` (`electricity_default_price`, `water_default_price`)
  - `InvoicesTab.jsx` (`payForm.amount`)

### 5.2. Khoảng thời gian & Gợi ý ngày trống (`frontend/src/utils/dateRange.js`)
- **Tính ngày bắt đầu trống đầu tiên (`findFirstAvailableStartDate`):**
  - Tổng hợp các khoảng bận `[from, to]` của căn hộ từ hợp đồng (`ACTIVE`, `RENEWAL_PENDING`, `TERMINATION_PENDING`, `PENDING_APPROVAL`, `DRAFT`, lấy `to = terminated_at || end_date`) và phiếu giữ chỗ `HELD` (`hold_from || created_at` → `hold_until`), hỗ trợ bỏ qua `excludeContractId` (khi sửa nháp) hoặc `excludeReservationId` (khi chuyển cọc giữ chỗ của đúng khách đó thành hợp đồng).
  - Xuất phát từ `today`: nếu ngày ứng viên nằm trong bất kỳ khoảng `[from, to]` nào (`from <= candidate <= to`), nhảy ứng viên sang `to + 1 ngày` và lặp lại tới khi nằm ngoài mọi khoảng bận. Ví dụ hôm nay `31/10/2026`, căn hộ đang thuê `01/10/2026 -> 01/12/2026` → tự chọn `02/12/2026`.
  - Đặt `min` của ô ngày bắt đầu bằng ngày trống đầu tiên này (khi từ hôm nay đến đó kín lịch) để khóa luôn giai đoạn đang thuê trên lịch.
  - Áp dụng khi chọn căn hộ / mở modal tại: tạo hợp đồng (`ContractsPage.jsx` — đồng thời bỏ điều kiện chặn nhầm `prev.start_date > todayStr`), đặt cọc giữ chỗ (`FloorPlanPage.jsx`), và chọn căn hộ đích chuyển phòng (`ContractDetailPage.jsx`).
- **Kiểm tra chồng lấn & Chặn ngày sau < ngày trước:**
  - **Bộ lọc tức thời (`AuditLogsPage.jsx`):** `toDate` có `min={fromDate}`. Khi đổi `fromDate` vượt quá `toDate` đang có, tự động cập nhật `toDate = fromDate`.
  - **Các form lưu dữ liệu:**
    - Khóa `min` trên lịch của "ngày sau":
      - `start_date + 1 ngày` đối với kỳ hạn hợp đồng (`ContractsPage.jsx`, sửa nháp & chuyển phòng tại `ContractDetailPage.jsx`), ngày kết thúc gia hạn (`renewForm.new_end_date` & đề nghị `RENEWAL` tại `ContractTab.jsx` dùng `contract.end_date + 1 ngày`), và giữ chỗ (`FloorPlanPage.jsx` `hold_until` có `min = hold_from + 1 ngày`, `max = hold_from + 30 ngày`).
      - `>= ngày trước` đối với phụ lục (`ContractDetailPage.jsx`), hủy dịch vụ (`SubscriptionsPage.jsx`, `ServicesTab.jsx`), chấm dứt hợp đồng (`ContractDetailPage.jsx`, `ContractTab.jsx`), gia hạn hạn thanh toán hóa đơn (`InvoiceDetailPage.jsx` so với ngày lập/phát hành).
    - Nếu người dùng đổi "ngày trước" vượt qua "ngày sau" đang có (hoặc chọn khoảng ngày chồng lấn vào lịch đã thuê/giữ chỗ của căn hộ): giữ nguyên giá trị trên ô để người dùng đối chiếu, hiển thị ngay lỗi đỏ (`error`) dưới ô tương ứng và chặn thao tác Lưu.

### 5.3. Dropdown Ngân hàng VietQR (`useVietQrBanks.js` & `BankSelect.jsx`)
- **Backend (`api/src/routes/buildings.js`):** Bổ sung danh mục dự phòng `FALLBACK_VIETQR_BANKS` đầy đủ các ngân hàng thương mại Việt Nam chuẩn VietQR (`code`, `bin`, `shortName`, `name`, `logo`) để luôn hiển thị đủ ngân hàng kể cả khi không gọi được ra internet.
- **Frontend (`frontend/src/hooks/useVietQrBanks.js` + `frontend/src/components/common/BankSelect.jsx`):**
  - Cache danh sách ngân hàng từ `/api/v1/buildings/banks` ở bộ nhớ phiên để mở modal tức thì.
  - Render trên `Select` có logo ngân hàng, tên ngắn + mã (`Vietcombank (VCB)`), tên đầy đủ, badge `BIN`, tìm kiếm nhanh không dấu, và tự giữ giá trị hiện có nếu dữ liệu cũ lưu tên ngân hàng ngoài danh sách.
  - Sử dụng thống nhất tại `BuildingsPage.jsx` và mục ngân hàng thụ hưởng hoàn cọc cư dân tại `DepositsPage.jsx` (lưu kèm `bank_code`, `bank_bin`, `bank_logo` trong `bank_info`).

## 6. Phần chi tiết để bước lập kế hoạch & thi công quyết định (Left to the Builder)
- Thuật toán giữ vị trí con trỏ (`selectionStart`) trong `MoneyInput` khi thêm/bớt dấu chấm `.`.
- Tổ chức unit test cho `MoneyInput` / hàm format tiền và `dateRange` (gồm các ca biên chồng lấn liên tiếp, khoảng trống xen kẽ, ngày âm/dương) bằng `node --test`.
