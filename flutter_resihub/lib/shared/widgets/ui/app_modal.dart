import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';

enum AppModalSize {
  sm,
  md,
  lg,
  xl,
  full,
}

enum AppModalVariant {
  center,
  drawer,
}

class AppModal extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Widget child;
  final Widget? footer;
  final AppModalSize size;
  final AppModalVariant variant;
  final VoidCallback? onClose;

  const AppModal({
    super.key,
    required this.title,
    this.subtitle,
    required this.child,
    this.footer,
    this.size = AppModalSize.md,
    this.variant = AppModalVariant.center,
    this.onClose,
  });

  static Future<T?> show<T>({
    required BuildContext context,
    required String title,
    String? subtitle,
    required Widget child,
    Widget? footer,
    AppModalSize size = AppModalSize.md,
    AppModalVariant variant = AppModalVariant.center,
    bool barrierDismissible = true,
  }) {
    if (variant == AppModalVariant.drawer) {
      return showGeneralDialog<T>(
        context: context,
        barrierDismissible: barrierDismissible,
        barrierLabel: 'Dismiss',
        barrierColor: AppColors.slate900.withValues(alpha: 0.45),
        transitionDuration: const Duration(milliseconds: 250),
        pageBuilder: (ctx, anim1, anim2) {
          return Align(
            alignment: Alignment.centerRight,
            child: Material(
              type: MaterialType.transparency,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 512),
                child: AppModal(
                  title: title,
                  subtitle: subtitle,
                  footer: footer,
                  size: size,
                  variant: variant,
                  onClose: () => Navigator.of(ctx).pop(),
                  child: child,
                ),
              ),
            ),
          );
        },
        transitionBuilder: (ctx, anim1, anim2, childWidget) {
          final slide = Tween<Offset>(
            begin: const Offset(1, 0),
            end: Offset.zero,
          ).animate(CurvedAnimation(parent: anim1, curve: Curves.easeOut));
          return SlideTransition(position: slide, child: childWidget);
        },
      );
    }

    final double maxWidth = switch (size) {
      AppModalSize.sm => 448.0,
      AppModalSize.md => 512.0,
      AppModalSize.lg => 672.0,
      AppModalSize.xl => 896.0,
      AppModalSize.full => 1152.0,
    };

    return showDialog<T>(
      context: context,
      barrierDismissible: barrierDismissible,
      barrierColor: AppColors.slate900.withValues(alpha: 0.45),
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: maxWidth,
            maxHeight: MediaQuery.sizeOf(ctx).height * 0.9,
          ),
          child: AppModal(
            title: title,
            subtitle: subtitle,
            footer: footer,
            size: size,
            variant: variant,
            onClose: () => Navigator.of(ctx).pop(),
            child: child,
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final isDrawer = variant == AppModalVariant.drawer;

    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: isDrawer ? null : BorderRadius.circular(16),
        border: isDrawer
            ? const Border(left: BorderSide(color: AppColors.border))
            : Border.all(color: AppColors.border),
        boxShadow: const [AppColors.elevatedShadow],
      ),
      child: Column(
        mainAxisSize: isDrawer ? MainAxisSize.max : MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 14, 14),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        title,
                        style: const TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: AppColors.slate900,
                        ),
                      ),
                      if (subtitle != null) ...[
                        const SizedBox(height: 2),
                        Text(
                          subtitle!,
                          style: const TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 12,
                            color: AppColors.slate500,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                if (onClose != null)
                  IconButton(
                    icon: const Icon(LucideIcons.x, size: 18, color: AppColors.slate400),
                    onPressed: onClose,
                    splashRadius: 18,
                  ),
              ],
            ),
          ),
          const Divider(height: 1),

          // Scrollable body
          Flexible(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: child,
            ),
          ),

          // Optional footer
          if (footer != null) ...[
            const Divider(height: 1),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
              decoration: const BoxDecoration(
                color: AppColors.slate50,
                borderRadius: BorderRadius.vertical(bottom: Radius.circular(16)),
              ),
              child: footer!,
            ),
          ],
        ],
      ),
    );
  }
}
