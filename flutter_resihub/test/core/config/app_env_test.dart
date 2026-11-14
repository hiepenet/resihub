// flutter_resihub/test/core/config/app_env_test.dart
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_resihub/core/config/app_env.dart';

void main() {
  test('ưu tiên URL truyền qua --dart-define và cắt dấu / dư ở cuối', () {
    expect(
      AppEnv.resolveApiBaseUrl(
        isWeb: true,
        isReleaseMode: true,
        platform: TargetPlatform.linux,
        definedUrl: 'https://api.resihub.vn/',
      ),
      'https://api.resihub.vn',
    );
  });

  test('Web Release mặc định trả chuỗi rỗng để đi qua Nginx reverse proxy (:3001)', () {
    expect(
      AppEnv.resolveApiBaseUrl(isWeb: true, isReleaseMode: true, platform: TargetPlatform.linux, definedUrl: ''),
      '',
    );
  });

  test('Web Debug (flutter run -d chrome) mặc định trỏ http://localhost:5000', () {
    expect(
      AppEnv.resolveApiBaseUrl(isWeb: true, isReleaseMode: false, platform: TargetPlatform.linux, definedUrl: ''),
      'http://localhost:5000',
    );
  });

  test('Android mặc định trỏ 10.0.2.2:5000 cho Android Emulator', () {
    expect(
      AppEnv.resolveApiBaseUrl(isWeb: false, isReleaseMode: false, platform: TargetPlatform.android, definedUrl: ''),
      'http://10.0.2.2:5000',
    );
  });

  test('iOS/Desktop mặc định trỏ localhost:5000', () {
    expect(
      AppEnv.resolveApiBaseUrl(isWeb: false, isReleaseMode: false, platform: TargetPlatform.iOS, definedUrl: ''),
      'http://localhost:5000',
    );
  });
}
