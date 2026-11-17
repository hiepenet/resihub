import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../providers/toast_provider.dart';

class AppToastOverlay extends ConsumerWidget {
  final Widget child;

  const AppToastOverlay({super.key, required this.child});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final toasts = ref.watch(toastProvider);
    final topPadding = MediaQuery.paddingOf(context).top;
    final isNarrow = MediaQuery.sizeOf(context).width < 500;

    return Directionality(
      textDirection: TextDirection.ltr,
      child: Stack(
        children: [
          child,
          if (toasts.isNotEmpty)
            Positioned(
              top: topPadding + 16,
              right: 16,
              left: isNarrow ? 16 : null,
              width: isNarrow ? null : 380,
              child: SafeArea(
                top: false,
                bottom: false,
                child: Material(
                  type: MaterialType.transparency,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      for (final toast in toasts)
                        _ToastCard(
                          key: ValueKey(toast.id),
                          toast: toast,
                          onDismiss: () => ref.read(toastProvider.notifier).dismiss(toast.id),
                        ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _ToastCard extends StatelessWidget {
  final ToastItem toast;
  final VoidCallback onDismiss;

  const _ToastCard({
    super.key,
    required this.toast,
    required this.onDismiss,
  });

  @override
  Widget build(BuildContext context) {
    final (borderColor, iconColor, iconData) = switch (toast.variant) {
      ToastVariant.success => (
          AppColors.emerald200,
          AppColors.emerald500,
          LucideIcons.circleCheck,
        ),
      ToastVariant.error => (
          AppColors.rose200,
          AppColors.rose500,
          LucideIcons.circleAlert,
        ),
      ToastVariant.warning => (
          AppColors.amber200,
          AppColors.amber500,
          LucideIcons.triangleAlert,
        ),
      ToastVariant.info => (
          AppColors.sky200,
          AppColors.sky500,
          LucideIcons.info,
        ),
    };

    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: borderColor),
        boxShadow: const [AppColors.elevatedShadow],
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(iconData, color: iconColor, size: 20),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (toast.title != null && toast.title!.isNotEmpty)
                  Text(
                    toast.title!,
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 13,
                      fontWeight: FontWeight.w600,
                      color: AppColors.slate900,
                    ),
                  ),
                if (toast.message.isNotEmpty)
                  Text(
                    toast.message,
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      color: AppColors.slate600,
                      height: 1.35,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          InkWell(
            key: const Key('toast_dismiss_button'),
            onTap: onDismiss,
            borderRadius: BorderRadius.circular(4),
            child: const Padding(
              padding: EdgeInsets.all(4),
              child: Icon(
                LucideIcons.x,
                size: 16,
                color: AppColors.slate400,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
