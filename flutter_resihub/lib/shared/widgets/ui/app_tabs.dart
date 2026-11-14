import 'package:flutter/material.dart';
import '../../../core/theme/app_colors.dart';

class AppTabItem {
  final String id;
  final String label;
  final Widget? icon;
  final int? count;

  const AppTabItem({
    required this.id,
    required this.label,
    this.icon,
    this.count,
  });
}

class AppTabs extends StatelessWidget {
  final List<AppTabItem> tabs;
  final String activeTab;
  final ValueChanged<String>? onChanged;

  const AppTabs({
    super.key,
    required this.tabs,
    required this.activeTab,
    this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: AppColors.border)),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          children: [
            for (final tab in tabs) _buildTab(tab),
          ],
        ),
      ),
    );
  }

  Widget _buildTab(AppTabItem tab) {
    final isActive = tab.id == activeTab;

    return InkWell(
      onTap: () => onChanged?.call(tab.id),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        decoration: BoxDecoration(
          border: Border(
            bottom: BorderSide(
              color: isActive ? AppColors.primary500 : Colors.transparent,
              width: 2,
            ),
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (tab.icon != null) ...[
              tab.icon!,
              const SizedBox(width: 8),
            ],
            Text(
              tab.label,
              style: TextStyle(
                fontFamily: 'Inter',
                fontSize: 14,
                fontWeight: isActive ? FontWeight.w600 : FontWeight.w500,
                color: isActive ? AppColors.primary600 : AppColors.slate500,
              ),
            ),
            if (tab.count != null) ...[
              const SizedBox(width: 6),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                decoration: BoxDecoration(
                  color: isActive ? AppColors.primary100 : AppColors.slate100,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  '${tab.count}',
                  style: TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                    color: isActive ? AppColors.primary700 : AppColors.slate600,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
