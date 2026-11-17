import 'package:flutter/material.dart';
import '../../../core/theme/app_colors.dart';

class AppCardHeader extends StatelessWidget {
  final String title;
  final String? subtitle;
  final Widget? action;

  const AppCardHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.action,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
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
                    fontSize: 14,
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
          if (action != null) ...[
            const SizedBox(width: 12),
            action!,
          ],
        ],
      ),
    );
  }
}

class AppCard extends StatelessWidget {
  final Widget child;
  final AppCardHeader? header;
  final EdgeInsetsGeometry padding;
  final Color? color;
  final BoxBorder? border;
  final BorderRadiusGeometry? borderRadius;

  const AppCard({
    super.key,
    required this.child,
    this.header,
    this.padding = const EdgeInsets.all(20),
    this.color,
    this.border,
    this.borderRadius,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: color ?? Colors.white,
        borderRadius: borderRadius ?? BorderRadius.circular(12),
        border: border ?? Border.all(color: AppColors.border),
        boxShadow: const [AppColors.cardShadow],
      ),
      padding: padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (header != null) header!,
          child,
        ],
      ),
    );
  }
}
