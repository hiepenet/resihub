import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';

class BreadcrumbItem {
  final String label;
  final String? to;
  final VoidCallback? onTap;

  const BreadcrumbItem({
    required this.label,
    this.to,
    this.onTap,
  });
}

/// Standard page header with title, subtitle, breadcrumbs, back button, and action widgets.
/// Port of `frontend/src/components/common/PageHeader.jsx`.
class PageHeader extends StatelessWidget {
  final String title;
  final String? subtitle;
  final List<BreadcrumbItem> breadcrumbs;
  final String? backTo;
  final bool? showBack;
  final Widget? actions;
  final VoidCallback? onBack;

  const PageHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.breadcrumbs = const [],
    this.backTo,
    this.showBack,
    this.actions,
    this.onBack,
  });

  @override
  Widget build(BuildContext context) {
    final hasBack = showBack ?? (backTo != null || breadcrumbs.any((b) => b.to != null || b.onTap != null));

    return Padding(
      padding: const EdgeInsets.only(bottom: 24.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (breadcrumbs.isNotEmpty) ...[
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 6,
              runSpacing: 4,
              children: [
                for (int i = 0; i < breadcrumbs.length; i++) ...[
                  if (i > 0)
                    const Icon(
                      LucideIcons.chevronRight,
                      size: 14,
                      color: AppColors.slate400,
                    ),
                  if (breadcrumbs[i].onTap != null)
                    InkWell(
                      onTap: breadcrumbs[i].onTap,
                      child: Text(
                        breadcrumbs[i].label,
                        style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w500,
                          color: AppColors.primary600,
                        ),
                      ),
                    )
                  else
                    Text(
                      breadcrumbs[i].label,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: i == breadcrumbs.length - 1 ? AppColors.slate700 : AppColors.slate500,
                      ),
                    ),
                ],
              ],
            ),
            const SizedBox(height: 8),
          ],
          LayoutBuilder(
            builder: (context, constraints) {
              final isNarrow = constraints.maxWidth < 600;

              final titleSection = Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  if (hasBack) ...[
                    InkWell(
                      onTap: () {
                        if (onBack != null) {
                          onBack!();
                        } else {
                          Navigator.maybePop(context);
                        }
                      },
                      borderRadius: BorderRadius.circular(12),
                      child: Container(
                        width: 36,
                        height: 36,
                        decoration: BoxDecoration(
                          color: Colors.white,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: AppColors.slate200),
                        ),
                        child: const Icon(
                          LucideIcons.arrowLeft,
                          size: 16,
                          color: AppColors.slate600,
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                  ],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          style: const TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w700,
                            letterSpacing: -0.5,
                            color: AppColors.slate900,
                          ),
                        ),
                        if (subtitle != null && subtitle!.isNotEmpty) ...[
                          const SizedBox(height: 2),
                          Text(
                            subtitle!,
                            style: const TextStyle(
                              fontSize: 14,
                              color: AppColors.slate500,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              );

              if (isNarrow) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    titleSection,
                    if (actions != null) ...[
                      const SizedBox(height: 16),
                      actions is Wrap
                          ? actions!
                          : SingleChildScrollView(
                              scrollDirection: Axis.horizontal,
                              child: actions!,
                            ),
                    ],
                  ],
                );
              }

              return Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(child: titleSection),
                  if (actions != null) ...[
                    const SizedBox(width: 16),
                    ConstrainedBox(
                      constraints: BoxConstraints(
                        maxWidth: constraints.maxWidth * 0.62,
                      ),
                      child: actions is Wrap
                          ? actions!
                          : SingleChildScrollView(
                              scrollDirection: Axis.horizontal,
                              child: actions!,
                            ),
                    ),
                  ],
                ],
              );
            },
          ),
        ],
      ),
    );
  }
}
