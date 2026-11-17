# Flutter Navigation Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Giảm độ trễ khi chuyển trang trên Flutter (web + mobile) bằng cách đo đạc và loại bỏ rebuild/refetch/selection-area không cần thiết, chỉ sửaFlutter.

**Architecture:** Đo baseline ở chế độ release trước, sau đó xử lý theo thứ tự ưu tiên đã xác minh: (1) `SelectionArea` bọc shell + lồng trong bảng → thu hẹp phạm vi; (2) rebuild thừa do watch provider toàn phần và tạo lại widget tab mỗi build → `select()` + key/const ổn định; (3) refetch sau điều hướng → tận dụng `QueryCache`; (4) `shrinkWrap` trên list dài. Mỗi bước đo lại để chứng minh cải thiện.

**Tech Stack:** Flutter 3.50 / Dart 3.14, Riverpod 2.6 (`ref.watch`/`select`), go_router 14 (`ShellRoute`), `flutter_test` + `integration_test` (nếu có), Chrome DevTools trace/CPU.

**Spec:** `docs/superpowers/specs/2026-11-17-flutter-navigation-performance-design.md`

## Global Constraints

- **Chỉ sửa Flutter** (`flutter_resihub/**`). Không sửa `frontend/**`, không sửa backend.
- **KHÔNG đụng ~37 file đang có thay đổi unstaged ngoài plan** (danh sách tại `git status`), đặc biệt `lib/shared/widgets/common/data_table_widget.dart` đang lỗi compile do WIP ngoài — plan này không sửa file đó cho đến khi chủ nhân WIP commit/stash. Task 1 chạy từ HEAD sạch (`bc3df9d`) hoặc worktree tách.
- Không thêm dependency mới vào `pubspec.yaml`.
- Không làm mất khả năng chọn/chép chữ trên web (ý đồ của commit `53be85f`) — nếu bỏ `SelectionArea` cấp shell thì phải giữ nó ở vùng nội dung có ý nghĩa (xem Task 2).
- Mỗi task: test failing trước → implement tối thiểu → test pass → commit riêng. Không gộp nhiều sửa đổi vào một task.
- Đo ở **release/profile mode** (`flutter run --release -d web-server` hoặc build web + serve), không dùng debug để kết luận hiệu năng.
- Giữ nguyên 624 test hiện tại xanh; không đổi hành vi nghiệp vụ/labels tiếng Việt đã audit.

## Review Focus

| Input / điều kiện dễ hỏng | Hành vi mong đợi | Test gắn ở task |
|---|---|---|
| Web build release, đổi route admin qua sidebar | Thời gian chuyển trang giảm rõ ràng vs baseline; không rebuild toàn shell | Task 1 (baseline + A/B), Task 4 |
| Chuyển tab cổng cư dân qua lại | Không re-init/fetch lại tab đã ghé trong cùng phiên | Task 3, Task 5 |
| Notification poll 60s / auth refresh | Shell không rebuild khi `unreadCount` không đổi; rebuild khi đổi | Task 4 |
| Chọn chữ trên web trong bảng dữ liệu | Vẫn chọn được (SelectionArea vẫn hiện ở vùng nội dung) | Task 2 |
| Quay lại trang trong vòng TTL 20s | Dùng cache, không gọi API lại | Task 5 |
| Danh sách dài (notifications/invoices) | Không layout toàn bộ items khi mở trang | Task 6 |

---

## Task 1: Baseline đo & xác nhận giả thuyết (A/B)

**Files:**
- Create: `flutter_resihub/test/performance/navigation_perf_harness.dart` (helper đo rebuild/fetch, không phải benchmark thời gian cố định)
- Modify (tạm, rồi hoàn tác): `lib/shared/widgets/layout/resident_shell.dart`, `lib/shared/widgets/layout/admin_shell.dart` (chỉ trong worktree đo)
- Create: `docs/performance/navigation-baseline.md` (số liệu)

**Interfaces:**
- Consumes: HEAD sạch `bc3df9d`, API local `http://localhost:3000`, tài khoản `tenant1@resihub.vn` / `admin@resihub.vn`.
- Produces: số liệu baseline (release web) và kết luận H1/H2/H3/H4 được xác nhận hay bác bỏ.

- [ ] **Step 1: Chuẩn bị môi trường đo** — từ HEAD sạch tạo worktree tách (`git worktree add ../perf-measure bc3df9d`), chạy `flutter run --release -d web-server --web-port <p> --dart-define=API_BASE_URL=http://localhost:3000`. Ghi cấu hình vào `docs/performance/navigation-baseline.md`. (Không đụng worktree đang có WIP.)
- [ ] **Step 2: Đo baseline** — Chrome DevTools `trace.start` → login resident → đổi lần lượt 8 tab → `trace.stop`/`trace.analyze`; lặp admin đổi 5 route. Ghi long tasks, tổng scripting/layout time, số request API (`network.list` lọc `/api`). Chụp màn hình để đối chiếu.
- [ ] **Step 3: A/B H1** — trong worktree đo, comment tạm `SelectionArea` ở 2 shell (`resident_shell.dart:776`, `admin_shell.dart:109`), rebuild, đo lại cùng thao tác. Ghi chênh lệch. Hoàn tác ngay sau khi đo (worktree đo không commit thay đổi này).
- [ ] **Step 4: A/B H3** — tạm thay `ref.watch(notificationProvider)` bằng `ref.watch(notificationProvider.select((s) => s.unreadCount))` ở shell, đo lại; hoàn tác.
- [ ] **Step 5: Kết luận** — ghi rõ giả thuyết nào đúng, mức độ cải thiện, và **chỉ giữ lại các task tương ứng** trong plan (task 2–6 có thể bỏ nếu A/B chứng minh không đáng kể). Chốt baseline document.
- [ ] **Step 6: Commit** `perf: add navigation baseline and A/B results` (chỉ docs + harness; worktree đo xóa sau).

### Task 2: Thu hẹp `SelectionArea` (nếu H1 đúng)

**Files:**
- Modify: `lib/shared/widgets/layout/resident_shell.dart:776`, `lib/shared/widgets/layout/admin_shell.dart:109`
- Không modify `data_table_widget.dart` trong task này (thuộc WIP ngoài plan).
- Test: `test/shared/widgets/layout_shell_test.dart` (thêm assert), `test/features/resident/resident_portal_test.dart` (assert tab content vẫn có selectable region).

**Interfaces:**
- Consumes: kết quả A/B Task 1.
- Produces: shell không còn `SelectionArea` cấp gốc; vùng nội dung chính vẫn có một `SelectionArea` duy nhất (không lồng).

- [ ] **Step 1: Failing test** — assert `find.byType(SelectionArea)` trong shell (không tính table) trả về **0** ở cấp shell; assert vùng child có đúng 1 `SelectionArea`.
- [ ] **Step 2: Run** → FAIL (hiện có SelectionArea ở shell).
- [ ] **Step 3: Implement** — bỏ `SelectionArea` trong 2 shell; bọc nội dung trang (không phải shell chrome) bằng 1 `SelectionArea` duy nhất tại điểm `widget.child` được truyền vào (hoặc để page tự quyết định). Đảm bảo không nested với table (nếu table có SelectionArea, bỏ wrapper ở mức page chứa bảng đó). Giữ hành vi copy được.
- [ ] **Step 4: Run test** → PASS; chạy `flutter test test/shared/widgets/layout_shell_test.dart` → PASS.
- [ ] **Step 5: Đo lại** (release web) → ghi số liệu vào baseline doc, so với Task 1.
- [ ] **Step 6: Commit** `perf(resident,admin): scope selection area to content`.

### Task 3: Ổn định tab tree trong ResidentPortalPage (nếu H3 đúng)

**Files:**
- Modify: `lib/features/resident/screens/resident_portal_page.dart:247-256,302-361`
- Test: `test/features/resident/resident_portal_test.dart` (thêm test đếm initState/build).

**Interfaces:**
- Consumes: `_visitedTabs`, `_buildTabContent()` hiện tại.
- Produces: `_buildSingleTab` trả widget có `ValueKey(tab)` ổn định; `_visitedTabs` chỉ cập nhật trong `_handleNavigateTab`, không trong `build()`.

- [ ] **Step 1: Failing test** — đếm số lần `initState` của `InvoicesTab` sau chuỗi navigate `overview → invoices → overview → invoices`: kỳ vọng **1**; hiện tại có thể >1 do widget bị tạo mới. Dùng stub đếm qua subclass hoặc mock service `listInvoices` gọi count.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thêm `ValueKey(tab)` cho mỗi tab widget; chuyển `_visitedTabs.add(_activeTab)` ra khỏi `build()` (đã có trong `_handleNavigateTab` — xóa dòng `:350`); bọc mỗi tab bằng `RepaintBoundary` + `AutomaticKeepAliveClientMixin` nếu tab là StatefulWidget và có fetch (chỉ áp dụng cho tab tốn kém: invoices/maintenance/services/contract). Không đổi props/callback.
- [ ] **Step 4: Run test** → PASS; `flutter test test/features/resident/resident_portal_test.dart` → PASS.
- [ ] **Step 5: Đo lại** → ghi chênh lệch request/rebuild.
- [ ] **Step 6: Commit** `perf(resident): stabilize tab widgets across navigation`.

### Task 4: Giảm rebuild shell do provider (nếu H3 đúng)

**Files:**
- Modify: `lib/shared/widgets/layout/resident_shell.dart:295-297`, `lib/shared/widgets/layout/top_bar.dart:155-161`, `lib/shared/widgets/layout/sidebar_widget.dart:74-75`
- Test: `test/shared/widgets/layout_shell_test.dart` (thêm test rebuild count), `test/features/notifications/announcements_test.dart` nếu có chỗ phù hợp.

**Interfaces:**
- Consumes: `notificationProvider` (`NotificationState.unreadCount`, `loading`), `authProvider`, `buildingsListProvider`.
- Produces: shell chỉ rebuild khi `unreadCount` đổi, không rebuild khi `loading`/`notifications` đổi; top bar chỉ rebuild khi danh sách tòa nhà thực sự đổi.

- [ ] **Step 1: Failing test** — pump shell với `ProviderScope` override notif state; emit `state.copyWith(loading: true)` (unreadCount giữ nguyên); assert số lần build của shell **không tăng**. Hiện tại tăng → FAIL.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — thay `ref.watch(notificationProvider).unreadCount` bằng `ref.watch(notificationProvider.select((s) => s.unreadCount))`; với `authProvider` dùng `select` lấy đúng field cần (`isAuthenticated`, `user`, `primaryRole`); `buildingsListProvider` dùng `select` lấy `valueOrNull` thay vì watch toàn AsyncValue nếu không cần trạng thái loading. Giữ listener `ref.listen` hiện có.
- [ ] **Step 4: Run test** → PASS; `flutter test test/shared/widgets/layout_shell_test.dart` → PASS.
- [ ] **Step 5: Đo lại** → ghi số liệu.
- [ ] **Step 6: Commit** `perf(shell): narrow provider watches to selected fields`.

### Task 5: Tận dụng cache khi quay lại trang (nếu H4 đúng)

**Files:**
- Modify: `lib/features/resident/tabs/invoices_tab.dart`, `maintenance_tab.dart`, `services_tab.dart`, `contract_tab.dart` (chỉ phần `initState`/`didUpdateWidget` gọi fetch)
- Test: `test/features/resident/resident_portal_test.dart` (mock `ResidentService` đếm lời gọi), `test/features/invoices/invoices_payments_test.dart`.

**Interfaces:**
- Consumes: `QueryCache.cachedFetch` TTL 20s (`core/network/query_cache.dart:5`), service `listInvoices/listServiceRequests/listServices` (có `force` param).
- Produces: khi mount lại tab trong vòng TTL, gọi service với `force: false` (dùng cache); chỉ mutation mới `force: true`.

- [ ] **Step 1: Failing test** — mount `InvoicesTab` → unmount → mount lại ngay (cùng contractId, cùng cache scope); assert `listInvoices` được gọi **1** lần (hoặc 2 nhưng lần 2 có `force:false` trả cache). Hiện tại gọi lại mỗi lần → FAIL.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — trong `initState`, gọi fetch với `force: false`; đảm bảo `didUpdateWidget` chỉ fetch khi `contract_id` đổi (đã có ở hầu hết tab — giữ nguyên). Với refresh/pull-to-refresh giữ `force: true`. Không đổi signature service.
- [ ] **Step 4: Run test** → PASS; chạy focused tests của 4 tab → PASS.
- [ ] **Step 5: Đo lại** network count → ghi số liệu.
- [ ] **Step 6: Commit** `perf(resident): reuse query cache on tab remount`.

### Task 6: Giảm chi phí list dài (nếu đo thấy long task khi mở danh sách)

**Files:**
- Modify: `lib/features/notifications/screens/notifications_page.dart:1457,1732,1893,2177`; `lib/shared/widgets/common/notification_bell.dart:162`; các chỗ `shrinkWrap: true` trong scroll view có parent đã là scrollable.
- Test: `test/features/notifications/announcements_test.dart` (assert cấu trúc `ListView.builder` thay `Column(children: map)` nếu đổi).

**Interfaces:**
- Consumes: cấu trúc list hiện tại.
- Produces: list dài dùng lazy builder (`ListView.builder`/`SliverList`) hoặc bỏ `shrinkWrap` khi parent đã có scroll; giữ giao diện/ngữ cảnh không đổi.

- [ ] **Step 1: Failing test** — với 200 notifications, assert widget tree không tạo 200 `NotificationCard` cùng lúc (dùng `find.byType(...).evaluate().length` nhỏ hơn tổng số); hiện tại >100 → FAIL.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — chuyển map sang `ListView.builder` trong khung scroll có chiều cao xác định, hoặc bỏ `shrinkWrap` ở các GridView lồng trong `SingleChildScrollView` có thể thay bằng `SliverGrid`. Làm từng màn một, ưu tiên notifications trước. Giữ key ổn định cho item.
- [ ] **Step 4: Run test** → PASS; focused tests → PASS.
- [ ] **Step 5: Đo lại** (trace khi mở notifications) → ghi số liệu.
- [ ] **Step 6: Commit** `perf(lists): lazy-build long notification and invoice lists`.

### Task 7: Tổng hợp & tài liệu hóa kết quả

**Files:**
- Modify: `docs/performance/navigation-baseline.md`
- Create: `docs/performance/navigation-optimization-report.md`

**Interfaces:**
- Consumes: số liệu Task 1–6.
- Produces: bảng before/after, danh sách giả thuyết được xác nhận/bác bỏ, khuyến nghị vận hành (build release để dùng hàng ngày, không dùng debug).

- [ ] **Step 1: Chạy full suite** `flutter test` → 624/624 PASS (baseline hiện tại).
- [ ] **Step 2: Chạy lại baseline harness** trên HEAD cuối cùng, ghi before/after vào report.
- [ ] **Step 3: Viết report** — nêu rõ task nào bỏ qua vì A/B không ủng hộ, và rủi ro còn lại.
- [ ] **Step 4: Commit** `docs: add navigation performance report`.

---

## Self-review

- **Spec coverage**: E1→Task 2, E3→Task 4, E4→Task 3, E6→Task 5, E7→Task 6, E8→Task 1; H1–H4 đều có A/B ở Task 1. E2 (`data_table_widget.dart`) **không có task sửa** vì file đang là WIP ngoài plan — được ghi rõ ở Global Constraints; nếu H1 đúng, Task 2 xử lý phía shell và bỏ wrapper page chứa bảng mà không sửa file WIP.
- **Step scan**: mỗi step một hành động, có test name/assert cụ thể; Task 1 là measurement (không phải code fix) nên output là số liệu — chấp nhận được vì đây là phase root-cause.
- **Type consistency**: `force: bool`, `unreadCount: int`, `ValueKey(tab)` dùng nhất quán.
- **Review Focus**: 6 input classes đều có test-pin; không có item nào bị bỏ.
- **Proportion**: plan dài hơn spec nhưng phần lớn là test name + command, không phải thân hàm — phù hợp với plan dạng TDD.
