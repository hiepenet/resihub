import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
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
        ref.read(toastProvider.notifier).error('Không thể thực hiện cuộc gọi đến số $phone');
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Lỗi khi gọi điện.'));
    }
  }

  Future<void> _sendEmail(WidgetRef ref, String email) async {
    final uri = Uri.parse('mailto:$email');
    try {
      if (await canLaunchUrl(uri)) {
        await launchUrl(uri);
      } else {
        ref.read(toastProvider.notifier).error('Không thể mở ứng dụng email cho $email');
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Lỗi khi gửi email.'));
    }
  }

  void _copyToClipboard(WidgetRef ref, String text, String label) {
    Clipboard.setData(ClipboardData(text: text));
    ref.read(toastProvider.notifier).info('Đã sao chép $label: $text');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ov = overview ?? const {};
    final contract = ov['active_contract'] is Map
        ? ov['active_contract'] as Map
        : (ov['contract'] is Map ? ov['contract'] as Map : const {});

    final rawManager = {
      ...(ov['manager_contact'] is Map ? ov['manager_contact'] as Map : const {}),
      ...(ov['building_manager'] is Map ? ov['building_manager'] as Map : const {}),
    };

    final rawContactConfig = {
      ...(ov['manager_contact'] is Map ? ov['manager_contact'] as Map : const {}),
      ...(ov['contact_config'] is Map ? ov['contact_config'] as Map : const {}),
    };

    final managerName = rawManager['full_name']?.toString() ?? 'Ban Quản Lý Tòa Nhà ResiHub';
    final managerPhone = rawManager['phone']?.toString() ?? '0901234567';
    final managerEmail = rawManager['email']?.toString() ?? 'manager@resihub.vn';
    final buildingName = rawManager['building_name']?.toString() ??
        contract['building_name']?.toString() ??
        'Hệ thống Căn hộ Dịch vụ ResiHub';
    final buildingAddress = rawManager['building_address']?.toString() ??
        contract['building_address']?.toString() ??
        'Văn phòng Ban Quản Lý tại sảnh tầng 1 tòa nhà';

    final workingHours = rawContactConfig['working_hours']?.toString() ?? '08:00 – 18:00 (Thứ 2 – Thứ 7)';
    final technicalHotline = rawContactConfig['technical_hotline']?.toString() ?? '1900 6868';
    final securityHotline = rawContactConfig['security_hotline']?.toString() ?? '1900 9119';
    final emergencyPhone = rawContactConfig['emergency_phone']?.toString() ?? '0909 113 114';
    final supportEmail = rawContactConfig['support_email']?.toString() ?? 'support@resihub.vn';

    return RefreshIndicator(
      onRefresh: onRefreshOverview,
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Manager Hero Card
            Container(
              decoration: BoxDecoration(
                gradient: const LinearGradient(
                  colors: [AppColors.primary600, AppColors.secondary600],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.circular(20),
                boxShadow: const [
                  BoxShadow(
                    color: Color.fromRGBO(37, 99, 235, 0.2),
                    blurRadius: 16,
                    offset: Offset(0, 6),
                  ),
                ],
              ),
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
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
                            managerName.isNotEmpty ? managerName.substring(0, 1).toUpperCase() : 'M',
                            style: const TextStyle(
                              fontSize: 22,
                              fontWeight: FontWeight.bold,
                              color: Colors.white,
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: Colors.white.withValues(alpha: 0.2),
                                borderRadius: BorderRadius.circular(10),
                              ),
                              child: const Text(
                                'Quản lý tòa nhà trực tiếp',
                                style: TextStyle(fontSize: 11, color: Colors.white),
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              managerName,
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 18,
                                fontWeight: FontWeight.bold,
                                color: Colors.white,
                              ),
                            ),
                            const SizedBox(height: 2),
                            Text(
                              buildingName,
                              style: const TextStyle(fontSize: 13, color: Color(0xFFE2E8F0)),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 16),
                  const Divider(color: Colors.white24, height: 1),
                  const SizedBox(height: 14),
                  Row(
                    children: [
                      Expanded(
                        child: AppButton(
                          text: 'Gọi điện',
                          size: AppButtonSize.sm,
                          icon: const Icon(LucideIcons.phone, size: 14),
                          onPressed: () => _makePhoneCall(ref, managerPhone),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: AppButton(
                          text: 'Gửi Email',
                          size: AppButtonSize.sm,
                          variant: AppButtonVariant.outline,
                          icon: const Icon(LucideIcons.mail, size: 14),
                          onPressed: () => _sendEmail(ref, managerEmail),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Hotline Directory
            AppCard(
              header: const AppCardHeader(title: 'Đường dây nóng & Hỗ trợ kỹ thuật 24/7'),
              child: Column(
                children: [
                  _buildContactRow(
                    ref: ref,
                    icon: LucideIcons.phoneCall,
                    color: AppColors.primary600,
                    label: 'Hotline Kỹ thuật & Sự cố điện nước',
                    value: technicalHotline,
                    onCall: () => _makePhoneCall(ref, technicalHotline),
                  ),
                  const Divider(color: AppColors.slate100, height: 1),
                  _buildContactRow(
                    ref: ref,
                    icon: LucideIcons.shieldAlert,
                    color: AppColors.rose600,
                    label: 'Đội Bảo vệ & An ninh tòa nhà',
                    value: securityHotline,
                    onCall: () => _makePhoneCall(ref, securityHotline),
                  ),
                  const Divider(color: AppColors.slate100, height: 1),
                  _buildContactRow(
                    ref: ref,
                    icon: LucideIcons.siren,
                    color: Colors.amber.shade700,
                    label: 'Cứu hộ khẩn cấp 24/7',
                    value: emergencyPhone,
                    onCall: () => _makePhoneCall(ref, emergencyPhone),
                  ),
                  const Divider(color: AppColors.slate100, height: 1),
                  _buildContactRow(
                    ref: ref,
                    icon: LucideIcons.mail,
                    color: AppColors.secondary600,
                    label: 'Hòm thư tiếp nhận ý kiến',
                    value: supportEmail,
                    onCall: () => _sendEmail(ref, supportEmail),
                  ),
                  const Divider(color: AppColors.slate100, height: 1),
                  _buildContactRow(
                    ref: ref,
                    icon: LucideIcons.clock,
                    color: AppColors.slate600,
                    label: 'Thời gian làm việc văn phòng BQL',
                    value: workingHours,
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Building Address Info
            AppCard(
              header: const AppCardHeader(title: 'Địa chỉ ban quản lý'),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(LucideIcons.mapPin, size: 20, color: AppColors.primary600),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          buildingName,
                          style: const TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 14,
                            fontWeight: FontWeight.bold,
                            color: AppColors.slate900,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          buildingAddress,
                          style: const TextStyle(fontSize: 13, color: AppColors.slate600),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildContactRow({
    required WidgetRef ref,
    required IconData icon,
    required Color color,
    required String label,
    required String value,
    VoidCallback? onCall,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.1),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, size: 18, color: color),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12,
                    color: AppColors.slate500,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  value,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 14,
                    fontWeight: FontWeight.bold,
                    color: AppColors.slate900,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(LucideIcons.copy, size: 16, color: AppColors.slate400),
            tooltip: 'Sao chép',
            onPressed: () => _copyToClipboard(ref, value, label),
          ),
          if (onCall != null) ...[
            IconButton(
              icon: Icon(
                icon == LucideIcons.mail ? LucideIcons.send : LucideIcons.phone,
                size: 16,
                color: color,
              ),
              tooltip: icon == LucideIcons.mail ? 'Gửi email' : 'Gọi ngay',
              onPressed: onCall,
            ),
          ],
        ],
      ),
    );
  }
}
