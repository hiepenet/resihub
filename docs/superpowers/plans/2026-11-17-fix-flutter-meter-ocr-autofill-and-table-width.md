# Fix Flutter Meter OCR Auto-Fill, Table Overflow, and React Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Flutter meter reading OCR so AI automatically populates reading fields with confidence badges for manager approval, resolve table width overflow in batch import, and align AI auto-fill behavior with ReactJS.

**Architecture:** 
1. Use `TextEditingController` for reading inputs in both single detail modal (`MeterReadingsPage`) and batch import modal (`MeterBatchPhotoImportModal`) to ensure Flutter's `TextFormField` updates synchronously upon AI OCR completion.
2. In single meter modal, wrap the reading field in `AISuggestionField` to display AI confidence, confirmation/dismissal actions, and warning banners for manager approval.
3. In batch import modal, configure `DataTable` with compact `columnSpacing` (16px), explicit column widths, visible `Scrollbar`, confidence badges, meter type tags, retry action, and clean dropdown selection matching ReactJS (`MeterBatchPhotoImportModal.jsx`).

**Tech Stack:** Flutter, Dart, Riverpod, Lucide Icons Flutter, `ai_helpers.dart`, `AISuggestionField`.

**Spec:** PRD FR-030 (Batch meter photo import & AI OCR), FR-031 (Meter anomaly verification), PRD 12.1 / 16.2 / 16.5 (Human-in-the-loop AI suggestion approval).

## Global Constraints

- Preserve all existing 26 unit & widget tests in `test/features/meters/meters_batch_ocr_test.dart`.
- Ensure strict parity with `frontend/src/components/meters/MeterBatchPhotoImportModal.jsx` and `frontend/src/pages/admin/meters/MeterReadingsPage.jsx`.
- Never mutate controller state after disposal.
- Follow test-driven verification before completion.

## Review Focus

1. AI OCR returns null or unparseable reading (blurry/glare photo) -> text field remains editable, warning displayed, no crash.
2. AI OCR returns valid reading -> text field immediately populates, consumption & estimated cost update, confidence badge appears.
3. User manually edits AI-suggested reading -> marks `edited: true`, preserves user input, does not overwrite on re-render.
4. Table width in batch modal -> columns (including "Đánh giá" and "Thao tác/Xóa") fit within viewport without truncation; horizontal scrollbar functions if screen is narrow.
5. Target meter dropdown -> unassigned rows display `-- Chọn công tơ --` rather than `-- Bỏ chọn --`.

---

### Task 1: Single Meter Reading OCR Auto-Fill & Confidence Approval Modal

**Files:**
- Modify: `flutter_resihub/lib/features/meters/screens/meter_readings_page.dart:440-760`
- Create / Test: `flutter_resihub/test/features/meters/meters_single_ocr_test.dart`

**Interfaces:**
- Consumes: `ref.read(aiServiceProvider).ocrMeterReading(...)`, `AISuggestionField`, `formatConfidenceBadge`.
- Produces: Auto-filled `readingController.text`, `AISuggestionField` with confidence badge, confirm/dismiss actions, and `ai_suggestion_id` passed to `recordReading`.

- [ ] **Step 1: Write widget test for single meter reading OCR auto-fill & AISuggestionField**

Write `flutter_resihub/test/features/meters/meters_single_ocr_test.dart` testing:
1. `_openSingleDetailModal` initializes with existing draft reading.
2. When AI OCR returns a reading and confidence, the reading input immediately populates with that reading.
3. `AISuggestionField` displays "AI đề xuất" and confidence percentage.
4. Confirming or editing updates suggestion confirmation state.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd flutter_resihub; flutter test test/features/meters/meters_single_ocr_test.dart`
Expected: FAIL (controller / AISuggestionField not wired up yet).

- [ ] **Step 3: Implement controller and AISuggestionField in `_openSingleDetailModal`**

In `flutter_resihub/lib/features/meters/screens/meter_readings_page.dart`:
1. Create `final readingController = TextEditingController(text: currentReadingStr);`
2. Add states for AI suggestion:
   - `num? aiOcrReading;`
   - `dynamic aiOcrConfidence;`
   - `bool aiOcrConfirmed = false;`
   - `bool aiOcrEdited = false;`
   - `String? aiOcrWarningText;`
3. When `ocrMeterReading` succeeds with `out['reading'] != null`:
   - Set `readingController.text = out['reading'].toString();`
   - Set `currentReadingStr = readingController.text;`
   - Set `aiOcrReading = num.tryParse(out['reading'].toString());`
   - Set `aiOcrConfidence = data['confidence'];`
   - Extract `aiOcrWarningText` from `out['reason']` or `data['warnings']`.
   - Set `aiOcrConfirmed = false; aiOcrEdited = false;`
4. Wrap `AppInput` in `AISuggestionField`:
   - `active: aiOcrReading != null`
   - `confirmed: aiOcrConfirmed`
   - `edited: aiOcrEdited`
   - `confidence: aiOcrConfidence`
   - `threshold: 0.85`
   - `warningText: aiOcrWarningText`
   - `onConfirm: () => setModalState(() { aiOcrConfirmed = true; aiOcrEdited = num.tryParse(readingController.text) != num.tryParse(aiOcrReading.toString()); })`
   - `onDismiss: () => setModalState(() { aiOcrReading = null; aiOcrConfidence = null; aiOcrConfirmed = false; aiOcrEdited = false; aiSuggestionId = null; })`
   - Pass `controller: readingController` to `AppInput`.
   - When user edits `AppInput`, update `currentReadingStr` and if `aiOcrReading != null`, mark `aiOcrConfirmed = true; aiOcrEdited = true;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd flutter_resihub; flutter test test/features/meters/meters_single_ocr_test.dart`
Expected: PASS.

---

### Task 2: Batch Photo Import Table Width Optimization

**Files:**
- Modify: `flutter_resihub/lib/features/meters/widgets/meter_batch_photo_import_modal.dart:530-685`
- Test: `flutter_resihub/test/features/meters/meters_batch_ocr_test.dart`

**Interfaces:**
- Consumes: `DataTable`, `SingleChildScrollView`, `Scrollbar`, `BoxConstraints`.
- Produces: Responsive table with compact column spacing (16px), explicit column widths, visible horizontal scrollbar, preventing overflow/truncation.

- [ ] **Step 1: Write test verifying table column structure and width constraints**

Add widget test in `meters_batch_ocr_test.dart` asserting table rendered with compact spacing and all columns visible (including evaluation badge and delete action).

- [ ] **Step 2: Update `DataTable` layout in `meter_batch_photo_import_modal.dart`**

1. Set `columnSpacing: 16.0` (down from 56.0).
2. Set `horizontalMargin: 12.0` (down from 24.0).
3. Set `dataRowMinHeight: 60.0`, `dataRowMaxHeight: 76.0`.
4. Wrap horizontal `SingleChildScrollView` with `Scrollbar` using dedicated `ScrollController`.
5. Assign explicit widths to columns:
   - Ảnh chụp: 54
   - Tệp & Gợi ý AI: 210
   - Công tơ đích: 220
   - Chỉ số cũ: 64
   - Chỉ số mới (Draft): 100
   - Tiêu thụ & Biến động: 110
   - Đánh giá: 110
   - Thao tác: 80
   Total width ~ 948px (fits well within `AppModalSize.full` 1152px width).

- [ ] **Step 3: Run tests to verify table rendering**

Run: `cd flutter_resihub; flutter test test/features/meters/meters_batch_ocr_test.dart`
Expected: PASS.

---

### Task 3: Batch Photo Import AI Auto-Fill & Parity with ReactJS

**Files:**
- Modify: `flutter_resihub/lib/features/meters/widgets/meter_batch_photo_import_modal.dart`
- Test: `flutter_resihub/test/features/meters/meters_batch_ocr_test.dart`

**Interfaces:**
- Consumes: `formatConfidenceBadge`, `_readingControllers`, `_handleRetrySingleRow`.
- Produces: Instant text field population upon OCR completion, AI confidence badge in table row, meter type badge, retry button, corrected dropdown hint.

- [ ] **Step 1: Write test for batch OCR auto-fill & confidence display**

Add test in `meters_batch_ocr_test.dart` verifying:
1. When batch OCR completes, the reading input text updates to the OCR reading value.
2. AI confidence badge is rendered with formatted percent text.
3. Meter type badge (Electricity/Water) is rendered when detected.
4. Target meter dropdown shows `-- Chọn công tơ --` when meter is unassigned.

- [ ] **Step 2: Run test to verify failure**

Run: `cd flutter_resihub; flutter test test/features/meters/meters_batch_ocr_test.dart`
Expected: FAIL.

- [ ] **Step 3: Implement batch OCR auto-fill controllers, confidence tags, retry, and dropdown fix**

In `meter_batch_photo_import_modal.dart`:
1. Add `final Map<String, TextEditingController> _readingControllers = {};` to `_MeterBatchPhotoImportModalState`.
2. When creating items in `_pickPhotos`:
   - `_readingControllers[localId] = TextEditingController(text: '');`
3. In `_runOcrForRow`:
   - When `hasAiReading`:
     ```dart
     final nextDraft = hasAiReading ? out['reading'].toString() : rowSnapshot['draftReading'];
     _readingControllers[localId]?.text = nextDraft;
     ```
4. In `DataTable` DataCell for `AppInput`:
   - Pass `controller: _readingControllers[localId]`.
5. In Column 2 ("Tệp & Gợi ý AI"):
   - Add detected meter type tag (`AI: Điện` in amber or `AI: Nước` in sky).
   - Add confidence badge `AI {pct}%` using `formatConfidenceBadge(raw['confidence'], 0.8)`.
   - Add type mismatch warning if detected type differs from selected meter's type.
   - Display `aiReason` or `ocrError`.
6. In Column 3 ("Công tơ đích"):
   - When `raw['meterId'] == null`, display `-- Chọn công tơ --` cleanly.
7. In Column 8 ("Thao tác"):
   - Add "Thử lại" retry button calling `_handleRetrySingleRow(raw)`.
   - Add trash delete button.
8. Clean up controllers in `_items.removeWhere` and `dispose()`.

- [ ] **Step 4: Run all tests to verify everything passes**

Run: `cd flutter_resihub; flutter test`
Expected: All tests PASS.
