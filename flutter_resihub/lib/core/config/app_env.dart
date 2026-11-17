import 'package:flutter/foundation.dart';

/// Application environment configuration and API endpoint resolution.
class AppEnv {
  AppEnv._();

  /// Resolves the base URL for API requests depending on the platform and runtime mode.
  static String resolveApiBaseUrl({
    required bool isWeb,
    required bool isReleaseMode,
    required TargetPlatform platform,
    String definedUrl = const String.fromEnvironment('API_BASE_URL'),
  }) {
    final trimmed = definedUrl.trim();
    if (trimmed.isNotEmpty) {
      return trimmed.replaceAll(RegExp(r'/+$'), '');
    }

    if (isWeb) {
      if (isReleaseMode) {
        return '';
      }
      return 'http://localhost:5000';
    }

    if (platform == TargetPlatform.android) {
      return 'http://10.0.2.2:5000';
    }

    return 'http://localhost:5000';
  }

  /// Default resolved API base URL using runtime environment.
  static String get apiBaseUrl => resolveApiBaseUrl(
        isWeb: kIsWeb,
        isReleaseMode: kReleaseMode,
        platform: defaultTargetPlatform,
      );
}
