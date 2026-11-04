# Thiết kế Điều hướng Hành động & Mở sẵn Modal từ Thông báo cho Toàn bộ Vai trò

- **Ngày lập:** 2026-11-05
- **Phạm vi:** Cổng Cư dân (`/resident`) + Cổng Quản trị (`/admin/*`) + API Thông báo (`/api/v1/notifications`) & các route phát thông báo nghiệp vụ
- **Vai trò áp dụng:** `RESIDENT`, `MANAGER`, `OWNER`, `SYS_ADMIN`

---

## 1. Mục đích & Lý do (Intent & Why)

Hiện tại trong ResiHub, khi người dùng bấm vào một thông báo:
1. Tại chuông thông báo [`NotificationBell.jsx`](../../../frontend/src/components/common/NotificationBell.jsx), hệ thống chỉ đánh dấu đã đọc rồi chuyển về trang danh sách thông báo chung (`/admin/notifications` hoặc `/resident?tab=notifications`).
2. Tại hộp thư Cư dân [`NotificationsTab.jsx`](../../../frontend/src/pages/resident/tabs/NotificationsTab.jsx) và hộp thư Quản trị [`NotificationsPage.jsx`](../../../frontend/src/pages/admin/notifications/NotificationsPage.jsx), bấm vào thẻ thông báo chỉ gọi API đánh dấu đã đọc mà không đưa người dùng tới nơi xử lý.
3. Một số luồng bàn giao việc giữa Cư dân -> Quản lý -> Chủ nhà (báo đã thanh toán, đăng ký/hủy dịch vụ tiện ích, xin gia hạn/chấm dứt hợp đồng, đề nghị hoàn tiền tín dụng 4 mắt) chưa phát thông báo In-App cho vai trò xử lý kế tiếp.

Người dùng muốn **mọi thông báo trên toàn hệ thống (cho tất cả các vai trò và tất cả các loại thông báo)** hoạt động như một lối tắt xử lý công việc khép kín: khi click vào thông báo, hệ thống vừa đánh dấu đã đọc, vừa điều hướng tới đúng màn hình nghiệp vụ tương ứng và **tự động mở sẵn modal thao tác/chi tiết của bản ghi đó**.

---

## 2. Mục tiêu, Phi mục tiêu & Điều cần tránh (Goals, Non-Goals, Anti-Goals)

### Mục tiêu (Goals)
1. **Đồng bộ trên cả 3 điểm chạm thông báo:** Chuông thông báo trên thanh điều hướng (`NotificationBell.jsx`), tab Hộp thư Cư dân (`NotificationsTab.jsx`), và tab Hộp thư đến của Quản trị (`NotificationsPage.jsx`).
2. **Bao phủ cả 4 vai trò (`RESIDENT`, `MANAGER`, `OWNER`, `SYS_ADMIN`) và 100% loại thông báo** trong hệ thống, bao gồm bổ sung đầy đủ 4 luồng phát thông báo còn thiếu:
   - Cư dân gửi biên lai báo đã thanh toán (`POST /api/v1/resident/payments/report` -> thông báo `PAYMENT_REPORTED` tới `MANAGER` tòa nhà).
   - Cư dân gửi yêu cầu đăng ký mới hoặc hủy dịch vụ tiện ích (`POST /api/v1/resident/services`, `PATCH /api/v1/resident/services/:id/cancel` khi chuyển sang `CANCELLATION_PENDING` -> thông báo `SERVICE_SUBSCRIPTION_REQUESTED` / `SERVICE_CANCELLATION_REQUESTED` tới `MANAGER` tòa nhà).
   - Cư dân gửi đề nghị gia hạn / chấm dứt hợp đồng (`POST /api/v1/resident/contract-requests` -> thông báo `CONTRACT_REQUEST_SUBMITTED` tới `MANAGER` tòa nhà).
   - Quản lý gửi đề nghị hoàn tiền tín dụng chờ duyệt 4 mắt (`POST /api/v1/payments/credits/:id/refund` -> thông báo `PENDING_CREDIT_REFUND` tới `OWNER` / người có quyền duyệt 4 mắt và `CREDIT_REFUND_PENDING` tới `RESIDENT`).
3. **Tự động mở sẵn modal phù hợp ngay khi tới trang đích:**
   - Nếu thông báo gắn với tác vụ cần thực hiện và bản ghi đang ở trạng thái cho phép vai trò hiện tại thao tác (ví dụ: cư dân bấm hóa đơn chưa trả -> mở sẵn **Modal Báo thanh toán**; quản lý bấm phiếu báo hỏng -> mở sẵn **Modal Xử lý kỹ thuật**; quản lý bấm biên lai cư dân vừa gửi -> mở sẵn **Modal Đối soát chứng từ**; quản lý bấm yêu cầu dịch vụ -> mở sẵn **Modal Duyệt đăng ký / Hủy Pro-rata**; chủ nhà bấm yêu cầu tất toán cọc hoặc hoàn tiền tín dụng -> mở sẵn **Modal Phê duyệt Four-Eyes**), hệ thống bật ngay modal thao tác đó.
   - Nếu bản ghi đã được xử lý xong trước đó hoặc vai trò hiện tại chỉ có quyền xem (`OWNER`/`SYS_ADMIN` read-only), hệ thống mở modal xem chi tiết bản ghi thay vì mở form nhập liệu rỗng hoặc báo lỗi.
   - Với các bản tin thông báo chung không gắn với thực thể tác vụ riêng (`ANNOUNCEMENT`, `UTILITY_INTERRUPTION`, `MAINTENANCE_NOTICE`, `HOUSE_RULES`, `SECURITY_ALERT`, `SYSTEM`, `SYSTEM_NOTICE`...), bấm vào sẽ mở ngay **Modal Chi tiết Thông báo** (`NotificationDetailModal`).
4. **Hoạt động cho cả thông báo cũ trong cơ sở dữ liệu lẫn thông báo phát sinh mới:** Tự động làm giàu (`enrich`) các khóa liên kết còn thiếu (`contract_id`, `invoice_id`, `building_id`, `apartment_id`) ngay khi đọc API `GET /api/v1/notifications`, đồng thời bổ sung đầy đủ `payload` ở các điểm phát thông báo phía Backend.
5. **Tự động đồng bộ ngữ cảnh lọc:**
   - Phía Cư dân nhiều hợp đồng: tự chuyển sang đúng `contract_id` đang hiệu lực của thông báo; nếu thông báo thuộc về hợp đồng cũ đã kết thúc (`EXPIRED`/`TERMINATED`), vẫn tải đúng dữ liệu hợp đồng cũ đó để bật modal mà không làm hỏng bộ chọn căn hộ đang hiệu lực.
   - Phía Quản trị (`TopBar`): nếu `selectedBuildingId` hiện tại đang lọc tòa nhà khác với `building_id` của thông báo, tự động đồng bộ `selectedBuildingId` sang đúng tòa nhà đó (hoặc gỡ lọc về tất cả tòa trong phạm vi) trước khi chuyển trang để trang đích không lọc mất bản ghi cần mở modal.

### Phi mục tiêu (Non-Goals)
- Không viết migration sửa đổi các hàm PL/pgSQL hiện có (`fn_notify_*`) hoặc thêm bảng phụ trên PostgreSQL để tránh rủi ro ảnh hưởng logic tài chính – sổ cọc đã ổn định.
- Không bổ sung kênh gửi thông báo bên ngoài mới (Email, SMS, WebPush).

### Điều cần tránh (Anti-Goals)
- **Không lặp vô hạn việc tự bật modal:** Khi người dùng đóng modal hoặc nhấn F5 tải lại trang, modal không được tự bật lại lần nữa (phải dọn các query param kích hoạt modal bằng `replace: true` ngay sau khi đã tiêu thụ).
- **Không điều hướng vào trang bị chặn quyền (`<AccessDenied />`):** Mọi đường dẫn đích phải kiểm tra quyền vai trò hiện tại theo đúng `RoleGuard` trong `frontend/src/router/index.jsx` (ví dụ `/admin/settings` chỉ dành cho `SYS_ADMIN`; nếu `OWNER`/`MANAGER` nhận thông báo hệ thống thì mở `NotificationDetailModal` thay vì đẩy vào `/admin/settings`).
- **Không làm rò rỉ dữ liệu chéo tổ chức / chéo phạm vi RLS** khi làm giàu `payload` tại Backend.

---

## 3. Ràng buộc hệ thống (Constraints)

1. **RBAC & Read-Only Policy:**
   - `SYS_ADMIN` và `OWNER` là Read-Only trên các nghiệp vụ vận hành thường nhật của `MANAGER`, ngoại trừ quyền phê duyệt Four-Eyes của `OWNER` (duyệt giá/đổi phòng hợp đồng, duyệt tất toán cọc, duyệt hủy giữ chỗ, duyệt điều chỉnh hóa đơn, duyệt hoàn tiền tín dụng) và quyền cấu hình hệ thống của `SYS_ADMIN` (`/admin/settings`, `/admin/users`).
2. **Cấu trúc Router hiện tại (`frontend/src/router/index.jsx`):**
   - Cổng Cư dân dùng 1 route `/resident` điều khiển qua query params (`?tab=...&contract_id=...`).
   - Cổng Quản trị dùng các route con dưới `/admin/*` (`/admin/contracts`, `/admin/contracts/:id`, `/admin/deposits`, `/admin/services/subscriptions`, `/admin/meters`, `/admin/invoices`, `/admin/invoices/:id`, `/admin/payments`, `/admin/maintenance`, `/admin/notifications`, `/admin/reports`, `/admin/apartments/:id`, `/admin/tenants/:id`, `/admin/settings`, `/admin/audit-logs`). Lưu ý: không có route `/admin/service-requests` (route chuẩn là `/admin/maintenance`).
3. **An toàn RLS trên PostgreSQL:**
   - API `GET /api/v1/notifications` lấy tối đa 80 thông báo của chính `req.user.sub` (hoặc thông báo toàn `org_id` có `user_id IS NULL` phù hợp vai trò). Bước làm giàu `payload` chỉ tra cứu các khóa ngoại (`invoice_id`, `payment_id`, `credit_id`, `deposit_id`, `contract_id`, `service_request_id`, `reservation_id`, `subscription_id`, `tenant_id`) thuộc cùng `org_id` của chính các dòng thông báo đã được phép đọc, chỉ ghép thêm các định danh điều hướng (`contract_id`, `invoice_id`, `building_id`, `apartment_id`), tuyệt đối không lộ dữ liệu nội bộ (`internal_note`).

---

## 4. Các phương án đã cân nhắc (Approaches)

### Phương án 1 (Đã chọn): Bộ điều phối URL Query tập trung + Làm giàu ngữ cảnh `payload` tại API thông báo
- **Cơ chế:**
  - Backend làm giàu các định danh điều hướng còn khuyết ngay tại `GET /api/v1/notifications` cho 80 thông báo trả về, chuẩn hóa `payload` tại các điểm `INSERT INTO notification` ở tầng Node.js và bổ sung 4 luồng thông báo còn thiếu (báo thanh toán, đăng ký/hủy dịch vụ, xin gia hạn/chấm dứt HĐ, hoàn tiền tín dụng 4 mắt).
  - Frontend dùng một module phân giải tập trung `notificationNavigation.js` cho cả chuông và 2 trang hộp thư, điều hướng bằng URL kèm query mở modal, sau đó trang đích đọc query để bật modal rồi xóa tham số mở modal bằng `replace: true`.
- **Lý do chọn:** Tương thích ngược 100% với thông báo lịch sử đang có trong DB, giải quyết triệt để bài toán cư dân nhiều hợp đồng và bộ lọc tòa nhà `selectedBuildingId`, không cần sửa các hàm SQL phức tạp, giữ lịch sử nút Back tự nhiên.

### Phương án 2 (Không chọn): Chỉ xử lý thuần ở Frontend qua Zustand Store
- **Đánh đổi:** Không sửa Backend nhưng bị gãy với các thông báo cũ/hiện tại thiếu khóa phụ (`INVOICE_ISSUED` thiếu `contract_id`, `PAYMENT_REJECTED` chỉ có `payment_id`, nhiều thông báo thiếu `building_id` khiến trang đích lọc theo tòa khác không tìm thấy bản ghi để mở modal).

### Phương án 3 (Không chọn): Ghi cứng đường dẫn + query mở modal vào Database lúc `INSERT`
- **Đánh đổi:** Phải viết migration sửa hàng loạt hàm PL/pgSQL `fn_notify_*`, trói chặt URL giao diện vào Database và không khắc phục được các thông báo đã lưu trước đó.

---

## 5. Thiết kế chi tiết (Detailed Design)

### 5.1. Chuẩn hóa, Làm giàu `payload` & Bổ sung 4 Luồng Thông báo phía Backend

1. **Làm giàu & Lọc phạm vi khi đọc (`GET /api/v1/notifications` trong `api/src/routes/notifications.js`):**
   - **Lọc thông báo mẫu toàn tổ chức (`user_id IS NULL`) *(Quyết định kỹ thuật của Builder)*:** Với người dùng chỉ có vai trò `RESIDENT`, loại trừ các dòng `user_id IS NULL` có `payload->>'link' LIKE '/admin%'` (các dòng seed mẫu quản trị từ `011_notifications.sql`) để cư dân không nhìn thấy và không bấm nhầm thông báo nội bộ của quản trị.
   - Sau khi lấy danh sách thông báo của người dùng hiện tại (`LIMIT 80`), chạy hàm `enrichNotificationsContext(rows, orgId)` bằng truy vấn gom lô `ANY($2::uuid[])` theo `org_id` (chỉ truy vấn bảng nào thực sự có ID xuất hiện, không N+1):
     - `payment_id` -> tra `payment p JOIN invoice i ON i.id = p.invoice_id` để điền `invoice_id`, `contract_id`, `building_id`, `apartment_id`.
     - `invoice_id` -> tra `invoice` để điền `contract_id`, `building_id`, `apartment_id`.
     - `credit_id` -> tra `credit_balance cb LEFT JOIN contract c ON c.id = cb.contract_id` để điền `contract_id`, `building_id`, `apartment_id`.
     - `deposit_id` -> tra `deposit d JOIN contract c ON c.id = d.contract_id` để điền `contract_id`, `building_id`, `apartment_id`.
     - `service_request_id` -> tra `service_request sr` để điền `building_id`, `apartment_id`, và nếu thiếu `contract_id` thì ghép hợp đồng của căn hộ đó.
     - `subscription_id` -> tra `service_subscription ss` để điền `contract_id`, `building_id`, `apartment_id`.
     - `reservation_id` -> tra `reservation` để điền `apartment_id`, `building_id`.
     - `contract_id` -> tra `contract` để điền `building_id`, `apartment_id`.
     - `tenant_id` -> tra `tenant` để điền `desired_building_id` / `building_id` (nếu có).
     - Chuẩn hóa `payload.link`: tự động sửa `/admin/service-requests` thành `/admin/maintenance`.

2. **Bổ sung 4 luồng thông báo còn thiếu & Chuẩn hóa khi ghi mới (Node.js routes/jobs):**
   - **Luồng 1 — Cư dân gửi biên lai báo thanh toán (`POST /api/v1/resident/payments/report` trong `api/src/routes/resident.js`):** Phát thông báo `PAYMENT_REPORTED` cho các `MANAGER` đang hoạt động của tòa nhà với `{ payment_id, invoice_id, contract_id, building_id, apartment_id, amount }`.
   - **Luồng 2 — Cư dân đăng ký / yêu cầu hủy dịch vụ tiện ích (`POST /api/v1/resident/services` và `PATCH /api/v1/resident/services/:id/cancel` khi chuyển sang `CANCELLATION_PENDING` trong `api/src/routes/resident.js`):** Phát thông báo `SERVICE_SUBSCRIPTION_REQUESTED` / `SERVICE_CANCELLATION_REQUESTED` cho các `MANAGER` của tòa nhà với `{ subscription_id, service_id, contract_id, building_id, apartment_id, status }`. Khi `MANAGER` xác nhận chấm dứt dịch vụ tại `api/src/routes/services.js` (`nextStatus === 'TERMINATED'`), gửi `SERVICE_TERMINATED` (hoặc `SERVICE_UPDATE` kèm `status: 'TERMINATED'`) đầy đủ `{ subscription_id, contract_id, building_id, status }` cho cư dân.
   - **Luồng 3 — Cư dân gửi đề nghị gia hạn / chấm dứt hợp đồng (`POST /api/v1/resident/contract-requests` trong `api/src/routes/resident.js`):** Phát thông báo `CONTRACT_REQUEST_SUBMITTED` cho các `MANAGER` của tòa nhà với `{ request_id, contract_id, building_id, apartment_id, request_type }`.
   - **Luồng 4 — Đề nghị & Duyệt hoàn tiền tín dụng 4 mắt (`POST /api/v1/payments/credits/:id/refund`, `/approve`, `/reject` trong `api/src/routes/payments.js`):**
     - Khi `MANAGER` tạo đề nghị hoàn tiền tín dụng (`PENDING_DIRECT_REFUND`): gửi `PENDING_CREDIT_REFUND` tới `OWNER` của tòa nhà (hoặc cấp phê duyệt hợp lệ nếu tòa không có `OWNER` active) và gửi `CREDIT_REFUND_PENDING` tới `RESIDENT` thụ hưởng, kèm `{ credit_id, contract_id, building_id, refund_amount }`.
     - Khi người duyệt phê duyệt / từ chối hoàn tiền tín dụng (hoặc duyệt/từ chối điều chỉnh hóa đơn 4 mắt tại `api/src/routes/invoices.js`): ngoài thông báo cho `RESIDENT` do hàm SQL tạo sẵn, gửi thêm thông báo kết quả (`CREDIT_REFUNDED` / `CREDIT_REFUND_REJECTED` / `INVOICE_ADJUSTED`) cho `MANAGER` đã lập đề nghị *(Quyết định kỹ thuật của Builder để khép kín phản hồi 2 chiều)*.
   - **Chuẩn hóa các điểm phát có sẵn:**
     - `api/src/jobs/daily.js`: sửa `link` của `SERVICE_REQUEST_SLA_BREACH` thành `/admin/maintenance`; bổ sung `building_id` cho `CONTRACT_EXPIRY`, `DEPOSIT_WARNING_3D`, `DEPOSIT_OVERDUE_5D`, `PAYMENT_REMINDER`.
     - `api/src/routes/invoices.js` & `api/src/routes/payments.js`: bổ sung `contract_id`, `building_id`, `invoice_id` cho `INVOICE_ISSUED`, `PAYMENT_CONFIRMED`, `PAYMENT_REJECTED`.
     - `api/src/services/aiGateway.js`: phát thêm `AI_BUDGET_EXCEEDED` cho `SYS_ADMIN` (1 lần/kỳ tương tự `AI_BUDGET_WARNING`) khi chạm trần cứng ngân sách AI *(Quyết định kỹ thuật của Builder)*.
   - Tất cả các lệnh phát thông báo bổ sung đều bọc `try/catch` an toàn để không làm hỏng giao dịch nghiệp vụ chính nếu có sự cố phụ.

---

### 5.2. Bộ phân giải điều hướng thống nhất phía Frontend (`frontend/src/utils/notificationNavigation.js`)

Hàm thuần `resolveNotificationAction(notification, { role, isAdminPortal })` trả về cấu trúc thống nhất:

```js
{
  kind: 'navigate' | 'detail_modal',
  url: '/resident?tab=invoices&...', // khi kind === 'navigate'
  buildingId: 'uuid-or-null',        // dùng để đồng bộ TopBar selectedBuildingId ở Admin Portal
  contractId: 'uuid-or-null',        // dùng cho Cổng Cư dân
  actionLabel: 'Thanh toán ngay',    // nhãn gợi ý hành động
}
```

#### Bảng ánh xạ đầy đủ cho vai trò Cư dân (`RESIDENT` — Cổng `/resident`)

| Nhóm / Loại thông báo (`type`) | Đích điều hướng (`/resident?...`) | Modal tự động mở sẵn khi tới nơi |
|---|---|---|
| `INVOICE_ISSUED`, `PAYMENT_REMINDER`, `PAYMENT_REJECTED` | `?tab=invoices&target_contract_id=<cid>&invoice_id=<iid>&modal=pay` | Mở **Modal Báo đã thanh toán** (`payModalOpen`) chọn sẵn `invoice_id` nếu hóa đơn còn dư nợ; nếu hóa đơn đã trả hết/`VOID` thì mở **Modal Chi tiết Hóa đơn** |
| `PAYMENT_CONFIRMED`, `INVOICE_ADJUSTED`, `INVOICE_ADJUSTMENT_PENDING`, `INVOICE_VOIDED`, `CREDIT_APPLIED`, `CREDIT_REFUND_PENDING`, `CREDIT_REFUNDED`, `CREDIT_REFUND_REJECTED` | `?tab=invoices&target_contract_id=<cid>&invoice_id=<iid>&modal=detail` (hoặc `&credit_id=<crid>&modal=credit` với `CREDIT_*` không có `invoice_id`) | Mở **Modal Chi tiết Hóa đơn & Đối soát** (hoặc **Modal Chi tiết Sổ tín dụng** hiển thị số dư khả dụng & trạng thái hoàn tiền; nếu có hóa đơn chưa thanh toán vẫn có nút chuyển ngay sang Báo thanh toán) |
| `SETTLEMENT_STATEMENT_READY`, `DISPUTE_RESOLVED`, `SETTLEMENT_REJECTED` | `?tab=contract&target_contract_id=<cid>&deposit_id=<did>&modal=settlement` | Nếu đang trong thời hạn khiếu nại hợp lệ -> mở **Modal Bảng kê Tất toán & Khiếu nại** (hiển thị chi tiết khấu trừ kèm mở form khiếu nại `disputeModalOpen`); ngoài thời hạn -> mở **Modal Chi tiết Bảng kê Tất toán & Sổ cọc** |
| `SETTLEMENT_APPROVED`, `SETTLEMENT_READY_FOR_PAYOUT`, `DEPOSIT_PAYOUT_RETURNED` | `?tab=contract&target_contract_id=<cid>&deposit_id=<did>&modal=bank` | Nếu trạng thái cho phép cập nhật TK nhận hoàn cọc -> mở sẵn **Modal Cập nhật Tài khoản nhận hoàn cọc** (`bankModalOpen`); nếu đã khóa -> mở **Modal Chi tiết Bảng kê Tất toán & Sổ cọc** |
| `CONTRACT_EXPIRY`, `CONTRACT_EXPIRING` (có `contract_id`) | `?tab=contract&target_contract_id=<cid>&modal=renew` | Mở sẵn **Modal Đề nghị Gia hạn / Chấm dứt Hợp đồng** (`reqModalOpen` với `type = 'RENEWAL'`) nếu HĐ đang `ACTIVE`; ngược lại mở **Modal Xem Hợp đồng A4** (`templateOpen`) |
| `CONTRACT_ACTIVATED`, `CONTRACT_TERMINATED`, `CONTRACT_REQUEST_APPROVED`, `CONTRACT_REQUEST_REJECTED`, `DEPOSIT_PAYOUT_COMPLETED`, `DEPOSIT_PAYOUT_REISSUED`, `DEPOSIT_WARNING_3D`, `DEPOSIT_OVERDUE_5D` | `?tab=contract&target_contract_id=<cid>&modal=contract_view` (hoặc `&deposit_id=<did>&modal=deposit_view` cho sự kiện cọc) | Mở **Modal Xem Hợp đồng A4** (`templateOpen`) cho nhóm hợp đồng (hỗ trợ cả người ở cùng `contract_occupant`), hoặc **Modal Chi tiết Sổ cọc & Giao dịch** cho nhóm tiền cọc |
| `MAINTENANCE_UPDATE`, `SERVICE_REQUEST_*` | `?tab=maintenance&target_contract_id=<cid>&request_id=<srid>&modal=detail` | Nếu phiếu ở trạng thái `RESOLVED` và chưa đánh giá -> mở sẵn **Modal Nghiệm thu & Đánh giá 1–5 sao** (`ratingTarget`); các trạng thái khác -> mở **Modal Chi tiết Tiến độ Yêu cầu sửa chữa** (có sẵn nút Hủy / Mở lại / Đánh giá tùy trạng thái) |
| `SERVICE_UPDATE`, `SERVICE_TERMINATED` | `?tab=services&target_contract_id=<cid>&subscription_id=<subid>&modal=detail` | Mở **Modal Chi tiết Gói dịch vụ đăng ký** (hiển thị thông tin gói, biển số xe, đơn giá pro-rata và nút Hủy dịch vụ hoặc Đăng ký lại) |
| `TENANT_APPLICATION_REJECTED` | `?tab=overview&modal=apply` | Mở sẵn **Modal Cập nhật & Gửi lại Hồ sơ đăng ký nhận nhà** (`applyModalOpen`) |
| `TENANT_APPLICATION_APPROVED`, `RESERVATION_PAYMENT_CONFIRMED`, `RESERVATION_PAYMENT_REJECTED`, `RESERVATION_CANCEL_APPROVED`, `RESERVATION_CANCEL_REJECTED`, `RESERVATION_CANCEL_SETTLED` | `?tab=overview&reservation_id=<rid>&modal=reservation` | Nếu giữ chỗ đang `HELD` và chưa nộp hồ sơ nhận nhà (`RESERVATION_PAYMENT_CONFIRMED`) -> mở **Modal Đăng ký hồ sơ nhận nhà** (`applyModalOpen`); nếu giữ chỗ chờ hoàn tiền cần TK ngân hàng -> mở **Modal Cập nhật TK nhận hoàn tiền giữ chỗ**; các trường hợp còn lại -> mở **Modal Chi tiết Giữ chỗ / Hồ sơ** |
| `ANNOUNCEMENT`, `UTILITY_INTERRUPTION`, `MAINTENANCE_NOTICE`, `HOUSE_RULES`, `SECURITY_ALERT`, `SYSTEM`, `SYSTEM_NOTICE`, và loại chưa phân loại | `kind: 'detail_modal'` | Mở trực tiếp **Modal Chi tiết Thông báo** (`NotificationDetailModal`) ngay tại chỗ |

#### Bảng ánh xạ đầy đủ cho vai trò Quản trị (`MANAGER`, `OWNER`, `SYS_ADMIN` — Cổng `/admin/*`)

| Nhóm / Loại thông báo (`type`) | Đích điều hướng (`/admin/...`) | Modal tự động mở sẵn khi tới nơi |
|---|---|---|
| `SERVICE_REQUEST_CREATED`, `SERVICE_REQUEST_URGENT`, `SERVICE_REQUEST_ASSIGNED`, `SERVICE_REQUEST_REOPENED`, `SERVICE_REQUEST_RATED`, `SERVICE_REQUEST_SLA_BREACH`, `SERVICE_REQUEST_ESCALATED` | `/admin/maintenance?request_id=<srid>` | Tự gọi `openDetailDrawer(srid)` mở sẵn **Modal Chi tiết & Xử lý phiếu bảo trì** (gợi ý AI Triage, phân công kỹ thuật, cập nhật trạng thái) |
| `PAYMENT_REPORTED` (hoặc thông báo tài chính có `payment_id` tại cổng Admin) | `/admin/payments?tab=transactions&payment_id=<pid>&modal=review` | Tự mở **Modal Đối soát chứng từ thanh toán** (`setReviewPayment`) cho giao dịch `payment_id` (xem ảnh UNC, bấm Xác nhận / Từ chối nếu `MANAGER`, xem chi tiết nếu `OWNER`/`SYS_ADMIN`) |
| `PENDING_CREDIT_REFUND`, `CREDIT_REFUND_PENDING`, `CREDIT_REFUNDED`, `CREDIT_REFUND_REJECTED` | `/admin/payments?tab=credits&credit_id=<crid>&modal=credit` | Chuyển sang tab `Sổ tín dụng & Hoàn tiền` và mở **Modal Xem / Phê duyệt hoàn tiền tín dụng (4 mắt)** cho dòng `credit_id` |
| `SERVICE_SUBSCRIPTION_REQUESTED`, `SERVICE_CANCELLATION_REQUESTED` | `/admin/services/subscriptions?subscription_id=<subid>&modal=review` | Tại `SubscriptionsPage`: nếu gói đang `CANCELLATION_PENDING` và có quyền -> mở sẵn **Modal Xác nhận hủy kèm tính phí Pro-rata** (`cancelTarget`); nếu đang `PENDING_APPROVAL` hoặc trạng thái khác -> mở **Modal Xem & Phê duyệt Đăng ký Dịch vụ** (Phê duyệt / Từ chối cho `MANAGER`, xem chi tiết cho `OWNER`/`SYS_ADMIN`) |
| `INVOICE_ADJUSTMENT_PENDING`, `INVOICE_ADJUSTED`, `INVOICE_ISSUED`, `PAYMENT_REMINDER` | `/admin/invoices/<invoice_id>?modal=auto` (nếu thiếu `invoice_id` thì mở `NotificationDetailModal`) | Tại `InvoiceDetailPage`: nếu có đề nghị điều chỉnh `PENDING_APPROVAL` -> mở **Modal Xem & Phê duyệt Điều chỉnh hóa đơn (4 mắt)**; nếu hóa đơn chưa thu hết và `MANAGER` bấm `PAYMENT_REMINDER` -> mở **Modal Ghi nhận thu tiền** (`payOpen`); ngược lại mở **Modal Tóm tắt / Xem Hóa đơn** |
| `CONTRACT_REQUEST_SUBMITTED` | `/admin/contracts?tab=requests&request_id=<rid>&modal=request` | Chuyển sang tab `Yêu cầu Gia hạn / Chấm dứt` trên `ContractsPage` và mở **Modal Xử lý Yêu cầu Hợp đồng** (Duyệt / Từ chối cho `MANAGER`, xem chi tiết cho `OWNER`/`SYS_ADMIN`) |
| `CONTRACT_PENDING_APPROVAL`, `CONTRACT_PRICE_REJECTED`, `CONTRACT_BILLING_SCHEDULED`, `CONTRACT_EXPIRY`, `CONTRACT_EXPIRING`, `CONTRACT_ACTIVATED`, `CONTRACT_TERMINATED` | `/admin/contracts/<contract_id>?modal=auto` (nếu dòng seed `user_id IS NULL` không có `contract_id` -> mở `NotificationDetailModal` kèm nút đi tới `/admin/contracts`) | Tại `ContractDetailPage`: nếu `PENDING_APPROVAL` -> mở **Modal Phê duyệt Hợp đồng / Đổi phòng**; nếu `DRAFT` (`CONTRACT_PRICE_REJECTED`) -> mở **Modal Xem lý do trả về & Bản in A4**; các trạng thái khác -> mở **Modal Bản in Hợp đồng A4** (`templateOpen`) |
| `SETTLEMENT_PENDING_APPROVAL`, `SETTLEMENT_READY_FOR_PAYOUT`, `DEPOSIT_DISPUTED`, `DISPUTE_RESOLVED`, `DEPOSIT_WARNING_3D`, `DEPOSIT_OVERDUE_5D`, `DEPOSIT_BANK_INFO_UPDATED`, `DEPOSIT_PAYOUT_RETURNED`, `SETTLEMENT_APPROVED`, `SETTLEMENT_REJECTED` | `/admin/deposits?deposit_id=<did>&modal=settlement` (dòng seed `DEPOSIT_SECURE` không có `deposit_id` -> mở `NotificationDetailModal` kèm nút đi tới `/admin/deposits`) | Tự chuyển sang tab tương ứng trạng thái sổ cọc và gọi `handleOpenSettlement(dep)` mở sẵn **Modal Tất toán / Phê duyệt Four-Eyes / Giải quyết tranh chấp / Chi hoàn cọc** (nếu sổ cọc vẫn `HELD` và HĐ đang hiệu lực thì mở **Modal Lịch sử giao dịch sổ cọc** `handleOpenTransactions(dep)`) |
| `PUBLIC_RESERVATION_PENDING_CONFIRM`, `RESERVATION_NEW`, `RESERVATION_BANK_INFO_UPDATED`, `RESERVATION_CANCEL_PENDING_APPROVAL`, `RESERVATION_CANCEL_APPROVED_FOR_PAYOUT`, `RESERVATION_CANCEL_APPROVED`, `RESERVATION_CANCEL_REJECTED` | `/admin/apartments/<apartment_id>?reservation_id=<rid>&modal=reservation` (dòng seed `RESERVATION_NEW` không có `apartment_id` -> mở `NotificationDetailModal` kèm nút đi tới `/admin/buildings`) | Tại `ApartmentDetailPage`: tìm phiếu giữ chỗ và bật modal tương ứng trạng thái: `PENDING_CONFIRM` -> **Modal Đối soát biên lai giữ chỗ** (xem ảnh biên lai + nút Xác nhận / Từ chối); `CANCEL_PENDING_APPROVAL` -> **Modal Duyệt thanh lý hủy giữ chỗ** (`reviewCancelModal`); `APPROVED_PENDING_PAYOUT` -> **Modal Chi hoàn tiền giữ chỗ** (`payoutCancelModal`); các trạng thái khác -> **Modal Chi tiết Phiếu giữ chỗ** |
| `TENANT_APPLICATION` | `/admin/tenants/<tenant_id>?modal=approval` | Tại `TenantDetailPage`: nếu hồ sơ đang `PENDING` và người dùng có quyền `canManageTenants` -> mở sẵn **Modal Phê duyệt hồ sơ định danh** (`approvalDialog`); nếu đã xử lý hoặc chỉ có quyền xem -> mở **Modal Xem hồ sơ định danh / CCCD** |
| `MISSING_METER_READING` | `/admin/meters?period=<period>&contract_id=<cid>&modal=record` | Tại `MeterReadingsPage`: chuyển đúng kỳ `period`, tìm công tơ chưa chốt của `contract_id` và gọi `openSingleModal(meter)` mở sẵn **Modal Ghi chỉ số & Quét AI công tơ** |
| `MONTHLY_DEPOSIT_REPORT` | `/admin/reports?tab=deposit-ledger&building_id=<bid>&from_date=<from>&to_date=<to>&modal=summary` | Tại `ReportsPage`: chuyển sang tab `Sổ cọc (RP-07)` đúng kỳ báo cáo và mở **Modal Tóm tắt Báo cáo Sổ cọc tháng** (kèm nút Xuất Excel RP-07) |
| `AI_BUDGET_WARNING`, `AI_BUDGET_EXCEEDED`, `CRON_JOB_FAILED` | Nếu là `SYS_ADMIN`: `/admin/settings?modal=ai` (hoặc `?modal=cron`); nếu là `OWNER`/`MANAGER`: `kind: 'detail_modal'` | Với `SYS_ADMIN` tại `SettingsPage`: cuộn tới khu vực cấu hình và mở **Modal Chi tiết Cảnh báo Ngân sách AI / Lịch sử chạy Cron**; với `OWNER`/`MANAGER` (không có quyền `/admin/settings`): mở `NotificationDetailModal` |
| Bản tin chung (`ANNOUNCEMENT`, `UTILITY_INTERRUPTION`, `MAINTENANCE_NOTICE`, `HOUSE_RULES`, `SECURITY_ALERT`, `SYSTEM`, `SYSTEM_NOTICE`...) | `kind: 'detail_modal'` | Mở trực tiếp **Modal Chi tiết Thông báo** (`NotificationDetailModal`) |

---

### 5.3. Luồng thực thi thống nhất & Các Quyết định Kỹ thuật Edge-Case (Builder Calls)

1. **Xử lý đánh dấu đã đọc với thông báo toàn tổ chức `user_id IS NULL` *(Quyết định kỹ thuật của Builder)*:**
   - Do chính sách RLS `rls_notification_update` chỉ cho phép `SYS_ADMIN` hoặc chính chủ (`user_id = get_current_user_id()`) cập nhật bảng `notification`, với các dòng thông báo chung `user_id IS NULL`, `notificationStore` sẽ lưu thêm danh sách ID đã đọc theo từng `userId` trong `localStorage` (`resihub:read-org-notifs:<userId>`) song song với việc gọi API `markRead`. Khi tải lại thông báo (mỗi 60 giây hoặc F5), store tự động ghép trạng thái đã đọc từ `localStorage` và tính lại `unreadCount` chính xác mà không cần tạo bảng phụ trong DB.
2. **Hợp đồng cũ đã kết thúc (`EXPIRED`/`TERMINATED`) trên Cổng Cư dân nhiều hợp đồng *(Quyết định kỹ thuật của Builder)*:**
   - Bộ chọn căn hộ trên thanh tiêu đề `ResidentLayout` giữ nguyên chỉ liệt kê các hợp đồng đang hiệu lực (`overview.active_contracts`).
   - Khi URL điều hướng mang `target_contract_id`:
     - Nếu `target_contract_id` nằm trong `overview.active_contracts`, `ResidentPortalPage` tự đồng bộ `contract_id = target_contract_id` để chuyển ngữ cảnh sang căn hộ đó.
     - Nếu `target_contract_id` thuộc một hợp đồng cũ đã kết thúc (`EXPIRED`/`TERMINATED`), cổng vẫn giữ căn hộ đang hiệu lực hiện tại trên thanh tiêu đề, còn tab đích (`InvoicesTab`, `ContractTab`, `ServicesTab`, `MaintenanceTab`) sẽ truy vấn thêm theo `target_contract_id` (hoặc đọc từ `overview.contract_history` / `overview.deposit_settlements`) để mở đúng modal của hợp đồng cũ đó.
3. **Người ở cùng (`contract_occupant`) bấm thông báo `CONTRACT_ACTIVATED` *(Quyết định kỹ thuật của Builder)*:**
   - Tài khoản người ở cùng không đứng tên `primary_tenant_id` nên `overview.active_contract` có thể bằng `null`. Tại `ContractTab`, modal xem bản in hợp đồng A4 (`<Modal open={templateOpen}>`) được render độc lập bên ngoài nhánh EmptyState để khi có `?target_contract_id=<cid>&modal=contract_view`, hệ thống vẫn gọi `GET /api/v1/contracts/:id/template` (vốn đã phân quyền hợp lệ cho `contract_occupant`) và bật sẵn bản hợp đồng A4 ở chế độ chỉ xem, không lộ các thao tác tài chính/cọc của người đứng tên chính.
4. **Cơ chế Tiêu thụ Tham số Mở Modal một lần (One-Shot Modal Trigger):**
   - Sau khi trang đích tải xong dữ liệu và mở xong modal từ URL query (`modal`, `invoice_id`, `request_id`, `payment_id`, `deposit_id`, `credit_id`, `reservation_id`, `subscription_id`, `target_contract_id`), trang đích dọn các tham số kích hoạt một lần khỏi URL bằng `setSearchParams(..., { replace: true })` (chỉ giữ lại các tham số tab/bộ lọc bền vững như `tab`, `contract_id`, `period`, `from_date`, `to_date`).
   - Nếu bản ghi đích không còn tồn tại, hiển thị `toast.info('Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.')` và xóa tham số kích hoạt an toàn.
5. **Nút "Xem toàn bộ thông báo" dưới đáy `NotificationBell`:**
   - Cổng Cư dân: chuyển tới `/resident?tab=notifications`.
   - Cổng Quản trị: chuyển tới `/admin/notifications?tab=inbox` (`NotificationsPage` đọc `?tab=inbox` để mở thẳng tab **Hộp thư đến**).

---

## 6. Những chi tiết để người triển khai quyết định (Left to the Builder)

- Cách tổ chức bố cục bên trong `NotificationDetailModal` và các modal xem nhanh bổ sung (modal chi tiết hóa đơn/sổ tín dụng của cư dân, modal xem chi tiết gói dịch vụ / phiếu báo hỏng của cư dân, modal duyệt đăng ký dịch vụ tại `SubscriptionsPage`, modal đối soát nhanh biên lai giữ chỗ `PENDING_CONFIRM` tại `ApartmentDetailPage`, modal xem & duyệt điều chỉnh tại `InvoiceDetailPage`), sử dụng lại các UI primitives có sẵn (`Modal`, `Badge`, `StatusBadge`, `Button`, `AuthImage`).
- Tối ưu câu truy vấn gom lô trong `enrichNotificationsContext` tại `api/src/routes/notifications.js`.
- Cấu trúc bộ kiểm thử tự động (unit test cho `resolveNotificationAction` bao phủ 4 vai trò & toàn bộ loại thông báo + integration test cho `GET /api/v1/notifications` làm giàu `payload` và 4 luồng phát thông báo mới).
