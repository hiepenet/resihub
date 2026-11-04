# BÁO CÁO RÀ SOÁT MỨC ĐỘ TUÂN THỦ NGHIỆP VỤ PRD v2.0 — MODULE M03 → M06

- **Dự án:** ResiHub — Hệ thống Quản lý Căn hộ & Nhà cho thuê
- **Tài liệu đối chiếu:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` (mục 6.1–6.2, 7.4–7.5, 10.1–10.3, 11, 13, 14.1–14.2)
- **Phạm vi rà soát:** backend `api/src` (routes, services, jobs, migrations). Frontend **chưa** nằm trong phạm vi báo cáo này.
- **Thời điểm rà soát:** 03/11/2026
- **Tính chất:** báo cáo tuân thủ nghiệp vụ — **không sửa code**.

---

## 1. Phương pháp & thang đánh giá

Đối chiếu từng FR/AC của M03–M06 với luồng xử lý thực tế trong source: route → service → ràng buộc DB (migration) → job định kỳ. Mỗi kết luận đều kèm dẫn chứng file–dòng.

| Mức | Ý nghĩa |
| :--- | :--- |
| **Đạt** | Đủ luồng chính, đủ ràng buộc, đúng quyền theo PRD |
| **Đạt một phần** | Có nghiệp vụ nhưng thiếu một nhánh/bước hoặc thiếu ràng buộc |
| **Thiếu** | Chưa có chức năng |
| **Lệch** | Có chức năng nhưng khác đặc tả (quyền, trạng thái, công thức) |

**Lưu ý nền tảng — khác biệt mô hình vai trò:** PRD v2.0 mô tả 6 vai trò, trong đó có `ACCOUNTANT` và `FIN_APPROVER`. Migration `036_simplify_roles.sql` đã gộp `ACCOUNTANT` + `STAFF` vào `MANAGER`, hệ thống hiện chỉ còn 4 vai trò (`SYS_ADMIN`, `OWNER`, `MANAGER`, `RESIDENT`) và **không tồn tại `FIN_APPROVER`**. Vì vậy một số điểm "lệch quyền" bên dưới là hệ quả trực tiếp của quyết định giản lược này, không phải lỗi lập trình đơn lẻ.

---

## 2. Bảng tổng hợp

| Module | FR đã rà soát | Đạt | Đạt một phần | Thiếu | Lệch | Kết luận nhanh |
| :--- | :--- | :---: | :---: | :---: | :---: | :--- |
| **M03 — Bất động sản** | FR-007, FR-008, FR-009, FR-010 | 3 | 0 | 1 | 0 | Tuân thủ cao, thiếu FR-009 (P1) |
| **M04 — Cư dân & hộ thuê** | FR-011, FR-012, FR-013, FR-021 | 3 | 1 | 0 | 0 | Tuân thủ cao, FR-013 đi qua module hợp đồng |
| **M05 — Hợp đồng** | FR-014 → FR-020 | 4 | 3 | 0 | 0 | Tuân thủ khá, 3 điểm thiếu nhánh |
| **M06 — Cọc & giữ chỗ** | FR-022, FR-023, FR-024, FR-067, FR-068 | 2 | 2 | 0 | 1 | Nghiệp vụ đầy đủ, lệch phân quyền duyệt |

---

## 3. Module M03 — Bất động sản

### 3.1. Kết quả theo FR

| FR | Yêu cầu PRD | Hiện trạng | Đánh giá | Dẫn chứng |
| :--- | :--- | :--- | :---: | :--- |
| **FR-007** | Khởi tạo tòa nhà / khu / tầng, mã định danh duy nhất, trạng thái ACTIVE–INACTIVE | CRUD tòa nhà, tầng, khu; kiểm tra trùng mã; chặn xóa tòa còn dữ liệu; đổi trạng thái | **Đạt** | `routes/buildings.js:354, 602, 663, 739, 962, 1114`; `003_real_estate.sql:13-15, 24` |
| **FR-008** | Quản lý căn hộ & thuộc tính (diện tích, loại, phòng ngủ, giá niêm yết, tiện ích) | CRUD căn hộ; đủ 5 trạng thái; unique `(building_id, code)`; gợi ý mã; sửa diện tích khi có HĐ yêu cầu xác nhận tính lại phí | **Đạt** | `routes/apartments.js:262, 387`; `003_real_estate.sql:37-42` |
| **FR-009** | Tạo căn hộ **hàng loạt** theo mẫu tầng (1..n căn) | **Không có endpoint bulk/batch.** Chỉ tạo đơn lẻ | **Thiếu (P1)** | `routes/apartments.js` chỉ có 6 route: `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `DELETE /:id`, `PATCH /:id/handover` |
| **FR-010** | Sơ đồ trạng thái căn hộ theo tầng, lưới màu, click mở chi tiết | Có `GET /:id/floor-map` trả dữ liệu lưới theo tầng/trạng thái | **Đạt** | `routes/buildings.js:892` |

### 3.2. Điểm mạnh

- **Ràng buộc trạng thái căn hộ** được ép ở tầng DB bằng `CHECK` (`AVAILABLE/RESERVED/OCCUPIED/MAINTENANCE/INACTIVE`) và đồng bộ tự động qua `services/apartmentStatus.js` — không cho client tự do gán trạng thái.
- **Xóa an toàn:** chỉ `SYS_ADMIN` được xóa; `MANAGER` bị chặn với thông điệp CRU; căn đã từng có hợp đồng/giữ chỗ bị chặn xóa và buộc chuyển `INACTIVE` (`apartments.js:534-559`). Đúng tinh thần "không xóa dữ liệu lịch sử" của PRD.
- **Bàn giao/nghiệm thu** có endpoint riêng, ghi biên bản + ảnh + audit, giải phóng `MAINTENANCE → AVAILABLE` (`apartments.js:584`), phục vụ điều kiện tất toán cọc FR-024.
- **Mã định danh duy nhất** ở cả tòa nhà (`UNIQUE(org_id, code)`) và căn hộ (`UNIQUE(building_id, code)`).

### 3.3. Khoảng trống

| Mã | Ưu tiên | Mô tả | Hướng xử lý |
| :--- | :---: | :--- | :--- |
| **GAP-M03-01** | P1 | Không có API tạo căn hộ hàng loạt theo mẫu tầng | Thêm `POST /apartments/bulk` nhận `floor_id`, `pattern`, `from/to`, `quantity`; sinh mã theo quy tắc và trả danh sách mã đã tạo/trùng |

---

## 4. Module M04 — Cư dân & hộ thuê

### 4.1. Kết quả theo FR

| FR | Yêu cầu PRD | Hiện trạng | Đánh giá | Dẫn chứng |
| :--- | :--- | :--- | :---: | :--- |
| **FR-011** | Hồ sơ cư dân & thành viên hộ (thông tin cá nhân, giấy tờ, quan hệ) | CRUD hồ sơ; chi tiết kèm occupants; upload/đọc ảnh CCCD; audit | **Đạt** | `routes/tenants.js:511, 827, 916, 1172, 1226` |
| **FR-012** | Cư dân tự đăng ký từ cổng, BQL duyệt `PENDING/APPROVED/REJECTED` | Có `POST /resident/rental-application` tạo tenant `PENDING` kèm consent/privacy; duyệt/từ chối + notification | **Đạt** | `routes/resident.js:514, 644`; `routes/tenants.js:948-962, 1027-1033` |
| **FR-013** | Chuyển phòng: kết thúc HĐ cũ, tạo HĐ mới, **chuyển cọc** | Nằm trong module hợp đồng: `POST /contracts/:id/transfer-room`, có duyệt và kết chuyển cọc | **Đạt một phần** | `routes/contracts.js:5135, 5295` |
| **FR-021** | Phát hiện & hợp nhất bản ghi trùng (SĐT/CCCD → cảnh báo; merge có audit) | `GET /tenants/check-dup` (rate limit, mask PII); `POST /tenants/merge` bắt buộc lý do + audit; tự `APPROVED` hồ sơ đích | **Đạt** | `routes/tenants.js:36, 598, 779-781` |

### 4.2. Điểm mạnh

- **PII được bảo vệ:** check-dup có rate limit và trả dữ liệu đã mask; ảnh CCCD có endpoint riêng, không lộ trong list.
- **Merge không phá dữ liệu:** yêu cầu lý do, ghi `audit_log` trước/sau, xử lý chuyển quan hệ occupants/hợp đồng sang hồ sơ đích.
- **Cổng cư dân tách biệt** (`/resident/*`) với `authenticateToken` và lọc theo chính người dùng — không dùng chung route admin.

### 4.3. Điểm cần lưu ý

| Mã | Ưu tiên | Mô tả |
| :--- | :---: | :--- |
| **NOTE-M04-01** | P2 | FR-013 không nằm trong module M04 mà triển khai trong `contracts.js`; về nghiệp vụ vẫn đủ nhưng làm phụ thuộc chéo module, khó phân quyền riêng cho "chuyển phòng" |
| **NOTE-M04-02** | P2 | Chưa có ràng buộc DB đảm bảo một person chỉ có tối đa 1 hồ sơ `tenant` đang hoạt động (chỉ kiểm tra ở tầng ứng dụng) — cần nếu muốn chống trùng tuyệt đối |

---

## 5. Module M05 — Hợp đồng

### 5.1. Kết quả theo FR

| FR | Yêu cầu PRD | Hiện trạng | Đánh giá | Dẫn chứng |
| :--- | :--- | :--- | :---: | :--- |
| **FR-014** | Tạo hợp đồng: bên thuê, căn hộ, kỳ hạn, giá, dịch vụ kèm; chặn chồng lấn; lưu `DRAFT`; **bản ghi cọc PENDING**; giá lệch → duyệt | Luồng tạo đủ; chặn chồng lấn bằng exclusion constraint; giá lệch ≥10% → `PENDING_APPROVAL`; **chưa tạo bản ghi cọc ở bước DRAFT** (chỉ tạo khi `ACTIVE`); **không cưỡng chế cọc = 1 tháng tiền thuê** | **Đạt một phần** | `routes/contracts.js:1350, 1599-1602, 3416-3420`; `014_contract_exclusion.sql:7-9`; `contracts.js:3126` (`opensDeposit` khi activate) |
| **FR-015** | Gia hạn: tạo bản nối tiếp, giữ lịch sử, `RENEWAL_PENDING` | `POST /:id/renew`, tạo contract mới với `parent_contract_id`, giữ bản cũ | **Đạt** | `routes/contracts.js:5016, 5072-5078` |
| **FR-016** | Phụ lục: ghi nhận amendment, **không sửa bản gốc** | Phiên bản hóa qua `contract_version`; tạo/duyệt/từ chối phụ lục | **Đạt** | `routes/contracts.js:4221, 4348, 4451` |
| **FR-017** | Chấm dứt/hủy hợp đồng: **MANAGER + duyệt** | Có `terminate` + `terminate/approve` + `terminate/reject`; **nhưng** khi MANAGER tự gọi `terminate`, HĐ chuyển thẳng `TERMINATED`, không qua bước duyệt | **Đạt một phần** | `routes/contracts.js:2502, 2566-2572, 2660, 2783` |
| **FR-018** | Nhắc 60/30/15 ngày cho MANAGER + cư dân | Job daily đúng mốc: 60 ngày chỉ MANAGER, 30/15 ngày MANAGER + RESIDENT | **Đạt một phần** | `jobs/daily.js:811-890`; **không có email** — toàn bộ `api/src` không có `sendEmail`/`nodemailer`/`smtp` |
| **FR-019** | Cư dân gửi đề nghị gia hạn/chấm dứt, theo dõi trạng thái duyệt | `GET/POST /resident/contract-requests`; BQL duyệt/từ chối qua `contracts/requests/:id/approve|reject` | **Đạt** | `routes/resident.js:1740, 1780`; `routes/contracts.js:874, 1133` |
| **FR-020** | Tải & lưu trữ bản hợp đồng (PDF/ảnh), phiên bản hóa | Upload scan, lưu attachment, phục vụ điều kiện `ACTIVE` | **Đạt** | `routes/contracts.js:4006`; `contract_version` |

### 5.2. Điểm mạnh

- **Chống chồng lấn kỳ hạn ở tầng DB** bằng `EXCLUDE USING gist (... daterange(start_date, end_date, '[)') WITH &&)` — không thể lách bằng concurrent request.
- **Điều kiện kích hoạt chặt:** phải có bản scan, CCCD bên thuê chính, tenant `APPROVED`; thiếu giấy tờ thì được lưu `DRAFT` nhưng chặn `ACTIVE` — đúng luồng ngoại lệ FR-014.
- **Giá lệch khung** tự động đẩy `PENDING_APPROVAL`, có endpoint duyệt/từ chối riêng.
- **Chấm dứt hợp đồng** cập nhật đồng bộ: trạng thái HĐ → trạng thái căn hộ → hạn hoàn cọc → audit → notification cư dân (`contracts.js:2566-2620`).

### 5.3. Sai lệch & khoảng trống

| Mã | Ưu tiên | Mô tả | Dẫn chứng | Hướng xử lý |
| :--- | :---: | :--- | :--- | :--- |
| **DEV-M05-01** | **P0** | MANAGER gọi `POST /:id/terminate` → HĐ chuyển thẳng `TERMINATED`; PRD yêu cầu "MANAGER + duyệt". Chỉ nhánh cư dân gửi đề nghị mới đi qua approve/reject | `contracts.js:2502, 2566-2572` | Tách: MANAGER tạo yêu cầu → `TERMINATION_PENDING`; OWNER/SYS_ADMIN duyệt mới `TERMINATED`. Hoặc chặn `terminate` trực tiếp nếu actor không phải người duyệt |
| **GAP-M05-01** | P1 | FR-014 yêu cầu **bản ghi cọc `PENDING`** ngay khi lưu `DRAFT`; code chỉ tạo `deposit` khi kích hoạt | `contracts.js:3126` (`opensDeposit`) | Tạo `deposit(status='PENDING', amount_held=0)` trong transaction tạo HĐ |
| **GAP-M05-02** | P1 | Không cưỡng chế **cọc = 1 tháng tiền thuê**; API nhận `deposit_amount` tùy ý hoặc `deposit_months` bất kỳ | `contracts.js:1599-1602, 2344-2348` | Validate `deposit_amount === rent_amount` (trừ khi có cấu hình/ngoại lệ được duyệt) |
| **GAP-M05-03** | P0 | FR-018 chỉ gửi notification in-app; **không có kênh email** dù PRD yêu cầu nhắc cho MANAGER + cư dân | `jobs/daily.js:811-890`; không tồn tại mailer trong `api/src` | Bổ sung mailer + template; hoặc chốt lại PRD rằng kênh nhắc là in-app |
| **NOTE-M05-01** | P2 | Trạng thái mở rộng ngoài PRD: `TERMINATION_PENDING` | `contracts.js:2531` | Cập nhật PRD mục 13 (state machine) để hợp thức hóa |

---

## 6. Module M06 — Cọc, khấu trừ & hoàn cọc

### 6.1. Kết quả theo FR

| FR | Yêu cầu PRD | Hiện trạng | Đánh giá | Dẫn chứng |
| :--- | :--- | :--- | :---: | :--- |
| **FR-022** | Thu cọc & sổ cọc theo hợp đồng (số tiền, ngày, phương thức, chứng từ) → `HELD` | Chỉ thu khi sổ `HELD` + HĐ hiệu lực; chặn vượt `contract.deposit_amount`; giao dịch bất biến; audit | **Đạt** | `routes/deposits.js:561-579`; `037_deposit_txn_immutable.sql` |
| **FR-023** | Khấu trừ cọc: bảng khấu trừ từng khoản kèm bằng chứng → `PARTIALLY_DEDUCTED` | Khấu trừ/hoàn **chỉ** qua hồ sơ tất toán có duyệt; API giao dịch chặn `deduct`/`refund` (`409 MUST_USE_SETTLEMENT`) | **Đạt** | `routes/deposits.js:570-574, 1048`; `services/depositSettlement.js` |
| **FR-024** | Hoàn cọc: lập → duyệt → ghi nhận chi; điều kiện HĐ `TERMINATED/EXPIRED`, chốt chỉ số cuối, biên bản bàn giao; `DISPUTED`; `RETURNED` | Đủ luồng lập/duyệt/từ chối/khiếu nại/giải quyết/chi hoàn/trả lại; kiểm tra điều kiện đầy đủ; PDF bảng kê; snapshot chống lệch số | **Lệch phân quyền** | `deposits.js:1048, 1404, 1676, 1780, 1866, 2043, 2326` |
| **FR-067** | Giữ chỗ: tạo, xác nhận, hủy/quá hạn, chuyển thành cọc HĐ | Đủ; có `PENDING_CONFIRM`, hủy chờ duyệt, chuyển cọc sang HĐ | **Đạt** | `routes/reservations.js:269, 1022, 1193, 1353`; `jobs/daily.js:299-318` |
| **FR-068** | Hạn hoàn cọc 3–5 ngày sau chấm dứt; cảnh báo quá hạn | Gán `refund_due_date` khi chấm dứt/hết hạn; job cảnh báo mọi trạng thái chưa tất toán | **Đạt** | `contracts.js:2581-2588`; `services/deadlines.js`; `jobs/daily.js:890-1140` |

### 6.2. Điểm mạnh

- **Bất biến tài chính:** giao dịch cọc đã duyệt không sửa/xóa được (trigger DB); mọi thay đổi tiền đi qua `idempotencyGuard`.
- **Tách nợ đúng PRD:** `rentDebt` **không** cấn trừ vào cọc, chỉ `serviceDebt`/hư hỏng được đối trừ — khắc phục đúng lỗi "cấn trừ cọc vào tiền thuê" mà PRD 1.4 yêu cầu bỏ.
- **Điều kiện tất toán đầy đủ:** HĐ `TERMINATED/EXPIRED`, chỉ số cuối `CONFIRMED`, không còn hóa đơn `DRAFT`, có biên bản bàn giao kèm ảnh, không còn adjustment/credit chờ.
- **Chống lệch số khi duyệt:** settlement lưu snapshot; approve phát hiện snapshot stale thay vì âm thầm tính lại.
- **Ngoại lệ đúng PRD:** khấu trừ > cọc → hoàn 0 + phần thiếu thành công nợ; `DISPUTED` khóa chi; `RETURNED` cho phép phát hành lại lệnh chi.

### 6.3. Sai lệch & khoảng trống

| Mã | Ưu tiên | Mô tả | Dẫn chứng |
| :--- | :---: | :--- | :--- |
| **DEV-M06-01** | **P0** | PRD 6.2/7.5 và FR-024 quy định **ACCOUNTANT lập; OWNER/FIN_APPROVER duyệt**. Code cho `MANAGER` lập **và** `MANAGER` cũng nằm trong nhóm được duyệt (`canActAsDepositApprover` chấp nhận OWNER/MANAGER/SYS_ADMIN). Có kiểm tra four-eyes (người lập ≠ người duyệt) nhưng **có thể tắt bằng cấu hình `allow_self_approval`** (có audit) | `deposits.js:1048` (lập: MANAGER), `deposits.js:1404` (duyệt), `deposits.js:81-90` (approver), `deposits.js:1459-1475` (four-eyes) |
| **DEV-M06-02** | P1 | Không tồn tại vai trò `ACCOUNTANT` và `FIN_APPROVER`; đã gộp vào `MANAGER` tại migration 036 → không còn tách "người lập" và "người duyệt tài chính" theo đúng PRD | `036_simplify_roles.sql:1-3, 27` |

> Đã kiểm tra lại: báo cáo tổng hợp Sổ cọc tháng gửi OWNER **đã có** (`sendMonthlyOwnerDepositReports`, `jobs/daily.js:1168-1177`) — không phải gap.

### 6.4. Trạng thái mở rộng ngoài PRD (không vi phạm, cần cập nhật tài liệu)

`APPROVED_PENDING_PAYOUT`, `DEDUCTED_FULL`, `RETURNED` (deposit); `CANCEL_PENDING_APPROVAL`, `PENDING_CONFIRM`, `APPROVED_PENDING_PAYOUT` (reservation); `TERMINATION_PENDING` (contract). Đây là các trạng thái hợp lý để mô hình hóa bước chờ chi tiền / chờ xác nhận sao kê / chờ duyệt hủy, nhưng **PRD mục 13 chưa có**, gây khó khi đối chiếu nghiệm thu.

---

## 7. Khuyến nghị ưu tiên

| # | Ưu tiên | Việc cần làm | Module | Loại |
| :---: | :---: | :--- | :--- | :--- |
| 1 | **P0** | Buộc tất toán cọc phải có người duyệt khác người lập và giới hạn người duyệt ở `OWNER` (hoặc khôi phục `FIN_APPROVER`); không cho `MANAGER` duyệt | M06 | Lệch quyền |
| 2 | **P0** | MANAGER-initiated terminate phải qua bước duyệt (`TERMINATION_PENDING` → duyệt → `TERMINATED`), không chấm dứt trực tiếp | M05 | Lệch luồng |
| 3 | **P0** | Bổ sung kênh email cho nhắc 60/30/15 ngày (hoặc chốt lại PRD chỉ dùng in-app) | M05 | Thiếu kênh |
| 4 | **P1** | Tạo bản ghi `deposit(PENDING)` ngay khi lưu HĐ `DRAFT` | M05 | Thiếu bước |
| 5 | **P1** | Cưỡng chế cọc = 1 tháng tiền thuê (validate + ngoại lệ có duyệt) | M05 | Thiếu ràng buộc |
| 6 | **P1** | Thêm API tạo căn hộ hàng loạt theo mẫu tầng | M03 | Thiếu chức năng |
| 7 | P2 | Cập nhật PRD mục 6.1/6.2/13 cho khớp 4 vai trò và các trạng thái mở rộng | Chung | Tài liệu |

---

## 8. Kết luận

- **M03:** tuân thủ tốt phần quản lý tòa nhà/căn hộ, trạng thái và an toàn dữ liệu; **thiếu FR-009 (P1)**.
- **M04:** tuân thủ tốt, đặc biệt ở chống trùng, merge có audit và bảo vệ PII; FR-013 triển khai chéo module nhưng nghiệp vụ đủ.
- **M05:** luồng tạo – kích hoạt – phụ lục – gia hạn – chuyển phòng chắc và có ràng buộc DB; **ba điểm cần xử lý: duyệt khi chấm dứt, bản ghi cọc PENDING, kênh email FR-018**, cùng ràng buộc cọc 1 tháng.
- **M06:** nghiệp vụ tất toán đầy đủ và chặt hơn PRD ở nhiều điểm (snapshot, bất biến giao dịch, tách nợ thuê/dịch vụ); **điểm lệch nghiêm trọng nhất là phân quyền duyệt**: `MANAGER` vừa là người lập vừa nằm trong nhóm được duyệt, kiểm tra four-eyes có thể bị tắt bằng cấu hình, và vai trò `FIN_APPROVER` không tồn tại.

**Mức độ tuân thủ tổng thể M03–M06: cao về nghiệp vụ, cần đóng 2 lỗ hổng P0 về phân quyền/duyệt (M05, M06) trước khi nghiệm thu.**
