import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../ui/app_button.dart';
import '../ui/app_input.dart';
import '../ui/app_modal.dart';

enum ConfirmDialogVariant {
  danger,
  primary,
  warning;

  static ConfirmDialogVariant fromString(String? v) {
    return switch (v?.toLowerCase()) {
      'primary' => ConfirmDialogVariant.primary,
      'warning' => ConfirmDialogVariant.warning,
      _ => ConfirmDialogVariant.danger,
    };
  }
}

/// Confirmation dialog with danger/warning/primary variants, static show helper,
/// and optional reason input field.
/// Port of `frontend/src/components/common/ConfirmDialog.jsx`.
class ConfirmDialog extends StatefulWidget {
  final String title;
  final String message;
  final String confirmLabel;
  final String cancelLabel;
  final ConfirmDialogVariant variant;
  final bool loading;
  final VoidCallback? onConfirm;
  final VoidCallback? onClose;
  final bool showReasonInput;
  final String? reasonLabel;
  final String? reasonHint;
  final void Function(String reason)? onConfirmWithReason;

  const ConfirmDialog({
    super.key,
    this.title = 'Xác nhận thao tác',
    required this.message,
    this.confirmLabel = 'Xác nhận',
    this.cancelLabel = 'Hủy bỏ',
    this.variant = ConfirmDialogVariant.danger,
    this.loading = false,
    this.onConfirm,
    this.onClose,
    this.showReasonInput = false,
    this.reasonLabel,
    this.reasonHint,
    this.onConfirmWithReason,
  });

  /// Displays the confirmation dialog modally and returns true if confirmed.
  static Future<bool?> show({
    required BuildContext context,
    String title = 'Xác nhận thao tác',
    required String message,
    String confirmLabel = 'Xác nhận',
    String cancelLabel = 'Hủy bỏ',
    ConfirmDialogVariant variant = ConfirmDialogVariant.danger,
    bool showReasonInput = false,
    String? reasonLabel,
    String? reasonHint,
    void Function(String reason)? onConfirmWithReason,
  }) {
    return showDialog<bool>(
      context: context,
      builder: (ctx) {
        return ConfirmDialog(
          title: title,
          message: message,
          confirmLabel: confirmLabel,
          cancelLabel: cancelLabel,
          variant: variant,
          showReasonInput: showReasonInput,
          reasonLabel: reasonLabel,
          reasonHint: reasonHint,
          onClose: () => Navigator.of(ctx).pop(false),
          onConfirm: () => Navigator.of(ctx).pop(true),
          onConfirmWithReason: onConfirmWithReason != null
              ? (reason) {
                  onConfirmWithReason(reason);
                  Navigator.of(ctx).pop(true);
                }
              : null,
        );
      },
    );
  }

  @override
  State<ConfirmDialog> createState() => _ConfirmDialogState();
}

class _ConfirmDialogState extends State<ConfirmDialog> {
  final TextEditingController _reasonController = TextEditingController();

  @override
  void dispose() {
    _reasonController.dispose();
    super.dispose();
  }

  AppButtonVariant _buttonVariant() {
    return switch (widget.variant) {
      ConfirmDialogVariant.primary => AppButtonVariant.primary,
      ConfirmDialogVariant.warning => AppButtonVariant.primary,
      ConfirmDialogVariant.danger => AppButtonVariant.danger,
    };
  }

  @override
  Widget build(BuildContext context) {
    final isDanger = widget.variant == ConfirmDialogVariant.danger;
    final iconBg = isDanger ? const Color(0xFFFFF1F2) : const Color(0xFFFFFBEB);
    final iconColor = isDanger ? const Color(0xFFE11D48) : const Color(0xFFD97706);

    return AppModal(
      title: widget.title,
      size: AppModalSize.sm,
      onClose: widget.onClose,
      footer: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          AppButton(
            text: widget.cancelLabel,
            variant: AppButtonVariant.outline,
            onPressed: widget.loading ? null : widget.onClose,
          ),
          const SizedBox(width: 8),
          AppButton(
            text: widget.confirmLabel,
            variant: _buttonVariant(),
            loading: widget.loading,
            onPressed: () {
              if (widget.showReasonInput && widget.onConfirmWithReason != null) {
                widget.onConfirmWithReason!(_reasonController.text.trim());
              } else if (widget.onConfirm != null) {
                widget.onConfirm!();
              }
            },
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 40,
                height: 40,
                decoration: BoxDecoration(
                  color: iconBg,
                  shape: BoxShape.circle,
                ),
                child: Icon(
                  LucideIcons.triangleAlert,
                  size: 20,
                  color: iconColor,
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(top: 2.0),
                  child: Text(
                    widget.message,
                    style: const TextStyle(
                      fontSize: 14,
                      color: AppColors.slate600,
                      height: 1.5,
                    ),
                  ),
                ),
              ),
            ],
          ),
          if (widget.showReasonInput) ...[
            const SizedBox(height: 16),
            AppInput(
              controller: _reasonController,
              label: widget.reasonLabel ?? 'Lý do / Ghi chú',
              placeholder: widget.reasonHint ?? 'Nhập lý do thực hiện...',
              multiline: true,
              rows: 2,
            ),
          ],
        ],
      ),
    );
  }
}
