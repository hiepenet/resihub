import 'package:flutter/material.dart';

import '../../../shared/widgets/common/page_header.dart';
import '../widgets/audit_logs_view.dart';

/// Standalone Audit Logs Page.
/// Root widget has `key: const Key('route:/admin/audit-logs')` for route testing.
class AuditLogsPage extends StatelessWidget {
  const AuditLogsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      key: Key('route:/admin/audit-logs'),
      body: SingleChildScrollView(
        padding: EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            PageHeader(
              title: 'Nhật ký Kiểm toán Hệ thống (Audit Logs)',
              subtitle: 'Truy vết bất biến toàn bộ thao tác nghiệp vụ, cảnh báo tự phê duyệt (SELF_APPROVAL_WARNING) và truy cập bị từ chối (ACCESS_DENIED).',
            ),
            SizedBox(height: 16),
            AuditLogsView(),
          ],
        ),
      ),
    );
  }
}
