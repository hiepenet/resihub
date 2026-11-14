import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/core/constants/statuses.dart';
import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/theme/app_colors.dart';
import 'package:flutter_resihub/core/theme/app_theme.dart';
import 'package:flutter_resihub/shared/providers/toast_provider.dart';
import 'package:flutter_resihub/shared/widgets/ui/ai_suggestion_field.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_badge.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_button.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_card.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_input.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_modal.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_select.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_skeleton.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_tabs.dart';
import 'package:flutter_resihub/shared/widgets/ui/app_toast_overlay.dart';
import 'package:flutter_resihub/shared/widgets/ui/auth_media_viewer.dart';
import 'package:flutter_resihub/shared/widgets/ui/auth_pdf_viewer.dart';
import 'package:flutter_resihub/shared/widgets/ui/file_upload_field.dart';
import 'package:flutter_resihub/shared/widgets/ui/html_print_preview_modal.dart';
import 'package:flutter_resihub/shared/widgets/ui/money_input.dart';

// Minimal 1x1 transparent PNG for mock image tests
final Uint8List kTransparent1x1Png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('1. AppTheme & AppColors', () {
    test('AppColors palette exposes required primary, secondary and semantic tones', () {
      expect(AppColors.primary500, const Color(0xFF0EA5E9));
      expect(AppColors.secondary500, const Color(0xFF6366F1));
      expect(AppColors.emerald600, const Color(0xFF059669));
      expect(AppColors.rose600, const Color(0xFFE11D48));
      expect(AppColors.amber500, const Color(0xFFF59E0B));
      expect(AppColors.slate900, const Color(0xFF0F172A));
      expect(AppColors.border, const Color(0xFFE2E8F0));
    });

    test('buildAppTheme configures Material 3 light theme with consistent input & card themes', () {
      final theme = buildAppTheme();
      expect(theme.useMaterial3, isTrue);
      expect(theme.scaffoldBackgroundColor, AppColors.background);
      expect(theme.cardTheme.color, AppColors.surface);
      expect(theme.inputDecorationTheme.filled, isTrue);
    });
  });

  group('2. MoneyInput (PostgreSQL NUMERIC, typing, separator keys)', () {
    testWidgets('formats PostgreSQL NUMERIC(14,2) string "8500000.00" without 100x multiplication', (tester) async {
      String? emitted;
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: Scaffold(
            body: MoneyInput(
              label: 'Tiền thuê',
              value: '8500000.00',
              onChanged: (val) => emitted = val,
            ),
          ),
        ),
      );

      final textField = tester.widget<TextField>(find.byType(TextField));
      expect(textField.controller?.text, '8.500.000');
      expect(find.text('Tiền thuê'), findsOneWidget);
      expect(emitted, isNull);
    });

    testWidgets('emits clean raw integer on typing and preserves dot formatting', (tester) async {
      String? emitted;
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: Scaffold(
            body: MoneyInput(
              value: '100000',
              onChanged: (val) => emitted = val,
            ),
          ),
        ),
      );

      expect(find.text('100.000'), findsOneWidget);

      await tester.enterText(find.byType(TextField), '2000000');
      await tester.pumpAndSettle();

      expect(emitted, '2000000');
      expect(find.text('2.000.000'), findsOneWidget);
    });

    testWidgets('handle separator key Backspace when positioned immediately after dot', (tester) async {
      String? emitted;
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: Scaffold(
            body: MoneyInput(
              value: '12000',
              onChanged: (val) => emitted = val,
            ),
          ),
        ),
      );

      expect(find.text('12.000'), findsOneWidget);

      // Focus the input
      await tester.tap(find.byType(TextField));
      await tester.pump();

      // Set selection right after the dot: "12." (position 3)
      final state = tester.state(find.byType(MoneyInput)) as dynamic;
      final controller = state.controller as TextEditingController;
      controller.selection = const TextSelection.collapsed(offset: 3);

      // Send Backspace key event
      await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
      await tester.pumpAndSettle();

      // Deleting the digit before the dot leaves "1000" -> "1.000"
      expect(emitted, '1000');
      expect(controller.text, '1.000');
    });
  });

  group('3. AuthImage & AuthMediaViewer (Safe Attachment Routing)', () {
    testWidgets('renders data: URI directly with Image.memory without calling Dio', (tester) async {
      final base64Png = base64Encode(kTransparent1x1Png);
      final dataUri = 'data:image/png;base64,$base64Png';

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AuthImage(src: dataUri),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(Image), findsOneWidget);
    });

    testWidgets('renders external URL directly with Image.network without JWT header', (tester) async {
      const externalUrl = 'https://img.vietqr.io/image/970422-123456-compact.png';

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AuthImage(src: externalUrl),
          ),
        ),
      );

      // Image.network is rendered
      expect(find.byType(Image), findsOneWidget);
    });

    testWidgets('routes protected API attachment to fetchAuthAttachmentBytes', (tester) async {
      const protectedUrl = '/api/v1/attachments/file-123/view';
      var dioCalled = false;

      final dio = Dio();
      dio.interceptors.add(
        InterceptorsWrapper(
          onRequest: (options, handler) {
            dioCalled = true;
            return handler.resolve(
              Response(
                requestOptions: options,
                data: kTransparent1x1Png.toList(),
                statusCode: 200,
              ),
            );
          },
        ),
      );

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            dioProvider.overrideWithValue(dio),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: AuthImage(src: protectedUrl),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(dioCalled, isTrue);
      expect(find.byType(Image), findsOneWidget);
    });
  });

  group('4. AISuggestionField (PRD 12.1 / 16.2)', () {
    testWidgets('renders only child when active is false', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: AISuggestionField(
              active: false,
              child: Text('Normal content'),
            ),
          ),
        ),
      );

      expect(find.text('Normal content'), findsOneWidget);
      expect(find.text('AI đề xuất'), findsNothing);
    });

    testWidgets('renders AI badge, confidence percentage and handles confirm / dismiss', (tester) async {
      var confirmed = false;
      var dismissed = false;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AISuggestionField(
              active: true,
              confirmed: false,
              confidence: 0.92,
              onConfirm: () => confirmed = true,
              onDismiss: () => dismissed = true,
              warningText: 'Cần kiểm tra kỹ hợp đồng',
              child: const Text('Suggested 8.500.000'),
            ),
          ),
        ),
      );

      expect(find.text('AI đề xuất'), findsOneWidget);
      expect(find.text('Tin cậy 92%'), findsOneWidget);
      expect(find.text('Xác nhận'), findsOneWidget);
      expect(find.text('Bỏ'), findsOneWidget);
      expect(find.text('Cần kiểm tra kỹ hợp đồng'), findsOneWidget);

      await tester.tap(find.text('Xác nhận'));
      expect(confirmed, isTrue);

      await tester.tap(find.text('Bỏ'));
      expect(dismissed, isTrue);
    });

    testWidgets('shows confirmed label and hides confirm button when confirmed is true', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: AISuggestionField(
              active: true,
              confirmed: true,
              child: Text('Accepted value'),
            ),
          ),
        ),
      );

      expect(find.text('Đã xác nhận gợi ý AI'), findsOneWidget);
      expect(find.text('Xác nhận'), findsNothing);
    });
  });

  group('5. AppSelect<T> (Searchable selection dialog/sheet)', () {
    testWidgets('opens selection dialog and filters options with Vietnamese diacritics', (tester) async {
      String? selected;
      final options = [
        const AppSelectOption(value: 'q1', label: 'Quận 1'),
        const AppSelectOption(value: 'bt', label: 'Bình Thạnh'),
        const AppSelectOption(value: 'td', label: 'Thủ Đức'),
      ];

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppSelect<String>(
              label: 'Khu vực',
              placeholder: 'Chọn khu vực',
              value: selected,
              options: options,
              searchable: true,
              onChanged: (val) => selected = val,
            ),
          ),
        ),
      );

      expect(find.text('Chọn khu vực'), findsOneWidget);

      // Open select modal
      await tester.tap(find.byType(AppSelect<String>));
      await tester.pumpAndSettle();

      expect(find.text('Bình Thạnh'), findsOneWidget);
      expect(find.text('Thủ Đức'), findsOneWidget);

      // Search without accents "binh thanh"
      final searchInput = find.byType(TextField);
      expect(searchInput, findsOneWidget);
      await tester.enterText(searchInput, 'binh');
      await tester.pumpAndSettle();

      expect(find.text('Bình Thạnh'), findsOneWidget);
      expect(find.text('Thủ Đức'), findsNothing);

      // Select 'Bình Thạnh'
      await tester.tap(find.text('Bình Thạnh'));
      await tester.pumpAndSettle();

      expect(selected, 'bt');
    });
  });

  group('6. AppTabs', () {
    testWidgets('highlights active tab and triggers onChanged with badge count', (tester) async {
      String active = 'all';
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: StatefulBuilder(
              builder: (context, setState) {
                return AppTabs(
                  activeTab: active,
                  onChanged: (tab) => setState(() => active = tab),
                  tabs: const [
                    AppTabItem(id: 'all', label: 'Tất cả', count: 12),
                    AppTabItem(id: 'pending', label: 'Chờ duyệt', count: 3),
                  ],
                );
              },
            ),
          ),
        ),
      );

      expect(find.text('Tất cả'), findsOneWidget);
      expect(find.text('12'), findsOneWidget);
      expect(find.text('Chờ duyệt'), findsOneWidget);
      expect(find.text('3'), findsOneWidget);

      await tester.tap(find.text('Chờ duyệt'));
      await tester.pumpAndSettle();

      expect(active, 'pending');
    });
  });

  group('7. toastProvider & AppToastOverlay', () {
    testWidgets('displays toast message and dismisses via notifier or close button', (tester) async {
      final container = ProviderContainer();
      addTearDown(container.dispose);

      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: const MaterialApp(
            home: AppToastOverlay(
              child: Scaffold(
                body: Text('Overlay Child'),
              ),
            ),
          ),
        ),
      );

      expect(find.text('Overlay Child'), findsOneWidget);

      // Emit success toast with 0 duration to avoid pending timer in test
      container.read(toastProvider.notifier).success(
        'Đã lưu hóa đơn thành công',
        title: 'Thành công',
        duration: Duration.zero,
      );
      await tester.pumpAndSettle();

      expect(find.text('Thành công'), findsOneWidget);
      expect(find.text('Đã lưu hóa đơn thành công'), findsOneWidget);

      // Tap close button on toast
      final closeButton = find.byKey(const Key('toast_dismiss_button'));
      expect(closeButton, findsOneWidget);
      await tester.tap(closeButton);
      await tester.pumpAndSettle();

      expect(find.text('Đã lưu hóa đơn thành công'), findsNothing);
    });
  });

  group('8. AppBadge (StatusMeta integration)', () {
    testWidgets('renders from StatusMeta with correct label, background and dot', (tester) async {
      final meta = resolveStatusMeta(StatusDomain.apartment, 'OCCUPIED');
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppBadge.fromStatusMeta(meta, dot: true),
          ),
        ),
      );

      expect(find.text('Đang thuê'), findsOneWidget);
      expect(find.byType(AppBadge), findsOneWidget);
    });
  });

  group('9. AppButton', () {
    testWidgets('renders loading spinner and ignores taps while loading', (tester) async {
      var tapped = false;
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AppButton(
              loading: true,
              text: 'Lưu hợp đồng',
              onPressed: () => tapped = true,
            ),
          ),
        ),
      );

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      await tester.tap(find.byType(AppButton));
      expect(tapped, isFalse);
    });
  });

  group('10. AppCard, AppInput, AppModal, AppSkeleton', () {
    testWidgets('renders AppCard and PageSkeleton without errors', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(
              child: Column(
                children: [
                  AppCard(
                    header: AppCardHeader(title: 'Tiêu đề thẻ', subtitle: 'Mô tả phụ'),
                    child: Text('Nội dung thẻ'),
                  ),
                  PageSkeleton(),
                ],
              ),
            ),
          ),
        ),
      );

      expect(find.text('Tiêu đề thẻ'), findsOneWidget);
      expect(find.text('Nội dung thẻ'), findsOneWidget);
      expect(find.byType(PageSkeleton), findsOneWidget);
    });

    testWidgets('renders AppInput with label and hint', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: AppInput(
              label: 'Họ và tên',
              hint: 'Nhập họ và tên',
              required: true,
            ),
          ),
        ),
      );

      expect(find.text('Họ và tên'), findsOneWidget);
      expect(find.text('Nhập họ và tên'), findsOneWidget);
    });
  });

  group('11. FileUploadField', () {
    testWidgets('renders upload box and previews existing image and PDF items', (tester) async {
      final base64Png = base64Encode(kTransparent1x1Png);
      final files = [
        'data:image/png;base64,$base64Png',
        'data:application/pdf;base64,JVBERi0xLjQK',
      ];
      dynamic updatedFiles;

      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: FileUploadField(
              label: 'Ảnh & Tài liệu đính kèm',
              value: files,
              multiple: true,
              maxFiles: 3,
              onChanged: (val) => updatedFiles = val,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Ảnh & Tài liệu đính kèm'), findsOneWidget);
      expect(find.text('PDF'), findsOneWidget);
      expect(find.byType(AuthImage), findsOneWidget);

      // Tap remove button of second item
      final inkWells = find.descendant(of: find.byType(Stack), matching: find.byType(InkWell));
      await tester.tap(inkWells.last);
      await tester.pumpAndSettle();
      expect(updatedFiles, isNotNull);
    });
  });

  group('12. Platform-Guarded AuthPdfViewer & HtmlPrintPreviewModal', () {
    testWidgets('renders AuthPdfViewer in test environment without throwing', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: AuthPdfViewer(
              bytes: Uint8List.fromList([37, 80, 68, 70]), // %PDF
              title: 'HopDong.pdf',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.textContaining('PDF Document (4 bytes)'), findsOneWidget);
    });

    testWidgets('renders HtmlPrintPreviewModal in test environment without throwing', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: HtmlPrintPreviewModal(
              title: 'Bản in mẫu hợp đồng A4',
              htmlContent: '<h1>HỢP ĐỒNG THUÊ NHÀ</h1><p>Điều 1: Thông tin phòng</p>',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Print Preview: Bản in mẫu hợp đồng A4'), findsOneWidget);
    });
  });

  group('13. AppModal dialog', () {
    testWidgets('AppModal.show displays title, subtitle and closes via close button', (tester) async {
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) {
                return ElevatedButton(
                  onPressed: () {
                    AppModal.show(
                      context: context,
                      title: 'Xác nhận gia hạn',
                      subtitle: 'Kiểm tra thông tin trước khi lưu',
                      footer: const Text('Footer actions'),
                      child: const Text('Modal Body Content'),
                    );
                  },
                  child: const Text('Mở Modal'),
                );
              },
            ),
          ),
        ),
      );

      await tester.tap(find.text('Mở Modal'));
      await tester.pumpAndSettle();

      expect(find.text('Xác nhận gia hạn'), findsOneWidget);
      expect(find.text('Kiểm tra thông tin trước khi lưu'), findsOneWidget);
      expect(find.text('Modal Body Content'), findsOneWidget);
      expect(find.text('Footer actions'), findsOneWidget);

      // Close modal
      final closeBtn = find.byType(IconButton);
      expect(closeBtn, findsOneWidget);
      await tester.tap(closeBtn);
      await tester.pumpAndSettle();

      expect(find.text('Modal Body Content'), findsNothing);
    });
  });
}
