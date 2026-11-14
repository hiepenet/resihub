import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/vietqr_banks.dart';
import '../../../features/buildings/services/buildings_service.dart';
import '../ui/app_select.dart';

/// Dropdown selector for standard VietQR banking partners.
/// Displays bank logos, short names, full bank names, and BIN codes with instant fuzzy search.
/// Port of `frontend/src/components/common/BankSelect.jsx`.
class BankSelect extends ConsumerStatefulWidget {
  final String label;
  final String value;
  final Map<String, dynamic>? bankMeta;
  final void Function(String nextVal, Map<String, dynamic>? bank)? onBankChange;
  final ValueChanged<String?>? onChanged;
  final String? placeholder;
  final String searchPlaceholder;
  final bool required;
  final bool disabled;
  final String? error;
  final String? hint;

  const BankSelect({
    super.key,
    this.label = 'Ngân hàng (VietQR)',
    this.value = '',
    this.bankMeta,
    this.onBankChange,
    this.onChanged,
    this.placeholder,
    this.searchPlaceholder = 'Tìm tên NH, mã VCB, TCB, MB, mã BIN...',
    this.required = false,
    this.disabled = false,
    this.error,
    this.hint,
  });

  @override
  ConsumerState<BankSelect> createState() => _BankSelectState();
}

class _BankSelectState extends ConsumerState<BankSelect> {
  List<dynamic> _banks = kFallbackVietQrBanks;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _loadBanks();
  }

  Future<void> _loadBanks() async {
    setState(() => _loading = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.listBanks();
      if (mounted) {
        if (res is Map && res['data'] is List && (res['data'] as List).isNotEmpty) {
          setState(() {
            _banks = res['data'] as List;
            _loading = false;
          });
          return;
        } else if (res is List && res.isNotEmpty) {
          setState(() {
            _banks = res;
            _loading = false;
          });
          return;
        }
      }
    } catch (_) {
      // Use fallback
    }
    if (mounted) {
      setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final matched = matchVietQrBank(_banks, {
      'bank_name': widget.value,
      'bank_code': widget.bankMeta?['bank_code'] ?? '',
      'bank_bin': widget.bankMeta?['bank_bin'] ?? '',
    });

    final resolvedValue = matched != null
        ? (matched['shortName'] ?? matched['short_name'] ?? widget.value).toString()
        : widget.value;

    final rawOptions = buildVietQrBankOptions(_banks, {
      'bank_name': widget.value,
      'bank_code': widget.bankMeta?['bank_code'] ?? '',
      'bank_bin': widget.bankMeta?['bank_bin'] ?? '',
      'bank_logo': widget.bankMeta?['bank_logo'] ?? '',
    });

    final options = rawOptions.map((o) {
      return AppSelectOption<String>(
        value: o['value']?.toString() ?? '',
        label: o['label']?.toString() ?? '',
        sublabel: o['sublabel']?.toString(),
        badge: o['badge']?.toString(),
        logo: o['logo']?.toString(),
      );
    }).toList();

    final placeholderText = widget.placeholder ??
        (_loading && options.isEmpty ? 'Đang tải ngân hàng VietQR...' : '-- Chọn ngân hàng --');

    return AppSelect<String>(
      label: widget.label,
      placeholder: placeholderText,
      value: resolvedValue.isNotEmpty ? resolvedValue : null,
      options: options,
      required: widget.required,
      disabled: widget.disabled,
      searchable: true,
      searchPlaceholder: widget.searchPlaceholder,
      emptyText: 'Không tìm thấy ngân hàng phù hợp trong danh mục VietQR',
      error: widget.error,
      hint: widget.hint,
      icon: const Icon(LucideIcons.landmark, size: 18, color: AppColors.slate400),
      onChanged: (val) {
        widget.onChanged?.call(val);
        if (widget.onBankChange != null && val != null) {
          final matchedRaw = rawOptions.firstWhere(
            (o) => o['value'] == val,
            orElse: () => const {},
          );
          final chosenBank = matchedRaw['bank'] is Map
              ? Map<String, dynamic>.from(matchedRaw['bank'] as Map)
              : null;
          widget.onBankChange!(val, chosenBank);
        }
      },
    );
  }
}
