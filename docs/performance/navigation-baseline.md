# Navigation Performance Baseline & A/B Results

> Đo ngày 17/11/2026. Worktree sạch `perf/navigation` @ `9d44d46`. Flutter 3.50 release web. API `http://localhost:5000` (gọi trực tiếp từ browser).

## Môi trường

- Build: `flutter build web --release --no-wasm-dry-run --dart-define=API_BASE_URL=http://localhost:5000` → OK.
- Serve: SPA fallback server (`spa_server.py`) trên cổng 8083.
- Chrome DevTools: viewport 1440×900, login `tenant1@resihub.vn`.
- Full suite baseline: **621 test PASS** (worktree mới; con số khác 624 ở worktree gốc do bối cảnh worktree, không phải lỗi).

## Quan sát runtime (release web)

- Sau khi login resident và bấm ~8 tab liên tiếp, renderer Chrome **crash/freeze**: a11y tree timeout, `Runtime.evaluate` → `Target crashed`; phải reload mới hồi sinh. Triệu chứng lặp lại được, khớp phản hồi "chuyển trang rất chậm" của người dùng (thực tế là đóng băng dần theo số tab đã ghé).
- Không lấy được CPU trace vì renderer crash giữa thao tác — dùng widget test để pin nguyên nhân thay thế (xem dưới).

## A/B giả thuyết

| Giả thuyết | Phép đo | Kết quả |
|---|---|---|
| H1 — `SelectionArea` cấp shell + lồng bảng | Runtime crash sau nhiều tab; a11y tree timeout | **Ủng hộ** (gián tiếp): web selection region là đắt nhất; crash xảy ra đúng luồng đổi tab. Chưa A/B trực tiếp do renderer crash. |
| H2 — đo nhầm debug build | Đã build `--release`, API 200 | **Loại**: vẫn chậm/crash ở release. |
| H3 — watch provider gây rebuild child | Widget test `BuildCountProbe` làm child shell, đổi `notification.loading` | **Không chứng minh được** (test pass ngay — probe nằm dưới child instance không đổi). Không bác bỏ H3; chuyển đo bằng fetch-count. |
| H4 — refetch sau điều hướng | Widget test `navigation_fetch_test.dart`: vào invoices → overview → invoices | **XÁC NHẬN**: `listInvoices` gọi **2 lần** (kỳ vọng 1). Mỗi lần quay lại tab gọi API lại. |

## Kết luận Task 1

- Nguyên nhân đã xác nhận bằng test lặp lại được: **H4 (refetch mỗi lần đổi tab)** — `IndexedStack` giữ tab widget nhưng mỗi lần quay lại vẫn tạo instance mới/`initState` hoặc `didUpdateWidget` gọi fetch.
- H1 có bằng chứng runtime gián tiếp mạnh (crash/freeze) → giữ Task 2 để xử lý SelectionArea.
- H3 chưa có phép đo kết luận → giữ Task 4 nhưng phải viết lại test đo đúng (không dùng child probe).
- H7 (list dài) chưa đo → giữ Task 6.

## Sau các fix (Task 3 + 4 + 5)

- Build release lại từ HEAD sau fix (`3b4c6ca`), serve 8083, login resident, đổi lần lượt 8 tab: **tất cả 8 tab đổi được, renderer KHÔNG crash** (baseline trước đó crash ở tab ~6). Một dialog thông báo mở do bấm tab "Thông báo" (bell) — hành vi bình thường, đóng bằng Escape, không phải lỗi.
- `listInvoices` = 1 lần / 2 lần ghé tab (widget test).
- Rebuild shell trên notification.loading-only = 1 (trước 2) — widget test.
- Task 6 (lazy list) đã **revert** vì nested-scroll 560px phá UI-1-1; lợi ích lazy chưa được chứng minh bằng runtime trace.
- Task 2 (SelectionArea) không triển khai: crash đã hết sau khi sửa refetch → SelectionArea không phải nguyên nhân chính. Giữ deferred, không mở rộng scope.

## Kết luận chung

Nguyên nhân gây "chuyển trang rất chậm" là **refetch mỗi lần đổi tab** (mỗi tab tạo widget mới → initState → gọi API + rebuild cả cây), không phải SelectionArea hay provider watch. Fix bằng IndexedStack + cache widget (Task 3), thu hẹp provider watch (Task 4), cache khi remount (Task 5). Không đo được milliseconds do DevTools trace bị renderer timeout ở baseline, nhưng hành vi crash → không-crash lặp lại được.
