import 'package:flutter/material.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';

enum AppBadgeVariant {
  sky,
  indigo,
  emerald,
  amber,
  red,
  purple,
  slate;

  static AppBadgeVariant fromString(String? val) {
    return switch (val?.toLowerCase().trim()) {
      'sky' => AppBadgeVariant.sky,
      'indigo' => AppBadgeVariant.indigo,
      'emerald' || 'green' => AppBadgeVariant.emerald,
      'amber' || 'yellow' => AppBadgeVariant.amber,
      'red' || 'rose' => AppBadgeVariant.red,
      'purple' || 'violet' => AppBadgeVariant.purple,
      _ => AppBadgeVariant.slate,
    };
  }
}

class AppBadge extends StatelessWidget {
  final String? label;
  final Widget? child;
  final AppBadgeVariant variant;
  final bool dot;
  final Widget? icon;
  final Color? customBgColor;
  final Color? customTextColor;
  final Color? customBorderColor;
  final Color? customDotColor;

  const AppBadge({
    super.key,
    this.label,
    this.child,
    this.variant = AppBadgeVariant.slate,
    this.dot = false,
    this.icon,
    this.customBgColor,
    this.customTextColor,
    this.customBorderColor,
    this.customDotColor,
  });

  factory AppBadge.fromStatusMeta(
    StatusMeta meta, {
    Key? key,
    bool dot = false,
    Widget? icon,
  }) {
    return AppBadge(
      key: key,
      label: meta.label,
      variant: AppBadgeVariant.fromString(meta.variant),
      dot: dot,
      icon: icon,
      customBgColor: meta.bgColor,
      customTextColor: meta.color,
      customBorderColor: meta.borderColor,
      customDotColor: meta.dotColor,
    );
  }

  @override
  Widget build(BuildContext context) {
    final (defBg, defText, defBorder, defDot) = switch (variant) {
      AppBadgeVariant.sky => (
          AppColors.sky50,
          AppColors.sky700,
          AppColors.sky200,
          AppColors.sky500,
        ),
      AppBadgeVariant.indigo => (
          AppColors.secondary50,
          AppColors.secondary700,
          AppColors.secondary100,
          AppColors.secondary500,
        ),
      AppBadgeVariant.emerald => (
          AppColors.emerald50,
          AppColors.emerald700,
          AppColors.emerald200,
          AppColors.emerald500,
        ),
      AppBadgeVariant.amber => (
          AppColors.amber50,
          AppColors.amber700,
          AppColors.amber200,
          AppColors.amber500,
        ),
      AppBadgeVariant.red => (
          AppColors.rose50,
          AppColors.rose700,
          AppColors.rose200,
          AppColors.rose500,
        ),
      AppBadgeVariant.purple => (
          AppColors.purple50,
          AppColors.purple700,
          AppColors.purple200,
          AppColors.purple500,
        ),
      AppBadgeVariant.slate => (
          AppColors.slate100,
          AppColors.slate700,
          AppColors.slate200,
          AppColors.slate400,
        ),
    };

    final bg = customBgColor ?? defBg;
    final textCol = customTextColor ?? defText;
    final borderCol = customBorderColor ?? defBorder;
    final dotCol = customDotColor ?? defDot;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: borderCol),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (dot) ...[
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                color: dotCol,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 6),
          ],
          if (icon != null) ...[
            icon!,
            const SizedBox(width: 4),
          ],
          if (child != null)
            child!
          else if (label != null)
            Text(
              label!,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: textCol,
              ),
            ),
        ],
      ),
    );
  }
}
