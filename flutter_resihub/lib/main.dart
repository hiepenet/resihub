import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_web_plugins/url_strategy.dart';

import 'app.dart';
import 'core/storage/app_storage.dart';
import 'features/auth/providers/auth_provider.dart';
import 'features/auth/services/auth_service.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Configure clean path URL strategy on Web (no /#/) matching React Router and nginx.conf
  usePathUrlStrategy();

  // Initialize storage before creating ProviderContainer so RAM cache is ready
  final appStorage = AppStorage();
  await appStorage.init();

  // Synchronously hydrate auth session into ProviderContainer before first router evaluation
  // to prevent F5 reload flash-to-/login on Web.
  final container = ProviderContainer(
    overrides: [
      appStorageProvider.overrideWithValue(appStorage),
    ],
  );

  final authState = container.read(authProvider);

  // Background profile refresh matching frontend/src/App.jsx getMe startup behavior
  if (authState.isAuthenticated) {
    container.read(authServiceProvider).me().then((res) {
      if (res is Map && res['user'] != null) {
        container.read(authProvider.notifier).updateUser(res['user']);
      }
    }).catchError((_) {
      // Handled silently or session expiration triggered via AuthInterceptor
    });
  }

  runApp(
    UncontrolledProviderScope(
      container: container,
      child: const ResiHubApp(),
    ),
  );
}
