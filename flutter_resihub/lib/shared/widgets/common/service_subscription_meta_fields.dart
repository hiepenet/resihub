import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/utils/service_subscription_meta.dart';
import '../ui/app_badge.dart';
import '../ui/app_input.dart';

/// Form fields for service subscription metadata:
/// dynamic parking vehicle plate slots synced to quantity, and service note.
/// Port of `frontend/src/components/common/ServiceSubscriptionMetaFields.jsx`.
class ServiceSubscriptionMetaFields extends StatelessWidget {
  final bool isParking;
  final int quantity;
  final List<dynamic> vehiclePlates;
  final String note;
  final List<String> plateErrors;
  final String noteError;
  final void Function(int index, String value)? onPlateChange;
  final ValueChanged<String>? onNoteChange;
  final bool noteMultiline;
  final int noteRows;

  const ServiceSubscriptionMetaFields({
    super.key,
    this.isParking = false,
    this.quantity = 1,
    this.vehiclePlates = const [],
    this.note = '',
    this.plateErrors = const [],
    this.noteError = '',
    this.onPlateChange,
    this.onNoteChange,
    this.noteMultiline = false,
    this.noteRows = 2,
  });

  @override
  Widget build(BuildContext context) {
    final slots = isParking ? syncVehiclePlatesArray(vehiclePlates, quantity) : <String>[];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (isParking) ...[
          for (int i = 0; i < slots.length; i++) ...[
            Padding(
              padding: const EdgeInsets.only(bottom: 12.0),
              child: AppInput(
                key: ValueKey('plate_$i'),
                label: slots.length == 1 ? 'Biển số xe' : 'Biển số xe #${i + 1}',
                required: true,
                placeholder: 'VD: 59A1-123.45, Xe đạp #1 hoặc Chờ bấm biển',
                initialValue: slots[i],
                error: i < plateErrors.length ? plateErrors[i] : null,
                icon: const Icon(LucideIcons.car, size: 16),
                onChanged: (val) => onPlateChange?.call(i, val),
              ),
            ),
          ],
        ],
        AppInput(
          label: 'Ghi chú dịch vụ (tùy chọn)',
          placeholder: isParking
              ? 'VD: Loại xe tay ga, ô đỗ hầm B1, mã thẻ từ...'
              : 'VD: Khung giờ phục vụ, gói cước hoặc thỏa thuận riêng...',
          initialValue: note,
          multiline: noteMultiline,
          rows: noteRows,
          error: noteError.isNotEmpty ? noteError : null,
          onChanged: (val) => onNoteChange?.call(val),
        ),
      ],
    );
  }
}

/// Badges showing clean license plate numbers with car icons.
class VehiclePlatesBadges extends StatelessWidget {
  final List<dynamic>? plates;

  const VehiclePlatesBadges({
    super.key,
    this.plates,
  });

  @override
  Widget build(BuildContext context) {
    final cleanPlates = plates != null
        ? plates!
            .map((p) => p?.toString().trim() ?? '')
            .where((p) => p.isNotEmpty)
            .toList()
        : <String>[];

    if (cleanPlates.isEmpty) return const SizedBox.shrink();

    return Wrap(
      spacing: 6,
      runSpacing: 4,
      children: cleanPlates.map((plate) {
        return AppBadge(
          label: plate,
          variant: AppBadgeVariant.sky,
          icon: const Icon(LucideIcons.car, size: 12),
        );
      }).toList(),
    );
  }
}
