import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';

/// KPI / Summary stats card displaying a metric, trend badge, icon, and optional subtext.
/// Port of `frontend/src/components/common/StatsCard.jsx`.
class StatsCard extends StatelessWidget {
  final String title;
  final dynamic value;
  final String? valueTitle;
  final String? subtext;
  final IconData? icon;
  final num? trend;
  final String color;
  final VoidCallback? onClick;

  const StatsCard({
    super.key,
    required this.title,
    required this.value,
    this.valueTitle,
    this.subtext,
    this.icon,
    this.trend,
    this.color = 'sky',
    this.onClick,
  });

  (Color bg, Color text, Color border) _resolveIconColors() {
    return switch (color) {
      'indigo' => (const Color(0xFFEEF2FF), const Color(0xFF4F46E5), const Color(0xFFE0E7FF)),
      'emerald' => (const Color(0xFFECFDF5), const Color(0xFF059669), const Color(0xFFD1FAE5)),
      'amber' => (const Color(0xFFFFFBEB), const Color(0xFFD97706), const Color(0xFFFEF3C7)),
      'rose' => (const Color(0xFFFFF1F2), const Color(0xFFE11D48), const Color(0xFFFFE4E6)),
      'slate' => (AppColors.slate100, AppColors.slate700, AppColors.slate200),
      _ => (const Color(0xFFF0F9FF), const Color(0xFF0284C7), const Color(0xFFE0F2FE)), // sky
    };
  }

  @override
  Widget build(BuildContext context) {
    final (iconBg, iconColor, iconBorder) = _resolveIconColors();
    final isPositive = trend != null && trend! >= 0;
    final hasFooter = trend != null || (subtext != null && subtext!.isNotEmpty);

    return LayoutBuilder(
      builder: (context, constraints) {
        final bounded = constraints.hasBoundedHeight;
        final maxH = constraints.maxHeight;
        final isUltraCompact = bounded && maxH < 130;
        final isCompact = bounded && !isUltraCompact && maxH < 170;

        final outerPadding = isUltraCompact
            ? const EdgeInsets.symmetric(horizontal: 12, vertical: 8)
            : (isCompact
                ? const EdgeInsets.symmetric(horizontal: 14, vertical: 10)
                : const EdgeInsets.symmetric(horizontal: 16, vertical: 14));
        final iconBoxSize = isUltraCompact ? 24.0 : (isCompact ? 30.0 : 34.0);
        final iconSize = isUltraCompact ? 13.0 : (isCompact ? 15.0 : 17.0);
        final titleFontSize = isUltraCompact ? 11.0 : 12.0;
        final valueFontSize = isUltraCompact ? 16.0 : (isCompact ? 20.0 : 22.0);
        final gapHeight = isUltraCompact ? 2.0 : (isCompact ? 4.0 : 6.0);
        final footerTopPad = isUltraCompact ? 3.0 : (isCompact ? 6.0 : 8.0);
        final subtextFontSize = isUltraCompact ? 10.0 : (isCompact ? 11.0 : 12.0);

        final bodyColumn = Padding(
          padding: outerPadding,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Expanded(
                    child: Text(
                      title.toUpperCase(),
                      style: TextStyle(
                        fontSize: titleFontSize,
                        fontWeight: FontWeight.w600,
                        letterSpacing: 0.5,
                        color: AppColors.slate500,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  if (icon != null) ...[
                    const SizedBox(width: 8),
                    Container(
                      width: iconBoxSize,
                      height: iconBoxSize,
                      decoration: BoxDecoration(
                        color: iconBg,
                        borderRadius: BorderRadius.circular(isUltraCompact ? 8 : 12),
                        border: Border.all(color: iconBorder),
                      ),
                      child: Icon(icon, size: iconSize, color: iconColor),
                    ),
                  ],
                ],
              ),
              SizedBox(height: gapHeight),
              Text(
                value?.toString() ?? '—',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: valueFontSize,
                  fontWeight: FontWeight.w700,
                  color: AppColors.slate900,
                  letterSpacing: -0.5,
                ),
              ),
              if (hasFooter) ...[
                SizedBox(height: gapHeight),
                Container(
                  padding: EdgeInsets.only(top: footerTopPad),
                  decoration: const BoxDecoration(
                    border: Border(top: BorderSide(color: AppColors.slate100)),
                  ),
                  child: Row(
                    children: [
                      if (trend != null) ...[
                        Container(
                          padding: EdgeInsets.symmetric(
                            horizontal: isUltraCompact ? 4 : 6,
                            vertical: isUltraCompact ? 1 : 2,
                          ),
                          decoration: BoxDecoration(
                            color: isPositive ? const Color(0xFFECFDF5) : const Color(0xFFFFF1F2),
                            borderRadius: BorderRadius.circular(6),
                          ),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                isPositive ? LucideIcons.trendingUp : LucideIcons.trendingDown,
                                size: isUltraCompact ? 11 : 13,
                                color: isPositive ? const Color(0xFF047857) : const Color(0xFFBE123C),
                              ),
                              const SizedBox(width: 2),
                              Text(
                                '${isPositive ? '+' : ''}$trend%',
                                style: TextStyle(
                                  fontSize: isUltraCompact ? 10 : 11,
                                  fontWeight: FontWeight.w600,
                                  color: isPositive ? const Color(0xFF047857) : const Color(0xFFBE123C),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(width: 8),
                      ],
                      if (subtext != null && subtext!.isNotEmpty)
                        Expanded(
                          child: Text(
                            subtext!,
                            style: TextStyle(
                              fontSize: subtextFontSize,
                              color: AppColors.slate500,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                  ),
                ),
              ],
            ],
          ),
        );

        return Container(
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: AppColors.slate200),
            boxShadow: const [
              BoxShadow(
                color: Color(0x08000000),
                blurRadius: 4,
                offset: Offset(0, 1),
              ),
            ],
          ),
          child: onClick != null
              ? Material(
                  color: Colors.transparent,
                  borderRadius: BorderRadius.circular(16),
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: onClick,
                    hoverColor: AppColors.slate50.withValues(alpha: 0.6),
                    borderRadius: BorderRadius.circular(16),
                    child: bodyColumn,
                  ),
                )
              : bodyColumn,
        );
      },
    );
  }
}
