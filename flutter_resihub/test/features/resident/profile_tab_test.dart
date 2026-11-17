import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:flutter_resihub/core/network/dio_client.dart';
import 'package:flutter_resihub/core/storage/app_storage.dart';
import 'package:flutter_resihub/features/auth/providers/auth_provider.dart';
import 'package:flutter_resihub/features/resident/services/resident_service.dart';
import 'package:flutter_resihub/features/resident/tabs/profile_tab.dart';

class _RecordingAdapter implements HttpClientAdapter {
  RequestOptions? lastProfilePatch;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    if (options.path.contains('/resident/profile') &&
        options.method == 'PATCH') {
      lastProfilePatch = options;
      return ResponseBody.fromString(
        jsonEncode({
          'success': true,
          'data': {
            'full_name': 'Nguyễn Văn Mới',
            'phone': '0901234567',
            'email': 'new@resihub.vn',
          },
        }),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType]
        },
      );
    }
    return ResponseBody.fromString(
      jsonEncode({'success': true, 'data': {}}),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType]
      },
    );
  }

  @override
  void close({bool force = false}) {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('T7 parity — profile (E6-E7)', () {
    test('uploadIdImage payload uses image_base64, not image_data', () {
      final payload =
          buildIdImagePayload('front', 'data:image/jpeg;base64,AAAA');
      expect(payload['side'], 'front');
      expect(payload['image_base64'], 'data:image/jpeg;base64,AAAA');
      expect(payload.containsKey('image_data'), isFalse);
    });

    testWidgets('save profile updates auth user', (tester) async {
      SharedPreferences.setMockInitialValues({});
      final prefs = await SharedPreferences.getInstance();
      final storage = AppStorage(prefs: prefs);
      final adapter = _RecordingAdapter();
      final dio = Dio(BaseOptions(baseUrl: 'http://localhost:3000'))
        ..httpClientAdapter = adapter;

      final container = ProviderContainer(
        overrides: [
          appStorageProvider.overrideWithValue(storage),
          dioProvider.overrideWithValue(dio),
          residentServiceProvider.overrideWithValue(ResidentService(dio: dio)),
        ],
      );
      addTearDown(container.dispose);

      await tester.binding.setSurfaceSize(const Size(1200, 900));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        UncontrolledProviderScope(
          container: container,
          child: MaterialApp(
            home: Scaffold(
              body: ProfileTab(
                overview: const {
                  'user': {
                    'full_name': 'Nguyễn Văn Cũ',
                    'phone': '0901234567',
                    'email': 'old@resihub.vn',
                  },
                },
                onRefreshOverview: () async {},
                onNavigateTab: (tab, [extra]) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.text('Lưu thay đổi hồ sơ'));
      await tester.pumpAndSettle();

      expect(adapter.lastProfilePatch, isNotNull);
      final user = container.read(authProvider).user;
      expect(user, isNotNull);
      expect(user!.fullName, 'Nguyễn Văn Mới');
    });
  });
}
