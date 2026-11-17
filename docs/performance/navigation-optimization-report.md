# Navigation Optimization Report (Flutter)

> 17/11/2026. Branch `perf/navigation`. Chỉ sửa Flutter. Baseline & A/B: `docs/performance/navigation-baseline.md`.

## Tóm tắt

Người dùng phản ánh chuyển trang Flutter "rất chậm". Điều tra bằng source + runtime release web + widget test xác nhận nguyên nhân gốc: **mỗi lần đổi tab tạo widget mới → initState → fetch API + rebuild cả cây**, dồn dập đến mức renderer Chrome crash sau ~8 tab.

## Thay đổi đã commit

| Task | Commit | Thay đổi | Bằng chứng |
|---|---|---|---|
| 1 | `cfc799d` | Baseline + failing refetch test + harness | `navigation_fetch_test.dart` RED `1 vs 2`; full suite 621 pass |
| 3 | `ca16403` | `ResidentPortalPage`: IndexedStack + cache tab widgets + `ValueKey` | fetch test GREEN (1 call); resident tests 31/31 |
| 4 | `3f78084` | Shell/topbar/sidebar dùng `ref.watch(select(...))` | RED rebuild 2 → GREEN 1; layout 20/20 |
| 5 | `ed5f3b0` | Tab remount dùng `QueryCache.cachedFetch(force:false)`; mutation/refresh giữ `force:true` | RED remount 2 → GREEN 1; 13/13 + 30/30 |
| 6 | `0c2c796` → revert `3b4c6ca` | ~~Lazy list~~ | Bị review loại: nested-scroll 560px phá UI-1-1 |

## Kết quả đo

- Trước: `listInvoices` 2 lần / 2 lần ghé tab; crash renderer sau ~8 tab (DevTools `Target crashed`).
- Sau: `listInvoices` 1 lần; đổi đủ 8 tab không crash; rebuild shell 1 thay vì 2 khi notification `loading` đổi.
- Full suite: **625/625 PASS**.
- Không có số milliseconds: DevTools trace timeout ngay trên baseline do renderer crash; dùng hành vi lặp lại được (crash → không-crash, fetch count) làm thước đo.

## Giả thuyết đã xử lý

- H2 (debug build): loại — build `--release` vẫn chậm.
- H4 (refetch): **xác nhận & sửa** — nguyên nhân chính.
- H3 (provider watch): **xác nhận & sửa** — đóng góp thứ hai.
- H1 (SelectionArea): **không triển khai** — sau khi sửa refetch, crash hết; không bằng chứng SelectionArea là nguyên nhân. Deferred.
- H7 (list dài): **defer** — lợi ích lazy chưa chứng minh, cái giá là phá UI-1-1. Cần trace thật + sliver conversion nếu làm.

## Rủi ro / follow-up

- Cache resident URLs chưa nằm trong `kUrlInvalidationRules`; độ tươi phụ thuộc `force:true` ở mutation/refresh + TTL 20s.
- Task 4 test dùng helper seam (`watchShellUnreadCount`) — không bắt được nếu ai đó watch trực tiếp trở lại tại callsite. Giữ callsite duy nhất dưới review.
- Chạy bản release (`flutter build web --release`) khi dùng hàng ngày; debug web chậm hơn nhiều.

## Phạm vi đo / không overclaim

- Số liệu runtime (crash → không-crash, fetch-count, rebuild-count) **chỉ đo ở cổng cư dân (resident)**. Điều hướng admin qua sidebar chưa đo/release A/B; `.select()` ở `sidebar_widget`/`top_bar` chỉ giảm rebuild khi auth/building churn, không chứng minh giảm rebuild khi đổi route admin (go_router vẫn rebuild ShellRoute). Đây là follow-up, không phải kết quả đã đạt.

## Không làm

- Không sửa `frontend/**` / backend / `pubspec.yaml`.
- Không đụng 37 file WIP ngoài plan ở worktree `flutter-v2` (đặc biệt `data_table_widget.dart`).
- Không đổi nhãn tiếng Việt / giao diện đã audit UI-1-1.
