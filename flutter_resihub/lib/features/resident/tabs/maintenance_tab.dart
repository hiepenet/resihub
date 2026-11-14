import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../services/resident_service.dart';

class MaintenanceTab extends ConsumerStatefulWidget {
  final Map<String, dynamic>? overview;
  final Future<void> Function() onRefreshOverview;
  final void Function(String tab, [Map<String, dynamic>? extra]) onNavigateTab;
  final void Function(List<dynamic> rows)? onRequestsChanged;
  final String? actionParam;
  final VoidCallback? onClearActionParam;

  const MaintenanceTab({
    super.key,
    required this.overview,
    required this.onRefreshOverview,
    required this.onNavigateTab,
    this.onRequestsChanged,
    this.actionParam,
    this.onClearActionParam,
  });

  @override
  ConsumerState<MaintenanceTab> createState() => _MaintenanceTabState();
}

class _MaintenanceTabState extends ConsumerState<MaintenanceTab> {
  bool _loading = false;
  List<dynamic> _requests = [];

  @override
  void initState() {
    super.initState();
    _fetchRequests();
    if (widget.actionParam == 'create') {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        _openCreateModal(context);
        widget.onClearActionParam?.call();
      });
    }
  }

  @override
  void didUpdateWidget(covariant MaintenanceTab oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldCid = oldWidget.overview?['active_contract']?['contract_id'];
    final newCid = widget.overview?['active_contract']?['contract_id'];
    if (oldCid != newCid) {
      _fetchRequests();
    }
  }

  String? get _contractId {
    final c = widget.overview?['active_contract'] ?? widget.overview?['contract'];
    return c?['contract_id']?.toString() ?? c?['id']?.toString();
  }

  Future<void> _fetchRequests() async {
    setState(() => _loading = true);
    try {
      final res = await ref.read(residentServiceProvider).listServiceRequests(_contractId);
      final list = res is Map && res['data'] is List
          ? res['data'] as List
          : (res is List ? res : []);

      if (mounted) {
        setState(() {
          _requests = list;
          _loading = false;
        });
        widget.onRequestsChanged?.call(list);
      }
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref
            .read(toastProvider.notifier)
            .error(extractErrorMessage(err, 'Không thể tải danh sách sự cố & yêu cầu.'));
      }
    }
  }

  void _openCreateModal(BuildContext context) {
    final cid = _contractId;
    final titleCtrl = TextEditingController();
    final descCtrl = TextEditingController();
    String category = 'ELECTRICITY';
    String priority = 'NORMAL';
    List<String> photos = [];
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Tạo yêu cầu sửa chữa / Báo sự cố',
      subtitle: 'Kỹ thuật viên sẽ tiếp nhận và liên hệ kiểm tra trong vòng 2-4 giờ.',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AppInput(
                  label: 'Tiêu đề sự cố *',
                  controller: titleCtrl,
                  hint: 'Ví dụ: Điều hòa phòng ngủ chảy nước...',
                ),
                const SizedBox(height: 12),
                AppSelect<String>(
                  label: 'Hạng mục sự cố',
                  value: category,
                  options: const [
                    AppSelectOption(value: 'ELECTRICITY', label: 'Hệ thống Điện & Chiếu sáng'),
                    AppSelectOption(value: 'WATER', label: 'Hệ thống Nước & Vệ sinh'),
                    AppSelectOption(value: 'APPLIANCE', label: 'Thiết bị gia dụng (Tủ lạnh, Máy giặt...)'),
                    AppSelectOption(value: 'FURNITURE', label: 'Nội thất, Khóa cửa & Cửa kính'),
                    AppSelectOption(value: 'OTHER', label: 'Hạng mục khác'),
                  ],
                  onChanged: (val) {
                    if (val != null) setModalState(() => category = val);
                  },
                ),
                const SizedBox(height: 12),
                AppSelect<String>(
                  label: 'Mức độ khẩn cấp',
                  value: priority,
                  options: const [
                    AppSelectOption(value: 'LOW', label: 'Bình thường (1-2 ngày)'),
                    AppSelectOption(value: 'NORMAL', label: 'Cần sớm (Trong ngày)'),
                    AppSelectOption(value: 'URGENT', label: 'Khẩn cấp (Ngay lập tức)'),
                  ],
                  onChanged: (val) {
                    if (val != null) setModalState(() => priority = val);
                  },
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Mô tả chi tiết *',
                  controller: descCtrl,
                  multiline: true,
                  rows: 4,
                  hint: 'Mô tả hiện tượng, vị trí cụ thể hoặc thời điểm phát sinh...',
                ),
                const SizedBox(height: 12),
                FileUploadField(
                  label: 'Ảnh chụp hiện trường / Video ngắn',
                  value: photos,
                  multiple: true,
                  onChanged: (val) {
                    setModalState(() {
                      if (val is List) {
                        photos = val.map((e) => e.toString()).toList();
                      } else if (val != null && val.toString().isNotEmpty) {
                        photos = [val.toString()];
                      } else {
                        photos = [];
                      }
                    });
                  },
                ),
                const SizedBox(height: 20),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    AppButton(
                      text: 'Hủy',
                      variant: AppButtonVariant.outline,
                      onPressed: submitting ? null : () => Navigator.of(ctx).pop(),
                    ),
                    const SizedBox(width: 8),
                    AppButton(
                      text: submitting ? 'Đang gửi...' : 'Gửi yêu cầu',
                      loading: submitting,
                      onPressed: submitting
                          ? null
                          : () async {
                              final title = titleCtrl.text.trim();
                              final desc = descCtrl.text.trim();
                              if (title.isEmpty || desc.isEmpty) {
                                ref
                                    .read(toastProvider.notifier)
                                    .error('Vui lòng điền tiêu đề và mô tả sự cố.');
                                return;
                              }

                              setModalState(() => submitting = true);
                              try {
                                await ref.read(residentServiceProvider).createServiceRequest({
                                  if (cid != null && cid.isNotEmpty) 'contract_id': cid,
                                  'title': title,
                                  'description': desc,
                                  'category': category,
                                  'priority': priority,
                                  if (photos.isNotEmpty) 'attachments': photos,
                                });
                                if (ctx.mounted) {
                                  Navigator.of(ctx).pop();
                                }
                                ref
                                    .read(toastProvider.notifier)
                                    .success('Đã gửi yêu cầu sự cố đến BQL.');
                                await _fetchRequests();
                              } catch (err) {
                                setModalState(() => submitting = false);
                                ref
                                    .read(toastProvider.notifier)
                                    .error(extractErrorMessage(err, 'Không thể gửi yêu cầu sự cố.'));
                              }
                            },
                    ),
                  ],
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  void _openCancelModal(BuildContext context, String reqId) {
    final reasonCtrl = TextEditingController();
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Hủy yêu cầu sự cố',
      subtitle: 'Xác nhận hủy yêu cầu nếu sự cố đã tự khắc phục.',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AppInput(
                label: 'Lý do hủy yêu cầu',
                controller: reasonCtrl,
                multiline: true,
                rows: 2,
                hint: 'Ví dụ: Thiết bị đã hoạt động lại bình thường...',
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed: submitting ? null : () => Navigator.of(ctx).pop(),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: submitting ? 'Đang hủy...' : 'Xác nhận hủy',
                    variant: AppButtonVariant.danger,
                    loading: submitting,
                    onPressed: submitting
                        ? null
                        : () async {
                            setModalState(() => submitting = true);
                            try {
                              await ref.read(residentServiceProvider).cancelServiceRequest(
                                reqId,
                                {'reason': reasonCtrl.text.trim()},
                              );
                              if (ctx.mounted) {
                                Navigator.of(ctx).pop();
                              }
                              ref.read(toastProvider.notifier).success('Đã hủy yêu cầu sự cố.');
                              await _fetchRequests();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(err, 'Không thể hủy yêu cầu.'),
                                  );
                            }
                          },
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  void _openReopenModal(BuildContext context, String reqId) {
    final reasonCtrl = TextEditingController();
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Mở lại yêu cầu sự cố',
      subtitle: 'Nếu sự cố tái phát hoặc chưa được xử lý dứt điểm.',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              AppInput(
                label: 'Lý do mở lại *',
                controller: reasonCtrl,
                multiline: true,
                rows: 3,
                hint: 'Mô tả tình trạng lỗi vẫn còn xuất hiện...',
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Hủy',
                    variant: AppButtonVariant.outline,
                    onPressed: submitting ? null : () => Navigator.of(ctx).pop(),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: submitting ? 'Đang gửi...' : 'Mở lại yêu cầu',
                    loading: submitting,
                    onPressed: submitting
                        ? null
                        : () async {
                            final r = reasonCtrl.text.trim();
                            if (r.isEmpty) {
                              ref.read(toastProvider.notifier).error('Vui lòng nhập lý do.');
                              return;
                            }

                            setModalState(() => submitting = true);
                            try {
                              await ref
                                  .read(residentServiceProvider)
                                  .reopenServiceRequest(reqId, {'reason': r});
                              if (ctx.mounted) {
                                Navigator.of(ctx).pop();
                              }
                              ref.read(toastProvider.notifier).success('Đã mở lại yêu cầu sự cố.');
                              await _fetchRequests();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(err, 'Không thể mở lại yêu cầu.'),
                                  );
                            }
                          },
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  void _openRatingModal(BuildContext context, String reqId) {
    int rating = 5;
    final feedbackCtrl = TextEditingController();
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Đánh giá chất lượng xử lý',
      subtitle: 'Ý kiến của bạn giúp BQL cải thiện chất lượng dịch vụ tòa nhà.',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Center(
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: List.generate(5, (index) {
                    final star = index + 1;
                    return IconButton(
                      icon: Icon(
                        star <= rating ? Icons.star : Icons.star_border,
                        color: Colors.amber,
                        size: 32,
                      ),
                      onPressed: () => setModalState(() => rating = star),
                    );
                  }),
                ),
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Nhận xét & Góp ý',
                controller: feedbackCtrl,
                multiline: true,
                rows: 3,
                hint: 'Thái độ kỹ thuật viên, độ nhanh chóng, sạch sẽ...',
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed: submitting ? null : () => Navigator.of(ctx).pop(),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: submitting ? 'Đang gửi...' : 'Gửi đánh giá',
                    loading: submitting,
                    onPressed: submitting
                        ? null
                        : () async {
                            setModalState(() => submitting = true);
                            try {
                              await ref.read(residentServiceProvider).rateServiceRequest(
                                reqId,
                                {
                                  'rating': rating,
                                  'feedback': feedbackCtrl.text.trim(),
                                },
                              );
                              if (ctx.mounted) {
                                Navigator.of(ctx).pop();
                              }
                              ref.read(toastProvider.notifier).success('Cảm ơn bạn đã đánh giá!');
                              await _fetchRequests();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(err, 'Không thể gửi đánh giá.'),
                                  );
                            }
                          },
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return RefreshIndicator(
      onRefresh: () async {
        await widget.onRefreshOverview();
        await _fetchRequests();
      },
      child: SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Yêu cầu kỹ thuật & Sự cố (${_requests.length})',
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 16,
                    fontWeight: FontWeight.bold,
                    color: AppColors.slate900,
                  ),
                ),
                AppButton(
                  text: 'Báo sự cố mới',
                  size: AppButtonSize.sm,
                  icon: const Icon(LucideIcons.plus, size: 14),
                  onPressed: () => _openCreateModal(context),
                ),
              ],
            ),
            const SizedBox(height: 16),
            if (_loading && _requests.isEmpty)
              const Center(child: CircularProgressIndicator())
            else if (_requests.isEmpty)
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(LucideIcons.wrench, size: 48, color: AppColors.slate400),
                      const SizedBox(height: 12),
                      const Text(
                        'Chưa có yêu cầu nào',
                        style: TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: AppColors.slate800,
                        ),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Nhấn "Báo sự cố mới" nếu thiết bị hoặc căn hộ cần sửa chữa.',
                        style: TextStyle(fontSize: 13, color: AppColors.slate500),
                      ),
                    ],
                  ),
                ),
              )
            else
              ..._requests.map((r) {
                final req = r is Map ? Map<String, dynamic>.from(r) : <String, dynamic>{};
                final id = req['id']?.toString() ?? req['request_id']?.toString() ?? '';
                final status = req['status']?.toString().toUpperCase() ?? 'NEW';
                final title = req['title']?.toString() ?? 'Yêu cầu';
                final desc = req['description']?.toString() ?? '';
                final createdAt = req['created_at'];

                final canCancel = status == 'NEW' || status == 'ASSIGNED';
                final canReopen = status == 'COMPLETED' || status == 'CLOSED';
                final canRate = status == 'COMPLETED' && req['rating'] == null;

                return Container(
                  margin: const EdgeInsets.only(bottom: 12),
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(14),
                    border: Border.all(color: AppColors.slate200),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Expanded(
                            child: Text(
                              title,
                              style: const TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 15,
                                fontWeight: FontWeight.bold,
                                color: AppColors.slate900,
                              ),
                            ),
                          ),
                          AppBadge(
                            label: status == 'NEW'
                                ? 'Mới'
                                : status == 'IN_PROGRESS'
                                    ? 'Đang sửa'
                                    : status == 'COMPLETED'
                                        ? 'Hoàn thành'
                                        : status == 'CANCELLED'
                                            ? 'Đã hủy'
                                            : status,
                            variant: status == 'COMPLETED'
                                ? AppBadgeVariant.emerald
                                : status == 'IN_PROGRESS'
                                    ? AppBadgeVariant.sky
                                    : AppBadgeVariant.slate,
                          ),
                        ],
                      ),
                      if (createdAt != null) ...[
                        const SizedBox(height: 4),
                        Text(
                          formatDateTime(createdAt),
                          style: const TextStyle(fontSize: 12, color: AppColors.slate400),
                        ),
                      ],
                      if (desc.isNotEmpty) ...[
                        const SizedBox(height: 8),
                        Text(
                          desc,
                          style: const TextStyle(fontSize: 13, color: AppColors.slate700),
                        ),
                      ],
                      const SizedBox(height: 12),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          if (canCancel) ...[
                            AppButton(
                              text: 'Hủy yêu cầu',
                              size: AppButtonSize.sm,
                              variant: AppButtonVariant.ghost,
                              onPressed: () => _openCancelModal(context, id),
                            ),
                          ],
                          if (canReopen) ...[
                            AppButton(
                              text: 'Mở lại yêu cầu',
                              size: AppButtonSize.sm,
                              variant: AppButtonVariant.outline,
                              onPressed: () => _openReopenModal(context, id),
                            ),
                          ],
                          if (canRate) ...[
                            const SizedBox(width: 8),
                            AppButton(
                              text: 'Đánh giá',
                              size: AppButtonSize.sm,
                              icon: const Icon(LucideIcons.star, size: 14),
                              onPressed: () => _openRatingModal(context, id),
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                );
              }),
          ],
        ),
      ),
    );
  }
}
