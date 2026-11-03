# Thiết kế Định dạng Chữ In Đậm (Rich Text) khi Sao chép Tin nhắn sang Zalo PC/Web

**Ngày:** 2026-11-04  
**Quy mô:** Thay đổi nhỏ gọn (nâng cấp bộ mẫu tin nhắn Zalo, hàm sao chép Rich Text Clipboard và khung xem trước trên 2 màn hình quản trị hiện có)

## 1. Mục đích & Lý do (Intent & Why)
Khi Ban Quản Lý sao chép thông báo vận hành hoặc cập nhật tiến độ sửa chữa từ ResiHub dán vào nhóm Zalo tòa nhà / nhóm Zalo phòng trên **Zalo PC / Zalo Web**, việc **in đậm** những thông tin cốt lõi giúp cư dân lướt tin nắm bắt ngay tiêu đề, phạm vi phòng/tòa, mã phiếu, trạng thái xử lý, khung giờ áp dụng và số hotline liên hệ, đồng thời cho phép Quản lý chủ động nhấn mạnh thêm các mốc giờ/lưu ý quan trọng ngay trong đoạn văn xuôi.

## 2. Mục tiêu, Giới hạn & Điều cần tránh (Goals, Non-Goals, Anti-Goals)
- **Mục tiêu (Goals):**
  1. Đánh dấu sẵn cặp `**...**` quanh các trường và mốc thông tin quan trọng trong toàn bộ mẫu tin nhắn Zalo ở cả Backend (`api/src/services/zaloFormatter.js`) và Frontend (`frontend/src/utils/zaloFormat.js`), bao gồm 5 mẫu thông báo nhanh (`bodyTemplate`), tin nhắn thông báo tòa/tầng/phòng và tin nhắn cập nhật sửa chữa phòng.
  2. Nâng cấp tiện ích sao chép Zalo trên Frontend để ghi đồng thời 2 định dạng vào Clipboard:
     - `text/html`: chuyển các cụm `**...**` thành thẻ `<b>...</b>` và xuống dòng `\n` thành `<br>` để dán vào **Zalo PC / Zalo Web** hiển thị đúng chữ **in đậm** với dấu tiếng Việt chuẩn.
     - `text/plain`: tự động bóc sạch cặp dấu `**` để mọi trường hợp dán văn bản thuần đều sạch gọn.
  3. Hiển thị trực quan chữ **in đậm thật** (không lộ dấu `**`) trên khung xem trước trong Modal *"Sao chép & Dán sang nhóm Zalo"* (`NotificationsPage.jsx`) và bổ sung khung xem nhanh + hướng dẫn ngắn trên `NotificationsPage.jsx` / `ServiceRequestsPage.jsx`.
- **Không nằm trong phạm vi (Non-Goals):**
  - Không thay đổi cấu trúc bảng cơ sở dữ liệu PostgreSQL (`announcement.zalo_content` giữ nguyên kiểu `TEXT`).
  - Không chuyển đổi sang bộ ký tự toán học Unicode Bold (vì luồng thao tác mục tiêu là copy–paste trên Zalo PC/Web và ưu tiên giữ font tiếng Việt có dấu sắc nét 100%).
- **Điều cần tránh (Anti-Goals):**
  - Không bao giờ để lộ ký tự `**` thô khi dán ở chế độ `text/plain`.
  - Không chèn HTML chưa escape từ dữ liệu người dùng vào `text/html` (phải escape `&`, `<`, `>`, `"`, `'` trước khi sinh thẻ `<b>` để chống XSS tuyệt đối).
  - Không bao giờ đưa `internal_note` của BQL vào nội dung tin nhắn Zalo phòng.

## 3. Ràng buộc kỹ thuật (Constraints)
- Frontend React + trình duyệt chạy trên môi trường HTTPS hoặc `localhost` dùng `navigator.clipboard.write([new ClipboardItem({ 'text/html': ..., 'text/plain': ... })])`, kèm cơ chế dự phòng dùng phần tử ẩn `contenteditable` + `document.execCommand('copy')` khi trình duyệt không hỗ trợ `ClipboardItem`.
- Giữ tương thích ngược với các bản ghi `announcement.zalo_content` cũ trong DB chưa có dấu `**` (vẫn hiển thị và sao chép bình thường).

## 4. Các hướng tiếp cận đã cân nhắc (Approaches)
1. **Phương án 1 — Đánh dấu nhẹ `**...**` trong mẫu & ô soạn thảo + chuyển đổi Rich Text Clipboard tự động *(Đã chọn)*:**
   Các mẫu tự động đặt `**...**` quanh chỗ quan trọng; Quản lý có thể tự gõ thêm `**cụm từ cần nhấn mạnh**` ngay trong ô chỉnh sửa `zalo_content`; khung xem trước render chữ **đậm** trực quan và nút Copy xuất đồng thời `text/html` (`<b>`) + `text/plain` (đã bóc `**`).
2. **Phương án 2 — Giữ chuỗi văn bản thuần, chỉ tô đậm tự động theo cấu trúc dòng cố định lúc bấm Copy:**
   Ô nhập liệu không có dấu `**`, nhưng Quản lý không thể tự in đậm khung giờ cắt điện/nước hay lưu ý đặc thù nằm giữa đoạn thân bài.

**Lý do chọn Phương án 1:** Đáp ứng trọn vẹn nhu cầu thực tế của vận hành tòa nhà là nhấn mạnh được cả các trường cố định lẫn các mốc giờ/địa điểm quan trọng nằm giữa câu văn, không cần đổi schema DB.

## 5. Chi tiết thiết kế theo quyết định đã chốt

### 5.1. Các vị trí được in đậm mặc định trong mẫu Zalo (`zaloFormatter.js` & `zaloFormat.js`)
- **Thông báo Tòa / Tầng / Phòng (`formatAnnouncementForZalo` & `buildZaloPreviewText`):**
  - Tiêu ngữ đầu tin: `**[THÔNG BÁO BQL TÒA <MÃ_TÒA>]**`
  - Nhãn phân loại: `🔔 Phân loại: **<NHÃN PHÂN LOẠI>**`
  - Tiêu đề bản tin: `📌 **<Tiêu đề thông báo>**`
  - Phạm vi cư dân trong lời chào: `Kính gửi Quý Cư dân **Tòa <Tên/Mã>**` / `**Tầng ...**` / `**Phòng <Mã căn>**`
  - Các mốc điền thông tin trong 5 mẫu nhanh (`ZALO_ANNOUNCEMENT_TEMPLATES` / `ZALO_QUICK_TEMPLATES`): `**[GIỜ BẮT ĐẦU]**`, `**[GIỜ KẾT THÚC]**`, `**[NGÀY/THÁNG]**`, `**[KHUNG GIỜ]**`, `**sau 22:00**`, `**[NỘI DUNG CHI TIẾT]**`
  - Thời gian & liên hệ cuối tin: `🕒 Thời gian phát hành: **<HH:mm dd/MM/yyyy>**`, `📞 Hotline hỗ trợ kỹ thuật/BQL: **<Số điện thoại>**`
- **Cập nhật sửa chữa Nhóm Zalo Phòng (`formatServiceRequestForRoomZalo` & `buildRoomMaintenanceZaloText`):**
  - Tiêu ngữ đầu tin: `**[CẬP NHẬT KỸ THUẬT — Phòng <Mã căn> — Tòa <Mã tòa>]**`
  - Thông tin định danh & tiến độ: `• Mã yêu cầu: **<Mã SR>**`, `• Hạng mục: **<Tên hạng mục>** — <Tiêu đề>`, `• Trạng thái hiện tại: **<Nhãn trạng thái>**`
  - Thông tin điều phối & nghiệm thu (nếu có): tên **nhân sự phụ trách**, **khung giờ cư dân đăng ký**, **lịch hẹn xử lý tiếp theo**, **lý do tạm hoãn**, **phản hồi/kết quả xử lý**, và **số Hotline BQL**.

### 5.2. Chuyển đổi Rich Text & Hiển thị xem trước (`zaloFormat.js`, `NotificationsPage.jsx`, `ServiceRequestsPage.jsx`)
- Cung cấp các hàm thuần trong `frontend/src/utils/zaloFormat.js`:
  - `parseZaloBoldSegments(text)` → mảng `{ text, bold }` để React render an toàn bằng `<strong>` trong khung xem trước mà không cần `dangerouslySetInnerHTML`.
  - `stripZaloBoldMarkers(text)` → chuỗi văn bản thuần đã gỡ cặp `**...**` hoàn chỉnh.
  - `zaloTextToHtml(text)` → chuỗi HTML đã escape ký tự đặc biệt, bọc `<b>...</b>` cho đoạn đậm và `<br>` cho xuống dòng.
  - `copyZaloMessageToClipboard(text)` (và hỗ trợ ngay trong `copyTextToClipboard(text, { richZalo: true })`): ghi `ClipboardItem` gồm cả `text/html` và `text/plain` (bản đã strip `**`), fallback sang vùng chọn `contenteditable` ẩn rồi mới tới `textarea` thuần.
- Trên `NotificationsPage.jsx` và `ServiceRequestsPage.jsx`:
  - Ô soạn thảo `zalo_content` bổ sung gợi ý ngắn: *"Dùng `**nội dung**` để in đậm khi dán sang Zalo PC/Web"*.
  - Khung xem trước trong Modal sao chép Zalo hiển thị trực tiếp các đoạn in đậm bằng `<strong>` và kèm ghi chú nhỏ hướng dẫn dán trên Zalo PC/Web (`Ctrl+V` hoặc *Chuột phải → Dán giữ định dạng*).

## 6. Phần chi tiết để bước lập kế hoạch & thi công quyết định (Left to the Builder)
- Quy tắc xử lý dấu `*` đơn lẻ hoặc cặp `**` không đóng (giữ nguyên như ký tự thường, không làm mất chữ).
- Tổ chức unit test trong `api/test/` cho cả `zaloFormatter.js` và các hàm `parseZaloBoldSegments` / `stripZaloBoldMarkers` / `zaloTextToHtml` của `zaloFormat.js` (bao gồm ca kiểm tra chống XSS và tương thích các bài test M11/M13 hiện hữu).
