import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';

class ContactTab extends ConsumerWidget {
  final Map<String, dynamic>? overview;
  final Future<void> Function() onRefreshOverview;
  final void Function(String tab, [Map<String, dynamic>? extra]) onNavigateTab;

  const ContactTab({
    super.key,
    required this.overview,
    required this.onRefreshOverview,
    required this.onNavigateTab,
  });

  Future<void> _makePhoneCall(WidgetRef ref, String phone) async {
    final clean = phone.replaceAll(RegExp(r'[^\d+]'), '');
    final uri = Uri.parse('tel:$clean');
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri);
      } else {
        ref
            .read(toastProvider.notifier)
            .error('Không thể thực hiện cuộc gọi đến số $phone');
      }
    } catch (err) {
      ref
          .read(toastProvider.notifier)
          .error(extractErrorMessage(err, 'Lỗi khi gọi điện.'));
    }
  }

  Future<void> _sendEmail(WidgetRef ref, String email) async {
    final uri = Uri.parse('mailto:$email');
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri);
      } else {
        ref
            .read(toastProvider.notifier)
            .error('Không thể mở ứng dụng email cho $email');
      }
    } catch (err) {
      ref
          .read(toastProvider.notifier)
          .error(extractErrorMessage(err, 'Lỗi khi gửi email.'));
    }
  }

  void _copyToClipboard(WidgetRef ref, String text) {
    Clipboard.setData(ClipboardData(text: text));
    ref.read(toastProvider.notifier).info('Đã sao chép: $text');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ov = overview ?? const {};
    final contract = ov['active_contract'] is Map
        ? ov['active_contract'] as Map
        : (ov['contract'] is Map ? ov['contract'] as Map : const {});
    final reservations = ov['reservations'];
    final reservation = reservations is List &&
            reservations.isNotEmpty &&
            reservations.first is Map
        ? reservations.first as Map
        : (ov['reservation'] is Map ? ov['reservation'] as Map : const {});
    final onboardingApp = ov['onboarding_application'] is Map
        ? ov['onboarding_application'] as Map
        : (ov['pending_application'] is Map
            ? ov['pending_application'] as Map
            : const {});

    final rawManager = {
      ...(ov['manager_contact'] is Map
          ? ov['manager_contact'] as Map
          : const {}),
      ...(ov['building_manager'] is Map
          ? ov['building_manager'] as Map
          : const {}),
    };

    final rawContactConfig = {
      ...(ov['manager_contact'] is Map
          ? ov['manager_contact'] as Map
          : const {}),
      ...(ov['contact_config'] is Map ? ov['contact_config'] as Map : const {}),
    };

    final managerName =
        rawManager['full_name']?.toString() ?? 'Ban Quản Lý Tòa Nhà ResiHub';
    final managerPhone = rawManager['phone']?.toString() ?? '0901 234 567';
    final managerEmail =
        rawManager['email']?.toString() ?? 'manager@resihub.vn';
    final buildingName = rawManager['building_name']?.toString() ??
        contract['building_name']?.toString() ??
        reservation['building_name']?.toString() ??
        onboardingApp['desired_building_name']?.toString() ??
        'Hệ thống Căn hộ Dịch vụ ResiHub';
    final buildingAddress = rawManager['building_address']?.toString() ??
        contract['building_address']?.toString() ??
        reservation['building_address']?.toString() ??
        onboardingApp['desired_building_address']?.toString() ??
        'Văn phòng Ban Quản Lý tại sảnh tầng 1 tòa nhà';

    final workingHours = rawContactConfig['working_hours']?.toString() ??
        '08:00 – 18:00 (Thứ 2 – Thứ 7)';
    final technicalHotline =
        rawContactConfig['technical_hotline']?.toString() ?? '1900 6868';
    final securityHotline =
        rawContactConfig['security_hotline']?.toString() ?? '1900 9119';
    final emergencyPhone =
        rawContactConfig['emergency_phone']?.toString() ?? '0909 113 114';
    final supportEmail =
        rawContactConfig['support_email']?.toString() ?? 'support@resihub.vn';

    return RefreshIndicator(
      onRefresh: onRefreshOverview,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Manager hero card
            _buildHeroCard(
              managerName: managerName,
              managerPhone: managerPhone,
              managerEmail: managerEmail,
              buildingName: buildingName,
              buildingAddress: buildingAddress,
              workingHours: workingHours,
              onCall: () => _makePhoneCall(ref, managerPhone),
              onEmail: () => _sendEmail(ref, managerEmail),
            ),
            const SizedBox(height: 16),

            // Hotline cards — 1 column on narrow screens, 2 on wide (React grid-cols-1 md:grid-cols-2)
            LayoutBuilder(
              builder: (context, constraints) {
                const gap = 16.0;
                final cardWidth = constraints.maxWidth >= 720
                    ? (constraints.maxWidth - gap) / 2
                    : constraints.maxWidth;
                return Wrap(
                  spacing: gap,
                  runSpacing: gap,
                  children: [
                    SizedBox(
                      width: cardWidth,
                      child: _buildHotlineCard(
                        ref: ref,
                        icon: LucideIcons.wrench,
                        color: AppColors.amber600,
                        background: AppColors.amber50,
                        badge: 'Kỹ thuật',
                        badgeVariant: AppBadgeVariant.amber,
                        title: 'Hotline Kỹ thuật Tòa nhà',
                        copy: 'Sự cố điện, nước, điều hòa, thang máy, internet',
                        value: technicalHotline,
                        copyTooltip: 'Sao chép số',
                        actionLabel: 'Gọi ngay',
                        actionIcon: LucideIcons.phoneCall,
                        onAction: () => _makePhoneCall(ref, technicalHotline),
                        footer: Row(
                          children: [
                            const Expanded(
                              child: Text(
                                'Hoặc gửi phiếu kèm ảnh sự cố',
                                style: TextStyle(
                                    fontSize: 11, color: AppColors.slate500),
                              ),
                            ),
                            const SizedBox(width: 8),
                            AppButton(
                              text: 'Mở mục Báo hỏng →',
                              size: AppButtonSize.xs,
                              variant: AppButtonVariant.ghost,
                              onPressed: () => onNavigateTab(
                                  'maintenance', {'action': 'new'}),
                            ),
                          ],
                        ),
                      ),
                    ),
                    SizedBox(
                      width: cardWidth,
                      child: _buildHotlineCard(
                        ref: ref,
                        icon: LucideIcons.shieldAlert,
                        color: AppColors.secondary600,
                        background: AppColors.secondary50,
                        badge: 'Trực 24/7',
                        badgeVariant: AppBadgeVariant.indigo,
                        title: 'Hotline An ninh & Bảo vệ',
                        copy:
                            'Trực chốt sảnh, hầm gửi xe, kiểm soát ra vào & thẻ từ',
                        value: securityHotline,
                        copyTooltip: 'Sao chép số',
                        actionLabel: 'Gọi ngay',
                        actionIcon: LucideIcons.phoneCall,
                        onAction: () => _makePhoneCall(ref, securityHotline),
                        footer: const Text(
                          'Hỗ trợ mở khóa khẩn cấp, đăng ký khách thăm và đảm bảo trật tự khu căn hộ 24/24.',
                          style: TextStyle(
                              fontSize: 11, color: AppColors.slate500),
                        ),
                      ),
                    ),
                    SizedBox(
                      width: cardWidth,
                      child: _buildHotlineCard(
                        ref: ref,
                        icon: LucideIcons.siren,
                        color: AppColors.rose600,
                        background: AppColors.rose100,
                        badge: 'Khẩn cấp 24/7',
                        badgeVariant: AppBadgeVariant.red,
                        title: 'Đường dây Khẩn cấp (SOS / PCCC)',
                        copy:
                            'Sự cố cháy nổ, y tế khẩn cấp, an toàn tính mạng & tài sản',
                        value: emergencyPhone,
                        copyTooltip: 'Sao chép số',
                        actionLabel: 'Gọi SOS',
                        actionIcon: LucideIcons.phoneCall,
                        onAction: () => _makePhoneCall(ref, emergencyPhone),
                        danger: true,
                        footer: const Wrap(
                          children: [
                            Text('Số khẩn cấp quốc gia: ',
                                style: TextStyle(
                                    fontSize: 11, color: AppColors.rose700)),
                            Text('113',
                                style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.bold,
                                    color: AppColors.rose700)),
                            Text(' (Công an) • ',
                                style: TextStyle(
                                    fontSize: 11, color: AppColors.rose700)),
                            Text('114',
                                style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.bold,
                                    color: AppColors.rose700)),
                            Text(' (Cứu hỏa) • ',
                                style: TextStyle(
                                    fontSize: 11, color: AppColors.rose700)),
                            Text('115',
                                style: TextStyle(
                                    fontSize: 11,
                                    fontWeight: FontWeight.bold,
                                    color: AppColors.rose700)),
                            Text(' (Cấp cứu)',
                                style: TextStyle(
                                    fontSize: 11, color: AppColors.rose700)),
                          ],
                        ),
                      ),
                    ),
                    SizedBox(
                      width: cardWidth,
                      child: _buildHotlineCard(
                        ref: ref,
                        icon: LucideIcons.headphones,
                        color: AppColors.emerald600,
                        background: AppColors.emerald50,
                        badge: 'CSKH',
                        badgeVariant: AppBadgeVariant.emerald,
                        title: 'Chăm sóc Cư dân & Email Hỗ trợ',
                        copy:
                            'Giải đáp hóa đơn, thủ tục hợp đồng, đăng ký tạm trú & góp ý dịch vụ',
                        value: supportEmail,
                        copyTooltip: 'Sao chép email',
                        actionLabel: 'Gửi Email',
                        actionIcon: LucideIcons.mail,
                        onAction: () => _sendEmail(ref, supportEmail),
                        footer: Row(
                          children: [
                            const Icon(LucideIcons.clock,
                                size: 14, color: AppColors.slate400),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(
                                'Giờ hành chính: $workingHours',
                                style: const TextStyle(
                                    fontSize: 11, color: AppColors.slate500),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ],
                );
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildHeroCard({
    required String managerName,
    required String managerPhone,
    required String managerEmail,
    required String buildingName,
    required String buildingAddress,
    required String workingHours,
    required VoidCallback onCall,
    required VoidCallback onEmail,
  }) {
    return Container(
      decoration: BoxDecoration(
        gradient: const LinearGradient(
          colors: [AppColors.primary600, AppColors.secondary600],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(20),
        boxShadow: const [AppColors.elevatedShadow],
      ),
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 52,
                height: 52,
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: 0.2),
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Center(
                  child: Text(
                    managerName.isNotEmpty
                        ? managerName.substring(0, 1).toUpperCase()
                        : 'M',
                    style: const TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.bold,
                        color: Colors.white),
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(
                          horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: 0.2),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(LucideIcons.userCheck,
                              size: 12, color: Colors.white),
                          SizedBox(width: 4),
                          Flexible(
                            child: Text(
                              'Quản lý tòa nhà phụ trách trực tiếp',
                              style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w600,
                                  color: Colors.white),
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      managerName,
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 18,
                        fontWeight: FontWeight.bold,
                        color: Colors.white,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Row(
                      children: [
                        const Icon(LucideIcons.building2,
                            size: 14, color: AppColors.sky200),
                        const SizedBox(width: 4),
                        Expanded(
                          child: Text(
                            buildingName,
                            style: const TextStyle(
                                fontSize: 12, color: Color(0xFFE2E8F0)),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Row(
                      children: [
                        const Icon(LucideIcons.mapPin,
                            size: 14, color: AppColors.sky200),
                        const SizedBox(width: 4),
                        Expanded(
                          child: Text(
                            buildingAddress,
                            style: const TextStyle(
                                fontSize: 11, color: Color(0xFFE2E8F0)),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          const Divider(color: Colors.white24, height: 1),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: AppButton(
                  text: 'Gọi Quản lý: $managerPhone',
                  size: AppButtonSize.sm,
                  icon: const Icon(LucideIcons.phoneCall, size: 14),
                  onPressed: onCall,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: AppButton(
                  text: managerEmail,
                  size: AppButtonSize.sm,
                  variant: AppButtonVariant.outline,
                  icon: const Icon(LucideIcons.mail, size: 14),
                  onPressed: onEmail,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          const Divider(color: Colors.white24, height: 1),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Icon(LucideIcons.clock, size: 14, color: AppColors.sky200),
              const SizedBox(width: 6),
              Expanded(
                child: Wrap(
                  children: [
                    const Text('Giờ làm việc Văn phòng BQL: ',
                        style:
                            TextStyle(fontSize: 11, color: Color(0xFFE2E8F0))),
                    Text(
                      workingHours,
                      style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.bold,
                          color: Colors.white),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          const Text(
            'Tiếp nhận hỗ trợ cư dân trực tiếp tại Quầy lễ tân Sảnh chính',
            style: TextStyle(fontSize: 11, color: Color(0xFFE2E8F0)),
          ),
        ],
      ),
    );
  }

  Widget _buildHotlineCard({
    required WidgetRef ref,
    required IconData icon,
    required Color color,
    required Color background,
    required String badge,
    required AppBadgeVariant badgeVariant,
    required String title,
    required String copy,
    required String value,
    required String copyTooltip,
    required String actionLabel,
    required IconData actionIcon,
    required VoidCallback onAction,
    required Widget footer,
    bool danger = false,
  }) {
    return AppCard(
      padding: const EdgeInsets.all(16),
      color: danger ? AppColors.rose50 : Colors.white,
      border: Border.all(color: danger ? AppColors.rose200 : AppColors.border),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  color: background,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Icon(icon, size: 20, color: color),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 13,
                        fontWeight: FontWeight.bold,
                        color: danger ? AppColors.rose800 : AppColors.slate900,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      copy,
                      style: TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 11,
                        color: danger ? AppColors.rose700 : AppColors.slate500,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              AppBadge(
                label: badge,
                variant: badgeVariant,
                dot: badge == 'Trực 24/7' || badge == 'Khẩn cấp 24/7',
              ),
            ],
          ),
          const SizedBox(height: 14),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: danger ? Colors.white : AppColors.slate50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                  color: danger ? AppColors.rose200 : AppColors.slate200),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    value,
                    style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 15,
                      fontWeight: FontWeight.bold,
                      color: danger ? AppColors.rose600 : AppColors.slate900,
                    ),
                  ),
                ),
                IconButton(
                  icon: const Icon(LucideIcons.copy,
                      size: 16, color: AppColors.slate500),
                  tooltip: copyTooltip,
                  onPressed: () => _copyToClipboard(ref, value),
                ),
                AppButton(
                  text: actionLabel,
                  size: AppButtonSize.sm,
                  variant: danger
                      ? AppButtonVariant.danger
                      : AppButtonVariant.primary,
                  icon: Icon(actionIcon, size: 14),
                  onPressed: onAction,
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          const Divider(height: 1, color: AppColors.slate100),
          const SizedBox(height: 10),
          footer,
        ],
      ),
    );
  }
}
