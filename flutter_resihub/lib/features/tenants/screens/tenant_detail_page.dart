import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/ai_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../ai_gateway/services/ai_service.dart';
import '../../auth/providers/permission_provider.dart';
import '../services/tenants_service.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/loading_spinner.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/ai_suggestion_field.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_tabs.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';

/// Tenant / Resident Detail & Identity Verification Screen.
/// Port of `frontend/src/pages/admin/tenants/TenantDetailPage.jsx`.
class TenantDetailPage extends ConsumerStatefulWidget {
  final String tenantId;
  final String? initialModal;

  const TenantDetailPage({
    super.key,
    required this.tenantId,
    this.initialModal,
  });

  @override
  ConsumerState<TenantDetailPage> createState() => _TenantDetailPageState();
}

class _TenantDetailPageState extends ConsumerState<TenantDetailPage> {
  Map<String, dynamic>? _tenant;
  List<dynamic> _idImages = [];
  Map<String, dynamic> _idImagesMeta = {
    'maskedForOwner': false,
    'hasIdImages': false,
  };
  bool _loading = true;
  String _activeTab = 'profile';

  // Edit profile state
  bool _isEditing = false;
  final Map<String, dynamic> _form = {
    'full_name': '',
    'phone': '',
    'email': '',
    'id_number': '',
    'dob': '',
    'nationality': 'Việt Nam',
    'address': '',
  };
  Map<String, String> _errors = {};
  bool _saving = false;

  // AI CCCD scan state
  List<String> _aiScanFiles = [];
  bool _aiScanConsent = true;
  bool _extractingCccd = false;
  Map<String, dynamic>? _cccdAiTracker;
  String? _cccdAiError;

  // Approval modal state
  bool _applicationReviewOpen = false;
  bool _approvalDialogOpen = false;
  String _approvalAction = 'approve';
  String _approvalReason = '';
  String _approvalError = '';
  bool _processingApproval = false;

  // Delete states
  bool _deleteTenantOpen = false;
  dynamic _deleteImageTarget;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  Future<void> _loadData({bool force = false}) async {
    final tenantsService = ref.read(tenantsServiceProvider);
    final cached = tenantsService.peekById(widget.tenantId);
    if (cached != null && cached is Map && cached['data'] is Map && !force) {
      _tenant = Map<String, dynamic>.from(cached['data']);
      _populateForm(_tenant!);
      _loading = false;
    } else {
      setState(() => _loading = true);
    }

    try {
      final detailRes = await tenantsService.getById(widget.tenantId, force: force);
      final imgRes = await tenantsService.getIdImages(widget.tenantId, force: force).catchError((_) => {'data': []});

      final data = (detailRes is Map && detailRes['data'] is Map)
          ? Map<String, dynamic>.from(detailRes['data'])
          : (detailRes is Map ? Map<String, dynamic>.from(detailRes) : null);

      final imgs = (imgRes is Map && imgRes['data'] is List) ? List<dynamic>.from(imgRes['data']) : [];
      final maskedForOwner = imgRes is Map && (imgRes['masked_for_owner'] == true);
      final hasIdImgs = imgRes is Map && (imgRes['has_id_images'] == true);

      setState(() {
        _tenant = data;
        _idImages = imgs;
        _idImagesMeta = {
          'maskedForOwner': maskedForOwner,
          'hasIdImages': hasIdImgs,
        };
        if (data != null) {
          _populateForm(data);
        }
      });

      if (widget.initialModal == 'approval') {
        setState(() => _applicationReviewOpen = true);
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải thông tin chi tiết cư dân.'),
          );
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  void _populateForm(Map<String, dynamic> data) {
    _form['full_name'] = data['full_name']?.toString() ?? '';
    _form['phone'] = data['phone']?.toString() ?? '';
    _form['email'] = data['email']?.toString() ?? '';
    _form['id_number'] = data['id_number']?.toString() ?? '';
    _form['dob'] = data['dob'] != null ? toInputDate(data['dob']) : '';
    _form['nationality'] = data['nationality']?.toString() ?? 'Việt Nam';
    _form['address'] = data['address']?.toString() ?? '';
  }

  Future<void> _handleSaveProfile() async {
    final nextErrs = <String, String>{};
    final fullName = (_form['full_name']?.toString() ?? '').trim();
    final phone = (_form['phone']?.toString() ?? '').trim();
    final email = (_form['email']?.toString() ?? '').trim();
    final idNumber = (_form['id_number']?.toString() ?? '').trim();

    if (fullName.isEmpty) {
      nextErrs['full_name'] = 'Họ và tên không được để trống.';
    }
    if (phone.isEmpty) {
      nextErrs['phone'] = 'Số điện thoại không được để trống.';
    } else if (!isValidPhone(phone)) {
      nextErrs['phone'] = 'Số điện thoại không đúng định dạng (10 chữ số).';
    }
    if (email.isNotEmpty && !isValidEmail(email)) {
      nextErrs['email'] = 'Địa chỉ email không hợp lệ.';
    }
    if (idNumber.isNotEmpty && !isValidIdNumber(idNumber)) {
      nextErrs['id_number'] = 'Số CCCD/CMND hoặc Hộ chiếu không hợp lệ.';
    }

    setState(() => _errors = nextErrs);
    if (nextErrs.isNotEmpty) return;

    setState(() => _saving = true);
    try {
      final payload = {
        'full_name': fullName,
        'phone': normalizePhone(phone),
        'email': email.isNotEmpty ? email : null,
        'id_number': idNumber.isNotEmpty ? idNumber : null,
        'dob': _form['dob']?.toString().isNotEmpty == true ? _form['dob'] : null,
        'nationality': _form['nationality']?.toString().isNotEmpty == true ? _form['nationality'] : 'Việt Nam',
        'address': _form['address']?.toString().trim().isNotEmpty == true ? _form['address'] : null,
        if (_cccdAiTracker?['suggestionId'] != null) 'ai_suggestion_id': _cccdAiTracker!['suggestionId'],
      };

      final res = await ref.read(tenantsServiceProvider).update(widget.tenantId, payload);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Cập nhật thông tin cá nhân thành công.',
          );
      setState(() {
        _cccdAiTracker = null;
        _isEditing = false;
      });
      _loadData(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể lưu thông tin cư dân.'));
    } finally {
      if (mounted) {
        setState(() => _saving = false);
      }
    }
  }

  Future<void> _handleExtractDetailCccd() async {
    List<String> files = _aiScanFiles.where((s) => s.isNotEmpty).toList();
    if (files.isEmpty) {
      files = _idImages
          .map((img) => (img is Map ? (img['url'] ?? img['image_url'] ?? img['image_base64'])?.toString() : null))
          .where((s) => s != null && s.isNotEmpty)
          .cast<String>()
          .toList();
    }
    if (files.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn hoặc tải lên ít nhất 1 ảnh CCCD để AI trích xuất.');
      return;
    }

    setState(() {
      _extractingCccd = true;
      _cccdAiError = null;
    });

    try {
      final activeContract = _tenant?['active_contract'];
      final bId = (activeContract is Map ? activeContract['building_id']?.toString() : null) ??
          _tenant?['desired_building_id']?.toString();

      final res = await ref.read(aiServiceProvider).extractDocument({
        'document_type': 'CCCD',
        'building_id': bId,
        'files': files,
        'privacy_acknowledged': _aiScanConsent,
      });

      final data = (res is Map && res['data'] != null) ? res['data'] : res;
      final out = (data is Map && data['output'] is Map) ? data['output'] as Map : {};

      final mapped = <String, dynamic>{
        'full_name': out['full_name']?.toString().trim() ?? '',
        'id_number': out['id_number']?.toString().trim() ?? '',
        'dob': out['dob'] != null ? toInputDate(out['dob']) : '',
        'address': out['permanent_address']?.toString().trim() ?? '',
      };

      setState(() {
        if (mapped['full_name']?.isNotEmpty == true) {
          _form['full_name'] = mapped['full_name'];
        }
        if (mapped['id_number']?.isNotEmpty == true) {
          _form['id_number'] = mapped['id_number'];
        }
        if (mapped['dob']?.isNotEmpty == true) {
          _form['dob'] = mapped['dob'];
        }
        if (mapped['address']?.isNotEmpty == true) {
          _form['address'] = mapped['address'];
        }

        final baseConf = data is Map ? data['confidence'] : null;
        final confMap = {
          'full_name': out['field_confidences']?['full_name'] ?? baseConf,
          'id_number': out['field_confidences']?['id_number'] ?? baseConf,
          'dob': out['field_confidences']?['dob'] ?? baseConf,
          'address': out['field_confidences']?['permanent_address'] ?? baseConf,
        };
        _cccdAiTracker = createAiFieldTracker(
          data is Map ? data['suggestion_id']?.toString() : null,
          mapped,
          confMap,
        );
        _isEditing = true;
      });

      ref.read(toastProvider.notifier).success('AI đã điền nháp thông tin từ CCCD — vui lòng kiểm tra và bấm "Lưu thông tin".');
    } catch (err) {
      final aiErr = mapAiErrorToVietnamese(err);
      setState(() => _cccdAiError = '${aiErr.title}: ${aiErr.guidance}');
    } finally {
      if (mounted) {
        setState(() => _extractingCccd = false);
      }
    }
  }

  Future<void> _handleUploadIdCard(String side, String base64Val) async {
    if (base64Val.isEmpty) return;
    try {
      final res = await ref.read(tenantsServiceProvider).uploadIdImage(widget.tenantId, {
        'side': side,
        'image_base64': base64Val,
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : 'Đã tải lên ảnh CCCD mặt ${side == 'front' ? 'trước' : 'sau'} thành công.',
          );
      final imgRes = await ref.read(tenantsServiceProvider).getIdImages(widget.tenantId, force: true);
      if (mounted && imgRes is Map && imgRes['data'] is List) {
        setState(() {
          _idImages = List<dynamic>.from(imgRes['data']);
          _idImagesMeta['maskedForOwner'] = imgRes['masked_for_owner'] == true;
          _idImagesMeta['hasIdImages'] = imgRes['has_id_images'] == true;
        });
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể tải ảnh CCCD lên máy chủ.'));
    }
  }

  Future<void> _handleConfirmApproval() async {
    if (_approvalAction == 'reject' && _approvalReason.trim().isEmpty) {
      setState(() => _approvalError = 'Vui lòng nhập lý do từ chối để cư dân biết cần bổ sung thông tin gì.');
      return;
    }

    setState(() => _processingApproval = true);
    try {
      final payload = <String, dynamic>{'action': _approvalAction};
      if (_approvalAction == 'reject') {
        payload['reason'] = _approvalReason.trim();
      }
      if (_form['id_number']?.toString().trim().isNotEmpty == true) {
        payload['id_number'] = _form['id_number'].toString().trim();
      }

      final res = await ref.read(tenantsServiceProvider).update(widget.tenantId, payload);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã cập nhật trạng thái duyệt hồ sơ.',
          );
      setState(() {
        _approvalDialogOpen = false;
        _applicationReviewOpen = false;
      });
      _loadData(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể duyệt hồ sơ cư dân.'));
    } finally {
      if (mounted) {
        setState(() => _processingApproval = false);
      }
    }
  }

  Future<void> _handleConfirmDeleteTenant() async {
    try {
      final res = await ref.read(tenantsServiceProvider).remove(widget.tenantId);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã xóa hồ sơ cư dân.',
          );
      if (mounted) {
        context.go('/admin/tenants');
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể xóa hồ sơ cư dân.'));
    }
  }

  Future<void> _handleConfirmDeleteIdImage() async {
    if (_deleteImageTarget == null || _deleteImageTarget is! Map) return;
    final attId = _deleteImageTarget['attachment_id']?.toString();
    if (attId == null) return;

    try {
      final res = await ref.read(tenantsServiceProvider).deleteIdImage(widget.tenantId, attId);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã xóa ảnh giấy tờ định danh.',
          );
      setState(() => _deleteImageTarget = null);
      final imgRes = await ref.read(tenantsServiceProvider).getIdImages(widget.tenantId, force: true);
      if (mounted && imgRes is Map && imgRes['data'] is List) {
        setState(() {
          _idImages = List<dynamic>.from(imgRes['data']);
          _idImagesMeta['maskedForOwner'] = imgRes['masked_for_owner'] == true;
          _idImagesMeta['hasIdImages'] = imgRes['has_id_images'] == true;
        });
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể xóa ảnh giấy tờ định danh.'));
    }
  }

  Future<void> _handleRejectAiDraft() async {
    final sid = _cccdAiTracker?['suggestionId']?.toString();
    setState(() => _cccdAiTracker = null);
    if (sid != null && sid.isNotEmpty) {
      try {
        await ref.read(aiServiceProvider).reviewSuggestion(sid, {'decision': 'REJECT'});
      } catch (_) {
        // Ignore network error on draft reject
      }
    }
  }

  Widget? _buildActiveModal(bool isMaskedForOwner, bool isPending, bool canManageTenants, Map<String, dynamic> tenant, dynamic latestFrontImg, dynamic latestBackImg) {
    final status = tenant['status']?.toString() ?? 'INACTIVE';
    final fullName = tenant['full_name']?.toString() ?? 'Cư dân';

    if (_applicationReviewOpen) {
      return Material(
        color: Colors.transparent,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: 672,
            maxHeight: MediaQuery.sizeOf(context).height * 0.9,
          ),
          child: AppModal(
          title: 'Hồ sơ Định danh & Xét duyệt Cư dân',
          subtitle: '$fullName • SĐT: ${tenant['phone'] ?? '—'}',
          size: AppModalSize.lg,
          onClose: () => setState(() => _applicationReviewOpen = false),
          footer: Wrap(
            alignment: WrapAlignment.end,
            spacing: 8,
            runSpacing: 8,
            children: [
              AppButton(
                text: 'Đóng',
                variant: AppButtonVariant.outline,
                onPressed: () => setState(() => _applicationReviewOpen = false),
              ),
              if (canManageTenants && isPending) ...[
                AppButton(
                  text: 'Từ chối / Yêu cầu bổ sung',
                  variant: AppButtonVariant.danger,
                  icon: const Icon(LucideIcons.circleX, size: 16),
                  onPressed: () {
                    setState(() {
                      _applicationReviewOpen = false;
                      _approvalAction = 'reject';
                      _approvalReason = '';
                      _approvalError = '';
                      _approvalDialogOpen = true;
                    });
                  },
                ),
                AppButton(
                  text: 'Phê duyệt hồ sơ',
                  variant: AppButtonVariant.success,
                  icon: const Icon(LucideIcons.circleCheck, size: 16),
                  onPressed: () {
                    setState(() {
                      _applicationReviewOpen = false;
                      _approvalAction = 'approve';
                      _approvalReason = '';
                      _approvalError = '';
                      _approvalDialogOpen = true;
                    });
                  },
                ),
              ],
            ],
          ),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: AppColors.slate50,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.slate200),
                  ),
                  child: Column(
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Trạng thái hồ sơ:', style: TextStyle(color: AppColors.slate500)),
                          const SizedBox(width: 8),
                          Flexible(
                            child: StatusBadge(status: status, domain: StatusDomain.tenant),
                          ),
                        ],
                      ),
                      const Divider(height: 16),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Số CCCD / Hộ chiếu:', style: TextStyle(color: AppColors.slate500)),
                          Text(
                            tenant['id_number']?.toString() ?? 'Chưa cập nhật',
                            style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Ngày sinh:', style: TextStyle(color: AppColors.slate500)),
                          Text(tenant['dob'] != null ? formatDate(tenant['dob']) : '—'),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Email:', style: TextStyle(color: AppColors.slate500)),
                          Text(tenant['email']?.toString() ?? '—'),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text('Địa chỉ thường trú:', style: TextStyle(color: AppColors.slate500)),
                          Expanded(
                            child: Text(
                              tenant['address']?.toString() ?? '—',
                              textAlign: TextAlign.right,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 14),

                // Masked for OWNER Notice in Modal
                if (isMaskedForOwner)
                  Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.amber50,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.amber200),
                    ),
                    child: const Row(
                      children: [
                        Icon(LucideIcons.shieldCheck, size: 16, color: AppColors.amber600),
                        SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            'Ảnh chụp CCCD gốc được ẩn đối với vai trò Chủ sở hữu theo chính sách bảo mật dữ liệu cá nhân (PII).',
                            style: TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.amber900),
                          ),
                        ),
                      ],
                    ),
                  )
                else if (latestFrontImg != null || latestBackImg != null) ...[
                  Row(
                    children: [
                      if (latestFrontImg != null)
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text('Mặt trước CCCD', style: TextStyle(fontWeight: FontWeight.bold)),
                              const SizedBox(height: 4),
                              Container(
                                height: 140,
                                decoration: BoxDecoration(
                                  color: AppColors.slate100,
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: AuthImage(
                                  src: latestFrontImg['url']?.toString() ?? latestFrontImg['image_url']?.toString(),
                                  alt: 'CCCD mặt trước',
                                ),
                              ),
                            ],
                          ),
                        ),
                      if (latestFrontImg != null && latestBackImg != null) const SizedBox(width: 12),
                      if (latestBackImg != null)
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text('Mặt sau CCCD', style: TextStyle(fontWeight: FontWeight.bold)),
                              const SizedBox(height: 4),
                              Container(
                                height: 140,
                                decoration: BoxDecoration(
                                  color: AppColors.slate100,
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: AuthImage(
                                  src: latestBackImg['url']?.toString() ?? latestBackImg['image_url']?.toString(),
                                  alt: 'CCCD mặt sau',
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ] else
                  const Center(
                    child: Padding(
                      padding: EdgeInsets.symmetric(vertical: 12),
                      child: Text('Chưa có ảnh CCCD đính kèm trong hồ sơ.', style: TextStyle(color: AppColors.slate400, fontStyle: FontStyle.italic)),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

    if (_approvalDialogOpen) {
      return Material(
        color: Colors.transparent,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: 512,
            maxHeight: MediaQuery.sizeOf(context).height * 0.9,
          ),
          child: AppModal(
            title: _approvalAction == 'approve' ? 'Phê duyệt hồ sơ cư dân' : 'Từ chối / Yêu cầu bổ sung',
            subtitle: 'Hồ sơ: $fullName (${tenant['phone'] ?? '—'})',
            size: AppModalSize.md,
            onClose: () => setState(() => _approvalDialogOpen = false),
            footer: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                AppButton(
                  text: 'Hủy bỏ',
                  variant: AppButtonVariant.outline,
                  onPressed: () => setState(() => _approvalDialogOpen = false),
                ),
                const SizedBox(width: 10),
                AppButton(
                  text: _approvalAction == 'approve' ? 'Xác nhận duyệt' : 'Xác nhận từ chối',
                  variant: _approvalAction == 'approve' ? AppButtonVariant.success : AppButtonVariant.danger,
                  loading: _processingApproval,
                  onPressed: _handleConfirmApproval,
                ),
              ],
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _approvalAction == 'approve'
                      ? 'Bạn có chắc chắn muốn duyệt hồ sơ định danh của cư dân này để cho phép lập hợp đồng thuê?'
                      : 'Vui lòng cung cấp lý do từ chối để gửi thông báo hướng dẫn cư dân cập nhật lại:',
                  style: const TextStyle(fontFamily: 'Inter', fontSize: 13, color: AppColors.slate800),
                ),
                if (_approvalAction == 'reject') ...[
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Lý do từ chối',
                    required: true,
                    initialValue: _approvalReason,
                    error: _approvalError.isNotEmpty ? _approvalError : null,
                    onChanged: (val) => setState(() {
                      _approvalReason = val;
                      _approvalError = '';
                    }),
                  ),
                ],
              ],
            ),
          ),
        ),
      );
    }

    if (_deleteTenantOpen) {
      return Material(
        color: Colors.transparent,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 448),
          child: ConfirmDialog(
            title: 'Xóa hồ sơ cư dân',
            message: 'Bạn có chắc chắn muốn xóa hồ sơ cư dân "$fullName"? Thao tác này không thể hoàn tác.',
            confirmLabel: 'Xóa hồ sơ',
            cancelLabel: 'Hủy bỏ',
            variant: ConfirmDialogVariant.danger,
            onClose: () => setState(() => _deleteTenantOpen = false),
            onConfirm: _handleConfirmDeleteTenant,
          ),
        ),
      );
    }

    if (_deleteImageTarget != null) {
      return Material(
        color: Colors.transparent,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 448),
          child: ConfirmDialog(
          title: 'Xóa ảnh CCCD',
          message: 'Bạn có chắc muốn xóa tệp ảnh định danh này?',
          confirmLabel: 'Xóa ảnh',
          cancelLabel: 'Hủy bỏ',
          variant: ConfirmDialogVariant.danger,
          onClose: () => setState(() => _deleteImageTarget = null),
          onConfirm: _handleConfirmDeleteIdImage,
        ),
      ),
    );
  }

    return null;
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _tenant == null) {
      return const Scaffold(
        backgroundColor: AppColors.slate50,
        body: Center(child: LoadingSpinner(label: 'Đang tải thông tin cư dân...')),
      );
    }

    final permissions = ref.watch(permissionProvider);
    final canManageTenants = permissions.canManageTenants;

    // Strict PII protection check: maskedForOwner from API OR isTenantIdImagesMasked from role
    final isMaskedForOwner = _idImagesMeta['maskedForOwner'] == true || permissions.isTenantIdImagesMasked;
    final hasIdImages = _idImagesMeta['hasIdImages'] == true;

    final tenant = _tenant ?? {};
    final fullName = tenant['full_name']?.toString() ?? 'Hồ sơ cư dân';
    final status = tenant['status']?.toString() ?? 'INACTIVE';
    final isPending = status == 'PENDING';

    final contracts = (tenant['contracts'] is List) ? tenant['contracts'] as List : [];
    final occupants = (tenant['occupants'] is List) ? tenant['occupants'] as List : [];

    final latestFrontImg = _idImages.reversed.firstWhere(
      (img) => img is Map && img['side'] == 'front',
      orElse: () => null,
    );
    final latestBackImg = _idImages.reversed.firstWhere(
      (img) => img is Map && img['side'] == 'back',
      orElse: () => null,
    );

    final activeModal = _buildActiveModal(
      isMaskedForOwner,
      isPending,
      canManageTenants,
      tenant,
      latestFrontImg,
      latestBackImg,
    );

    return Scaffold(
      backgroundColor: AppColors.slate50,
      body: Stack(
        children: [
          SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Page Header with back button & action buttons
            PageHeader(
              title: fullName,
              subtitle: 'Mã hồ sơ: ${widget.tenantId} • SĐT: ${tenant['phone'] ?? '—'}',
              showBack: true,
              onBack: () => context.go('/admin/tenants'),
              actions: Wrap(
                spacing: 8,
                runSpacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  if (canManageTenants && isPending) ...[
                    AppButton(
                      text: 'Từ chối / Bổ sung',
                      variant: AppButtonVariant.danger,
                      icon: const Icon(LucideIcons.circleX, size: 16),
                      onPressed: () {
                        setState(() {
                          _approvalAction = 'reject';
                          _approvalReason = '';
                          _approvalError = '';
                          _approvalDialogOpen = true;
                        });
                      },
                    ),
                    AppButton(
                      text: 'Phê duyệt hồ sơ',
                      variant: AppButtonVariant.success,
                      icon: const Icon(LucideIcons.circleCheck, size: 16),
                      onPressed: () {
                        setState(() {
                          _approvalAction = 'approve';
                          _approvalReason = '';
                          _approvalError = '';
                          _approvalDialogOpen = true;
                        });
                      },
                    ),
                  ],
                  if (canManageTenants && status != 'MERGED') ...[
                    if (!_isEditing)
                      AppButton(
                        text: 'Chỉnh sửa',
                        variant: AppButtonVariant.outline,
                        icon: const Icon(LucideIcons.pencil, size: 16),
                        onPressed: () => setState(() => _isEditing = true),
                      )
                    else
                      AppButton(
                        text: 'Lưu thay đổi',
                        variant: AppButtonVariant.primary,
                        icon: const Icon(LucideIcons.save, size: 16),
                        loading: _saving,
                        onPressed: _handleSaveProfile,
                      ),
                    AppButton(
                      text: 'Xóa hồ sơ',
                      variant: AppButtonVariant.danger,
                      icon: const Icon(LucideIcons.trash2, size: 16),
                      onPressed: () => setState(() => _deleteTenantOpen = true),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 16),

            // Tabs
            AppTabs(
              activeTab: _activeTab,
              tabs: [
                const AppTabItem(id: 'profile', label: 'Hồ sơ & Giấy tờ'),
                AppTabItem(id: 'contracts', label: 'Lịch sử hợp đồng', count: contracts.length),
                AppTabItem(id: 'occupants', label: 'Thành viên ở cùng', count: occupants.length),
              ],
              onChanged: (tabId) => setState(() => _activeTab = tabId),
            ),
            const SizedBox(height: 20),

            // Tab Content
            if (_activeTab == 'profile')
              LayoutBuilder(
                builder: (context, constraints) {
                  final isWide = constraints.maxWidth >= 960;
                  final leftCard = AppCard(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          alignment: WrapAlignment.spaceBetween,
                          crossAxisAlignment: WrapCrossAlignment.center,
                          children: [
                            const Text(
                              'Thông tin định danh',
                              style: TextStyle(
                                fontFamily: 'Inter',
                                fontSize: 16,
                                fontWeight: FontWeight.w600,
                                color: AppColors.slate900,
                              ),
                            ),
                            StatusBadge(status: status, domain: StatusDomain.tenant),
                          ],
                        ),
                        const SizedBox(height: 16),

                        AISuggestionField(
                          active: _cccdAiTracker?['fields']?['full_name']?['active'] == true,
                          confidence: _cccdAiTracker?['fields']?['full_name']?['confidence'],
                          onDismiss: () => setState(() => _cccdAiTracker?['fields']?.remove('full_name')),
                          child: AppInput(
                            label: 'Họ và tên',
                            required: true,
                            enabled: _isEditing,
                            initialValue: _form['full_name']?.toString(),
                            error: _errors['full_name'],
                            onChanged: (val) => _form['full_name'] = val,
                          ),
                        ),
                        const SizedBox(height: 12),

                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: AppInput(
                                label: 'Số điện thoại',
                                required: true,
                                enabled: _isEditing,
                                initialValue: _form['phone']?.toString(),
                                error: _errors['phone'],
                                onChanged: (val) => _form['phone'] = val,
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: AppInput(
                                label: 'Email',
                                enabled: _isEditing,
                                initialValue: _form['email']?.toString(),
                                error: _errors['email'],
                                onChanged: (val) => _form['email'] = val,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),

                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: AISuggestionField(
                                active: _cccdAiTracker?['fields']?['id_number']?['active'] == true,
                                confidence: _cccdAiTracker?['fields']?['id_number']?['confidence'],
                                onDismiss: () => setState(() => _cccdAiTracker?['fields']?.remove('id_number')),
                                child: AppInput(
                                  label: 'Số CCCD / Hộ chiếu',
                                  enabled: _isEditing,
                                  initialValue: _form['id_number']?.toString(),
                                  error: _errors['id_number'],
                                  onChanged: (val) => _form['id_number'] = val,
                                ),
                              ),
                            ),
                            const SizedBox(width: 12),
                            Expanded(
                              child: AISuggestionField(
                                active: _cccdAiTracker?['fields']?['dob']?['active'] == true,
                                confidence: _cccdAiTracker?['fields']?['dob']?['confidence'],
                                onDismiss: () => setState(() => _cccdAiTracker?['fields']?.remove('dob')),
                                child: AppInput(
                                  label: 'Ngày sinh (YYYY-MM-DD)',
                                  enabled: _isEditing,
                                  initialValue: _form['dob']?.toString(),
                                  onChanged: (val) => _form['dob'] = val,
                                ),
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 12),

                        AppInput(
                          label: 'Quốc tịch',
                          enabled: _isEditing,
                          initialValue: _form['nationality']?.toString(),
                          onChanged: (val) => _form['nationality'] = val,
                        ),
                        const SizedBox(height: 12),

                        AISuggestionField(
                          active: _cccdAiTracker?['fields']?['address']?['active'] == true,
                          confidence: _cccdAiTracker?['fields']?['address']?['confidence'],
                          onDismiss: () => setState(() => _cccdAiTracker?['fields']?.remove('address')),
                          child: AppInput(
                            label: 'Địa chỉ thường trú',
                            enabled: _isEditing,
                            initialValue: _form['address']?.toString(),
                            onChanged: (val) => _form['address'] = val,
                          ),
                        ),
                      ],
                    ),
                  );

                  final rightCard = AppCard(
                    padding: const EdgeInsets.all(20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            const Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    'Ảnh định danh CCCD / Hộ chiếu',
                                    style: TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 16,
                                      fontWeight: FontWeight.w600,
                                      color: AppColors.slate900,
                                    ),
                                  ),
                                  SizedBox(height: 2),
                                  Text(
                                    'Lưu trữ bảo mật và ghi nhật ký truy cập (PRD 17.1)',
                                    style: TextStyle(
                                      fontFamily: 'Inter',
                                      fontSize: 12,
                                      color: AppColors.slate500,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),
                            if (isMaskedForOwner)
                              AppBadge(
                                label: hasIdImages ? 'Đã lưu bảo mật' : 'Ẩn theo quyền CĐT',
                                variant: AppBadgeVariant.indigo,
                              )
                            else if (latestFrontImg != null && latestBackImg != null)
                              const AppBadge(
                                label: 'Đủ 2 mặt',
                                variant: AppBadgeVariant.emerald,
                              )
                            else
                              const AppBadge(
                                label: 'Chưa đủ 2 mặt',
                                variant: AppBadgeVariant.amber,
                              ),
                          ],
                        ),
                        const SizedBox(height: 16),

                        // STRICT PII PROTECTION NOTICE (TenantDetailPage.jsx:985-995)
                        if (isMaskedForOwner)
                          Container(
                            padding: const EdgeInsets.all(14),
                            decoration: BoxDecoration(
                              color: const Color(0xFFEEF2FF), // Indigo 50
                              borderRadius: BorderRadius.circular(12),
                              border: Border.all(color: const Color(0xFFC7D2FE)), // Indigo 200
                            ),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Row(
                                  children: [
                                    Icon(LucideIcons.shieldCheck, size: 16, color: AppColors.secondary600),
                                    SizedBox(width: 8),
                                    Expanded(
                                      child: Text(
                                        'Bảo mật giấy tờ tùy thân gốc (PRD Mục 13.5)',
                                        style: TextStyle(
                                          fontFamily: 'Inter',
                                          fontWeight: FontWeight.w600,
                                          fontSize: 13,
                                          color: Color(0xFF1E1B4B), // Indigo 950
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  hasIdImages
                                      ? 'Hồ sơ này đã có tệp ảnh CCCD/Hộ chiếu được lưu trữ mã hóa. Theo quy định phân quyền, chỉ Ban Quản Lý tòa nhà và Quản trị hệ thống mới có quyền xem ảnh gốc.'
                                      : 'Theo quy định phân quyền, ảnh chụp CCCD/Hộ chiếu gốc chỉ hiển thị với Ban Quản Lý tòa nhà và Quản trị hệ thống.',
                                  style: const TextStyle(
                                    fontFamily: 'Inter',
                                    fontSize: 12,
                                    color: Color(0xFF3730A3), // Indigo 800
                                    height: 1.4,
                                  ),
                                ),
                              ],
                            ),
                          )
                        else ...[
                          // AI CCCD scan section for MANAGER
                          if (canManageTenants && status != 'MERGED') ...[
                            Container(
                              padding: const EdgeInsets.all(14),
                              decoration: BoxDecoration(
                                color: const Color(0xFFEEF2FF),
                                borderRadius: BorderRadius.circular(12),
                                border: Border.all(color: const Color(0xFFC7D2FE)),
                              ),
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Wrap(
                                    alignment: WrapAlignment.spaceBetween,
                                    crossAxisAlignment: WrapCrossAlignment.center,
                                    spacing: 8,
                                    runSpacing: 4,
                                    children: [
                                      const Row(
                                        mainAxisSize: MainAxisSize.min,
                                        children: [
                                          Icon(LucideIcons.sparkles, size: 16, color: AppColors.secondary600),
                                          SizedBox(width: 8),
                                          Text(
                                            'Quét nhanh CCCD bằng AI (AI-01)',
                                            style: TextStyle(
                                              fontFamily: 'Inter',
                                              fontWeight: FontWeight.w600,
                                              color: Color(0xFF1E1B4B),
                                            ),
                                          ),
                                        ],
                                      ),
                                      if (_cccdAiTracker?['suggestionId'] != null)
                                        InkWell(
                                          onTap: _handleRejectAiDraft,
                                          child: const Text(
                                            'Hủy nháp AI',
                                            style: TextStyle(
                                              fontFamily: 'Inter',
                                              fontSize: 11,
                                              fontWeight: FontWeight.w600,
                                              color: AppColors.rose600,
                                              decoration: TextDecoration.underline,
                                            ),
                                          ),
                                        ),
                                    ],
                                  ),
                                  const SizedBox(height: 8),
                                  FileUploadField(
                                    label: 'Chọn tệp ảnh CCCD để quét',
                                    multiple: true,
                                    maxFiles: 2,
                                    value: _aiScanFiles,
                                    onChanged: (val) {
                                      if (val is List) {
                                        setState(() => _aiScanFiles = val.cast<String>());
                                      } else if (val is String && val.isNotEmpty) {
                                        setState(() => _aiScanFiles = [val]);
                                      }
                                    },
                                  ),
                                  const SizedBox(height: 8),
                                  Row(
                                    children: [
                                      Checkbox(
                                        value: _aiScanConsent,
                                        onChanged: (v) => setState(() => _aiScanConsent = v ?? true),
                                      ),
                                      const Expanded(
                                        child: Text(
                                          'Đồng thuận quyền riêng tư trước khi gửi AI',
                                          style: TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate700),
                                        ),
                                      ),
                                    ],
                                  ),
                                  if (_cccdAiError != null)
                                    Padding(
                                      padding: const EdgeInsets.only(bottom: 8),
                                      child: Text(
                                        _cccdAiError!,
                                        style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.rose600),
                                      ),
                                    ),
                                  AppButton(
                                    text: 'Quét nhanh CCCD',
                                    icon: const Icon(LucideIcons.sparkles, size: 16),
                                    loading: _extractingCccd,
                                    variant: AppButtonVariant.primary,
                                    onPressed: _handleExtractDetailCccd,
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 16),
                          ],

                          // CCCD Front Slot
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'Mặt trước CCCD',
                                style: TextStyle(fontFamily: 'Inter', fontWeight: FontWeight.w600, color: AppColors.slate700),
                              ),
                              const SizedBox(height: 6),
                              if (latestFrontImg != null) ...[
                                Container(
                                  height: 160,
                                  width: double.infinity,
                                  decoration: BoxDecoration(
                                    color: AppColors.slate900.withValues(alpha: 0.05),
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(color: AppColors.slate200),
                                  ),
                                  child: AuthImage(
                                    src: latestFrontImg['url']?.toString() ?? latestFrontImg['image_url']?.toString(),
                                    alt: 'CCCD mặt trước',
                                  ),
                                ),
                                const SizedBox(height: 6),
                                if (canManageTenants)
                                  Row(
                                    children: [
                                      AppButton(
                                        text: 'Xóa ảnh mặt trước',
                                        variant: AppButtonVariant.ghost,
                                        icon: const Icon(LucideIcons.trash2, size: 16),
                                        onPressed: () => setState(() => _deleteImageTarget = latestFrontImg),
                                      ),
                                    ],
                                  ),
                              ] else
                                FileUploadField(
                                  label: 'Tải lên mặt trước',
                                  onChanged: (val) {
                                    if (val != null && val.toString().isNotEmpty) {
                                      _handleUploadIdCard('front', val.toString());
                                    }
                                  },
                                ),
                            ],
                          ),
                          const SizedBox(height: 16),

                          // CCCD Back Slot
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text(
                                'Mặt sau CCCD',
                                style: TextStyle(fontFamily: 'Inter', fontWeight: FontWeight.w600, color: AppColors.slate700),
                              ),
                              const SizedBox(height: 6),
                              if (latestBackImg != null) ...[
                                Container(
                                  height: 160,
                                  width: double.infinity,
                                  decoration: BoxDecoration(
                                    color: AppColors.slate900.withValues(alpha: 0.05),
                                    borderRadius: BorderRadius.circular(12),
                                    border: Border.all(color: AppColors.slate200),
                                  ),
                                  child: AuthImage(
                                    src: latestBackImg['url']?.toString() ?? latestBackImg['image_url']?.toString(),
                                    alt: 'CCCD mặt sau',
                                  ),
                                ),
                                const SizedBox(height: 6),
                                if (canManageTenants)
                                  Row(
                                    children: [
                                      AppButton(
                                        text: 'Xóa ảnh mặt sau',
                                        variant: AppButtonVariant.ghost,
                                        icon: const Icon(LucideIcons.trash2, size: 16),
                                        onPressed: () => setState(() => _deleteImageTarget = latestBackImg),
                                      ),
                                    ],
                                  ),
                              ] else
                                FileUploadField(
                                  label: 'Tải lên mặt sau',
                                  onChanged: (val) {
                                    if (val != null && val.toString().isNotEmpty) {
                                      _handleUploadIdCard('back', val.toString());
                                    }
                                  },
                                ),
                          ],
                        ),
                      ],
                    ],
                  ),
                );

                if (isWide) {
                  return Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(flex: 6, child: leftCard),
                      const SizedBox(width: 20),
                      Expanded(flex: 5, child: rightCard),
                    ],
                  );
                }
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    leftCard,
                    const SizedBox(height: 20),
                    rightCard,
                  ],
                );
              },
            )
            else if (_activeTab == 'contracts')
              AppCard(
                padding: EdgeInsets.zero,
                child: DataTableWidget<dynamic>(
                  columns: [
                    DataTableColumn<dynamic>(
                      key: 'code',
                      label: 'Mã hợp đồng',
                      render: (row) {
                        final id = row is Map ? row['id']?.toString() ?? '' : '';
                        final shortId = id.length >= 8 ? id.substring(0, 8).toUpperCase() : id;
                        return Text('HĐ-$shortId', style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold));
                      },
                    ),
                    DataTableColumn<dynamic>(
                      key: 'apartment_code',
                      label: 'Căn hộ / Tòa nhà',
                      render: (row) {
                        final apt = row is Map ? row['apartment_code']?.toString() ?? '' : '';
                        final bld = row is Map ? row['building_name']?.toString() ?? '' : '';
                        return Text('$apt • $bld');
                      },
                    ),
                    DataTableColumn<dynamic>(
                      key: 'start_date',
                      label: 'Thời hạn thuê',
                      align: TextAlign.center,
                      render: (row) {
                        final s = row is Map ? formatDate(row['start_date']) : '—';
                        final e = row is Map ? formatDate(row['end_date']) : '—';
                        return Text('$s → $e');
                      },
                    ),
                    DataTableColumn<dynamic>(
                      key: 'rent_amount',
                      label: 'Tiền thuê / tháng',
                      align: TextAlign.right,
                      render: (row) => Text(row is Map ? formatMoney(row['rent_amount']) : '0 ₫'),
                    ),
                    DataTableColumn<dynamic>(
                      key: 'status',
                      label: 'Trạng thái',
                      align: TextAlign.center,
                      render: (row) => StatusBadge(status: row is Map ? row['status']?.toString() : null),
                    ),
                  ],
                  data: contracts,
                  emptyTitle: 'Chưa có hợp đồng thuê nào',
                  emptyDescription: 'Cư dân này chưa tham gia hợp đồng thuê phòng nào.',
                ),
              )
            else if (_activeTab == 'occupants')
              AppCard(
                padding: EdgeInsets.zero,
                child: DataTableWidget<dynamic>(
                  columns: [
                    DataTableColumn<dynamic>(
                      key: 'full_name',
                      label: 'Họ và tên',
                      render: (row) => Text(row is Map ? row['full_name']?.toString() ?? '' : '', style: const TextStyle(fontWeight: FontWeight.w600)),
                    ),
                    DataTableColumn<dynamic>(
                      key: 'phone',
                      label: 'Số điện thoại',
                      render: (row) => Text(row is Map ? row['phone']?.toString() ?? '—' : '—'),
                    ),
                    DataTableColumn<dynamic>(
                      key: 'relationship',
                      label: 'Quan hệ với chủ HĐ',
                      render: (row) => Text(row is Map ? row['relationship']?.toString() ?? 'Người ở cùng' : '—'),
                    ),
                    DataTableColumn<dynamic>(
                      key: 'status',
                      label: 'Trạng thái',
                      render: (row) => StatusBadge(status: row is Map ? row['status']?.toString() : null, domain: StatusDomain.tenant),
                    ),
                  ],
                  data: occupants,
                  emptyTitle: 'Chưa có thành viên ở cùng',
                  emptyDescription: 'Không tìm thấy hồ sơ thành viên ở cùng nào.',
                ),
              ),
          ],
        ),
      ),
      if (activeModal != null)
        Positioned.fill(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: () {
              setState(() {
                _applicationReviewOpen = false;
                _approvalDialogOpen = false;
                _deleteTenantOpen = false;
                _deleteImageTarget = null;
              });
            },
            child: ColoredBox(
              color: AppColors.slate900.withValues(alpha: 0.45),
              child: Center(
                child: GestureDetector(
                  onTap: () {},
                  child: activeModal,
                ),
              ),
            ),
          ),
        ),
    ],
  ),
);
  }
}
