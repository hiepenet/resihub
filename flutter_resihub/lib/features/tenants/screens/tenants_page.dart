import 'dart:async';
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
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../services/tenants_service.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
import '../../../shared/widgets/common/stats_card.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/ai_suggestion_field.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';

String getAvatarLetters(String? fullName) {
  if (fullName == null || fullName.trim().isEmpty) return 'CD';
  final parts = fullName.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return 'CD';
  if (parts.length == 1) {
    return parts[0].substring(0, parts[0].length >= 2 ? 2 : 1).toUpperCase();
  }
  return '${parts[0][0]}${parts[parts.length - 1][0]}'.toUpperCase();
}

String getTenantDisplayStatus(dynamic tenant) {
  if (tenant == null) return 'INACTIVE';
  final status = tenant is Map ? tenant['status']?.toString() : null;
  if (status == 'MERGED') return 'MERGED';
  if (status == 'REJECTED') return 'REJECTED';

  final hasActiveContract = tenant is Map && tenant['active_contract'] != null;
  if (hasActiveContract || status == 'ACTIVE') {
    return 'ACTIVE';
  }
  if (status == 'PENDING') {
    return 'PENDING';
  }
  final hasPastContract = tenant is Map && tenant['has_past_contract'] == true;
  if (hasPastContract || status == 'MOVED_OUT' || status == 'INACTIVE') {
    return 'INACTIVE';
  }
  return 'APPROVED';
}

/// Admin Tenants & Resident Profiles Management Screen.
/// Port of `frontend/src/pages/admin/tenants/TenantsPage.jsx`.
class TenantsPage extends ConsumerStatefulWidget {
  const TenantsPage({super.key});

  @override
  ConsumerState<TenantsPage> createState() => _TenantsPageState();
}

class _TenantsPageState extends ConsumerState<TenantsPage> {
  List<dynamic> _tenants = [];
  bool _loading = true;
  String _search = '';
  String _statusFilter = '';
  String _typeFilter = '';
  bool _showMerged = false;

  // Create Modal state
  bool _createOpen = false;
  final Map<String, dynamic> _createForm = {
    'full_name': '',
    'phone': '',
    'email': '',
    'id_number': '',
    'dob': '',
    'nationality': 'Việt Nam',
    'address': '',
    'type': 'primary',
    'password': '',
    'privacy_consent': true,
  };
  Map<String, String> _createIdImages = {'front': '', 'back': ''};
  Map<String, String> _createErrors = {};
  bool _submittingCreate = false;
  bool _dupChecking = false;
  Map<String, dynamic> _dupInfo = {
    'isDuplicate': false,
    'inScope': true,
    'duplicates': [],
    'message': '',
  };
  Timer? _dupTimer;
  bool _extractingCccd = false;
  Map<String, dynamic>? _cccdAiTracker;
  bool _cccdAiConsent = true;
  String? _cccdAiError;

  // Edit Modal state
  bool _editOpen = false;
  dynamic _editingTenant;
  final Map<String, dynamic> _editForm = {
    'full_name': '',
    'phone': '',
    'email': '',
    'id_number': '',
    'dob': '',
    'nationality': 'Việt Nam',
    'address': '',
  };
  Map<String, String> _editErrors = {};
  bool _submittingEdit = false;

  // Merge Modal state
  bool _mergeOpen = false;
  final Map<String, String> _mergeForm = {
    'source_tenant_id': '',
    'target_tenant_id': '',
    'reason': 'Gộp hồ sơ cư dân trùng thông tin liên hệ / CCCD',
  };
  bool _submittingMerge = false;

  // Delete state
  dynamic _deleteTarget;

  @override
  void initState() {
    super.initState();
    _fetchTenants();
  }

  @override
  void dispose() {
    _dupTimer?.cancel();
    super.dispose();
  }

  Future<void> _fetchTenants({bool force = false}) async {
    final tenantsService = ref.read(tenantsServiceProvider);
    final cached = tenantsService.peekList();
    if (cached != null && cached is Map && cached['data'] is List && !force) {
      setState(() {
        _tenants = List<dynamic>.from(cached['data']);
        _loading = false;
      });
      return;
    }

    setState(() => _loading = true);
    try {
      final res = await tenantsService.list(null, null, force);
      final list = (res is Map && res['data'] is List) ? res['data'] as List : [];
      setState(() {
        _tenants = List<dynamic>.from(list);
      });
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải danh sách cư dân.'),
          );
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  void _onCheckDupDebounced() {
    _dupTimer?.cancel();
    final phone = normalizePhone(_createForm['phone']?.toString());
    final idNumber = (_createForm['id_number']?.toString() ?? '').trim();
    final shouldCheckPhone = phone.length == 10;
    final shouldCheckId = idNumber.length >= 9;

    if (!shouldCheckPhone && !shouldCheckId) {
      setState(() {
        _dupInfo = {'isDuplicate': false, 'inScope': true, 'duplicates': [], 'message': ''};
      });
      return;
    }

    _dupTimer = Timer(const Duration(milliseconds: 400), () async {
      setState(() => _dupChecking = true);
      try {
        final params = <String, dynamic>{};
        if (shouldCheckPhone) params['phone'] = phone;
        if (shouldCheckId) params['id_number'] = idNumber;

        final res = await ref.read(tenantsServiceProvider).checkDup(params);
        if (mounted) {
          setState(() {
            _dupInfo = {
              'isDuplicate': res is Map && res['isDuplicate'] == true,
              'inScope': res is Map ? res['inScope'] != false : true,
              'duplicates': res is Map && res['duplicates'] is List ? res['duplicates'] : [],
              'message': (res is Map && res['message'] != null) ? res['message'].toString() : '',
            };
          });
        }
      } catch (_) {
        // Ignored
      } finally {
        if (mounted) {
          setState(() => _dupChecking = false);
        }
      }
    });
  }

  Map<String, String> _validatePersonForm(Map<String, dynamic> form) {
    final errs = <String, String>{};
    final fullName = (form['full_name']?.toString() ?? '').trim();
    final phone = (form['phone']?.toString() ?? '').trim();
    final email = (form['email']?.toString() ?? '').trim();
    final idNumber = (form['id_number']?.toString() ?? '').trim();
    final password = (form['password']?.toString() ?? '');

    if (fullName.isEmpty) {
      errs['full_name'] = 'Vui lòng nhập họ và tên cư dân.';
    }
    if (phone.isEmpty) {
      errs['phone'] = 'Vui lòng nhập số điện thoại.';
    } else if (!isValidPhone(phone)) {
      errs['phone'] = 'Số điện thoại không đúng định dạng Việt Nam (10 số).';
    }
    if (email.isNotEmpty && !isValidEmail(email)) {
      errs['email'] = 'Địa chỉ email không hợp lệ.';
    }
    if (idNumber.isNotEmpty && !isValidIdNumber(idNumber)) {
      errs['id_number'] = 'CCCD/CMND (9 hoặc 12 số) hoặc Hộ chiếu không hợp lệ.';
    }
    if (password.isNotEmpty && password.length < 8) {
      errs['password'] = 'Mật khẩu đăng nhập ban đầu phải từ 8 ký tự trở lên.';
    }
    return errs;
  }

  Future<void> _handleExtractCreateCccd() async {
    final files = [_createIdImages['front'], _createIdImages['back']]
        .where((s) => s != null && s.isNotEmpty)
        .cast<String>()
        .toList();

    if (files.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn ít nhất 1 ảnh CCCD/Hộ chiếu trước khi trích xuất AI.');
      return;
    }

    setState(() {
      _extractingCccd = true;
      _cccdAiError = null;
    });

    try {
      final selectedBuildingId = ref.read(authProvider).selectedBuildingId;
      final res = await ref.read(aiServiceProvider).extractDocument({
        'document_type': 'CCCD',
        'building_id': selectedBuildingId.isNotEmpty ? selectedBuildingId : null,
        'files': files,
        'privacy_acknowledged': _cccdAiConsent,
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
          _createForm['full_name'] = mapped['full_name'];
        }
        if (mapped['id_number']?.isNotEmpty == true) {
          _createForm['id_number'] = mapped['id_number'];
        }
        if (mapped['dob']?.isNotEmpty == true) {
          _createForm['dob'] = mapped['dob'];
        }
        if (mapped['address']?.isNotEmpty == true) {
          _createForm['address'] = mapped['address'];
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
      });

      ref.read(toastProvider.notifier).success('AI đã trích xuất thông tin từ CCCD — vui lòng kiểm tra trước khi lưu.');
      _onCheckDupDebounced();
    } catch (err) {
      final aiErr = mapAiErrorToVietnamese(err);
      setState(() => _cccdAiError = '${aiErr.title}: ${aiErr.guidance}');
    } finally {
      if (mounted) {
        setState(() => _extractingCccd = false);
      }
    }
  }

  Future<void> _handleRejectCreateCccdAi() async {
    final suggId = _cccdAiTracker?['suggestionId']?.toString();
    setState(() => _cccdAiTracker = null);
    if (suggId != null && suggId.isNotEmpty) {
      try {
        await ref.read(aiServiceProvider).reviewSuggestion(suggId, {'decision': 'REJECT'});
      } catch (_) {}
    }
  }

  Future<void> _handleCreateSubmit() async {
    if (_dupInfo['isDuplicate'] == true) {
      ref.read(toastProvider.notifier).warning(
            'Phát hiện trùng SĐT hoặc CCCD (FR-021) — hệ thống chặn tạo mới bản ghi trùng. Vui lòng xem hồ sơ hiện có hoặc thực hiện Gộp hồ sơ.',
          );
      return;
    }

    final errs = _validatePersonForm(_createForm);
    setState(() => _createErrors = errs);
    if (errs.isNotEmpty) return;

    setState(() => _submittingCreate = true);
    try {
      final payload = {
        'full_name': _createForm['full_name'].toString().trim(),
        'phone': normalizePhone(_createForm['phone'].toString()),
        'email': _createForm['email'].toString().trim().isNotEmpty ? _createForm['email'].toString().trim() : null,
        'id_number': _createForm['id_number'].toString().trim().isNotEmpty ? _createForm['id_number'].toString().trim() : null,
        'dob': _createForm['dob'].toString().isNotEmpty ? _createForm['dob'] : null,
        'address': _createForm['address'].toString().trim().isNotEmpty ? _createForm['address'].toString().trim() : null,
        'nationality': _createForm['nationality'].toString().trim().isNotEmpty ? _createForm['nationality'].toString().trim() : 'Việt Nam',
        'type': _createForm['type'] == 'occupant' ? 'occupant' : 'primary',
        'privacy_consent': _createForm['privacy_consent'] == true,
        if (_createForm['password']?.toString().isNotEmpty == true) 'password': _createForm['password'],
        if (_cccdAiTracker?['suggestionId'] != null) 'ai_suggestion_id': _cccdAiTracker!['suggestionId'],
      };

      final res = await ref.read(tenantsServiceProvider).create(payload);
      final createdId = (res is Map && res['data'] is Map) ? res['data']['id']?.toString() : null;

      if (createdId != null) {
        if (_createIdImages['front']?.isNotEmpty == true) {
          try {
            await ref.read(tenantsServiceProvider).uploadIdImage(createdId, {
              'side': 'front',
              'image_base64': _createIdImages['front'],
            });
          } catch (_) {}
        }
        if (_createIdImages['back']?.isNotEmpty == true) {
          try {
            await ref.read(tenantsServiceProvider).uploadIdImage(createdId, {
              'side': 'back',
              'image_base64': _createIdImages['back'],
            });
          } catch (_) {}
        }
      }

      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Tạo hồ sơ cư dân thành công.',
          );
      setState(() => _createOpen = false);
      _fetchTenants(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể tạo hồ sơ cư dân.'));
    } finally {
      if (mounted) {
        setState(() => _submittingCreate = false);
      }
    }
  }

  void _handleOpenEdit(dynamic tenant) {
    if (tenant is! Map) return;
    setState(() {
      _editingTenant = tenant;
      _editForm['full_name'] = tenant['full_name']?.toString() ?? '';
      _editForm['phone'] = tenant['phone']?.toString() ?? '';
      _editForm['email'] = tenant['email']?.toString() ?? '';
      _editForm['id_number'] = tenant['id_number']?.toString() ?? '';
      _editForm['dob'] = tenant['dob'] != null ? toInputDate(tenant['dob']) : '';
      _editForm['nationality'] = tenant['nationality']?.toString() ?? 'Việt Nam';
      _editForm['address'] = tenant['address']?.toString() ?? '';
      _editErrors = {};
      _editOpen = true;
    });
  }

  Future<void> _handleEditSubmit() async {
    if (_editingTenant == null || _editingTenant is! Map) return;
    final errs = _validatePersonForm(_editForm);
    setState(() => _editErrors = errs);
    if (errs.isNotEmpty) return;

    setState(() => _submittingEdit = true);
    try {
      final payload = {
        'full_name': _editForm['full_name'].toString().trim(),
        'phone': normalizePhone(_editForm['phone'].toString()),
        'email': _editForm['email'].toString().trim().isNotEmpty ? _editForm['email'].toString().trim() : null,
        'id_number': _editForm['id_number'].toString().trim().isNotEmpty ? _editForm['id_number'].toString().trim() : null,
        'dob': _editForm['dob'].toString().isNotEmpty ? _editForm['dob'] : null,
        'address': _editForm['address'].toString().trim().isNotEmpty ? _editForm['address'].toString().trim() : null,
        'nationality': _editForm['nationality'].toString().trim().isNotEmpty ? _editForm['nationality'].toString().trim() : 'Việt Nam',
      };
      final id = _editingTenant['id'].toString();
      final res = await ref.read(tenantsServiceProvider).update(id, payload);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Cập nhật hồ sơ cư dân thành công.',
          );
      setState(() => _editOpen = false);
      _fetchTenants(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể cập nhật thông tin cư dân.'));
    } finally {
      if (mounted) {
        setState(() => _submittingEdit = false);
      }
    }
  }

  void _handleOpenMerge([dynamic sourceTenant]) {
    setState(() {
      _mergeForm['source_tenant_id'] = (sourceTenant is Map ? sourceTenant['id']?.toString() : '') ?? '';
      _mergeForm['target_tenant_id'] = '';
      _mergeForm['reason'] = 'Gộp hồ sơ cư dân trùng thông tin liên hệ / CCCD';
      _mergeOpen = true;
    });
  }

  Future<void> _handleMergeSubmit() async {
    final src = _mergeForm['source_tenant_id'] ?? '';
    final dst = _mergeForm['target_tenant_id'] ?? '';
    final reason = _mergeForm['reason']?.trim() ?? '';

    if (src.isEmpty || dst.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn đầy đủ hồ sơ cần gộp (nguồn) và hồ sơ chính giữ lại (đích).');
      return;
    }
    if (src == dst) {
      ref.read(toastProvider.notifier).warning('Hồ sơ nguồn và hồ sơ đích không được trùng nhau.');
      return;
    }
    if (reason.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do gộp hồ sơ để lưu vết kiểm toán (FR-021).');
      return;
    }

    setState(() => _submittingMerge = true);
    try {
      final res = await ref.read(tenantsServiceProvider).merge({
        'source_tenant_id': src,
        'target_tenant_id': dst,
        'reason': reason,
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã gộp hồ sơ cư dân thành công.',
          );
      setState(() => _mergeOpen = false);
      _fetchTenants(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể gộp hồ sơ cư dân.'));
    } finally {
      if (mounted) {
        setState(() => _submittingMerge = false);
      }
    }
  }

  Future<void> _handleConfirmDelete() async {
    if (_deleteTarget == null || _deleteTarget is! Map) return;
    final id = _deleteTarget['id'].toString();
    try {
      final res = await ref.read(tenantsServiceProvider).remove(id);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : 'Đã xóa hồ sơ cư dân "${_deleteTarget['full_name']}".',
          );
      setState(() => _deleteTarget = null);
      _fetchTenants(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể xóa hồ sơ cư dân.'));
    }
  }

  Widget? _buildActiveModal(List<dynamic> mergeableTenants) {
    if (_createOpen) {
      return Material(
        color: Colors.transparent,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            maxWidth: 672,
            maxHeight: MediaQuery.sizeOf(context).height * 0.9,
          ),
          child: AppModal(
          title: 'Tạo hồ sơ cư dân mới',
          subtitle: 'Nhập thông tin cư dân và tùy chọn quét CCCD bằng AI để tự động điền',
          size: AppModalSize.lg,
          onClose: () => setState(() => _createOpen = false),
          footer: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              AppButton(
                text: 'Hủy bỏ',
                variant: AppButtonVariant.outline,
                onPressed: () => setState(() => _createOpen = false),
              ),
              const SizedBox(width: 10),
              AppButton(
                text: 'Lưu cư dân',
                loading: _submittingCreate,
                onPressed: _handleCreateSubmit,
              ),
            ],
          ),
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // AI CCCD Extraction box
                Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: AppColors.primary50.withValues(alpha: 0.5),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: AppColors.primary200),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Row(
                        children: [
                          Icon(LucideIcons.sparkles, size: 16, color: AppColors.primary600),
                          SizedBox(width: 8),
                          Text(
                            'Quét nhanh CCCD bằng AI (AI-01)',
                            style: TextStyle(
                              fontFamily: 'Inter',
                              fontWeight: FontWeight.w600,
                              color: AppColors.primary900,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      const Text(
                        'Tải ảnh mặt trước và mặt sau thẻ CCCD để AI tự động trích xuất Họ tên, Số CCCD, Ngày sinh và Địa chỉ.',
                        style: TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.primary800),
                      ),
                      const SizedBox(height: 10),
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: FileUploadField(
                              label: 'Mặt trước CCCD',
                              value: _createIdImages['front'],
                              onChanged: (val) => setState(() => _createIdImages['front'] = val?.toString() ?? ''),
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: FileUploadField(
                              label: 'Mặt sau CCCD',
                              value: _createIdImages['back'],
                              onChanged: (val) => setState(() => _createIdImages['back'] = val?.toString() ?? ''),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Checkbox(
                            value: _cccdAiConsent,
                            onChanged: (v) => setState(() => _cccdAiConsent = v ?? true),
                          ),
                          const Expanded(
                            child: Text(
                              'Tôi xác nhận đã được cư dân đồng thuận cho phép gửi ảnh CCCD/Hộ chiếu để AI xử lý trích xuất dữ liệu tự động theo quy định bảo vệ dữ liệu cá nhân (PII).',
                              style: TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate700),
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      if (_cccdAiError != null)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: Text(
                            _cccdAiError!,
                            style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.rose600),
                          ),
                        ),
                      Row(
                        children: [
                          AppButton(
                            text: 'Quét nhanh bằng AI',
                            icon: const Icon(LucideIcons.sparkles, size: 16),
                            loading: _extractingCccd,
                            variant: AppButtonVariant.primary,
                            onPressed: _handleExtractCreateCccd,
                          ),
                          if (_cccdAiTracker != null) ...[
                            const SizedBox(width: 10),
                            AppButton(
                              text: 'Hủy gợi ý AI',
                              variant: AppButtonVariant.ghost,
                              onPressed: _handleRejectCreateCccdAi,
                            ),
                          ],
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),

                // Duplicate warning banner
                if (_dupInfo['isDuplicate'] == true) ...[
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.amber50,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: AppColors.amber300),
                    ),
                    child: Row(
                      children: [
                        _dupChecking
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(strokeWidth: 2, color: AppColors.amber600),
                              )
                            : const Icon(LucideIcons.triangleAlert, color: AppColors.amber600, size: 20),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            _dupInfo['message']?.toString() ?? 'Phát hiện cư dân đã tồn tại trong hệ thống (FR-021).',
                            style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.amber900),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),
                ],

                // Form Fields
                AISuggestionField(
                  active: _cccdAiTracker?['fields']?['full_name']?['active'] == true,
                  confidence: _cccdAiTracker?['fields']?['full_name']?['confidence'],
                  onDismiss: () => setState(() => _cccdAiTracker?['fields']?.remove('full_name')),
                  child: AppInput(
                    label: 'Họ và tên',
                    required: true,
                    initialValue: _createForm['full_name']?.toString(),
                    error: _createErrors['full_name'],
                    onChanged: (val) {
                      _createForm['full_name'] = val;
                      setState(() => _createErrors.remove('full_name'));
                    },
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
                        initialValue: _createForm['phone']?.toString(),
                        error: _createErrors['phone'],
                        onChanged: (val) {
                          _createForm['phone'] = val;
                          setState(() => _createErrors.remove('phone'));
                          _onCheckDupDebounced();
                        },
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: AppInput(
                        label: 'Email',
                        initialValue: _createForm['email']?.toString(),
                        error: _createErrors['email'],
                        onChanged: (val) {
                          _createForm['email'] = val;
                          setState(() => _createErrors.remove('email'));
                        },
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
                          label: 'CCCD / Hộ chiếu',
                          initialValue: _createForm['id_number']?.toString(),
                          error: _createErrors['id_number'],
                          onChanged: (val) {
                            _createForm['id_number'] = val;
                            setState(() => _createErrors.remove('id_number'));
                            _onCheckDupDebounced();
                          },
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
                          initialValue: _createForm['dob']?.toString(),
                          onChanged: (val) => _createForm['dob'] = val,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),

                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'Quốc tịch',
                        initialValue: _createForm['nationality']?.toString(),
                        onChanged: (val) => _createForm['nationality'] = val,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: AppSelect<String>(
                        label: 'Loại cư dân',
                        value: _createForm['type']?.toString(),
                        options: const [
                          AppSelectOption(value: 'primary', label: 'Khách đứng tên HĐ'),
                          AppSelectOption(value: 'occupant', label: 'Thành viên ở cùng'),
                        ],
                        onChanged: (val) => setState(() => _createForm['type'] = val ?? 'primary'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),

                AISuggestionField(
                  active: _cccdAiTracker?['fields']?['address']?['active'] == true,
                  confidence: _cccdAiTracker?['fields']?['address']?['confidence'],
                  onDismiss: () => setState(() => _cccdAiTracker?['fields']?.remove('address')),
                  child: AppInput(
                    label: 'Địa chỉ thường trú',
                    initialValue: _createForm['address']?.toString(),
                    onChanged: (val) => _createForm['address'] = val,
                  ),
                ),
                const SizedBox(height: 12),

                AppInput(
                  label: 'Mật khẩu khởi tạo tài khoản',
                  placeholder: 'Tối thiểu 8 ký tự (để trống nếu không tạo tài khoản Portal)',
                  initialValue: _createForm['password']?.toString(),
                  error: _createErrors['password'],
                  obscureText: true,
                  onChanged: (val) {
                    _createForm['password'] = val;
                    setState(() => _createErrors.remove('password'));
                  },
                ),
                const SizedBox(height: 12),

                Row(
                  children: [
                    Checkbox(
                      value: _createForm['privacy_consent'] == true,
                      onChanged: (v) => setState(() => _createForm['privacy_consent'] = v ?? true),
                    ),
                    const Expanded(
                      child: Text(
                        'Đồng thuận xử lý dữ liệu cư dân (GDPR / Nghị định 13/2023)',
                        style: TextStyle(fontFamily: 'Inter', fontSize: 13, color: AppColors.slate800),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  if (_editOpen) {
    return Material(
      color: Colors.transparent,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: 512,
          maxHeight: MediaQuery.sizeOf(context).height * 0.9,
        ),
        child: AppModal(
          title: 'Chỉnh sửa hồ sơ cư dân',
          subtitle: 'Cập nhật thông tin định danh và liên hệ',
          size: AppModalSize.md,
          onClose: () => setState(() => _editOpen = false),
          footer: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              AppButton(
                text: 'Hủy bỏ',
                variant: AppButtonVariant.outline,
                onPressed: () => setState(() => _editOpen = false),
              ),
              const SizedBox(width: 10),
              AppButton(
                text: 'Lưu thay đổi',
                loading: _submittingEdit,
                onPressed: _handleEditSubmit,
              ),
            ],
          ),
          child: SingleChildScrollView(
            child: Column(
              children: [
                AppInput(
                  label: 'Họ và tên',
                  required: true,
                  initialValue: _editForm['full_name']?.toString(),
                  error: _editErrors['full_name'],
                  onChanged: (val) {
                    _editForm['full_name'] = val;
                    setState(() => _editErrors.remove('full_name'));
                  },
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'Số điện thoại',
                        required: true,
                        initialValue: _editForm['phone']?.toString(),
                        error: _editErrors['phone'],
                        onChanged: (val) {
                          _editForm['phone'] = val;
                          setState(() => _editErrors.remove('phone'));
                        },
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: AppInput(
                        label: 'Email',
                        initialValue: _editForm['email']?.toString(),
                        error: _editErrors['email'],
                        onChanged: (val) {
                          _editForm['email'] = val;
                          setState(() => _editErrors.remove('email'));
                        },
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'CCCD / Hộ chiếu',
                        initialValue: _editForm['id_number']?.toString(),
                        error: _editErrors['id_number'],
                        onChanged: (val) {
                          _editForm['id_number'] = val;
                          setState(() => _editErrors.remove('id_number'));
                        },
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: AppInput(
                        label: 'Ngày sinh (YYYY-MM-DD)',
                        initialValue: _editForm['dob']?.toString(),
                        onChanged: (val) => _editForm['dob'] = val,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Quốc tịch',
                  initialValue: _editForm['nationality']?.toString(),
                  onChanged: (val) => _editForm['nationality'] = val,
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Địa chỉ',
                  initialValue: _editForm['address']?.toString(),
                  onChanged: (val) => _editForm['address'] = val,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  if (_mergeOpen) {
    return Material(
      color: Colors.transparent,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: 512,
          maxHeight: MediaQuery.sizeOf(context).height * 0.9,
        ),
        child: AppModal(
          title: 'Gộp hồ sơ cư dân trùng lặp (FR-021)',
          subtitle: 'Chuyển toàn bộ lịch sử hợp đồng và công nợ sang hồ sơ đích giữ lại',
          size: AppModalSize.md,
          onClose: () => setState(() => _mergeOpen = false),
          footer: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              AppButton(
                text: 'Hủy bỏ',
                variant: AppButtonVariant.outline,
                onPressed: () => setState(() => _mergeOpen = false),
              ),
              const SizedBox(width: 10),
              AppButton(
                text: 'Xác nhận gộp',
                variant: AppButtonVariant.primary,
                loading: _submittingMerge,
                onPressed: _handleMergeSubmit,
              ),
            ],
          ),
          child: SingleChildScrollView(
            child: Column(
              children: [
                AppSelect<String>(
                  label: 'Hồ sơ nguồn (bị gộp / sẽ đánh dấu MERGED)',
                  value: _mergeForm['source_tenant_id']?.isNotEmpty == true
                      ? _mergeForm['source_tenant_id']
                      : null,
                  options: mergeableTenants.map((t) {
                    final id = t['id'].toString();
                    final name = t['full_name']?.toString() ?? '';
                    final phone = t['phone']?.toString() ?? '';
                    return AppSelectOption(value: id, label: '$name ($phone)');
                  }).toList(),
                  onChanged: (val) => setState(() => _mergeForm['source_tenant_id'] = val ?? ''),
                ),
                const SizedBox(height: 12),
                AppSelect<String>(
                  label: 'Hồ sơ đích (giữ lại và tiếp nhận dữ liệu)',
                  value: _mergeForm['target_tenant_id']?.isNotEmpty == true
                      ? _mergeForm['target_tenant_id']
                      : null,
                  options: mergeableTenants.map((t) {
                    final id = t['id'].toString();
                    final name = t['full_name']?.toString() ?? '';
                    final phone = t['phone']?.toString() ?? '';
                    return AppSelectOption(value: id, label: '$name ($phone)');
                  }).toList(),
                  onChanged: (val) => setState(() => _mergeForm['target_tenant_id'] = val ?? ''),
                ),
                const SizedBox(height: 12),
                AppInput(
                  label: 'Lý do gộp hồ sơ',
                  required: true,
                  initialValue: _mergeForm['reason'],
                  onChanged: (val) => _mergeForm['reason'] = val,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  if (_deleteTarget != null) {
    return Material(
      color: Colors.transparent,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 448),
        child: ConfirmDialog(
          title: 'Xóa hồ sơ cư dân',
          message:
              'Bạn có chắc chắn muốn xóa hồ sơ cư dân "${_deleteTarget['full_name']}"? Thao tác này không thể hoàn tác.',
          confirmLabel: 'Xóa hồ sơ',
          cancelLabel: 'Hủy bỏ',
          variant: ConfirmDialogVariant.danger,
          onClose: () => setState(() => _deleteTarget = null),
          onConfirm: _handleConfirmDelete,
        ),
      ),
    );
  }

    return null;
  }

  @override
  Widget build(BuildContext context) {
    final permissions = ref.watch(permissionProvider);
    final canManageTenants = permissions.canManageTenants;
    final selectedBuildingId = ref.watch(authProvider).selectedBuildingId;

    // Filter scoped tenants
    final scopedTenants = _tenants.where((t) {
      if (t is! Map) return false;
      if (!_showMerged && t['status'] == 'MERGED') return false;
      if (selectedBuildingId.isNotEmpty) {
        final bId = t['active_contract']?['building_id']?.toString() ??
            t['desired_building_id']?.toString();
        if (bId != null && bId != selectedBuildingId) return false;
      }
      return true;
    }).toList();

    // Stats
    final activeTenants = scopedTenants.where((t) => t['status'] != 'MERGED').toList();
    int activeCount = 0;
    int pendingCount = 0;
    int inactiveCount = 0;

    for (final t in activeTenants) {
      final st = getTenantDisplayStatus(t);
      if (st == 'ACTIVE') {
        activeCount++;
      } else if (st == 'PENDING' || st == 'REJECTED') {
        pendingCount++;
      } else {
        inactiveCount++;
      }
    }

    // Filtered list
    final q = _search.trim().toLowerCase();
    final filteredTenants = scopedTenants.where((t) {
      final displayStatus = getTenantDisplayStatus(t);
      if (_statusFilter.isNotEmpty && displayStatus != _statusFilter) return false;
      if (_typeFilter.isNotEmpty && t['type'] != _typeFilter) return false;

      if (q.isNotEmpty) {
        final haystacks = [
          t['full_name'],
          t['phone'],
          t['id_number'],
          t['email'],
          t['nationality'],
          t['active_contract']?['apartment_code'],
          t['active_contract']?['building_name'],
        ].where((s) => s != null).map((s) => s.toString().toLowerCase()).join(' ');
        if (!haystacks.contains(q)) return false;
      }
      return true;
    }).toList();

    // Mergeable tenants
    final mergeableTenants = _tenants.where((t) => t is Map && t['status'] != 'MERGED').toList();

    final columns = [
      DataTableColumn<dynamic>(
        key: 'full_name',
        label: 'Cư dân',
        width: 240,
        sortable: true,
        sortValue: (r) => (r is Map ? r['full_name']?.toString() ?? '' : ''),
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          final fullName = row['full_name']?.toString() ?? '';
          final email = row['email']?.toString() ?? '';
          final type = row['type']?.toString();
          final isShared = row['is_shared_profile'] == true;
          final isMerged = row['status'] == 'MERGED';

          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 34,
                height: 34,
                decoration: BoxDecoration(
                  color: AppColors.primary50,
                  border: Border.all(color: AppColors.primary200),
                  shape: BoxShape.circle,
                ),
                alignment: Alignment.center,
                child: Text(
                  getAvatarLetters(fullName),
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 11,
                    fontWeight: FontWeight.w700,
                    color: AppColors.primary700,
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Wrap(
                      spacing: 4,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          fullName,
                          style: const TextStyle(
                            fontFamily: 'Inter',
                            fontWeight: FontWeight.w600,
                            color: AppColors.slate900,
                          ),
                        ),
                        if (type == 'occupant')
                          const AppBadge(
                            label: 'Ở cùng',
                            variant: AppBadgeVariant.indigo,
                          ),
                        if (isShared)
                          const AppBadge(
                            label: 'Liên tòa',
                            variant: AppBadgeVariant.sky,
                          ),
                        if (isMerged)
                          const AppBadge(
                            label: 'Đã gộp',
                            variant: AppBadgeVariant.slate,
                          ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      email.isNotEmpty ? email : 'Chưa có email',
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 12,
                        color: AppColors.slate500,
                      ),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'phone',
        label: 'Số điện thoại',
        width: 180,
        sortable: true,
        sortValue: (r) => (r is Map ? r['phone']?.toString() ?? '' : ''),
        render: (row) {
          final phone = row is Map ? row['phone']?.toString() : null;
          return Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(LucideIcons.phone, size: 14, color: AppColors.slate400),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  phone?.isNotEmpty == true ? phone! : '—',
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontWeight: FontWeight.w500,
                    color: AppColors.slate700,
                  ),
                ),
              ),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'id_number',
        label: 'CCCD / Hộ chiếu',
        width: 180,
        align: TextAlign.center,
        render: (row) {
          final idNum = row is Map ? row['id_number']?.toString() : null;
          if (idNum != null && idNum.trim().isNotEmpty) {
            return Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
              decoration: BoxDecoration(
                color: AppColors.slate100,
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: AppColors.slate200),
              ),
              child: Text(
                maskIdNumber(idNum),
                style: const TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: AppColors.slate800,
                ),
              ),
            );
          }
          return const Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(LucideIcons.triangleAlert, size: 14, color: AppColors.amber600),
              SizedBox(width: 4),
              Flexible(
                child: Text(
                  'Thiếu giấy tờ',
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: AppColors.amber600,
                  ),
                ),
              ),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'nationality',
        label: 'Quốc tịch',
        width: 120,
        align: TextAlign.center,
        render: (row) {
          final nat = row is Map ? row['nationality']?.toString() : null;
          return Text(
            nat?.isNotEmpty == true ? nat! : 'Việt Nam',
            style: const TextStyle(fontFamily: 'Inter', fontSize: 13, color: AppColors.slate700),
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'active_contract',
        label: 'Căn / Tòa hiện tại',
        width: 220,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          final ac = row['active_contract'];
          if (ac is Map) {
            final apt = ac['apartment_code']?.toString() ?? '';
            final bld = ac['building_name']?.toString() ?? '';
            return Text(
              '$apt${bld.isNotEmpty ? ' • $bld' : ''}',
              style: const TextStyle(
                fontFamily: 'Inter',
                fontSize: 13,
                fontWeight: FontWeight.w600,
                color: AppColors.primary600,
              ),
            );
          }
          final desApt = row['desired_apartment_code']?.toString();
          if (desApt != null && desApt.isNotEmpty) {
            return Text(
              'Đăng ký: Căn $desApt',
              style: const TextStyle(
                fontFamily: 'Inter',
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: AppColors.amber700,
              ),
            );
          }
          return const Text(
            'Chưa có HĐ hiệu lực',
            style: TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              fontStyle: FontStyle.italic,
              color: AppColors.slate400,
            ),
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'status',
        label: 'Trạng thái',
        width: 160,
        align: TextAlign.center,
        render: (row) {
          final st = getTenantDisplayStatus(row);
          return StatusBadge(status: st, domain: StatusDomain.tenant);
        },
      ),
      DataTableColumn<dynamic>(
        key: 'actions',
        label: 'Thao tác',
        width: 240,
        align: TextAlign.right,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          final id = row['id']?.toString() ?? '';

          return Row(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              IconButton(
                tooltip: 'Xem chi tiết',
                padding: const EdgeInsets.all(4),
                visualDensity: VisualDensity.compact,
                constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                icon: const Icon(LucideIcons.eye, size: 16, color: AppColors.slate500),
                onPressed: () => context.push('/admin/tenants/$id'),
              ),
              if (canManageTenants && row['status'] != 'MERGED') ...[
                const SizedBox(width: 4),
                IconButton(
                  tooltip: 'Chỉnh sửa',
                  padding: const EdgeInsets.all(4),
                  visualDensity: VisualDensity.compact,
                  constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                  icon: const Icon(LucideIcons.pencil, size: 16, color: AppColors.primary600),
                  onPressed: () => _handleOpenEdit(row),
                ),
                const SizedBox(width: 4),
                IconButton(
                  tooltip: 'Gộp hồ sơ',
                  padding: const EdgeInsets.all(4),
                  visualDensity: VisualDensity.compact,
                  constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                  icon: const Icon(LucideIcons.gitMerge, size: 16, color: AppColors.secondary600),
                  onPressed: () => _handleOpenMerge(row),
                ),
                const SizedBox(width: 4),
                IconButton(
                  tooltip: 'Xóa',
                  padding: const EdgeInsets.all(4),
                  visualDensity: VisualDensity.compact,
                  constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                  icon: const Icon(LucideIcons.trash2, size: 16, color: AppColors.rose600),
                  onPressed: () => setState(() => _deleteTarget = row),
                ),
              ],
            ],
          );
        },
      ),
    ];

    final activeModal = _buildActiveModal(mergeableTenants);

    return Scaffold(
      backgroundColor: AppColors.slate50,
      body: Stack(
        children: [
          SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            PageHeader(
              title: 'Hồ sơ cư dân',
              subtitle: 'Quản lý danh sách cư dân, thông tin liên hệ và định danh pháp lý',
              actions: canManageTenants
                  ? Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        AppButton(
                          text: 'Gộp hồ sơ',
                          variant: AppButtonVariant.outline,
                          icon: const Icon(LucideIcons.gitMerge, size: 16),
                          onPressed: () => _handleOpenMerge(),
                        ),
                        const SizedBox(width: 10),
                        AppButton(
                          text: 'Thêm cư dân',
                          variant: AppButtonVariant.primary,
                          icon: const Icon(LucideIcons.userPlus, size: 16),
                          onPressed: () {
                            setState(() {
                              _createForm['full_name'] = '';
                              _createForm['phone'] = '';
                              _createForm['email'] = '';
                              _createForm['id_number'] = '';
                              _createForm['dob'] = '';
                              _createForm['nationality'] = 'Việt Nam';
                              _createForm['address'] = '';
                              _createForm['type'] = 'primary';
                              _createForm['password'] = '';
                              _createForm['privacy_consent'] = true;
                              _createIdImages = {'front': '', 'back': ''};
                              _createErrors = {};
                              _dupInfo = {'isDuplicate': false, 'inScope': true, 'duplicates': [], 'message': ''};
                              _cccdAiTracker = null;
                              _cccdAiConsent = true;
                              _cccdAiError = null;
                              _createOpen = true;
                            });
                          },
                        ),
                      ],
                    )
                  : null,
            ),
            const SizedBox(height: 16),

            // KPI Stats row
            LayoutBuilder(
              builder: (context, constraints) {
                final isWide = constraints.maxWidth >= 900;
                return GridView.count(
                  crossAxisCount: isWide ? 4 : 2,
                  crossAxisSpacing: 16,
                  mainAxisSpacing: 16,
                  childAspectRatio: isWide ? 2.2 : 1.7,
                  shrinkWrap: true,
                  physics: const NeverScrollableScrollPhysics(),
                  children: [
                    StatsCard(
                      title: 'Tổng cư dân',
                      value: activeTenants.length,
                      icon: LucideIcons.users,
                      color: 'sky',
                    ),
                    StatsCard(
                      title: 'Đang thuê',
                      value: activeCount,
                      icon: LucideIcons.userCheck,
                      color: 'emerald',
                    ),
                    StatsCard(
                      title: 'Chờ duyệt / Thiếu giấy tờ',
                      value: pendingCount,
                      icon: LucideIcons.clock,
                      color: 'amber',
                    ),
                    StatsCard(
                      title: 'Đã trả phòng',
                      value: inactiveCount,
                      icon: LucideIcons.userMinus,
                      color: 'rose',
                    ),
                  ],
                );
              },
            ),
            const SizedBox(height: 20),

            // Filter row
            AppCard(
              padding: const EdgeInsets.all(16),
              child: Wrap(
                spacing: 12,
                runSpacing: 12,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  SizedBox(
                    width: 280,
                    child: SearchBarWidget(
                      placeholder: 'Tìm theo tên, SĐT, CCCD, căn hộ...',
                      value: _search,
                      onChanged: (val) => setState(() => _search = val),
                    ),
                  ),
                  SizedBox(
                    width: 220,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả trạng thái',
                      value: _statusFilter.isNotEmpty ? _statusFilter : null,
                      options: const [
                        AppSelectOption(value: '', label: 'Tất cả trạng thái'),
                        AppSelectOption(value: 'ACTIVE', label: 'Đang thuê (ACTIVE)'),
                        AppSelectOption(value: 'APPROVED', label: 'Đã duyệt — Chờ lập HĐ (APPROVED)'),
                        AppSelectOption(value: 'PENDING', label: 'Chờ duyệt / Thiếu giấy tờ (PENDING)'),
                        AppSelectOption(value: 'REJECTED', label: 'Từ chối hồ sơ (REJECTED)'),
                        AppSelectOption(value: 'INACTIVE', label: 'Đã trả phòng (MOVED_OUT)'),
                      ],
                      onChanged: (val) => setState(() => _statusFilter = val ?? ''),
                    ),
                  ),
                  SizedBox(
                    width: 200,
                    child: AppSelect<String>(
                      placeholder: 'Tất cả phân loại',
                      value: _typeFilter.isNotEmpty ? _typeFilter : null,
                      options: const [
                        AppSelectOption(value: '', label: 'Tất cả phân loại'),
                        AppSelectOption(value: 'primary', label: 'Khách đứng tên HĐ'),
                        AppSelectOption(value: 'occupant', label: 'Thành viên ở cùng'),
                      ],
                      onChanged: (val) => setState(() => _typeFilter = val ?? ''),
                    ),
                  ),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Checkbox(
                        value: _showMerged,
                        onChanged: (v) => setState(() => _showMerged = v ?? false),
                      ),
                      const Text(
                        'Hiện hồ sơ đã gộp',
                        style: TextStyle(fontFamily: 'Inter', fontSize: 13, color: AppColors.slate700),
                      ),
                    ],
                  ),
                  IconButton(
                    tooltip: 'Tải lại',
                    icon: const Icon(LucideIcons.refreshCw, size: 18, color: AppColors.slate600),
                    onPressed: () => _fetchTenants(force: true),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),

            // DataTable
            AppCard(
              padding: EdgeInsets.zero,
              child: DataTableWidget<dynamic>(
                columns: columns,
                data: filteredTenants,
                loading: _loading,
                onRowClick: (row) {
                  if (row is Map && row['id'] != null) {
                    context.push('/admin/tenants/${row['id']}');
                  }
                },
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
                _createOpen = false;
                _editOpen = false;
                _mergeOpen = false;
                _deleteTarget = null;
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
