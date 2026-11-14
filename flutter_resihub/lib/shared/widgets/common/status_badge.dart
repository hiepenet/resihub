import 'package:flutter/material.dart';

import '../../../core/constants/statuses.dart';
import '../ui/app_badge.dart';

/// Renders a domain status code with its standardized localized label,
/// color variant, and optional dot indicator.
/// Port of `frontend/src/components/common/StatusBadge.jsx`.
class StatusBadge extends StatelessWidget {
  final String? status;
  final StatusDomain domain;
  final bool dot;

  const StatusBadge({
    super.key,
    required this.status,
    this.domain = StatusDomain.contract,
    this.dot = true,
  });

  @override
  Widget build(BuildContext context) {
    if (status == null || status!.trim().isEmpty) {
      return AppBadge(
        label: '—',
        variant: AppBadgeVariant.slate,
        dot: dot,
      );
    }

    final meta = resolveStatusMeta(domain, status);
    final variant = AppBadgeVariant.fromString(meta.variant);

    return AppBadge(
      label: meta.label,
      variant: variant,
      dot: dot,
      customTextColor: meta.color,
      customBgColor: meta.bgColor,
      customBorderColor: meta.borderColor,
      customDotColor: meta.dotColor,
    );
  }
}
