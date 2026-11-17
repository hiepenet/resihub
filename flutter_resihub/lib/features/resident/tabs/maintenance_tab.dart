import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../core/utils/zalo_format.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/app_tabs.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../services/resident_service.dart';

const _kOpenStatuses = {
  'NEW',
  'ASSIGNED',
  'IN_PROGRESS',
  'ON_HOLD',
  'REOPENED'
};
const _kDoneStatuses = {'RESOLVED', 'CLOSED'};

const _kCategoryOptions = <AppSelectOption<String>>[
  AppSelectOption(
      value: 'ELECTRICAL', label: 'Điện chiếu sáng / Ổ cắm (ELECTRICAL)'),
  AppSelectOption(
      value: 'PLUMBING', label: 'Cấp thoát nước / Vòi sen (PLUMBING)'),
  AppSelectOption(value: 'HVAC', label: 'Điều hòa / Thông gió (HVAC)'),
  AppSelectOption(value: 'FURNITURE', label: 'Nội thất căn hộ (FURNITURE)'),
  AppSelectOption(value: 'APPLIANCE', label: 'Thiết bị gia dụng (APPLIANCE)'),
  AppSelectOption(value: 'CLEANING', label: 'Vệ sinh môi trường (CLEANING)'),
  AppSelectOption(
      value: 'SECURITY', label: 'An ninh / Khóa cửa thẻ từ (SECURITY)'),
  AppSelectOption(value: 'OTHER', label: 'Hạng mục khác (OTHER)'),
];

const _kPriorityOptions = <AppSelectOption<String>>[
  AppSelectOption(value: 'LOW', label: 'Thấp — Không ảnh hưởng sinh hoạt'),
  AppSelectOption(
      value: 'NORMAL', label: 'Bình thường — Xử lý trong giờ hành chính'),
  AppSelectOption(value: 'HIGH', label: 'Cao — Ảnh hưởng sinh hoạt hàng ngày'),
  AppSelectOption(
      value: 'URGENT', label: 'Khẩn cấp — Mất điện/nước, rò rỉ nghiêm trọng'),
];

const _kSlotOptions = <AppSelectOption<String>>[
  AppSelectOption(value: 'ANYTIME', label: 'Linh hoạt cả ngày'),
  AppSelectOption(value: 'MORNING_08_12', label: 'Sáng (08:00 – 12:00)'),
  AppSelectOption(value: 'AFTERNOON_13_17', label: 'Chiều (13:00 – 17:00)'),
  AppSelectOption(value: 'EVENING_18_21', label: 'Tối (18:00 – 21:00)'),
];

const _kStarLabels = <int, String>{
  1: 'Rất không hài lòng',
  2: 'Chưa hài lòng',
  3: 'Bình thường',
  4: 'Hài lòng',
  5: 'Rất hài lòng — Tuyệt vời!',
};

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
  String _filterTab = 'all';
  String? _copiedCode;

  @override
  void initState() {
    super.initState();
    _fetchRequests();
    if (widget.actionParam == 'create' || widget.actionParam == 'new') {
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
    final c =
        widget.overview?['active_contract'] ?? widget.overview?['contract'];
    return c?['contract_id']?.toString() ?? c?['id']?.toString();
  }

  int get _reopenWindowDays {
    final raw = widget.overview?['sla_config']?['reopen_window_days'];
    return int.tryParse(raw?.toString() ?? '') ?? 3;
  }

  List<dynamic> get _filteredRequests {
    if (_filterTab == 'open') {
      return _requests
          .where((r) => _kOpenStatuses.contains(_statusOf(r)))
          .toList();
    }
    if (_filterTab == 'done') {
      return _requests
          .where((r) => _kDoneStatuses.contains(_statusOf(r)))
          .toList();
    }
    return _requests;
  }

  int get _openCount =>
      _requests.where((r) => _kOpenStatuses.contains(_statusOf(r))).length;
  int get _doneCount =>
      _requests.where((r) => _kDoneStatuses.contains(_statusOf(r))).length;

  Future<void> _fetchRequests() async {
    setState(() => _loading = true);
    try {
      final res = await ref
          .read(residentServiceProvider)
          .listServiceRequests(_contractId);
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
        ref.read(toastProvider.notifier).error(extractErrorMessage(
            err, 'Không thể tải danh sách sự cố & yêu cầu.'));
      }
    }
  }

  // --- small helpers -------------------------------------------------------
  String _statusOf(dynamic r) =>
      (r is Map ? r['status']?.toString() : null)?.toUpperCase() ?? 'NEW';

  String _idOf(dynamic r) {
    if (r is! Map) return '';
    return r['id']?.toString() ?? r['request_id']?.toString() ?? '';
  }

  String _trackingCode(dynamic r) {
    if (r is! Map) return '';
    final code = r['tracking_code']?.toString();
    if (code != null && code.isNotEmpty) return code;
    final id = _idOf(r);
    return 'SR-${id.length > 8 ? id.substring(0, 8) : id}';
  }

  Map<String, dynamic> _asMap(dynamic r) =>
      r is Map ? Map<String, dynamic>.from(r) : <String, dynamic>{};

  List<dynamic> _asList(dynamic v) {
    if (v is List) return v;
    if (v != null && v.toString().isNotEmpty) return [v];
    return const [];
  }

  String _slotLabel(dynamic slot) {
    final code = slot?.toString() ?? '';
    return kPreferredSlotLabels[code.toUpperCase()] ?? code;
  }

  String _categoryLabel(dynamic category) {
    final code = category?.toString() ?? '';
    return kServiceRequestCategories[code.toUpperCase()] ?? code;
  }

  bool _isReopenExpired(dynamic r) {
    final raw = r is Map ? r['resolved_at'] : null;
    if (raw == null) return false;
    final dt = raw is DateTime ? raw : DateTime.tryParse(raw.toString());
    if (dt == null) return false;
    return DateTime.now().millisecondsSinceEpoch - dt.millisecondsSinceEpoch >
        _reopenWindowDays * 24 * 60 * 60 * 1000;
  }

  AppBadge _slaBadge(dynamic r) {
    final req = _asMap(r);
    final meta = computeSlaBadgeMeta(
      status: _statusOf(r),
      slaDueAt: req['sla_due_at'],
      slaBreachedAt: req['sla_breached_at'],
    );
    return AppBadge(
      label: 'SLA: ${meta.label}',
      variant: AppBadgeVariant.fromString(meta.variant),
    );
  }

  Future<void> _copyCode(String code) async {
    if (code.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: code));
    if (!mounted) return;
    setState(() => _copiedCode = code);
    ref.read(toastProvider.notifier).info('Đã sao chép mã tra cứu $code');
  }

  Widget _trackingCodeChip(dynamic r) {
    final code = _trackingCode(r);
    final copied = _copiedCode == code;
    return InkWell(
      onTap: () => _copyCode(code),
      borderRadius: BorderRadius.circular(8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
        decoration: BoxDecoration(
          color: AppColors.slate100,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              'Mã tra cứu: $code',
              style: const TextStyle(
                fontFamily: 'Inter',
                fontSize: 11,
                fontWeight: FontWeight.bold,
                color: AppColors.slate800,
              ),
            ),
            const SizedBox(width: 6),
            Icon(
              copied ? LucideIcons.check : LucideIcons.copy,
              size: 13,
              color: copied ? AppColors.emerald600 : AppColors.slate400,
            ),
          ],
        ),
      ),
    );
  }

  Widget _imageStrip(BuildContext context, dynamic raw,
      {bool resolution = false}) {
    final srcs = _asList(raw);
    if (srcs.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const SizedBox(height: 8),
        Text(
          resolution
              ? 'Ảnh nghiệm thu sau sửa chữa (${srcs.length})'
              : 'Ảnh hiện trạng sự cố (${srcs.length})',
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            color: resolution ? AppColors.emerald700 : AppColors.slate500,
          ),
        ),
        const SizedBox(height: 6),
        Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [
            for (final src in srcs)
              GestureDetector(
                onTap: () => _openLightbox(context, src.toString()),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(10),
                  child: AuthImage(
                    src: src.toString(),
                    width: 72,
                    height: 72,
                    fit: BoxFit.cover,
                  ),
                ),
              ),
          ],
        ),
      ],
    );
  }

  // --- create --------------------------------------------------------------
  void _openCreateModal(BuildContext context) {
    final contract =
        widget.overview?['active_contract'] ?? widget.overview?['contract'];
    if (contract == null) {
      ref.read(toastProvider.notifier).warning(
          'Bạn cần có hợp đồng thuê đang hiệu lực để gửi yêu cầu sửa chữa.');
      return;
    }

    final cid = _contractId;
    final apartmentId = contract['apartment_id']?.toString();
    final titleCtrl = TextEditingController();
    final descCtrl = TextEditingController();
    final locationCtrl = TextEditingController();
    String category = 'ELECTRICAL';
    String priority = 'NORMAL';
    String slot = 'ANYTIME';
    List<String> images = [];
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Gửi yêu cầu sửa chữa / báo hỏng',
      subtitle:
          'Căn hộ ${contract['apartment_code']?.toString() ?? ''} — ${contract['building_name']?.toString() ?? ''}',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                AppSelect<String>(
                  label: 'Hạng mục sự cố',
                  required: true,
                  value: category,
                  options: _kCategoryOptions,
                  onChanged: (val) {
                    if (val != null) setModalState(() => category = val);
                  },
                ),
                const SizedBox(height: 12),
                AppSelect<String>(
                  label: 'Mức độ khẩn cấp',
                  required: true,
                  value: priority,
                  options: _kPriorityOptions,
                  onChanged: (val) {
                    if (val != null) setModalState(() => priority = val);
                  },
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Vị trí sự cố',
                  controller: locationCtrl,
                  placeholder: 'VD: Nhà vệ sinh phụ, Ban công, Bếp...',
                ),
                const SizedBox(height: 12),
                AppSelect<String>(
                  label: 'Khung giờ thuận tiện tiếp kỹ thuật',
                  value: slot,
                  options: _kSlotOptions,
                  onChanged: (val) {
                    if (val != null) setModalState(() => slot = val);
                  },
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Tiêu đề tóm tắt',
                  controller: titleCtrl,
                  placeholder:
                      'Ví dụ: Điều hòa phòng ngủ chính không mát, chảy nước...',
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Mô tả chi tiết tình trạng',
                  required: true,
                  controller: descCtrl,
                  multiline: true,
                  rows: 4,
                  placeholder:
                      'Mô tả rõ hiện tượng hư hỏng, mức độ ảnh hưởng để kỹ thuật viên chuẩn bị dụng cụ...',
                ),
                const SizedBox(height: 12),
                FileUploadField(
                  label: 'Ảnh chụp minh họa sự cố (tối đa 3 ảnh)',
                  value: images,
                  multiple: true,
                  maxFiles: 3,
                  allowPdf: false,
                  onChanged: (val) {
                    setModalState(() {
                      if (val is List) {
                        images = val.map((e) => e.toString()).toList();
                      } else if (val != null && val.toString().isNotEmpty) {
                        images = [val.toString()];
                      } else {
                        images = [];
                      }
                      if (images.length > 3) images = images.sublist(0, 3);
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
                      onPressed:
                          submitting ? null : () => Navigator.of(ctx).pop(),
                    ),
                    const SizedBox(width: 8),
                    AppButton(
                      text: submitting ? 'Đang gửi...' : 'Gửi yêu cầu',
                      loading: submitting,
                      onPressed: submitting
                          ? null
                          : () async {
                              final desc = descCtrl.text.trim();
                              if (desc.isEmpty) {
                                ref.read(toastProvider.notifier).error(
                                    'Vui lòng mô tả chi tiết tình trạng sự cố.');
                                return;
                              }
                              final payload = <String, dynamic>{
                                'category': category,
                                'priority': priority,
                                'location_detail': locationCtrl.text.trim(),
                                'preferred_slot': slot,
                                'title': titleCtrl.text.trim(),
                                'description': desc,
                                if (cid != null && cid.isNotEmpty)
                                  'contract_id': cid,
                                if (apartmentId != null &&
                                    apartmentId.isNotEmpty)
                                  'apartment_id': apartmentId,
                                'images': images.take(3).toList(),
                              };

                              setModalState(() => submitting = true);
                              try {
                                final res = await ref
                                    .read(residentServiceProvider)
                                    .createServiceRequest(payload);
                                if (ctx.mounted) Navigator.of(ctx).pop();
                                ref.read(toastProvider.notifier).success(
                                      _createSuccessMessage(res),
                                    );
                                await _fetchRequests();
                                widget.onRefreshOverview();
                              } on DioException catch (err) {
                                final data = err.response?.data;
                                if (err.response?.statusCode == 409 &&
                                    data is Map &&
                                    data['code']?.toString() ==
                                        'DUPLICATE_SERVICE_REQUEST') {
                                  if (ctx.mounted) Navigator.of(ctx).pop();
                                  if (!context.mounted) return;
                                  _showDuplicateModal(
                                    context,
                                    message: data['message']?.toString() ??
                                        'Căn hộ đang có yêu cầu cùng hạng mục vừa gửi trong 24 giờ qua. Bạn vẫn muốn tiếp tục gửi thêm yêu cầu mới?',
                                    existing: data['existing_request'] is Map
                                        ? _asMap(data['existing_request'])
                                        : null,
                                    payload: payload,
                                  );
                                  return;
                                }
                                setModalState(() => submitting = false);
                                ref.read(toastProvider.notifier).error(
                                      extractErrorMessage(err,
                                          'Không thể gửi yêu cầu sửa chữa.'),
                                    );
                              } catch (err) {
                                setModalState(() => submitting = false);
                                ref.read(toastProvider.notifier).error(
                                      extractErrorMessage(err,
                                          'Không thể gửi yêu cầu sửa chữa.'),
                                    );
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

  String _createSuccessMessage(dynamic res) {
    final data = res is Map ? res['data'] : null;
    final rawMsg = res is Map ? res['message']?.toString() : null;
    if (rawMsg != null && rawMsg.isNotEmpty) return rawMsg;
    final code = data is Map ? data['tracking_code']?.toString() ?? '' : '';
    return 'Đã tiếp nhận báo hỏng! Mã tra cứu: $code';
  }

  void _showDuplicateModal(
    BuildContext context, {
    required String message,
    required Map<String, dynamic>? existing,
    required Map<String, dynamic> payload,
  }) {
    bool submitting = false;

    void viewExisting(BuildContext ctx) {
      Navigator.of(ctx).pop();
      final id = existing?['id']?.toString();
      if (id == null || id.isEmpty) return;
      dynamic match;
      for (final r in _requests) {
        if (_idOf(r) == id) {
          match = r;
          break;
        }
      }
      setState(() => _filterTab = 'all');
      if (match != null) _openDetailModal(context, _asMap(match));
    }

    AppModal.show(
      context: context,
      title: 'Trùng lặp yêu cầu',
      subtitle:
          'Vui lòng kiểm tra yêu cầu đang mở để tránh tạo phiếu trùng lặp.',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.amber50,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.amber200),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Icon(LucideIcons.triangleAlert,
                        size: 16, color: AppColors.amber600),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        message,
                        style: const TextStyle(
                            fontSize: 12, color: AppColors.amber700),
                      ),
                    ),
                  ],
                ),
              ),
              if (existing != null) ...[
                const SizedBox(height: 12),
                Container(
                  padding: const EdgeInsets.all(12),
                  decoration: BoxDecoration(
                    color: AppColors.slate50,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.slate200),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '#${existing['tracking_code']?.toString() ?? ''}',
                        style: const TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                          color: AppColors.primary700,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        existing['title']?.toString() ?? '',
                        style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: AppColors.slate900),
                      ),
                      if (existing['created_at'] != null) ...[
                        const SizedBox(height: 4),
                        Text(
                          'Gửi lúc: ${formatDateTime(existing['created_at'])}',
                          style: const TextStyle(
                              fontSize: 11, color: AppColors.slate500),
                        ),
                      ],
                    ],
                  ),
                ),
              ],
              const SizedBox(height: 20),
              Wrap(
                alignment: WrapAlignment.end,
                spacing: 8,
                runSpacing: 8,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed:
                        submitting ? null : () => Navigator.of(ctx).pop(),
                  ),
                  if (existing != null)
                    AppButton(
                      text: 'Xem yêu cầu đã gửi',
                      variant: AppButtonVariant.secondary,
                      onPressed: submitting ? null : () => viewExisting(ctx),
                    ),
                  AppButton(
                    text: submitting ? 'Đang gửi...' : 'Vẫn tiếp tục gửi mới',
                    variant: AppButtonVariant.warning,
                    loading: submitting,
                    onPressed: submitting
                        ? null
                        : () async {
                            setModalState(() => submitting = true);
                            try {
                              final res = await ref
                                  .read(residentServiceProvider)
                                  .createServiceRequest({
                                ...payload,
                                'ignore_duplicate_warning': true,
                                'confirm_duplicate': true,
                              });
                              if (ctx.mounted) Navigator.of(ctx).pop();
                              ref
                                  .read(toastProvider.notifier)
                                  .success(_createSuccessMessage(res));
                              await _fetchRequests();
                              widget.onRefreshOverview();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(
                                        err, 'Không thể gửi yêu cầu sửa chữa.'),
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

  // --- cancel / reopen / rate ---------------------------------------------
  void _openCancelModal(BuildContext context, Map<String, dynamic> req) {
    final reqId = _idOf(req);
    final reasonCtrl = TextEditingController();
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Xác nhận hủy yêu cầu báo hỏng',
      subtitle:
          'Mã yêu cầu: ${_trackingCode(req)} — ${req['title']?.toString() ?? ''}',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Yêu cầu đang ở trạng thái Mới tiếp nhận và chưa phân công kỹ thuật viên. Bạn có thể hủy nếu sự cố đã tự khắc phục.',
                style: TextStyle(fontSize: 12, color: AppColors.slate600),
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Lý do hủy (tùy chọn)',
                controller: reasonCtrl,
                multiline: true,
                rows: 3,
                placeholder:
                    'Ví dụ: Đã bật lại aptomat, thiết bị hoạt động bình thường...',
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Giữ lại yêu cầu',
                    variant: AppButtonVariant.outline,
                    onPressed:
                        submitting ? null : () => Navigator.of(ctx).pop(),
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
                              final res = await ref
                                  .read(residentServiceProvider)
                                  .cancelServiceRequest(reqId, {
                                'cancel_reason': reasonCtrl.text.trim(),
                              });
                              if (ctx.mounted) Navigator.of(ctx).pop();
                              ref.read(toastProvider.notifier).success(
                                    res is Map && res['message'] != null
                                        ? res['message'].toString()
                                        : 'Đã hủy yêu cầu sửa chữa.',
                                  );
                              await _fetchRequests();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(
                                        err, 'Không thể hủy yêu cầu sửa chữa.'),
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

  void _openReopenModal(BuildContext context, Map<String, dynamic> req) {
    final reqId = _idOf(req);
    final reasonCtrl = TextEditingController();
    String? error;
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Chưa đạt — Yêu cầu kỹ thuật xử lý lại',
      subtitle:
          'Mã yêu cầu: ${_trackingCode(req)} (thời hạn mở lại: $_reopenWindowDays ngày)',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Nếu sự cố vẫn tái diễn hoặc chưa được xử lý triệt để, Ban quản lý sẽ nhận cảnh báo ưu tiên và cử kỹ thuật viên kiểm tra lại.',
                style: TextStyle(fontSize: 12, color: AppColors.slate600),
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Mô tả tình trạng chưa đạt',
                required: true,
                controller: reasonCtrl,
                error: error,
                multiline: true,
                rows: 4,
                placeholder:
                    'Ví dụ: Vòi nước dưới bồn rửa vẫn rỉ nước nhỏ giọt sau khi thay gioăng...',
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed:
                        submitting ? null : () => Navigator.of(ctx).pop(),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: submitting ? 'Đang gửi...' : 'Gửi yêu cầu xử lý lại',
                    variant: AppButtonVariant.danger,
                    loading: submitting,
                    onPressed: submitting
                        ? null
                        : () async {
                            final r = reasonCtrl.text.trim();
                            if (r.length < 5) {
                              setModalState(() => error =
                                  'Vui lòng mô tả lý do chưa đạt tối thiểu 5 ký tự để kỹ thuật kiểm tra lại.');
                              return;
                            }
                            setModalState(() {
                              error = null;
                              submitting = true;
                            });
                            try {
                              final res = await ref
                                  .read(residentServiceProvider)
                                  .reopenServiceRequest(reqId, {
                                'reopen_reason': r,
                              });
                              if (ctx.mounted) Navigator.of(ctx).pop();
                              ref.read(toastProvider.notifier).success(
                                    res is Map && res['message'] != null
                                        ? res['message'].toString()
                                        : 'Đã mở lại yêu cầu để Ban quản lý xử lý bổ sung.',
                                  );
                              await _fetchRequests();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(err,
                                        'Không thể mở lại yêu cầu sửa chữa.'),
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

  void _openRatingModal(BuildContext context, Map<String, dynamic> req) {
    final reqId = _idOf(req);
    int rating = 5;
    final noteCtrl = TextEditingController();
    bool submitting = false;

    AppModal.show(
      context: context,
      title: 'Nghiệm thu & Đánh giá chất lượng xử lý',
      subtitle:
          'Mã yêu cầu: ${_trackingCode(req)} — ${req['title']?.toString() ?? ''}',
      child: StatefulBuilder(
        builder: (ctx, setModalState) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                padding: const EdgeInsets.symmetric(vertical: 12),
                decoration: BoxDecoration(
                  color: AppColors.amber50,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.amber100),
                ),
                child: Column(
                  children: [
                    const Text(
                      'Mức độ hài lòng của bạn với kết quả sửa chữa',
                      style: TextStyle(fontSize: 12, color: AppColors.slate600),
                    ),
                    const SizedBox(height: 8),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
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
                    const SizedBox(height: 4),
                    Text(
                      _kStarLabels[rating] ?? '',
                      style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w600,
                          color: AppColors.amber700),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Nhận xét chi tiết (tùy chọn)',
                controller: noteCtrl,
                multiline: true,
                rows: 3,
                placeholder:
                    'Chia sẻ cảm nhận về thái độ nhân viên kỹ thuật và chất lượng xử lý...',
              ),
              const SizedBox(height: 20),
              Row(
                mainAxisAlignment: MainAxisAlignment.end,
                children: [
                  AppButton(
                    text: 'Đóng',
                    variant: AppButtonVariant.outline,
                    onPressed:
                        submitting ? null : () => Navigator.of(ctx).pop(),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text:
                        submitting ? 'Đang gửi...' : 'Nghiệm thu & Đóng phiếu',
                    variant: AppButtonVariant.warning,
                    loading: submitting,
                    onPressed: submitting
                        ? null
                        : () async {
                            setModalState(() => submitting = true);
                            try {
                              final res = await ref
                                  .read(residentServiceProvider)
                                  .rateServiceRequest(reqId, {
                                'rating': rating,
                                'rating_note': noteCtrl.text.trim(),
                              });
                              if (ctx.mounted) Navigator.of(ctx).pop();
                              ref.read(toastProvider.notifier).success(
                                    res is Map && res['message'] != null
                                        ? res['message'].toString()
                                        : 'Cảm ơn bạn đã nghiệm thu và đánh giá chất lượng xử lý!',
                                  );
                              await _fetchRequests();
                            } catch (err) {
                              setModalState(() => submitting = false);
                              ref.read(toastProvider.notifier).error(
                                    extractErrorMessage(
                                        err, 'Không thể lưu đánh giá.'),
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

  // --- detail & lightbox ---------------------------------------------------
  void _openLightbox(BuildContext context, String src) {
    AppModal.show(
      context: context,
      title: 'Xem ảnh chi tiết',
      size: AppModalSize.lg,
      child: Center(
        child: AuthImage(
          src: src,
          alt: 'Ảnh chi tiết',
          height: 400,
          fit: BoxFit.contain,
        ),
      ),
    );
  }

  void _openDetailModal(BuildContext context, Map<String, dynamic> req) {
    final status = _statusOf(req);
    final canCancel = status == 'NEW';
    final canReopen = status == 'RESOLVED' && !_isReopenExpired(req);
    final hasRated = (num.tryParse(req['rating']?.toString() ?? '') ?? 0) > 0;

    AppModal.show(
      context: context,
      title: 'Phiếu sửa chữa #${_trackingCode(req)}',
      subtitle: req['title']?.toString() ?? '',
      footer: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          AppButton(
            text: 'Đóng',
            variant: AppButtonVariant.outline,
            onPressed: () => Navigator.of(context).pop(),
          ),
          if (canCancel) ...[
            const SizedBox(width: 8),
            AppButton(
              text: 'Hủy yêu cầu',
              variant: AppButtonVariant.danger,
              onPressed: () {
                Navigator.of(context).pop();
                _openCancelModal(context, req);
              },
            ),
          ],
          if (canReopen) ...[
            const SizedBox(width: 8),
            AppButton(
              text: 'Yêu cầu xử lý lại',
              variant: AppButtonVariant.outline,
              onPressed: () {
                Navigator.of(context).pop();
                _openReopenModal(context, req);
              },
            ),
          ],
          if (status == 'RESOLVED' && !hasRated) ...[
            const SizedBox(width: 8),
            AppButton(
              text: 'Nghiệm thu & Đánh giá',
              variant: AppButtonVariant.warning,
              onPressed: () {
                Navigator.of(context).pop();
                _openRatingModal(context, req);
              },
            ),
          ],
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              AppBadge(
                  label: _categoryLabel(req['category']),
                  variant: AppBadgeVariant.indigo),
              AppBadge.fromStatusMeta(resolveStatusMeta(
                  StatusDomain.priority, req['priority']?.toString())),
              AppBadge.fromStatusMeta(
                  resolveStatusMeta(StatusDomain.serviceRequest, status),
                  dot: true),
              _slaBadge(req),
            ],
          ),
          const SizedBox(height: 12),
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.slate200),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  req['description']?.toString() ?? '',
                  style:
                      const TextStyle(fontSize: 12, color: AppColors.slate700),
                ),
                const SizedBox(height: 8),
                Text(
                  'Kỹ thuật phụ trách: ${req['assigned_to_name']?.toString() ?? 'Đang điều phối nhân sự'}',
                  style:
                      const TextStyle(fontSize: 12, color: AppColors.slate500),
                ),
              ],
            ),
          ),
          if (req['resolution_note'] != null) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.emerald50,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.emerald200),
              ),
              child: Text(
                'Kết quả xử lý kỹ thuật: ${req['resolution_note']}',
                style:
                    const TextStyle(fontSize: 12, color: AppColors.emerald700),
              ),
            ),
          ],
          if (req['hold_reason'] != null) ...[
            const SizedBox(height: 10),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.purple50,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.purple200),
              ),
              child: Text(
                'Lý do tạm hoãn / hẹn lại: ${req['hold_reason']}',
                style:
                    const TextStyle(fontSize: 12, color: AppColors.purple700),
              ),
            ),
          ],
          _imageStrip(context, req['images']),
          _imageStrip(context, req['resolution_images'], resolution: true),
        ],
      ),
    );
  }

  // --- build ---------------------------------------------------------------
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
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(14),
                border: Border.all(color: AppColors.slate200),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  const Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Báo hỏng & Yêu cầu Hỗ trợ Kỹ thuật',
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 16,
                            fontWeight: FontWeight.bold,
                            color: AppColors.slate900,
                          ),
                        ),
                        SizedBox(height: 4),
                        Text(
                          'Gửi yêu cầu sửa chữa kèm vị trí chi tiết, khung giờ hẹn, hình ảnh thực tế (tối đa 3 ảnh) và nghiệm thu kết quả xử lý SLA',
                          style: TextStyle(
                              fontSize: 12, color: AppColors.slate500),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  AppButton(
                    text: 'Gửi yêu cầu báo hỏng',
                    size: AppButtonSize.sm,
                    icon: const Icon(LucideIcons.plus, size: 14),
                    onPressed: () => _openCreateModal(context),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            AppTabs(
              activeTab: _filterTab,
              onChanged: (tab) => setState(() => _filterTab = tab),
              tabs: [
                AppTabItem(id: 'all', label: 'Tất cả', count: _requests.length),
                AppTabItem(id: 'open', label: 'Đang xử lý', count: _openCount),
                AppTabItem(id: 'done', label: 'Đã hoàn tất', count: _doneCount),
              ],
            ),
            const SizedBox(height: 16),
            if (_loading && _requests.isEmpty)
              const Center(child: CircularProgressIndicator())
            else if (_filteredRequests.isEmpty)
              Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(LucideIcons.wrench,
                          size: 48, color: AppColors.slate400),
                      const SizedBox(height: 12),
                      const Text(
                        'Chưa có yêu cầu báo hỏng nào',
                        style: TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: AppColors.slate800,
                        ),
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Khi căn hộ phát sinh sự cố điện, nước, điều hòa hoặc nội thất, bạn hãy nhấn nút Gửi yêu cầu báo hỏng để kỹ thuật tòa nhà hỗ trợ ngay.',
                        textAlign: TextAlign.center,
                        style:
                            TextStyle(fontSize: 13, color: AppColors.slate500),
                      ),
                    ],
                  ),
                ),
              )
            else
              ..._filteredRequests.map((r) => _buildRequestCard(context, r)),
          ],
        ),
      ),
    );
  }

  Widget _buildRequestCard(BuildContext context, dynamic r) {
    final req = _asMap(r);
    final status = _statusOf(r);
    final createdAt = req['created_at'];
    final canCancel = status == 'NEW';
    final canReopen = status == 'RESOLVED' && !_isReopenExpired(r);
    final hasRated = (num.tryParse(req['rating']?.toString() ?? '') ?? 0) > 0;
    final canRate = status == 'RESOLVED' && !hasRated;
    final openStatus = _kOpenStatuses.contains(status);
    final imgs = _asList(req['images']);
    final resImgs = _asList(req['resolution_images']);
    final reopenCount =
        num.tryParse(req['reopen_count']?.toString() ?? '') ?? 0;

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
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    _trackingCodeChip(r),
                    AppBadge(
                        label: _categoryLabel(req['category']),
                        variant: AppBadgeVariant.indigo),
                    AppBadge.fromStatusMeta(resolveStatusMeta(
                        StatusDomain.priority, req['priority']?.toString())),
                    AppBadge.fromStatusMeta(
                        resolveStatusMeta(StatusDomain.serviceRequest, status),
                        dot: true),
                    _slaBadge(r),
                    if (req['apartment_code'] != null)
                      Text(
                        'Căn ${req['apartment_code']}${req['building_name'] != null ? ' — ${req['building_name']}' : ''}',
                        style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w500,
                            color: AppColors.slate600),
                      ),
                  ],
                ),
              ),
              if (createdAt != null) ...[
                const SizedBox(width: 8),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(LucideIcons.clock,
                        size: 13, color: AppColors.slate400),
                    const SizedBox(width: 4),
                    Text(
                      formatDateTime(createdAt),
                      style: const TextStyle(
                          fontSize: 11, color: AppColors.slate400),
                    ),
                  ],
                ),
              ],
            ],
          ),
          const SizedBox(height: 10),
          Text(
            req['title']?.toString() ??
                'Báo hỏng ${_categoryLabel(req['category'])}',
            style: const TextStyle(
              fontFamily: 'Inter',
              fontSize: 15,
              fontWeight: FontWeight.bold,
              color: AppColors.slate900,
            ),
          ),
          if (req['location_detail'] != null ||
              req['preferred_slot'] != null ||
              reopenCount > 0) ...[
            const SizedBox(height: 8),
            Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                if (req['location_detail'] != null)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: AppColors.slate100,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: AppColors.slate200),
                    ),
                    child: Text(
                      'Vị trí: ${req['location_detail']}',
                      style: const TextStyle(
                          fontSize: 11, color: AppColors.slate700),
                    ),
                  ),
                if (req['preferred_slot'] != null)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: AppColors.sky50,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: AppColors.sky200),
                    ),
                    child: Text(
                      'Khung giờ hẹn: ${_slotLabel(req['preferred_slot'])}',
                      style: const TextStyle(
                          fontSize: 11, color: AppColors.sky700),
                    ),
                  ),
                if (reopenCount > 0)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    decoration: BoxDecoration(
                      color: AppColors.rose50,
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(color: AppColors.rose200),
                    ),
                    child: Text(
                      'Đã yêu cầu xử lý lại $reopenCount lần',
                      style: const TextStyle(
                          fontSize: 11, color: AppColors.rose700),
                    ),
                  ),
              ],
            ),
          ],
          if (req['description']?.toString().isNotEmpty ?? false) ...[
            const SizedBox(height: 8),
            Text(
              req['description'].toString(),
              style: const TextStyle(fontSize: 13, color: AppColors.slate700),
            ),
          ],
          if (status == 'ON_HOLD' ||
              req['hold_reason'] != null ||
              req['next_appointment_at'] != null) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.purple50,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.purple200),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (req['hold_reason'] != null)
                    Text('Lý do tạm hoãn / hẹn lại: ${req['hold_reason']}',
                        style: const TextStyle(
                            fontSize: 11, color: AppColors.purple700)),
                  if (req['next_appointment_at'] != null)
                    Text(
                        'Lịch hẹn kỹ thuật tiếp theo: ${formatDateTime(req['next_appointment_at'])}',
                        style: const TextStyle(
                            fontSize: 11, color: AppColors.purple700)),
                ],
              ),
            ),
          ],
          if (req['reopen_reason'] != null) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.rose50,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.rose200),
              ),
              child: Text(
                'Lý do yêu cầu xử lý lại gần nhất: ${req['reopen_reason']}',
                style: const TextStyle(fontSize: 11, color: AppColors.rose800),
              ),
            ),
          ],
          if (status == 'CANCELLED' && req['cancelled_reason'] != null) ...[
            const SizedBox(height: 8),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.slate50,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: AppColors.slate200),
              ),
              child: Text(
                'Lý do hủy: ${req['cancelled_reason']}',
                style: const TextStyle(fontSize: 11, color: AppColors.slate600),
              ),
            ),
          ],
          _imageStrip(context, imgs),
          const SizedBox(height: 12),
          const Divider(height: 1),
          const SizedBox(height: 10),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(LucideIcons.userCheck,
                            size: 14, color: AppColors.slate400),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Text(
                            'Kỹ thuật phụ trách: ${req['assigned_to_name']?.toString() ?? 'Đang điều phối nhân sự'}',
                            style: const TextStyle(
                                fontSize: 11, color: AppColors.slate500),
                          ),
                        ),
                      ],
                    ),
                    if (req['sla_due_at'] != null && openStatus) ...[
                      const SizedBox(height: 4),
                      Text(
                        '• Hạn xử lý SLA: ${formatDateTime(req['sla_due_at'])}',
                        style: const TextStyle(
                            fontSize: 11, color: AppColors.slate500),
                      ),
                    ],
                    if (req['resolved_at'] != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        '• Hoàn thành lúc: ${formatDateTime(req['resolved_at'])}',
                        style: const TextStyle(
                            fontSize: 11,
                            color: AppColors.emerald700,
                            fontWeight: FontWeight.w500),
                      ),
                    ],
                    if (req['resolution_note'] != null) ...[
                      const SizedBox(height: 8),
                      Container(
                        padding: const EdgeInsets.all(10),
                        decoration: BoxDecoration(
                          color: AppColors.emerald50,
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: AppColors.emerald200),
                        ),
                        child: Text(
                          'Kết quả xử lý kỹ thuật: ${req['resolution_note']}',
                          style: const TextStyle(
                              fontSize: 11, color: AppColors.emerald700),
                        ),
                      ),
                    ],
                    _imageStrip(context, resImgs, resolution: true),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 8,
            runSpacing: 8,
            children: [
              AppButton(
                text: 'Xem chi tiết',
                size: AppButtonSize.sm,
                variant: AppButtonVariant.soft,
                onPressed: () => _openDetailModal(context, req),
              ),
              if (canCancel)
                AppButton(
                  text: 'Hủy yêu cầu',
                  size: AppButtonSize.sm,
                  variant: AppButtonVariant.outline,
                  onPressed: () => _openCancelModal(context, req),
                ),
              if (canReopen)
                AppButton(
                  text: 'Chưa đạt — Yêu cầu xử lý lại',
                  size: AppButtonSize.sm,
                  variant: AppButtonVariant.outline,
                  onPressed: () => _openReopenModal(context, req),
                ),
              if (canRate)
                AppButton(
                  text: 'Nghiệm thu & Đánh giá (1–5 ★)',
                  size: AppButtonSize.sm,
                  variant: AppButtonVariant.warning,
                  icon: const Icon(LucideIcons.star, size: 14),
                  onPressed: () => _openRatingModal(context, req),
                ),
              if (hasRated)
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.star, size: 15, color: Colors.amber),
                    const SizedBox(width: 4),
                    Text(
                      '${req['rating']}/5',
                      style: const TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.bold,
                          color: AppColors.amber700),
                    ),
                  ],
                ),
            ],
          ),
        ],
      ),
    );
  }
}
