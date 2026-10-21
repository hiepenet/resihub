# Kế Hoạch Kiểm Thử ResiHub Bằng Chrome DevTools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to run this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kiểm thử end-to-end website ResiHub qua trình duyệt thực (Chrome DevTools MCP), tập trung hồi quy 17 lỗi nghiệp vụ M03/M04 vừa sửa + luồng cốt lõi, phát hiện lỗi UI/console/network mà curl không thấy được.

**Architecture:** Mở site chạy Vite dev (port 3000) gọi API Fastify (port 5000). Mỗi phase = một vai trò đăng nhập + một nhóm chức năng. Trước mỗi phase bật thu thập **console messages** và **network requests** của tab; mọi response ≥400 phải có lý do hợp lệ (bean lỗi nghiệp vụ) — nếu không là BUG. Mỗi bug chụp ảnh màn hình + ghi ERR-n.

**Tech Stack:** Chrome DevTools (MCP `chromium-devtools`/`browser`), app React 19 + Vite (3000), API (5000), Postgres 5433 (chỉ tra đối chứng khi nghi ngờ).

**Spec:** `docs/superpowers/plans/2026-10-21-fix-m03-m04-business-logic.md` + `Bao_Cao_Review_Nghiep_Vu_M03_M04.md` (17 fix là danh mục hồi quy chính).

## Global Constraints

- Chạy `npm run dev --prefix api` (5000) và `npm run dev --prefix frontend` (3000) trước khi kiểm thử; trang app: `http://localhost:3000`.
- Tài khoản seeded (password `password123`): `manager@resihub.vn` (MANAGER, quản 6 tòa), `owner@resihub.vn` (OWNER), `resident@resihub.vn` (RESIDENT).
- Tòa chính dùng test: `Tòa Kiểm Thử TN-TEST-7674` (đã có khu A/B, tầng, căn ZT-101); tòa sạch không HĐ ACTIVE: `TN-TEST-3450`.
- Không xóa / sửa dữ liệu seeded (A101/A102...); dữ liệu test mới đặt tên tiền tố `QA-` hoặc SĐT `09xx` riêng để dọn được.
- Mọi xác nhận dạng `window.confirm`/`window.prompt` đều click được qua DevTools dialog handling — không bypass bằng gọi API.

## Review Focus

- Nhập không hợp lệ ở trust boundary (mã trùng, thiếu CCCD, zone khác tòa) → phải hiện bean lỗi nghiệp vụ đúng mã, không die trắng, không lỗi 500 lộ ra UI.
- Vai trò truy cập: STAFF/RESIDENT không được thấy PII (CCCD) hay nút hành động vượt quyền; Owner chỉ xem.
- Đồng bộ trạng thái căn hộ ↔ hợp đồng ↔ giữ chỗ sau mỗi thao tác (OCCUPIED/RESERVED/AVAILABLE/MAINTENANCE).
- Console sạch: không có React warning đỏ, không CORS, không lỗi network bất ngờ.

---

### Task 0: Chuẩn bị môi trường + đo đạc

- [ ] **Step 1:** Bật 2 server (đã chạy nền nếu còn từ session trước — check `http://localhost:5000/api/v1/health`… nếuなければ start lại; frontend `http://localhost:3000`).
- [ ] **Step 2:** Mở tab Chrome tới `http://localhost:3000`, đặt viewport desktop 1440×900; bật thu thập console + network cho tab.
- [ ] **Step 3:** Kiểm tra trang load không có console error nào khi mới mở (kỳ vọng: sạch hoặc chỉ warning không chặn).

### Task 1: Đăng nhập & Phân quyền (Auth)

- [ ] **Step 1:** Sai mật khẩu (`manager@resihub.vn` / `wrong`) → kỳ vọng: thông báo lỗi bản dịch tiếng Việt, KHÔNG crash, không console error 500 không kiểm soát.
- [ ] **Step 2:** Đăng nhập đúng manager → kỳ vọng: vào Dashboard, TopBar có Building Switcher, vai trò hiển thị MANAGER.
- [ ] **Step 3:** Đổi Building Switcher sang `TN-TEST-3450` → mạng thấy requestBuildingId + `localStorage.resihub_selected_building_id` đổi. Ghi lại URL/state để Task 5 kiểm tra ContractsPage đồng bộ.
- [ ] **Step 4:** Đăng xuất → đăng nhập `resident@resihub.vn` → kỳ vọng: vào Cổng Cư Dân, KHÔNG truy cập được route admin (thử gõ tay URL admin → bị chặn/redirect).
- [ ] **Step 5:** Chụp ảnh tab hiện tại làm bằng chứng trạng thái đăng nhập resident; ghi kết quả.

### Task 2: Tòa nhà — Khu/Tầng (M03, C1, C3, C4)

- [ ] **Step 1:** Với manager, chọn tòa `TN-TEST-7674` → mở modal "Thêm khu": code `A` đã tồn tại → kỳ vọng: thông báo `Khu A đã tồn tại trong tòa này.` (409 ZONE_EXISTS), modal không đóng oке khi lỗi.
- [ ] **Step 2:** Tạo khu `QA-C` (tên "Khu QA") → kỳ vọng: pill mới hiện dải "Khu/Block" với đếm (0), audit_log có CREATE zone (kiểm bằng UI ảnh hoặc psql đối chứng: 1 dòng).
- [ ] **Step 3:** Bấm Tắt/Bật trên pill khu → status pill mờ đi/rực lại (INACTIVE/ACTIVE).
- [ ] **Step 4:** Thêm tầng mới (level 5, "Tầng 5") → tầng xuất hiện trên sơ đồ; psql đối chứng audit_log có dòng CREATE 'floor' (C3).
- [ ] **Step 5:** Bấm icon bút chì sửa tầng — đổi tên "Tầng QA-5" → tên cập nhật ngay.
- [ ] **Step 6:** Sửa một căn hộ panel: xem khối "Tiện ích đi kèm" — kỳ vọng chỉ hiện giá trị truthy từ amenities JSONB, không còn 4 chip cứng (C1). Căn không có tiện ích → hiện dòng nhạt "Không có tiện ích nào được ghi nhận."

### Task 3: Căn hộ — Guard trạng thái & gợi ý mã (A2, A9, C2)

- [ ] **Step 1:** Tạo căn trùng mã `ZT-101` → kỳ vọng: lỗi hiện kèm "Gợi ý mã kế tiếp: ZT-102." (C2); tạo `ZT-102` trùng lần nữa → gợi ý thành "ZT-103".
- [ ] **Step 2:** Tạo căn hợp lệ `QA-101` gắn khu `QA-C` → căn xanh AVAILABLE, panel hiện Khu/Block = QA-C.
- [ ] **Step 3:** Trên căn đang OCCUPIED (TN-TEST-7674-101): thử sửa trực tiếp status → kỳ vọng: bean `DIRECT_STATUS_CHANGE_PROHIBITED` (A2), căn giữ OCCUPIED.
- [ ] **Step 4:** Sửa `area_m2` của căn có HĐ ACTIVE → kỳ vọng: dialog xác nhận (A9), hủy → không đổi; xác nhận → đổi.
- [ ] **Step 5:** Tạo căn với zone của tòa khác (UI select chỉ liệt kê khu ACTIVE của tòa đang chọn — nếu vẫn nhét được zone khác tòa vào request thì kỳ vọng 400 ZONE_MISMATCH và lỗi hiển thị trên form).

### Task 4: Cư dân — Duyệt/sửa + CCCD (A6, A7, A8, B7)

- [ ] **Step 1:** Tạo resident `QA Duyet` SĐT `0901234501`, không CCCD → kỳ vọng: trạng thái badge **PENDING** + toast "đang chờ duyệt".
- [ ] **Step 2:** Bấm "Duyệt" ngay → kỳ vọng: lỗi `MISSING_IDENTITY_PAPER`, hồ sơ vẫn PENDING.
- [ ] **Step 3:** "Sửa" → thêm CCCD `030099888777` → lưu → bấm Duyệt → badge **APPROVED**.
- [ ] **Step 4:** Tạo resident thứ 2 SĐT trùng `0901234501` → banner cảnh báo FR-021 realtime ở modal + server chết 409 DUPLICATE_PERSON nếu vẫn submit.
- [ ] **Step 5:** Tra tenant vừa tạo, mở modal Sửa → bật "Ảnh CCCD": upload 2 ảnh nhỏ (<5MB, png) cho front/back → thumbnail hiện, click mở tab mới trả ảnh PNG đúng loại file (`Content-Type: image/png`).
- [ ] **Step 6:** Đăng nhập resident → dùng cookie/token của resident gọi ảnh CCCD của manager (qua network panel copy request) → kỳ vọng 403 FORBIDDEN_ATTACHMENT; nếu UI là resize thì xác nhận RESIDENT không có nút nào chạm PII.
- [ ] **Step 7:** Nếu có STAFF trong DB: login STAFF → cột CCCD hiện `•••••••• (Ẩn PII)`; nếu không có tài khoản, bỏ qua và ghi ghi chú N/A.

### Task 5: Hợp đồng — Vòng đời DRAFT → ACTIVE (A3, A5, B6, C7)

- [ ] **Step 1:** Tạo hợp đồng căn `QA-101` cho resident APPROVED, giá lệch ≤10% (đúng `base_rent`) → kỳ vọng: badge **DRAFT** (không phải ACTIVE!), căn đổi **RESERVED**.
- [ ] **Step 2:** Sửa DRAFT (đổi giá họ tên biểu phí) → lưu OK.
- [ ] **Step 3:** Mở tab "Thành viên" (B6) → thêm `QA Thanh Vien` (SĐT `0901234599`, quan hệ "vợ") → hiện trong list; thêm lần nữa → 409 OCCUPANT_EXISTS hiện alert; gỡ → list rỗng, hồ sơ cư dân không mất (tra TenantsPage vẫn còn người).
- [ ] **Step 4:** Kích hoạt không scan → kỳ vọng lỗi `MISSING_SIGNED_SCAN`.
- [ ] **Step 5:** Upload bản ký (dùng chính ảnh png test của Task 4) → kích hoạt:
  - Giá khớp → **APPROVED/CONFIRMED/ACTIVE** (theo enum thực tế — so khớp badge UI với psql), căn → **OCCUPIED** nếu start ≤ hôm nay.
  - Dùng hợp đồng giá lệch >10% của căn khác → kỳ vọng **PENDING_APPROVAL** và nút "Duyệt" chỉ hiện với OWNER.
- [ ] **Step 6:** Terminate một HĐ ACTIVE (dùng `f43f3d4f` hay HĐ test ai đó) → căn → **MAINTENANCE** (A1); hành động "Bàn giao" trên sơ đồ → căn → **AVAILABLE** (B8).
- [ ] **Step 7:** Tòa `TN-TEST-3450`: tạo giữ chỗ QA (dùng UI giữ chỗ/NV-06), rồi "Tạm dừng" tòa → kỳ vọng `RESERVED_APARTMENTS_EXIST` (C7); thu hồi giữ chỗ → tạm dừng được (rồi bật lại ACTIVE).
- [ ] **Step 8:** Đồng bộ Building Switcher (B3): đang ở Task 1 Step 3 chọn `TN-TEST-3450` → vào ContractsPage tạo HĐ → select tòa mặc định theo switcher (không phải tòa đầu danh sách).

### Task 6: Cổng Cư Dân (B9)

- [ ] **Step 1:** Resident có HĐ (dùng HĐ ACTIVE vừa tạo nếu đúng resident đó; ngược lại dùng resident đã ký sẵn `8f741c7a` nếu biết app_user) → kỳ vọng: card "Hồ sơ của tôi" hiện 4 ô (tên/SĐT/email/CCCD) đúng dữ liệu person.
- [ ] **Step 2:** Nộp hồ sơ nhận nhà (khai báo CCCD) → banner "đang chờ Ban Quản Lý phê duyệt" hiện (FR-012); bên admin, hồ sơ xuất hiện chờ duyệt (TenantsPage).
- [ ] **Step 3:** Báo hỏng/sự cố — modal gửi thông tin, hiện thông báo thành công.

### Task 7: cross-cutting — Console/Network/Responsive

- [ ] **Step 1:** Chạy lại toàn bộ tab, export console: không còn lỗi JS chưa bắt (uncaught), không React key warning đỏ.
- [ ] **Step 2:** Lọc network theo status ≥400: mọi dòng phải tương ứng một bean nghiệp vụ có chủ đích trong bảng kết quả bên dưới; các lỗi 500 bất kỳ là BUG.
- [ ] **Step 3:** Viewport 390×844 (mobile) chạy lại Task 2 Step 6 + Task 5 Step 3: layout không vỡ, modal cuộn được.
- [ ] **Step 4:** Dọn dẹp: xóa/entity `QA-` tạo ra (căn, tenant test) khi cần; catalog tổng hợp ERR-n (nếu có); commit báo cáo `docs/.../kiem-thu-chrome-devtools-2026-10-21.md`.

---

## Bảng Kết Quả (điền khi chạy)

| # | Task.Step | Kết quả (PASS/BUG) | Mã lỗi thấy được | Ảnh/Ghi chú |
|---|---|---|---|---|
| 1 | 1.1 |  |  |  |
| 2 | 1.2 |  |  |  |
| … |  |  |  |  |

## Định nghĩa BUG cần ghi lại

- UI chết trắng / infinite spin không có thông báo.
- Thông báo lỗi không đúng mã nghiệp vụ đã thiết kế (vd hiện "Something went wrong" thay vì ZONE_EXISTS).
- Trạng thái căn hộ/khách thuê không đồng bộ sau thao tác.
- Dữ liệu PII lộ cho vai trò sai.
- Console error chưa bắt bất kỳ nào.
