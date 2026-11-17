# Flutter Navigation Performance — Design / Diagnosis

> Ngày: 17/11/2026. Phạm vi: **chỉ Flutter** (`flutter_resihub/`). Không sửa `frontend/**`, không sửa backend.

## 1. Triệu chứng & giới hạn điều tra

- Triệu chứng: chuyển trang trong Flutter web **rất chậm** (cả tab cổng cư dân lẫn route admin).
- **Không đo được runtime**: cây làm việc hiện có ~37 file unstaged của công việc khác (ngoài plan này), trong đó `lib/shared/widgets/common/data_table_widget.dart` đang **lỗi compile** (mất ngoặc quanh `SelectionArea`/`ClipRRect` ở dòng ~191–372). `flutter run -d web-server` báo `Failed to compile application`. Theo nguyên tắc, không sửa/xóa/stash các file đó. Mọi phép đo phải chạy từ HEAD sạch (`bc3df9d`) hoặc worktree tách, sau khi chủ nhân WIP commit/stash.
- Vì vậy phần dưới là **bằng chứng tĩnh từ code**, và Task 1 của plan là đo xác nhận trước khi sửa.

## 2. Bằng chứng (file:line)

| # | Bằng chứng | Vị trí | Tác động giả định |
|---|---|---|---|
| E1 | `SelectionArea` bọc **toàn bộ nội dung** shell | `shared/widgets/layout/resident_shell.dart:776`, `admin_shell.dart:109` (thêm ở commit `53be85f`) | Trên web, `SelectableRegion` quét toàn subtree, đăng ký gesture, rebuild lại khi route đổi → chậm mỗi lần chuyển trang. Trùng với mốc "hiện tại". |
| E2 | `SelectionArea` **lồng nhau**: shell + mỗi bảng | `shared/widgets/common/data_table_widget.dart:191` | Nested selectable regions nhân chi phí; cũng là file đang lỗi compile do WIP ngoài plan. |
| E3 | Shell rebuild vì watch toàn provider | `resident_shell.dart:295` (`authProvider`), `:297` (`notificationProvider`); `top_bar.dart:160` (`buildingsListProvider`) | Mỗi lần poll thông báo (60s, `notification_bell.dart:39`) đổi state → rebuild cả shell + child. Dùng `.select()` để chỉ rebuild khi giá trị quan tâm đổi. |
| E4 | Mọi tab đã ghé đều bị rebuild khi setState | `resident_portal_page.dart:302-361`: `_buildTabContent()` tạo lại widget cho **mọi** tab trong `_visitedTabs` trên mỗi build; `_visitedTabs.add(_activeTab)` ngay trong `build()` (`:350`) | Chuyển tab / đổi hợp đồng / refresh → rebuild toàn bộ tab tree, kể cả tab không hiển thị. |
| E5 | Page widget tạo mới mỗi điều hướng admin | `router/app_router.dart:154-160` (ShellRoute builder), các `GoRoute.builder` (`:162+`) phần lớn không có `ValueKey` | Toàn bộ subtree dưới `SelectionArea` bị thay thế mỗi route change. |
| E6 | Refetch sau điều hướng | QueryCache TTL 20s (`core/network/query_cache.dart:5`); nhiều service có `force: true`; tab `initState` gọi fetch (`invoices_tab.dart`, `maintenance_tab.dart`, `services_tab.dart`...) | Quay lại tab/page có thể gọi API lại dù cache còn hiệu lực. |
| E7 | `shrinkWrap: true` trong scroll view | 16 chỗ (danh sách thông báo, hóa đơn,仪表...) | `shrinkWrap` bắt layout toàn bộ children — đắt với list dài, nhưng **không** phải nguyên nhân chính của chuyển trang. |
| E8 | Debug vs release | `flutter run` mặc định debug | Web debug chậm hơn release rất nhiều; đo ở release mới có ý nghĩa. |

## 3. Giả thuyết (theo thứ tự ưu tiên)

- **H1 (chính)**: E1+E2 — `SelectionArea` ở cấp shell + lồng trong bảng là đột phá hiệu năng web, trùng mốc commit `53be85f`. Kiểm tra bằng A/B: tạm bỏ SelectionArea ở 2 shell, đo lại.
- **H2**: E8 — đo nhầm debug build.
- **H3**: E3+E4+E5 — rebuild thừa toàn shell/toàn tab tree trên mỗi điều hướng.
- **H4**: E6+E7 — refetch/layout không cần thiết.

## 4. Nguyên tắc sửa

1. **Đo trước, sửa sau** (systematic debugging): baseline release-mode, A/B từng giả thuyết, một biến số mỗi lần.
2. **Không mất tính năng chọn chữ**: thay vì xóa hẳn `SelectionArea`, thu hẹp phạm vi (chỉ vùng cần chọn, không bọc cả app; không lồng). Nếu đo chứng minh vẫn quá tải, thêm cấu hình bật/tắt theo nền tảng/web route.
3. **Rebuild có chủ đích**: `.select()` cho provider, `const`/key ổn định, tách widget tĩnh (sidebar/topbar) khỏi child đổi.
4. **Cache có chủ đích**: giữ cache khi quay lại trang; chỉ `force` khi mutation.
5. Không thêm dependency; không đụng file WIP ngoài plan; mỗi task có test đo được (build-count / fetch-count / timer).

## 5. Tiêu chí thành công

- Đo được thời gian chuyển trang (release web) trước/sau, có số liệu.
- Giảm rõ ràng số rebuild và số request trên mỗi lần chuyển (assert trong test).
- Không hỏng text-selection và không hỏng 624 test hiện có.
