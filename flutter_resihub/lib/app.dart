import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/theme/app_theme.dart';
import 'router/app_router.dart';
import 'shared/widgets/ui/app_toast_overlay.dart';

/// The root application widget of ResiHub v2.0.
/// Configures [MaterialApp.router] with [appRouterProvider], [buildAppTheme],
/// Vietnamese/English localizations, and [AppToastOverlay].
class ResiHubApp extends ConsumerWidget {
  const ResiHubApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(appRouterProvider);

    return MaterialApp.router(
      title: 'ResiHub',
      debugShowCheckedModeBanner: false,
      theme: buildAppTheme(),
      routerConfig: router,
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      supportedLocales: const [
        Locale('vi', 'VN'),
        Locale('en', 'US'),
      ],
      builder: (context, child) => AppToastOverlay(
        child: child ?? const SizedBox.shrink(),
      ),
    );
  }
}
