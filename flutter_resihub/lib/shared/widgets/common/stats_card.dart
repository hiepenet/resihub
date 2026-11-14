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
      _ => (const Color(0xFFF0F9FF), const Color(0xFF0284C7), const Color(0xFFE0F2FE)), // sky
    };
  }

  @override
  Widget build(BuildContext context) {
    final (iconBg, iconColor, iconBorder) = _resolveIconColors();
    final isPositive = trend != null && trend! >= 0;

    final cardContent = Container(
      padding: const EdgeInsets.all(18),
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
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Text(
                  title.toUpperCase(),
                  style: const TextStyle(
                    fontSize: 12,
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
                  width: 38,
                  height: 38,
                  decoration: BoxDecoration(
                    color: iconBg,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: iconBorder),
                  ),
                  child: Icon(icon, size: 18, color: iconColor),
                ),
              ],
            ],
          ),
          const SizedBox(height: 12),
          Text(
            value?.toString() ?? '—',
            style: const TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w700,
              color: AppColors.slate900,
              letterSpacing: -0.5,
            ),
          ),
          if (trend != null || (subtext != null && subtext!.isNotEmpty)) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.only(top: 10),
              decoration: const BoxDecoration(
                border: Border(top: BorderSide(color: AppColors.slate100)),
              ),
              child: Row(
                children: [
                  if (trend != null) ...[
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                      decoration: BoxDecoration(
                        color: isPositive ? const Color(0xFFECFDF5) : const Color(0xFFFFF1F2),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            isPositive ? LucideIcons.trendingUp : LucideIcons.trendingDown,
                            size: 13,
                            color: isPositive ? const Color(0xFF047857) : const Color(0xFFBE123C),
                          ),
                          const SizedBox(width: 2),
                          Text(
                            '${isPositive ? '+' : ''}$trend%',
                            style: TextStyle(
                              fontSize: 11,
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
                        style: const TextStyle(
                          fontSize: 12,
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

    if (onClick != null) {
      return InkWell(
        onTap: onClick,
        borderRadius: BorderRadius.circular(16),
        child: cardContent,
      );
    }
    return cardContent;
  }
}
