import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/network/dio_client.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/date_range.dart';
import '../../../core/utils/deposit_ui_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/idempotency.dart';
import '../../../core/utils/notification_navigation.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/bank_select.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/app_skeleton.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../../../shared/widgets/ui/money_input.dart';
import '../../auth/providers/permission_provider.dart';
import '../services/buildings_service.dart';

const List<String> _kApartmentTypeOptions = [
  'Studio',
  '1PN',
  '2PN',
  '3PN',
  'Penthouse',
  'Duplex',
];

/// Chi tiết Căn hộ & Quản lý Giữ chỗ 4 Mắt — `ApartmentDetailPage` (M03–M04).
/// Port of `frontend/src/pages/admin/apartments/ApartmentDetailPage.jsx`.
class ApartmentDetailPage extends ConsumerStatefulWidget {
  final String apartmentId;
  final String? initialReservationId;
  final String? initialModal;

  const ApartmentDetailPage({
    super.key,
    required this.apartmentId,
    this.initialReservationId,
    this.initialModal,
  });

  @override
  ConsumerState<ApartmentDetailPage> createState() => _ApartmentDetailPageState();
}

class _ApartmentDetailPageState extends ConsumerState<ApartmentDetailPage> {
  Map<String, dynamic>? _apt;
  List<Map<String, dynamic>> _zones = [];
  Map<String, dynamic> _cancelPolicy = kDefaultReservationCancelPolicy;
  bool _allowSelfApproval = false;
  bool _loading = true;
  bool _saving = false;
  bool _deletingApt = false;
  bool _deepLinkHandled = false;

  // Edit apartment modal
  bool _editOpen = false;
  String _formZoneId = '';
  String _formType = '1PN';
  int _formBedrooms = 1;
  double _formAreaM2 = 0;
  int _formBaseRent = 0;
  String _formNote = '';
  String _formAmenitiesText = '';

  // Handover modal
  bool _handoverOpen = false;
  String _handoverNote = '';
  List<String> _handoverEvidence = [];
  bool _keepMaintenance = false;

  // Create reservation modal
  bool _createRsvOpen = false;
  String _createProspectName = '';
  String _createPhone = '';
  int _createHoldAmount = 2000000;
  String _createMethod = 'BANK_TRANSFER';
  String _createHoldFrom = '';
  String _createHoldUntil = '';
  List<String> _createEvidence = [];
  String _createNote = '';
  String _createIdemKey = '';

  // Reject payment modal
  bool _rejectModalOpen = false;
  Map<String, dynamic>? _rejectTargetRsv;
  String _rejectReason = '';
  String _rejectIdemKey = '';

  // Cancel settlement proposal modal (Step 1)
  bool _settleModalOpen = false;
  Map<String, dynamic>? _settleTargetRsv;
  ReservationCancelSplitResult _settleSuggested =
      const ReservationCancelSplitResult(refundedAmount: 0, forfeitedAmount: 0);
  int _settleRefundedAmount = 0;
  int _settleForfeitedAmount = 0;
  String _settleRefundMethod = 'BANK_TRANSFER';
  String _settleBankName = '';
  String _settleBankCode = '';
  String _settleBankBin = '';
  String _settleBankLogo = '';
  String _settleAccountNumber = '';
  String _settleAccountHolder = '';
  String _settleReason = '';
  String _settleIdemKey = '';

  // Review cancel modal (Step 2 - 4-Eyes)
  bool _reviewCancelOpen = false;
  Map<String, dynamic>? _reviewTargetRsv;
  String _reviewMode = 'approve'; // 'approve' or 'reject'
  String _reviewNote = '';
  String _reviewRejectReason = '';
  String _reviewIdemKey = '';

  // Payout cancel modal (Step 3)
  bool _payoutModalOpen = false;
  Map<String, dynamic>? _payoutTargetRsv;
  String _payoutRefundMethod = 'BANK_TRANSFER';
  String _payoutBankName = '';
  String _payoutBankCode = '';
  String _payoutBankBin = '';
  String _payoutBankLogo = '';
  String _payoutAccountNumber = '';
  String _payoutAccountHolder = '';
  List<String> _payoutEvidence = [];
  String _payoutReferenceCode = '';
  String _payoutNote = '';
  String _payoutIdemKey = '';

  // Edit reservation bank modal
  bool _editBankOpen = false;
  Map<String, dynamic>? _editBankTargetRsv;
  String _editBankName = '';
  String _editBankCode = '';
  String _editBankBin = '';
  String _editBankLogo = '';
  String _editAccountNumber = '';
  String _editAccountHolder = '';
  String _editBankIdemKey = '';

  // Review reservation modal from deep link (?reservation_id=...&modal=reservation)
  Map<String, dynamic>? _deepLinkReviewRsv;

  @override
  void initState() {
    super.initState();
    _loadInitialData();
  }

  @override
  void didUpdateWidget(covariant ApartmentDetailPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.apartmentId != oldWidget.apartmentId) {
      _fetchApartment(force: true);
    }
  }

  void _loadInitialData() {
    final today = toDateOnlyStr(DateTime.now());
    _createHoldFrom = today;
    _createHoldUntil = addDaysStr(today, 5);

    _fetchSettingsAndPolicy();
    _fetchApartment();
  }

  Future<void> _fetchSettingsAndPolicy() async {
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      final polRes = await buildingsService.getReservationCancelPolicy();
      if (polRes is Map && polRes['data'] is Map) {
        if (mounted) {
          setState(() {
            _cancelPolicy = Map<String, dynamic>.from(polRes['data'] as Map);
          });
        }
      }
    } catch (_) {}

    try {
      final dio = ref.read(dioProvider);
      final setRes = await dio.get<dynamic>('/api/v1/settings');
      if (setRes.data is Map && (setRes.data as Map)['data'] is Map) {
        final d = (setRes.data as Map)['data'] as Map;
        final approvalConfig = d['approval_config'];
        if (approvalConfig is Map && mounted) {
          setState(() {
            _allowSelfApproval = approvalConfig['allow_self_approval'] == true;
          });
        }
      }
    } catch (_) {}
  }

  Future<void> _fetchApartment({bool force = false}) async {
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      final res = await buildingsService.getApartment(widget.apartmentId, force: force);
      if (!mounted) return;

      Map<String, dynamic> data = {};
      if (res is Map && res['data'] is Map) {
        data = Map<String, dynamic>.from(res['data'] as Map);
      } else if (res is Map) {
        data = Map<String, dynamic>.from(res);
      }

      List<Map<String, dynamic>> zoneList = [];
      if (data['zones'] is List) {
        zoneList = (data['zones'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
      } else if (data['building_id'] != null) {
        try {
          final zRes = await buildingsService.listZones(data['building_id'].toString(), force: force);
          if (zRes is Map && zRes['data'] is List) {
            zoneList = (zRes['data'] as List)
                .whereType<Map>()
                .map((e) => Map<String, dynamic>.from(e))
                .toList();
          }
        } catch (_) {}
      }

      String amenitiesStr = '';
      if (data['amenities'] is Map) {
        amenitiesStr = (data['amenities'] as Map)
            .entries
            .where((e) => e.value == true)
            .map((e) => e.key.toString())
            .join(', ');
      }

      setState(() {
        _apt = data;
        _zones = zoneList;
        _loading = false;
        _formZoneId = data['zone_id']?.toString() ?? '';
        _formType = data['type']?.toString() ?? '1PN';
        _formBedrooms = num.tryParse(data['bedrooms']?.toString() ?? '')?.toInt() ?? 1;
        _formAreaM2 = num.tryParse(data['area_m2']?.toString() ?? '')?.toDouble() ?? 0.0;
        _formBaseRent = num.tryParse(data['base_rent']?.toString() ?? '')?.toInt() ?? 0;
        _formNote = data['note']?.toString() ?? '';
        _formAmenitiesText = amenitiesStr;
      });

      _checkDeepLink();
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(extractErrorMessage(err));
      }
    }
  }

  void _checkDeepLink() {
    if (_deepLinkHandled || _apt == null) return;
    final rsvId = widget.initialReservationId;
    final modal = widget.initialModal;
    if (rsvId == null && modal != 'reservation') return;

    _deepLinkHandled = true;
    final list = (_apt!['reservations'] as List?)
            ?.whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList() ??
        [];

    final rsv = pickDeepLinkTarget(list, rsvId);
    if (rsv == null) {
      ref.read(toastProvider.notifier).info(
            'Bản ghi liên quan không còn tồn tại hoặc đã thay đổi trạng thái.',
          );
      return;
    }

    final permissions = ref.read(permissionProvider);
    final currentUserId = permissions.user?.id ?? '';
    final allowApproveCancel = canApproveReservationCancel(
      rsv,
      isOwner: permissions.isOwner,
      isManager: permissions.isManager,
      isSysAdmin: permissions.isSysAdmin,
      currentUserId: currentUserId,
      buildingHasActiveOwner: (rsv['building_has_active_owner'] ??
              _apt!['building_has_active_owner']) ==
          true,
      allowSelfApproval: _allowSelfApproval,
    );
    final allowPayout = canPayoutReservationCancel(rsv, isManager: permissions.isManager);

    if (rsv['status'] == 'CANCEL_PENDING_APPROVAL' && allowApproveCancel) {
      _openReviewCancelModal(rsv, mode: 'approve');
    } else if (rsv['status'] == 'APPROVED_PENDING_PAYOUT' && allowPayout) {
      _openPayoutModal(rsv);
    } else {
      setState(() {
        _deepLinkReviewRsv = rsv;
      });
    }
  }

  // --- Handover logic ---
  Future<void> _handleHandoverSubmit() async {
    setState(() => _saving = true);
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      final res = await buildingsService.handoverApartment(widget.apartmentId, {
        'note': _handoverNote.trim().isEmpty ? null : _handoverNote.trim(),
        'evidence': _handoverEvidence,
        'keep_maintenance': _keepMaintenance,
      });
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Nghiệm thu & bàn giao phòng thành công.';
      ref.read(toastProvider.notifier).success(msg);
      if (mounted) {
        setState(() => _handoverOpen = false);
      }
      _fetchApartment(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // --- State transition logic ---
  Future<void> _handleTransition(String nextStatus) async {
    setState(() => _saving = true);
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      await buildingsService.updateApartment(widget.apartmentId, {'status': nextStatus});
      final meta = resolveStatusMeta(StatusDomain.apartment, nextStatus);
      ref.read(toastProvider.notifier).success('Đã chuyển trạng thái sang ${meta.label}.');
      _fetchApartment(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // --- Edit apartment logic ---
  Future<void> _handleSaveApartment() async {
    setState(() => _saving = true);
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      final amenitiesMap = <String, bool>{};
      for (final a in _formAmenitiesText.split(',')) {
        final t = a.trim();
        if (t.isNotEmpty) amenitiesMap[t] = true;
      }
      final payload = {
        'zone_id': _formZoneId.isEmpty ? null : _formZoneId,
        'type': _formType,
        'bedrooms': _formBedrooms,
        'area_m2': _formAreaM2,
        'base_rent': _formBaseRent,
        'note': _formNote,
        'amenities': amenitiesMap,
      };

      try {
        await buildingsService.updateApartment(widget.apartmentId, payload);
      } on DioException catch (err) {
        final data = err.response?.data;
        if (err.response?.statusCode == 409 &&
            data is Map &&
            data['code'] == 'AREA_CHANGE_REQUIRES_CONFIRM') {
          if (!mounted) return;
          final confirmed = await ConfirmDialog.show(
            context: context,
            title: 'Xác nhận đổi diện tích',
            message:
                'Căn hộ đang có hợp đồng hiệu lực. Thay đổi diện tích có thể ảnh hưởng cách tính phí dịch vụ. Bạn có chắc chắn muốn tiếp tục?',
            confirmLabel: 'Tiếp tục',
            variant: ConfirmDialogVariant.warning,
          );
          if (confirmed != true) return;
          await buildingsService.updateApartment(widget.apartmentId, {
            ...payload,
            'confirm_recalculate_fees': true,
          });
        } else {
          rethrow;
        }
      }
      ref.read(toastProvider.notifier).success('Đã cập nhật thông tin căn hộ.');
      if (mounted) setState(() => _editOpen = false);
      _fetchApartment(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // --- Delete apartment logic ---
  Future<void> _handleDeleteApartment() async {
    setState(() => _deletingApt = true);
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      final res = await buildingsService.deleteApartment(widget.apartmentId);
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã xóa căn hộ thành công.';
      ref.read(toastProvider.notifier).success(msg);
      if (mounted) {
        final bId = _apt?['building_id'];
        if (context.mounted) {
          if (bId != null) {
            context.go('/admin/buildings/$bId/floor-plan');
          } else {
            context.go('/admin/buildings');
          }
        }
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể xóa căn hộ.'));
    } finally {
      if (mounted) setState(() => _deletingApt = false);
    }
  }

  // --- Create reservation logic ---
  void _openCreateReservation() {
    final today = toDateOnlyStr(DateTime.now());
    final defaultAmt = num.tryParse(_cancelPolicy['default_hold_amount']?.toString() ?? '')?.toInt() ?? 2000000;
    final maxDays = num.tryParse(_cancelPolicy['max_hold_days']?.toString() ?? '')?.toInt() ?? 30;

    setState(() {
      _createIdemKey = createIdempotencyKey();
      _createProspectName = '';
      _createPhone = '';
      _createHoldAmount = defaultAmt;
      _createMethod = 'BANK_TRANSFER';
      _createHoldFrom = today;
      _createHoldUntil = addDaysStr(today, maxDays > 5 ? 5 : maxDays);
      _createEvidence = [];
      _createNote = '';
      _createRsvOpen = true;
    });
  }

  Future<void> _handleCreateReservationSubmit() async {
    if (_createHoldAmount <= 0) {
      ref.read(toastProvider.notifier).warning('Tiền đặt cọc giữ chỗ phải là số nguyên dương VND.');
      return;
    }
    if (_createProspectName.trim().isEmpty || _createPhone.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập họ tên và số điện thoại khách giữ chỗ.');
      return;
    }

    setState(() => _saving = true);
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      await buildingsService.createReservation(
        {
          'apartment_id': widget.apartmentId,
          'prospect_name': _createProspectName.trim(),
          'phone': _createPhone.trim(),
          'hold_amount': _createHoldAmount,
          'method': _createMethod,
          'hold_from': _createHoldFrom.isEmpty ? null : _createHoldFrom,
          'hold_until': _createHoldUntil,
          'evidence': _createEvidence,
          'note': _createNote.trim(),
        },
        options: Options(headers: {'Idempotency-Key': _createIdemKey}),
      );
      ref.read(toastProvider.notifier).success('Đã ghi nhận đặt cọc giữ chỗ thành công.');
      if (mounted) setState(() => _createRsvOpen = false);
      _fetchApartment(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // --- Confirm / Reject payment logic ---
  Future<void> _handleConfirmPayment(Map<String, dynamic> rsv) async {
    final id = rsv['id']?.toString();
    if (id == null) return;

    setState(() => _saving = true);
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      final res = await buildingsService.confirmReservationPayment(
        id,
        {},
        Options(headers: {'Idempotency-Key': createIdempotencyKey()}),
      );
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã xác nhận tiền về và khóa giữ chỗ căn hộ.';
      ref.read(toastProvider.notifier).success(msg);
      _fetchApartment(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  void _openRejectModal(Map<String, dynamic> rsv) {
    setState(() {
      _rejectIdemKey = createIdempotencyKey();
      _rejectTargetRsv = rsv;
      _rejectReason = '';
      _rejectModalOpen = true;
    });
  }

  Future<void> _handleRejectPaymentSubmit() async {
    final id = _rejectTargetRsv?['id']?.toString();
    if (id == null) return;
    if (_rejectReason.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do từ chối biên lai chuyển khoản.');
      return;
    }

    setState(() => _saving = true);
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      final res = await buildingsService.rejectReservationPayment(
        id,
        {'reason': _rejectReason.trim()},
        options: Options(headers: {'Idempotency-Key': _rejectIdemKey}),
      );
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã từ chối yêu cầu giữ chỗ.';
      ref.read(toastProvider.notifier).success(msg);
      if (mounted) {
        setState(() {
          _rejectModalOpen = false;
          _rejectTargetRsv = null;
        });
      }
      _fetchApartment(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // --- Cancel settle proposal logic (Step 1) ---
  void _openCancelSettleModal(Map<String, dynamic> rsv) {
    final today = toDateOnlyStr(DateTime.now());
    final holdAmt = num.tryParse(rsv['hold_amount']?.toString() ?? '')?.toInt() ?? 0;
    final suggested = computeSuggestedCancelSplit(
      holdAmount: holdAmt,
      holdUntil: rsv['hold_until'],
      todayStr: today,
      policy: _cancelPolicy,
    );

    final bank = rsv['refund_bank_info'] is Map ? (rsv['refund_bank_info'] as Map) : const {};

    setState(() {
      _settleIdemKey = createIdempotencyKey();
      _settleTargetRsv = rsv;
      _settleSuggested = suggested;
      _settleRefundedAmount = suggested.refundedAmount;
      _settleForfeitedAmount = suggested.forfeitedAmount;
      _settleRefundMethod = rsv['refund_method']?.toString() ?? 'BANK_TRANSFER';
      _settleBankName = bank['bank_name']?.toString() ?? '';
      _settleBankCode = bank['bank_code']?.toString() ?? '';
      _settleBankBin = bank['bank_bin']?.toString() ?? '';
      _settleBankLogo = bank['bank_logo']?.toString() ?? '';
      _settleAccountNumber = bank['account_number']?.toString() ?? '';
      _settleAccountHolder = bank['account_holder']?.toString() ?? (rsv['prospect_name']?.toString() ?? '');
      _settleReason = '';
      _settleModalOpen = true;
    });
  }

  void _onSettleRefundedChanged(String rawVal) {
    final total = num.tryParse(_settleTargetRsv?['hold_amount']?.toString() ?? '')?.toInt() ?? 0;
    final numVal = int.tryParse(rawVal.replaceAll('.', '').replaceAll(',', '').trim()) ?? 0;
    final clamped = numVal.clamp(0, total);
    setState(() {
      _settleRefundedAmount = clamped;
      _settleForfeitedAmount = total - clamped;
    });
  }

  Future<void> _handleCancelSettleSubmit() async {
    final id = _settleTargetRsv?['id']?.toString();
    if (id == null) return;
    final total = num.tryParse(_settleTargetRsv?['hold_amount']?.toString() ?? '')?.toInt() ?? 0;
    if (_settleRefundedAmount + _settleForfeitedAmount != total) {
      ref.read(toastProvider.notifier).warning('Tổng tiền hoàn + tiền phạt phải bằng đúng ${formatMoney(total)}.');
      return;
    }
    if (_settleReason.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do đề xuất thanh lý hủy giữ chỗ.');
      return;
    }
    if (_settleRefundedAmount > 0 && _settleRefundMethod == 'BANK_TRANSFER') {
      if (_settleBankName.trim().isEmpty ||
          _settleAccountNumber.trim().isEmpty ||
          _settleAccountHolder.trim().isEmpty) {
        ref.read(toastProvider.notifier).warning('Vui lòng nhập đầy đủ Ngân hàng, Số tài khoản và Chủ tài khoản nhận hoàn.');
        return;
      }
    }

    setState(() => _saving = true);
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      final payload = <String, dynamic>{
        'refunded_amount': _settleRefundedAmount,
        'forfeited_amount': _settleForfeitedAmount,
        'reason': _settleReason.trim(),
        'refund_method': _settleRefundMethod,
      };
      if (_settleRefundedAmount > 0 && _settleRefundMethod == 'BANK_TRANSFER') {
        payload['refund_bank_info'] = {
          'bank_name': _settleBankName.trim(),
          if (_settleBankCode.isNotEmpty) 'bank_code': _settleBankCode,
          if (_settleBankBin.isNotEmpty) 'bank_bin': _settleBankBin,
          if (_settleBankLogo.isNotEmpty) 'bank_logo': _settleBankLogo,
          'account_number': _settleAccountNumber.trim(),
          'account_holder': _settleAccountHolder.trim().toUpperCase(),
        };
      }

      final res = await buildingsService.cancelSettleReservation(
        id,
        payload,
        options: Options(headers: {'Idempotency-Key': _settleIdemKey}),
      );
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã gửi đề xuất thanh lý hủy giữ chỗ chờ phê duyệt.';
      ref.read(toastProvider.notifier).success(msg);
      if (mounted) setState(() => _settleModalOpen = false);
      _fetchApartment(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // --- Review cancel modal logic (Step 2) ---
  void _openReviewCancelModal(Map<String, dynamic> rsv, {String mode = 'approve'}) {
    setState(() {
      _reviewIdemKey = createIdempotencyKey();
      _reviewTargetRsv = rsv;
      _reviewMode = mode;
      _reviewNote = '';
      _reviewRejectReason = '';
      _reviewCancelOpen = true;
    });
  }

  Future<void> _handleReviewCancelSubmit() async {
    final id = _reviewTargetRsv?['id']?.toString();
    if (id == null) return;

    final buildingsService = ref.read(buildingsServiceProvider);
    if (_reviewMode == 'reject') {
      if (_reviewRejectReason.trim().isEmpty) {
        ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do từ chối đề xuất thanh lý giữ chỗ.');
        return;
      }
      setState(() => _saving = true);
      try {
        final res = await buildingsService.rejectReservationCancel(
          id,
          {'reason': _reviewRejectReason.trim()},
          options: Options(headers: {'Idempotency-Key': _reviewIdemKey}),
        );
        final msg = res is Map && res['message'] != null
            ? res['message'].toString()
            : 'Đã từ chối đề xuất thanh lý hủy giữ chỗ.';
        ref.read(toastProvider.notifier).success(msg);
        if (mounted) setState(() => _reviewCancelOpen = false);
        _fetchApartment(force: true);
      } catch (err) {
        ref.read(toastProvider.notifier).error(extractErrorMessage(err));
      } finally {
        if (mounted) setState(() => _saving = false);
      }
      return;
    }

    setState(() => _saving = true);
    try {
      final res = await buildingsService.approveReservationCancel(
        id,
        _reviewNote.trim().isNotEmpty ? {'note': _reviewNote.trim()} : {},
        Options(headers: {'Idempotency-Key': _reviewIdemKey}),
      );
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã phê duyệt phương án thanh lý hủy giữ chỗ.';
      ref.read(toastProvider.notifier).success(msg);
      if (mounted) setState(() => _reviewCancelOpen = false);
      _fetchApartment(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // --- Payout cancel modal logic (Step 3) ---
  void _openPayoutModal(Map<String, dynamic> rsv) {
    final bank = rsv['refund_bank_info'] is Map ? (rsv['refund_bank_info'] as Map) : const {};

    setState(() {
      _payoutIdemKey = createIdempotencyKey();
      _payoutTargetRsv = rsv;
      _payoutRefundMethod = rsv['refund_method']?.toString() ?? 'BANK_TRANSFER';
      _payoutBankName = bank['bank_name']?.toString() ?? '';
      _payoutBankCode = bank['bank_code']?.toString() ?? '';
      _payoutBankBin = bank['bank_bin']?.toString() ?? '';
      _payoutBankLogo = bank['bank_logo']?.toString() ?? '';
      _payoutAccountNumber = bank['account_number']?.toString() ?? '';
      _payoutAccountHolder = bank['account_holder']?.toString() ?? (rsv['prospect_name']?.toString() ?? '');
      _payoutEvidence = [];
      _payoutReferenceCode = '';
      _payoutNote = '';
      _payoutModalOpen = true;
    });
  }

  Future<void> _handlePayoutSubmit() async {
    final id = _payoutTargetRsv?['id']?.toString();
    if (id == null) return;

    if (_payoutRefundMethod == 'BANK_TRANSFER') {
      if (_payoutBankName.trim().isEmpty ||
          _payoutAccountNumber.trim().isEmpty ||
          _payoutAccountHolder.trim().isEmpty) {
        ref.read(toastProvider.notifier).warning('Vui lòng nhập đầy đủ Ngân hàng, Số tài khoản và Chủ tài khoản nhận hoàn.');
        return;
      }
      if (_payoutEvidence.isEmpty) {
        ref.read(toastProvider.notifier).warning('Chi hoàn tiền giữ chỗ qua chuyển khoản bắt buộc đính kèm ít nhất 01 ảnh chứng từ UNC.');
        return;
      }
    }

    setState(() => _saving = true);
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      final payload = <String, dynamic>{
        'refund_method': _payoutRefundMethod,
        'refund_evidence': _payoutEvidence,
        if (_payoutReferenceCode.trim().isNotEmpty) 'reference_code': _payoutReferenceCode.trim(),
        if (_payoutNote.trim().isNotEmpty) 'note': _payoutNote.trim(),
      };
      if (_payoutRefundMethod == 'BANK_TRANSFER') {
        payload['refund_bank_info'] = {
          'bank_name': _payoutBankName.trim(),
          if (_payoutBankCode.isNotEmpty) 'bank_code': _payoutBankCode,
          if (_payoutBankBin.isNotEmpty) 'bank_bin': _payoutBankBin,
          if (_payoutBankLogo.isNotEmpty) 'bank_logo': _payoutBankLogo,
          'account_number': _payoutAccountNumber.trim(),
          'account_holder': _payoutAccountHolder.trim().toUpperCase(),
        };
      }

      final res = await buildingsService.payoutReservationCancel(
        id,
        payload,
        options: Options(headers: {'Idempotency-Key': _payoutIdemKey}),
      );
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã xác nhận chi hoàn tiền giữ chỗ và lưu chứng từ UNC.';
      ref.read(toastProvider.notifier).success(msg);
      if (mounted) setState(() => _payoutModalOpen = false);
      _fetchApartment(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // --- Edit reservation bank logic ---
  void _openEditBankModal(Map<String, dynamic> rsv) {
    final bank = rsv['refund_bank_info'] is Map ? (rsv['refund_bank_info'] as Map) : const {};

    setState(() {
      _editBankIdemKey = createIdempotencyKey();
      _editBankTargetRsv = rsv;
      _editBankName = bank['bank_name']?.toString() ?? '';
      _editBankCode = bank['bank_code']?.toString() ?? '';
      _editBankBin = bank['bank_bin']?.toString() ?? '';
      _editBankLogo = bank['bank_logo']?.toString() ?? '';
      _editAccountNumber = bank['account_number']?.toString() ?? '';
      _editAccountHolder = bank['account_holder']?.toString() ?? (rsv['prospect_name']?.toString() ?? '');
      _editBankOpen = true;
    });
  }

  Future<void> _handleEditBankSubmit() async {
    final id = _editBankTargetRsv?['id']?.toString();
    if (id == null) return;
    if (_editBankName.trim().isEmpty ||
        _editAccountNumber.trim().isEmpty ||
        _editAccountHolder.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập đầy đủ Ngân hàng, Số tài khoản và Chủ tài khoản nhận hoàn.');
      return;
    }

    setState(() => _saving = true);
    final buildingsService = ref.read(buildingsServiceProvider);
    try {
      final res = await buildingsService.updateReservationBankInfo(
        id,
        {
          'bank_info': {
            'bank_name': _editBankName.trim(),
            if (_editBankCode.isNotEmpty) 'bank_code': _editBankCode,
            if (_editBankBin.isNotEmpty) 'bank_bin': _editBankBin,
            if (_editBankLogo.isNotEmpty) 'bank_logo': _editBankLogo,
            'account_number': _editAccountNumber.trim(),
            'account_holder': _editAccountHolder.trim().toUpperCase(),
          },
        },
        options: Options(headers: {'Idempotency-Key': _editBankIdemKey}),
      );
      final msg = res is Map && res['message'] != null
          ? res['message'].toString()
          : 'Đã cập nhật tài khoản nhận hoàn tiền giữ chỗ.';
      ref.read(toastProvider.notifier).success(msg);
      if (mounted) setState(() => _editBankOpen = false);
      _fetchApartment(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _apt == null) {
      return const Scaffold(
        body: Padding(
          padding: EdgeInsets.all(24),
          child: AppSkeleton(),
        ),
      );
    }

    if (_apt == null) {
      return const Scaffold(
        body: Center(child: Text('Không tìm thấy thông tin căn hộ.')),
      );
    }

    final permissions = ref.read(permissionProvider);
    final currentUserId = permissions.user?.id ?? '';
    final aptStatus = _apt!['status']?.toString() ?? '';
    final allowedTransitions = (_apt!['allowed_transitions'] as List?)
            ?.map((e) => e.toString())
            .where((st) => st != 'OCCUPIED' && st != 'RESERVED')
            .toList() ??
        [];

    final amenitiesList = _apt!['amenities'] is Map
        ? (_apt!['amenities'] as Map)
            .entries
            .where((e) => e.value == true)
            .map((e) => e.key.toString())
            .toList()
        : <String>[];

    final meters = (_apt!['meters'] as List?)
            ?.whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList() ??
        [];

    final contracts = (_apt!['contracts'] as List?)
            ?.whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList() ??
        [];

    final reservations = (_apt!['reservations'] as List?)
            ?.whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList() ??
        [];

    final serviceRequests = (_apt!['service_requests'] as List?)
            ?.whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList() ??
        [];

    final aptBusy = aptStatus == 'OCCUPIED' || aptStatus == 'RESERVED';

    return Scaffold(
      backgroundColor: AppColors.slate50,
      body: Stack(
        children: [
          SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Page Header
                PageHeader(
                  title: 'Căn hộ ${_apt!['code'] ?? ''}',
                  subtitle:
                      '${_apt!['building_code'] ?? ''} — ${_apt!['building_name'] ?? ''} · ${_apt!['floor_name'] ?? ''}${_apt!['zone_code'] != null ? ' · Khu ${_apt!['zone_code']}' : ''}',
                  breadcrumbs: [
                    const BreadcrumbItem(label: 'Bất động sản', to: '/admin/buildings'),
                    BreadcrumbItem(
                      label: '${_apt!['building_code'] ?? ''}',
                      to: '/admin/buildings/${_apt!['building_id'] ?? ''}',
                    ),
                    BreadcrumbItem(
                      label: 'Sơ đồ tầng',
                      to: '/admin/buildings/${_apt!['building_id'] ?? ''}/floor-plan',
                    ),
                    BreadcrumbItem(label: 'Căn ${_apt!['code'] ?? ''}'),
                  ],
                  actions: Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      if (permissions.canEditRealEstate && aptStatus == 'MAINTENANCE')
                        AppButton(
                          text: 'Nghiệm thu & Bàn giao',
                          icon: const Icon(LucideIcons.checkCircle2, size: 16),
                          variant: AppButtonVariant.primary,
                          size: AppButtonSize.sm,
                          loading: _saving,
                          onPressed: () {
                            setState(() {
                              _handoverNote = '';
                              _handoverEvidence = [];
                              _keepMaintenance = false;
                              _handoverOpen = true;
                            });
                          },
                        ),
                      if (permissions.isManager &&
                          (aptStatus == 'AVAILABLE' || aptStatus == 'RESERVED' || aptStatus == 'OCCUPIED'))
                        AppButton(
                          text: 'Đặt cọc giữ chỗ',
                          icon: const Icon(LucideIcons.bookmarkPlus, size: 16),
                          variant: AppButtonVariant.outline,
                          size: AppButtonSize.sm,
                          onPressed: _openCreateReservation,
                        ),
                      if (permissions.isManager &&
                          (aptStatus == 'AVAILABLE' || aptStatus == 'RESERVED' || aptStatus == 'OCCUPIED'))
                        AppButton(
                          text: 'Tạo hợp đồng thuê',
                          icon: const Icon(LucideIcons.plus, size: 16),
                          variant: AppButtonVariant.primary,
                          size: AppButtonSize.sm,
                          onPressed: () {
                            context.go('/admin/contracts?apartment_id=${_apt!['id']}');
                          },
                        ),
                      if (permissions.canEditRealEstate)
                        AppButton(
                          text: 'Chỉnh sửa',
                          icon: const Icon(LucideIcons.edit3, size: 16),
                          variant: AppButtonVariant.outline,
                          size: AppButtonSize.sm,
                          onPressed: () => setState(() => _editOpen = true),
                        ),
                      if (permissions.canManageBuildings)
                        AppButton(
                          text: 'Xóa căn hộ',
                          icon: const Icon(LucideIcons.trash2, size: 16),
                          variant: AppButtonVariant.danger,
                          size: AppButtonSize.sm,
                          disabled: aptBusy || _deletingApt,
                          loading: _deletingApt,
                          onPressed: () async {
                            final confirmed = await ConfirmDialog.show(
                              context: context,
                              title: 'Xác nhận xóa căn hộ',
                              message:
                                  'Bạn có chắc chắn muốn xóa vĩnh viễn căn hộ "${_apt!['code']}" (${_apt!['building_code']})? Nếu căn hộ đã từng có hợp đồng, giữ chỗ, hóa đơn hoặc yêu cầu dịch vụ, hệ thống sẽ từ chối và khuyến nghị chuyển sang trạng thái Tạm khóa (INACTIVE).',
                              confirmLabel: 'Xóa căn hộ',
                            );
                            if (confirmed == true) {
                              _handleDeleteApartment();
                            }
                          },
                        ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),

                // Specs Card & State Transitions Card
                LayoutBuilder(
                  builder: (ctx, constraints) {
                    final isWide = constraints.maxWidth >= 900;
                    final specsWidget = AppCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Thông số kỹ thuật & Tiện nghi',
                            style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold, color: AppColors.slate900),
                          ),
                          const SizedBox(height: 16),
                          Wrap(
                            spacing: 12,
                            runSpacing: 12,
                            children: [
                              _buildStatBox('Trạng thái', StatusBadge(status: aptStatus, domain: StatusDomain.apartment)),
                              _buildStatBox(
                                'Phân khu (Khu)',
                                Text(
                                  _apt!['zone_code'] != null
                                      ? '${_apt!['zone_code']}${_apt!['zone_name'] != null ? ' — ${_apt!['zone_name']}' : ''}'
                                      : 'Chưa gán khu',
                                  style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                    color: _apt!['zone_code'] != null ? AppColors.primary700 : AppColors.slate400,
                                  ),
                                ),
                              ),
                              _buildStatBox(
                                'Giá niêm yết',
                                Text(
                                  formatMoney(_apt!['base_rent']),
                                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AppColors.primary600),
                                ),
                              ),
                              _buildStatBox(
                                'Diện tích',
                                Text(
                                  '${_apt!['area_m2'] ?? 0} m²',
                                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AppColors.slate800),
                                ),
                              ),
                              _buildStatBox(
                                'Thiết kế',
                                Text(
                                  '${_apt!['type'] ?? '1PN'} (${_apt!['bedrooms'] ?? 1} PN)',
                                  style: const TextStyle(fontSize: 14, fontWeight: FontWeight.bold, color: AppColors.slate800),
                                ),
                              ),
                            ],
                          ),
                          const SizedBox(height: 16),
                          const Text(
                            'Danh sách nội thất / tiện nghi',
                            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate600),
                          ),
                          const SizedBox(height: 8),
                          if (amenitiesList.isNotEmpty)
                            Wrap(
                              spacing: 8,
                              runSpacing: 8,
                              children: amenitiesList.map((a) => AppBadge(label: a, variant: AppBadgeVariant.sky)).toList(),
                            )
                          else
                            const Text('Chưa khai báo danh mục tiện nghi chi tiết.', style: TextStyle(fontSize: 12, color: AppColors.slate400)),
                          if (_apt!['note'] != null && _apt!['note'].toString().trim().isNotEmpty) ...[
                            const SizedBox(height: 12),
                            Container(
                              padding: const EdgeInsets.all(12),
                              decoration: BoxDecoration(
                                color: const Color(0xFFFFFBEB),
                                borderRadius: BorderRadius.circular(8),
                                border: Border.all(color: const Color(0xFFFDE68A)),
                              ),
                              child: Text(
                                'Ghi chú: ${_apt!['note']}',
                                style: const TextStyle(fontSize: 12, color: AppColors.slate700),
                              ),
                            ),
                          ],
                        ],
                      ),
                    );

                    final transitionWidget = AppCard(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Chuyển trạng thái (FR-008)',
                            style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppColors.slate900),
                          ),
                          const Text(
                            'OCCUPIED & RESERVED tự động đồng bộ qua Hợp đồng / Giữ chỗ',
                            style: TextStyle(fontSize: 11, color: AppColors.slate500),
                          ),
                          const SizedBox(height: 12),
                          if (permissions.canEditRealEstate && allowedTransitions.isNotEmpty)
                            Column(
                              children: allowedTransitions.map((st) {
                                final meta = resolveStatusMeta(StatusDomain.apartment, st);
                                return Padding(
                                  padding: const EdgeInsets.only(bottom: 8),
                                  child: AppButton(
                                    text: 'Chuyển sang: ${meta.label}',
                                    variant: AppButtonVariant.outline,
                                    size: AppButtonSize.sm,
                                    fullWidth: true,
                                    loading: _saving,
                                    onPressed: () => _handleTransition(st),
                                  ),
                                );
                              }).toList(),
                            )
                          else
                            const Text(
                              'Không có chuyển đổi thủ công khả dụng ở trạng thái hiện tại.',
                              style: TextStyle(fontSize: 12, color: AppColors.slate500),
                            ),
                          const Divider(height: 24),
                          const Row(
                            children: [
                              Icon(LucideIcons.gauge, size: 16, color: AppColors.primary500),
                              SizedBox(width: 8),
                              Text(
                                'Đồng hồ Điện / Nước',
                                style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.slate700),
                              ),
                            ],
                          ),
                          const SizedBox(height: 8),
                          if (meters.isEmpty)
                            const Text('Chưa gắn đồng hồ.', style: TextStyle(fontSize: 12, color: AppColors.slate400))
                          else
                            Column(
                              children: meters.map((m) {
                                final isElec = m['meter_type'] == 'ELECTRICITY';
                                final label = isElec ? 'Điện' : 'Nước';
                                return Container(
                                  margin: const EdgeInsets.only(bottom: 6),
                                  padding: const EdgeInsets.all(10),
                                  decoration: BoxDecoration(
                                    color: AppColors.slate50,
                                    borderRadius: BorderRadius.circular(8),
                                    border: Border.all(color: AppColors.slate100),
                                  ),
                                  child: Row(
                                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                    children: [
                                      Expanded(
                                        child: Column(
                                          crossAxisAlignment: CrossAxisAlignment.start,
                                          children: [
                                            Text('$label (${m['meter_code']})', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold, color: AppColors.slate800)),
                                            Text('Đơn giá: ${formatMoney(m['unit_price'])}/${m['unit'] ?? ''}', style: const TextStyle(fontSize: 11, color: AppColors.slate400)),
                                          ],
                                        ),
                                      ),
                                      Column(
                                        crossAxisAlignment: CrossAxisAlignment.end,
                                        children: [
                                          Text('${m['latest_reading'] ?? m['initial_reading'] ?? 0} ${m['unit'] ?? ''}', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.bold, color: AppColors.primary700)),
                                          if (m['latest_period'] != null)
                                            Text('Kỳ ${m['latest_period']}', style: const TextStyle(fontSize: 11, color: AppColors.slate400)),
                                        ],
                                      ),
                                    ],
                                  ),
                                );
                              }).toList(),
                            ),
                        ],
                      ),
                    );

                    if (isWide) {
                      return Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(flex: 3, child: specsWidget),
                          const SizedBox(width: 20),
                          Expanded(flex: 2, child: transitionWidget),
                        ],
                      );
                    } else {
                      return Column(
                        children: [
                          specsWidget,
                          const SizedBox(height: 20),
                          transitionWidget,
                        ],
                      );
                    }
                  },
                ),
                const SizedBox(height: 24),

                // Contracts Section
                AppCard(
                  padding: EdgeInsets.zero,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Padding(
                        padding: EdgeInsets.all(16),
                        child: Row(
                          children: [
                            Icon(LucideIcons.fileSignature, size: 18, color: AppColors.primary500),
                            SizedBox(width: 8),
                            Text(
                              'Lịch sử Hợp đồng của căn hộ',
                              style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppColors.slate900),
                            ),
                          ],
                        ),
                      ),
                      DataTableWidget<Map<String, dynamic>>(
                        embedded: true,
                        data: contracts,
                        emptyTitle: 'Chưa phát sinh hợp đồng',
                        onRowClick: (c) {
                          final cid = c['id']?.toString();
                          if (cid != null) context.go('/admin/contracts/$cid');
                        },
                        columns: [
                          DataTableColumn(
                            key: 'tenant_name',
                            label: 'Khách thuê',
                            width: 220,
                            render: (r) => Text(
                              r['tenant_name']?.toString() ?? '—',
                              style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.slate900),
                            ),
                          ),
                          DataTableColumn(
                            key: 'period',
                            label: 'Kỳ hạn',
                            width: 200,
                            align: TextAlign.center,
                            render: (r) => Text(
                              '${formatDate(r['start_date'])} → ${formatDate(r['end_date'])}',
                              style: const TextStyle(fontSize: 12),
                            ),
                          ),
                          DataTableColumn(
                            key: 'rent_amount',
                            label: 'Giá thuê',
                            width: 140,
                            align: TextAlign.right,
                            render: (r) => Text(
                              formatMoney(r['rent_amount']),
                              style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.w600),
                            ),
                          ),
                          DataTableColumn(
                            key: 'status',
                            label: 'Trạng thái',
                            width: 160,
                            align: TextAlign.center,
                            render: (r) => FittedBox(
                              fit: BoxFit.scaleDown,
                              child: StatusBadge(status: r['status']?.toString(), domain: StatusDomain.contract),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 24),

                // Reservations Section (Hồ sơ Đặt cọc Giữ chỗ)
                AppCard(
                  padding: EdgeInsets.zero,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Padding(
                        padding: EdgeInsets.all(16),
                        child: Row(
                          children: [
                            Icon(LucideIcons.bookmark, size: 18, color: Color(0xFFF59E0B)),
                            SizedBox(width: 8),
                            Text(
                              'Hồ sơ Đặt cọc Giữ chỗ',
                              style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppColors.slate900),
                            ),
                          ],
                        ),
                      ),
                      DataTableWidget<Map<String, dynamic>>(
                        embedded: true,
                        data: reservations,
                        emptyTitle: 'Chưa có hồ sơ giữ chỗ',
                        columns: [
                          DataTableColumn(
                            key: 'prospect_name',
                            label: 'Khách đặt / Chứng từ',
                            width: 350,
                            render: (r) => _buildReservationProspectCell(r),
                          ),
                          DataTableColumn(
                            key: 'hold_amount',
                            label: 'Tiền giữ chỗ',
                            width: 220,
                            align: TextAlign.right,
                            render: (r) => _buildReservationAmountCell(r),
                          ),
                          DataTableColumn(
                            key: 'hold_until',
                            label: 'Khoảng giữ chỗ',
                            width: 220,
                            align: TextAlign.center,
                            render: (r) => Text(
                              '${formatDate(r['hold_from'] ?? r['created_at'])} → ${formatDate(r['hold_until'])}',
                              style: const TextStyle(fontSize: 12),
                            ),
                          ),
                          DataTableColumn(
                            key: 'actions',
                            label: 'Trạng thái / Xử lý',
                            width: 320,
                            align: TextAlign.center,
                            render: (r) => _buildReservationActionsCell(r, permissions, currentUserId),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                if (serviceRequests.isNotEmpty) ...[
                  const SizedBox(height: 24),
                  AppCard(
                    padding: EdgeInsets.zero,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Padding(
                          padding: EdgeInsets.all(16),
                          child: Row(
                            children: [
                              Icon(LucideIcons.wrench, size: 18, color: Color(0xFFF59E0B)),
                              SizedBox(width: 8),
                              Text(
                                'Lịch sử Yêu cầu Bảo trì / Báo hỏng',
                                style: TextStyle(fontSize: 15, fontWeight: FontWeight.bold, color: AppColors.slate900),
                              ),
                            ],
                          ),
                        ),
                        DataTableWidget<Map<String, dynamic>>(
                          embedded: true,
                          data: serviceRequests,
                          emptyTitle: 'Chưa có yêu cầu dịch vụ',
                          onRowClick: (_) => context.go('/admin/maintenance'),
                          columns: [
                            DataTableColumn(
                              key: 'tracking_code',
                              label: 'Mã YC',
                              width: 140,
                              render: (r) => Text(
                                r['tracking_code']?.toString() ?? '',
                                style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                              ),
                            ),
                            DataTableColumn(
                              key: 'title',
                              label: 'Nội dung',
                              width: 260,
                              render: (r) => Text(r['title']?.toString() ?? ''),
                            ),
                            DataTableColumn(
                              key: 'created_at',
                              label: 'Ngày báo',
                              width: 140,
                              align: TextAlign.center,
                              render: (r) => Text(formatDate(r['created_at']), style: const TextStyle(fontSize: 12)),
                            ),
                            DataTableColumn(
                              key: 'status',
                              label: 'Trạng thái',
                              width: 160,
                              align: TextAlign.center,
                              render: (r) => FittedBox(
                                fit: BoxFit.scaleDown,
                                child: StatusBadge(status: r['status']?.toString(), domain: StatusDomain.serviceRequest),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
          if (_hasOpenModal()) _buildModalsOverlay(permissions),
        ],
      ),
    );
  }

  bool _hasOpenModal() {
    return _handoverOpen ||
        _editOpen ||
        _createRsvOpen ||
        _rejectModalOpen ||
        _settleModalOpen ||
        _reviewCancelOpen ||
        _payoutModalOpen ||
        _editBankOpen ||
        _deepLinkReviewRsv != null;
  }

  Widget _buildStatBox(String title, Widget value) {
    return Container(
      constraints: const BoxConstraints(minWidth: 120),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.slate50,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.slate100),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(title, style: const TextStyle(fontSize: 11, color: AppColors.slate400)),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: value,
          ),
        ],
      ),
    );
  }

  Widget _buildReservationProspectCell(Map<String, dynamic> r) {
    final isOnline = r['source'] == 'PUBLIC';
    final bank = r['refund_bank_info'] is Map ? (r['refund_bank_info'] as Map) : null;
    final evidence = (r['evidence'] as List?)?.map((e) => e.toString()).toList() ?? [];
    final refundEvidence = (r['refund_evidence'] as List?)?.map((e) => e.toString()).toList() ?? [];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Flexible(
              child: Text(
                r['prospect_name']?.toString() ?? '—',
                style: const TextStyle(fontWeight: FontWeight.w600, color: AppColors.slate900),
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const SizedBox(width: 6),
            AppBadge(
              label: isOnline ? 'Online' : 'Nội bộ',
              variant: isOnline ? AppBadgeVariant.sky : AppBadgeVariant.slate,
            ),
          ],
        ),
        if (r['phone'] != null)
          Text(r['phone'].toString(), style: const TextStyle(fontSize: 12, fontFamily: 'monospace', color: AppColors.slate500)),
        if (r['method'] != null)
          Text('Phương thức: ${kPaymentMethodLabels[r['method']] ?? r['method']}', style: const TextStyle(fontSize: 11, color: AppColors.slate500)),
        if (r['note'] != null && r['note'].toString().isNotEmpty)
          Text(r['note'].toString(), style: const TextStyle(fontSize: 11, color: AppColors.slate500)),
        if (r['rejected_reason'] != null)
          Text('Lý do từ chối: ${r['rejected_reason']}', style: const TextStyle(fontSize: 11, color: Color(0xFFE11D48))),
        if (r['cancel_reason'] != null)
          Text('Lý do thanh lý: ${r['cancel_reason']}', style: const TextStyle(fontSize: 11, color: Color(0xFFB45309))),
        if (bank != null && bank['account_number'] != null)
          Text(
            'STK hoàn: ${bank['bank_name']} • ${bank['account_number']} (${bank['account_holder']})',
            style: const TextStyle(fontSize: 11, color: AppColors.slate600),
          ),
        if (evidence.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Wrap(
              spacing: 4,
              children: evidence
                  .map((url) => SizedBox(
                        width: 36,
                        height: 36,
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(4),
                          child: AuthImage(src: url),
                        ),
                      ))
                  .toList(),
            ),
          ),
        if (refundEvidence.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Wrap(
              spacing: 4,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                const Text('UNC: ', style: TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Color(0xFF047857))),
                ...refundEvidence.map((url) => SizedBox(
                      width: 36,
                      height: 36,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(4),
                        child: AuthImage(src: url),
                      ),
                    )),
              ],
            ),
          ),
      ],
    );
  }

  Widget _buildReservationAmountCell(Map<String, dynamic> r) {
    final holdAmt = num.tryParse(r['hold_amount']?.toString() ?? '')?.toInt() ?? 0;
    final refAmt = num.tryParse(r['refunded_amount']?.toString() ?? '')?.toInt() ?? 0;
    final forfAmt = num.tryParse(r['forfeited_amount']?.toString() ?? '')?.toInt() ?? 0;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(formatMoney(holdAmt), style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold)),
        if (refAmt + forfAmt > 0)
          Text(
            'Hoàn ${formatMoney(refAmt)} • Phạt ${formatMoney(forfAmt)}',
            style: const TextStyle(fontSize: 10, color: AppColors.slate500),
          ),
      ],
    );
  }

  Widget _buildReservationActionsCell(Map<String, dynamic> r, PermissionMatrix permissions, String currentUserId) {
    final canConfirm = canManagerConfirmReservationPayment(r, isManager: permissions.isManager);
    final holdAmt = num.tryParse(r['hold_amount']?.toString() ?? '')?.toInt() ?? 0;
    final canPropose = canProposeReservationCancel(r, isManager: permissions.isManager) && holdAmt > 0;
    final canApprove = canApproveReservationCancel(
      r,
      isOwner: permissions.isOwner,
      isManager: permissions.isManager,
      isSysAdmin: permissions.isSysAdmin,
      currentUserId: currentUserId,
      buildingHasActiveOwner: (r['building_has_active_owner'] ??
              _apt!['building_has_active_owner']) ==
          true,
      allowSelfApproval: _allowSelfApproval,
    );
    final canPayout = canPayoutReservationCancel(r, isManager: permissions.isManager);

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        FittedBox(
          fit: BoxFit.scaleDown,
          child: StatusBadge(status: r['status']?.toString(), domain: StatusDomain.reservation),
        ),
        const SizedBox(height: 6),
        if (canConfirm)
          Wrap(
            spacing: 4,
            runSpacing: 4,
            alignment: WrapAlignment.center,
            children: [
              AppButton(
                text: 'Xác nhận tiền về',
                variant: AppButtonVariant.primary,
                size: AppButtonSize.xs,
                loading: _saving,
                onPressed: () => _handleConfirmPayment(r),
              ),
              AppButton(
                text: 'Từ chối biên lai',
                variant: AppButtonVariant.danger,
                size: AppButtonSize.xs,
                disabled: _saving,
                onPressed: () => _openRejectModal(r),
              ),
            ],
          ),
        if (canPropose)
          AppButton(
            text: 'Đề xuất thanh lý hủy',
            icon: const Icon(LucideIcons.scale, size: 14),
            variant: AppButtonVariant.outline,
            size: AppButtonSize.xs,
            onPressed: () => _openCancelSettleModal(r),
          ),
        if (canApprove)
          Wrap(
            spacing: 4,
            runSpacing: 4,
            alignment: WrapAlignment.center,
            children: [
              AppButton(
                text: 'Duyệt thanh lý hủy',
                icon: const Icon(LucideIcons.shieldCheck, size: 14),
                variant: AppButtonVariant.primary,
                size: AppButtonSize.xs,
                disabled: _saving,
                onPressed: () => _openReviewCancelModal(r, mode: 'approve'),
              ),
              AppButton(
                text: 'Từ chối',
                variant: AppButtonVariant.danger,
                size: AppButtonSize.xs,
                disabled: _saving,
                onPressed: () => _openReviewCancelModal(r, mode: 'reject'),
              ),
            ],
          ),
        if (canPayout)
          Wrap(
            spacing: 4,
            runSpacing: 4,
            alignment: WrapAlignment.center,
            children: [
              AppButton(
                text: 'Chi hoàn & Tải UNC',
                icon: const Icon(LucideIcons.wallet, size: 14),
                variant: AppButtonVariant.primary,
                size: AppButtonSize.xs,
                disabled: _saving,
                onPressed: () => _openPayoutModal(r),
              ),
              AppButton(
                text: 'Sửa STK',
                variant: AppButtonVariant.outline,
                size: AppButtonSize.xs,
                disabled: _saving,
                onPressed: () => _openEditBankModal(r),
              ),
            ],
          ),
      ],
    );
  }

  // --- Modals Overlay ---
  Widget _buildModalsOverlay(PermissionMatrix permissions) {
    Widget? modalWidget;
    if (_handoverOpen) modalWidget = _buildHandoverModal();
    if (_editOpen) modalWidget = _buildEditApartmentModal();
    if (_createRsvOpen) modalWidget = _buildCreateReservationModal();
    if (_rejectModalOpen) modalWidget = _buildRejectPaymentModal();
    if (_settleModalOpen) modalWidget = _buildCancelSettleModal();
    if (_reviewCancelOpen) modalWidget = _buildReviewCancelModal();
    if (_payoutModalOpen) modalWidget = _buildPayoutModal();
    if (_editBankOpen) modalWidget = _buildEditBankModal();
    if (_deepLinkReviewRsv != null) modalWidget = _buildDeepLinkReservationModal(permissions);

    if (modalWidget == null) return const SizedBox.shrink();

    return Positioned.fill(
      child: Container(
        color: AppColors.slate900.withValues(alpha: 0.45),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: 560,
              maxHeight: 680,
            ),
            child: modalWidget,
          ),
        ),
      ),
    );
  }

  Widget _buildHandoverModal() {
    return AppModal(
      title: 'Nghiệm thu & Bàn giao căn ${_apt!['code'] ?? ''}',
      subtitle: 'Đính kèm hình ảnh hiện trạng bàn giao để đủ điều kiện tất toán tiền đặt cọc (FR-024, R-12)',
      onClose: _saving ? null : () => setState(() => _handoverOpen = false),
      footer: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.end,
        children: [
          AppButton(
            text: 'Hủy',
            variant: AppButtonVariant.outline,
            disabled: _saving,
            onPressed: () => setState(() => _handoverOpen = false),
          ),
          const SizedBox(width: 8),
          AppButton(
            text: _keepMaintenance ? 'Lưu biên bản nghiệm thu' : 'Nghiệm thu & Mở bán (AVAILABLE)',
            variant: AppButtonVariant.primary,
            loading: _saving,
            onPressed: _handleHandoverSubmit,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          FileUploadField(
            label: 'Ảnh biên bản / hiện trạng bàn giao phòng (Khuyến nghị ≥ 1 ảnh cho tất toán cọc)',
            multiple: true,
            maxFiles: 5,
            value: _handoverEvidence,
            onChanged: (vals) {
              if (vals is List) {
                setState(() => _handoverEvidence = vals.map((e) => e.toString()).toList());
              }
            },
            hint: 'Ảnh chụp hiện trạng nội thất, đồng hồ điện nước hoặc biên bản có chữ ký hai bên',
          ),
          const SizedBox(height: 16),
          AppInput(
            label: 'Ghi chú kiểm tra bàn giao',
            placeholder: 'VD: Đã kiểm tra điều hòa, tủ bếp, sàn gỗ — nguyên trạng tốt...',
            multiline: true,
            rows: 3,
            initialValue: _handoverNote,
            onChanged: (v) => _handoverNote = v,
          ),
          const SizedBox(height: 16),
          InkWell(
            onTap: () => setState(() => _keepMaintenance = !_keepMaintenance),
            child: Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: const Color(0xFFFFFBEB),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFFFDE68A)),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Checkbox(
                    value: _keepMaintenance,
                    onChanged: (v) => setState(() => _keepMaintenance = v ?? false),
                  ),
                  const Expanded(
                    child: Text(
                      'Giữ căn hộ ở trạng thái Đang bảo trì (MAINTENANCE) — chỉ ghi nhận biên bản nghiệm thu kèm ảnh để tất toán tiền cọc trước, chưa mở bán phòng ngay.',
                      style: TextStyle(fontSize: 12, color: AppColors.slate700),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildEditApartmentModal() {
    final zoneOptions = [
      const AppSelectOption(value: '', label: '-- Không gán phân khu --'),
      ..._zones.map((z) => AppSelectOption(
            value: z['id'].toString(),
            label: z['name']?.toString().isNotEmpty == true
                ? z['name'].toString()
                : 'Khu ${z['code']}',
          )),
    ];

    final typeOptions = _kApartmentTypeOptions.map((t) => AppSelectOption(value: t, label: t)).toList();

    return AppModal(
      title: 'Cập nhật căn hộ ${_apt!['code'] ?? ''}',
      onClose: _saving ? null : () => setState(() => _editOpen = false),
      footer: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.end,
        children: [
          AppButton(
            text: 'Hủy',
            variant: AppButtonVariant.outline,
            disabled: _saving,
            onPressed: () => setState(() => _editOpen = false),
          ),
          const SizedBox(width: 8),
          AppButton(
            text: 'Lưu thay đổi',
            variant: AppButtonVariant.primary,
            loading: _saving,
            onPressed: _handleSaveApartment,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppSelect<String>(
            label: 'Phân khu (Khu / Block — FR-007)',
            value: _formZoneId,
            options: zoneOptions,
            onChanged: (v) => setState(() => _formZoneId = v ?? ''),
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: AppSelect<String>(
                  label: 'Loại căn hộ',
                  value: _formType,
                  options: typeOptions,
                  onChanged: (v) => setState(() => _formType = v ?? '1PN'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: AppInput(
                  label: 'Số phòng ngủ',
                  keyboardType: TextInputType.number,
                  initialValue: _formBedrooms.toString(),
                  onChanged: (v) => _formBedrooms = int.tryParse(v) ?? 1,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: AppInput(
                  label: 'Diện tích (m²)',
                  keyboardType: const TextInputType.numberWithOptions(decimal: true),
                  initialValue: _formAreaM2.toString(),
                  onChanged: (v) => _formAreaM2 = double.tryParse(v) ?? 0,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: MoneyInput(
                  label: 'Giá thuê niêm yết (VND)',
                  value: _formBaseRent,
                  onChanged: (v) => _formBaseRent = int.tryParse(v.replaceAll('.', '').replaceAll(',', '').trim()) ?? 0,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          AppInput(
            label: 'Tiện nghi (ngăn cách bằng dấu phẩy)',
            placeholder: 'Điều hòa, Nóng lạnh, Tủ bếp, Máy giặt, Giường tủ',
            initialValue: _formAmenitiesText,
            onChanged: (v) => _formAmenitiesText = v,
          ),
          const SizedBox(height: 12),
          AppInput(
            label: 'Ghi chú vận hành',
            multiline: true,
            rows: 2,
            initialValue: _formNote,
            onChanged: (v) => _formNote = v,
          ),
        ],
      ),
    );
  }

  Widget _buildCreateReservationModal() {
    final maxDays = num.tryParse(_cancelPolicy['max_hold_days']?.toString() ?? '')?.toInt() ?? 30;

    return AppModal(
      title: 'Đặt cọc giữ chỗ — Căn ${_apt!['code'] ?? ''}',
      subtitle: 'Giữ chỗ nội bộ tối đa $maxDays ngày theo chính sách FR-067',
      onClose: _saving ? null : () => setState(() => _createRsvOpen = false),
      footer: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.end,
        children: [
          AppButton(
            text: 'Hủy',
            variant: AppButtonVariant.outline,
            disabled: _saving,
            onPressed: () => setState(() => _createRsvOpen = false),
          ),
          const SizedBox(width: 8),
          AppButton(
            text: 'Xác nhận giữ chỗ',
            variant: AppButtonVariant.primary,
            loading: _saving,
            onPressed: _handleCreateReservationSubmit,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: AppInput(
                  label: 'Họ tên khách đặt giữ chỗ',
                  initialValue: _createProspectName,
                  onChanged: (v) => _createProspectName = v,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: AppInput(
                  label: 'Số điện thoại',
                  placeholder: '0912345678',
                  initialValue: _createPhone,
                  onChanged: (v) => _createPhone = v,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: MoneyInput(
                  label: 'Tiền cọc giữ chỗ (VND)',
                  value: _createHoldAmount,
                  onChanged: (v) => _createHoldAmount = int.tryParse(v.replaceAll('.', '').replaceAll(',', '').trim()) ?? 0,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: AppSelect<String>(
                  label: 'Phương thức thu tiền',
                  value: _createMethod,
                  options: kPaymentMethodOptions.map((o) => AppSelectOption(value: o.value, label: o.label)).toList(),
                  onChanged: (v) => setState(() => _createMethod = v ?? 'BANK_TRANSFER'),
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: AppInput(
                  label: 'Giữ chỗ từ ngày',
                  initialValue: _createHoldFrom,
                  onChanged: (v) => _createHoldFrom = v,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: AppInput(
                  label: 'Đến hết ngày (tối đa $maxDays ngày)',
                  initialValue: _createHoldUntil,
                  onChanged: (v) => _createHoldUntil = v,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          FileUploadField(
            label: 'Ảnh biên lai / phiếu thu giữ chỗ (tùy chọn, tối đa 5 ảnh)',
            multiple: true,
            maxFiles: 5,
            value: _createEvidence,
            onChanged: (vals) {
              if (vals is List) {
                setState(() => _createEvidence = vals.map((e) => e.toString()).toList());
              }
            },
          ),
          const SizedBox(height: 12),
          AppInput(
            label: 'Ghi chú',
            multiline: true,
            rows: 2,
            initialValue: _createNote,
            onChanged: (v) => _createNote = v,
          ),
        ],
      ),
    );
  }

  Widget _buildRejectPaymentModal() {
    return AppModal(
      title: 'Từ chối xác nhận biên lai giữ chỗ',
      subtitle: _rejectTargetRsv != null
          ? 'Khách: ${_rejectTargetRsv!['prospect_name']} • ${formatMoney(_rejectTargetRsv!['hold_amount'])}'
          : null,
      onClose: _saving ? null : () => setState(() => _rejectModalOpen = false),
      footer: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.end,
        children: [
          AppButton(
            text: 'Hủy',
            variant: AppButtonVariant.outline,
            disabled: _saving,
            onPressed: () => setState(() => _rejectModalOpen = false),
          ),
          const SizedBox(width: 8),
          AppButton(
            text: 'Xác nhận từ chối',
            variant: AppButtonVariant.danger,
            loading: _saving,
            onPressed: _handleRejectPaymentSubmit,
          ),
        ],
      ),
      child: AppInput(
        label: 'Lý do từ chối biên lai (bắt buộc)',
        placeholder: 'VD: Sao kê ngân hàng chưa ghi nhận khoản tiền...',
        multiline: true,
        rows: 3,
        initialValue: _rejectReason,
        onChanged: (v) => _rejectReason = v,
      ),
    );
  }

  Widget _buildCancelSettleModal() {
    final holdAmt = num.tryParse(_settleTargetRsv?['hold_amount']?.toString() ?? '')?.toInt() ?? 0;

    return AppModal(
      title: 'Đề xuất thanh lý hủy giữ chỗ (Bước 1 — BQL lập đề xuất)',
      subtitle: _settleTargetRsv != null
          ? 'Khách: ${_settleTargetRsv!['prospect_name']} • Tiền giữ chỗ: ${formatMoney(holdAmt)} • Hạn: ${formatDate(_settleTargetRsv!['hold_until'])}'
          : null,
      onClose: _saving ? null : () => setState(() => _settleModalOpen = false),
      footer: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.end,
        children: [
          AppButton(
            text: 'Hủy',
            variant: AppButtonVariant.outline,
            disabled: _saving,
            onPressed: () => setState(() => _settleModalOpen = false),
          ),
          const SizedBox(width: 8),
          AppButton(
            text: 'Gửi đề xuất phê duyệt',
            variant: AppButtonVariant.primary,
            loading: _saving,
            onPressed: _handleCancelSettleSubmit,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFFF0F9FF),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFBAE6FD)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Gợi ý tự động theo chính sách tổ chức (làm tròn 1.000đ — PRD 10.3): Hoàn khách ${formatMoney(_settleSuggested.refundedAmount)} • Thu giữ phạt ${formatMoney(_settleSuggested.forfeitedAmount)}.',
                  style: const TextStyle(fontSize: 12, color: Color(0xFF0369A1)),
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 6,
                  children: [
                    AppButton(
                      text: 'Áp dụng gợi ý chính sách',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.xs,
                      onPressed: () {
                        setState(() {
                          _settleRefundedAmount = _settleSuggested.refundedAmount;
                          _settleForfeitedAmount = _settleSuggested.forfeitedAmount;
                        });
                      },
                    ),
                    AppButton(
                      text: 'Hoàn 100%',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.xs,
                      onPressed: () {
                        setState(() {
                          _settleRefundedAmount = holdAmt;
                          _settleForfeitedAmount = 0;
                        });
                      },
                    ),
                    AppButton(
                      text: 'Tịch thu 100%',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.xs,
                      onPressed: () {
                        setState(() {
                          _settleRefundedAmount = 0;
                          _settleForfeitedAmount = holdAmt;
                        });
                      },
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          MoneyInput(
            label: 'Số tiền đề xuất hoàn khách (VND)',
            value: _settleRefundedAmount,
            onChanged: _onSettleRefundedChanged,
          ),
          const SizedBox(height: 12),
          MoneyInput(
            label: 'Số tiền thu giữ / phạt cọc (VND)',
            value: _settleForfeitedAmount,
            disabled: true,
          ),
          if (_settleRefundedAmount > 0) ...[
            const SizedBox(height: 12),
            AppSelect<String>(
              label: 'Phương thức hoàn tiền dự kiến',
              value: _settleRefundMethod,
              options: const [
                AppSelectOption(value: 'BANK_TRANSFER', label: 'Chuyển khoản ngân hàng'),
                AppSelectOption(value: 'CASH', label: 'Tiền mặt tại quầy'),
              ],
              onChanged: (v) => setState(() => _settleRefundMethod = v ?? 'BANK_TRANSFER'),
            ),
            if (_settleRefundMethod == 'BANK_TRANSFER') ...[
              const SizedBox(height: 12),
              BankSelect(
                label: 'Ngân hàng nhận hoàn (bắt buộc)',
                value: _settleBankName,
                bankMeta: {
                  'bank_code': _settleBankCode,
                  'bank_bin': _settleBankBin,
                  'bank_logo': _settleBankLogo,
                },
                onBankChange: (val, chosen) {
                  setState(() {
                    _settleBankName = val;
                    _settleBankCode = chosen?['code']?.toString() ?? '';
                    _settleBankBin = chosen?['bin']?.toString() ?? '';
                    _settleBankLogo = chosen?['logo']?.toString() ?? '';
                  });
                },
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Số tài khoản nhận hoàn',
                      placeholder: 'Nhập STK ngân hàng',
                      initialValue: _settleAccountNumber,
                      onChanged: (v) => _settleAccountNumber = v,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Chủ tài khoản (IN HOA)',
                      placeholder: 'NGUYEN VAN A',
                      initialValue: _settleAccountHolder,
                      onChanged: (v) => _settleAccountHolder = v.toUpperCase(),
                    ),
                  ),
                ],
              ),
            ],
          ],
          const SizedBox(height: 12),
          AppInput(
            label: 'Lý do đề xuất thanh lý hủy (bắt buộc lưu vết kiểm toán)',
            placeholder: 'VD: Khách báo hủy sát hạn hoàn 50% theo chính sách giữ chỗ...',
            multiline: true,
            rows: 3,
            initialValue: _settleReason,
            onChanged: (v) => _settleReason = v,
          ),
        ],
      ),
    );
  }

  Widget _buildReviewCancelModal() {
    final holdAmt = num.tryParse(_reviewTargetRsv?['hold_amount']?.toString() ?? '')?.toInt() ?? 0;
    final refAmt = num.tryParse(_reviewTargetRsv?['refunded_amount']?.toString() ?? '')?.toInt() ?? 0;
    final forfAmt = num.tryParse(_reviewTargetRsv?['forfeited_amount']?.toString() ?? '')?.toInt() ?? 0;

    return AppModal(
      title: _reviewMode == 'reject'
          ? 'Từ chối đề xuất thanh lý hủy giữ chỗ'
          : 'Phê duyệt thanh lý hủy giữ chỗ (Bước 2 — Kiểm soát 4 mắt)',
      subtitle: _reviewTargetRsv != null
          ? 'Khách: ${_reviewTargetRsv!['prospect_name']} • Tiền giữ chỗ: ${formatMoney(holdAmt)}'
          : null,
      onClose: _saving ? null : () => setState(() => _reviewCancelOpen = false),
      footer: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.end,
        children: [
          AppButton(
            text: 'Đóng',
            variant: AppButtonVariant.outline,
            disabled: _saving,
            onPressed: () => setState(() => _reviewCancelOpen = false),
          ),
          const SizedBox(width: 8),
          AppButton(
            text: _reviewMode == 'reject'
                ? 'Xác nhận từ chối đề xuất'
                : (refAmt == 0 ? 'Phê duyệt & Tịch thu 100%' : 'Phê duyệt phương án & Mở phòng'),
            variant: _reviewMode == 'reject' ? AppButtonVariant.danger : AppButtonVariant.primary,
            loading: _saving,
            onPressed: _handleReviewCancelSubmit,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AppColors.slate200),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 16,
                  runSpacing: 8,
                  alignment: WrapAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Tổng giữ chỗ', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                        Text(formatMoney(holdAmt), style: const TextStyle(fontWeight: FontWeight.bold)),
                      ],
                    ),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Đề xuất hoàn khách', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                        Text(formatMoney(refAmt), style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFF047857))),
                      ],
                    ),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Đề xuất thu phạt', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                        Text(formatMoney(forfAmt), style: const TextStyle(fontWeight: FontWeight.bold, color: Color(0xFFE11D48))),
                      ],
                    ),
                  ],
                ),
                if (_reviewTargetRsv?['cancel_reason'] != null) ...[
                  const Divider(height: 16),
                  Text('Lý do BQL đề xuất: ${_reviewTargetRsv!['cancel_reason']}', style: const TextStyle(fontSize: 12, color: AppColors.slate700)),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              AppButton(
                text: 'Chế độ: Phê duyệt',
                variant: _reviewMode == 'approve' ? AppButtonVariant.primary : AppButtonVariant.outline,
                size: AppButtonSize.xs,
                onPressed: () => setState(() => _reviewMode = 'approve'),
              ),
              AppButton(
                text: 'Chế độ: Từ chối đề xuất',
                variant: _reviewMode == 'reject' ? AppButtonVariant.danger : AppButtonVariant.outline,
                size: AppButtonSize.xs,
                onPressed: () => setState(() => _reviewMode = 'reject'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          if (_reviewMode == 'reject')
            AppInput(
              label: 'Lý do từ chối đề xuất (bắt buộc)',
              placeholder: 'VD: Mức hoàn chưa đúng chính sách giữ chỗ, đề nghị áp dụng phạt 100%...',
              multiline: true,
              rows: 3,
              initialValue: _reviewRejectReason,
              onChanged: (v) => _reviewRejectReason = v,
            )
          else
            AppInput(
              label: 'Ghi chú phê duyệt (tùy chọn)',
              placeholder: 'VD: Đồng ý hoàn theo đề xuất, mở lại phòng để chào khách mới...',
              multiline: true,
              rows: 2,
              initialValue: _reviewNote,
              onChanged: (v) => _reviewNote = v,
            ),
        ],
      ),
    );
  }

  Widget _buildPayoutModal() {
    final refAmt = num.tryParse(_payoutTargetRsv?['refunded_amount']?.toString() ?? '')?.toInt() ?? 0;
    final forfAmt = num.tryParse(_payoutTargetRsv?['forfeited_amount']?.toString() ?? '')?.toInt() ?? 0;

    return AppModal(
      title: 'Thực chi hoàn tiền giữ chỗ & Tải UNC (Bước 3 — BQL thực chi)',
      subtitle: _payoutTargetRsv != null
          ? 'Khách: ${_payoutTargetRsv!['prospect_name']} • Đã duyệt hoàn: ${formatMoney(refAmt)}'
          : null,
      onClose: _saving ? null : () => setState(() => _payoutModalOpen = false),
      footer: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.end,
        children: [
          AppButton(
            text: 'Hủy',
            variant: AppButtonVariant.outline,
            disabled: _saving,
            onPressed: () => setState(() => _payoutModalOpen = false),
          ),
          const SizedBox(width: 8),
          AppButton(
            text: 'Xác nhận đã chi hoàn & Lưu UNC',
            variant: AppButtonVariant.primary,
            loading: _saving,
            onPressed: _handlePayoutSubmit,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: const Color(0xFFECFDF5),
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: const Color(0xFFA7F3D0)),
            ),
            child: Text(
              'Số tiền đã được phê duyệt hoàn trả: ${formatMoney(refAmt)} (Thu giữ phạt: ${formatMoney(forfAmt)}). Số tiền này đã khóa theo quyết định phê duyệt.',
              style: const TextStyle(fontSize: 12, color: Color(0xFF047857)),
            ),
          ),
          const SizedBox(height: 12),
          AppSelect<String>(
            label: 'Phương thức chi hoàn thực tế',
            value: _payoutRefundMethod,
            options: const [
              AppSelectOption(value: 'BANK_TRANSFER', label: 'Chuyển khoản ngân hàng (bắt buộc UNC)'),
              AppSelectOption(value: 'CASH', label: 'Tiền mặt tại quầy'),
            ],
            onChanged: (v) => setState(() => _payoutRefundMethod = v ?? 'BANK_TRANSFER'),
          ),
          if (_payoutRefundMethod == 'BANK_TRANSFER') ...[
            const SizedBox(height: 12),
            BankSelect(
              label: 'Ngân hàng nhận hoàn (bắt buộc)',
              value: _payoutBankName,
              bankMeta: {
                'bank_code': _payoutBankCode,
                'bank_bin': _payoutBankBin,
                'bank_logo': _payoutBankLogo,
              },
              onBankChange: (val, chosen) {
                setState(() {
                  _payoutBankName = val;
                  _payoutBankCode = chosen?['code']?.toString() ?? '';
                  _payoutBankBin = chosen?['bin']?.toString() ?? '';
                  _payoutBankLogo = chosen?['logo']?.toString() ?? '';
                });
              },
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: AppInput(
                    label: 'Số tài khoản nhận hoàn',
                    initialValue: _payoutAccountNumber,
                    onChanged: (v) => _payoutAccountNumber = v,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: AppInput(
                    label: 'Chủ tài khoản (IN HOA)',
                    initialValue: _payoutAccountHolder,
                    onChanged: (v) => _payoutAccountHolder = v.toUpperCase(),
                  ),
                ),
              ],
            ),
          ],
          const SizedBox(height: 12),
          FileUploadField(
            label: _payoutRefundMethod == 'BANK_TRANSFER'
                ? 'Ảnh chứng từ UNC chuyển khoản hoàn tiền (bắt buộc ≥ 1 ảnh — PRD 7.5)'
                : 'Ảnh phiếu chi tiền mặt / biên nhận (tùy chọn)',
            multiple: true,
            maxFiles: 3,
            value: _payoutEvidence,
            onChanged: (vals) {
              if (vals is List) {
                setState(() => _payoutEvidence = vals.map((e) => e.toString()).toList());
              }
            },
          ),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(
                child: AppInput(
                  label: 'Mã tham chiếu giao dịch / UNC',
                  placeholder: 'VD: FT26308...',
                  initialValue: _payoutReferenceCode,
                  onChanged: (v) => _payoutReferenceCode = v,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: AppInput(
                  label: 'Ghi chú chi hoàn',
                  placeholder: 'VD: Đã chuyển khoản hoàn giữ chỗ',
                  initialValue: _payoutNote,
                  onChanged: (v) => _payoutNote = v,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildEditBankModal() {
    return AppModal(
      title: 'Cập nhật tài khoản nhận hoàn giữ chỗ',
      subtitle: _editBankTargetRsv != null
          ? 'Khách: ${_editBankTargetRsv!['prospect_name']} • Số tiền hoàn: ${formatMoney(_editBankTargetRsv!['refunded_amount'])}'
          : null,
      onClose: _saving ? null : () => setState(() => _editBankOpen = false),
      footer: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.end,
        children: [
          AppButton(
            text: 'Hủy',
            variant: AppButtonVariant.outline,
            disabled: _saving,
            onPressed: () => setState(() => _editBankOpen = false),
          ),
          const SizedBox(width: 8),
          AppButton(
            text: 'Lưu tài khoản',
            variant: AppButtonVariant.primary,
            loading: _saving,
            onPressed: _handleEditBankSubmit,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          BankSelect(
            label: 'Ngân hàng nhận hoàn',
            value: _editBankName,
            bankMeta: {
              'bank_code': _editBankCode,
              'bank_bin': _editBankBin,
              'bank_logo': _editBankLogo,
            },
            onBankChange: (val, chosen) {
              setState(() {
                _editBankName = val;
                _editBankCode = chosen?['code']?.toString() ?? '';
                _editBankBin = chosen?['bin']?.toString() ?? '';
                _editBankLogo = chosen?['logo']?.toString() ?? '';
              });
            },
          ),
          const SizedBox(height: 12),
          AppInput(
            label: 'Số tài khoản nhận hoàn',
            initialValue: _editAccountNumber,
            onChanged: (v) => _editAccountNumber = v,
          ),
          const SizedBox(height: 12),
          AppInput(
            label: 'Chủ tài khoản (IN HOA)',
            initialValue: _editAccountHolder,
            onChanged: (v) => _editAccountHolder = v.toUpperCase(),
          ),
        ],
      ),
    );
  }

  Widget _buildDeepLinkReservationModal(PermissionMatrix permissions) {
    final rsv = _deepLinkReviewRsv!;
    final canConfirm = canManagerConfirmReservationPayment(rsv, isManager: permissions.isManager);
    final evidence = (rsv['evidence'] as List?)?.map((e) => e.toString()).toList() ?? [];

    return AppModal(
      title: 'Chi tiết Phiếu Giữ chỗ & Chứng từ Đặt cọc',
      subtitle:
          'Căn ${_apt!['code']} (${_apt!['building_code']}) • Khách: ${rsv['prospect_name'] ?? '—'}',
      onClose: _saving ? null : () => setState(() => _deepLinkReviewRsv = null),
      footer: Wrap(
        spacing: 8,
        runSpacing: 8,
        alignment: WrapAlignment.end,
        children: [
          AppButton(
            text: 'Đóng',
            variant: AppButtonVariant.outline,
            disabled: _saving,
            onPressed: () => setState(() => _deepLinkReviewRsv = null),
          ),
          if (canConfirm) ...[
            const SizedBox(width: 8),
            AppButton(
              text: 'Từ chối biên lai',
              variant: AppButtonVariant.danger,
              disabled: _saving,
              onPressed: () {
                final target = rsv;
                setState(() => _deepLinkReviewRsv = null);
                _openRejectModal(target);
              },
            ),
            const SizedBox(width: 8),
            AppButton(
              text: 'Xác nhận tiền về',
              variant: AppButtonVariant.primary,
              loading: _saving,
              onPressed: () async {
                final target = rsv;
                setState(() => _deepLinkReviewRsv = null);
                await _handleConfirmPayment(target);
              },
            ),
          ],
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.slate50,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AppColors.slate200),
            ),
            child: Wrap(
              spacing: 16,
              runSpacing: 12,
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Trạng thái giữ chỗ', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                    const SizedBox(height: 4),
                    StatusBadge(status: rsv['status']?.toString(), domain: StatusDomain.reservation),
                  ],
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Số điện thoại', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                    const SizedBox(height: 4),
                    Text(rsv['phone']?.toString() ?? '—', style: const TextStyle(fontWeight: FontWeight.bold)),
                  ],
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Số tiền giữ chỗ', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                    const SizedBox(height: 4),
                    Text(
                      formatMoney(rsv['hold_amount']),
                      style: const TextStyle(fontFamily: 'monospace', fontWeight: FontWeight.bold, color: Color(0xFF047857)),
                    ),
                  ],
                ),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('Thời hạn giữ chỗ', style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                    const SizedBox(height: 4),
                    Text(
                      '${formatDate(rsv['hold_from'] ?? rsv['created_at'])} → ${formatDate(rsv['hold_until'])}',
                      style: const TextStyle(fontWeight: FontWeight.bold),
                    ),
                  ],
                ),
              ],
            ),
          ),
          if (evidence.isNotEmpty) ...[
            const SizedBox(height: 16),
            Text('Ảnh chụp biên lai chuyển khoản (${evidence.length})', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 13)),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: evidence
                  .map((url) => SizedBox(
                        width: 120,
                        height: 120,
                        child: ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: AuthImage(src: url),
                        ),
                      ))
                  .toList(),
            ),
          ],
          if (rsv['note'] != null && rsv['note'].toString().isNotEmpty) ...[
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.slate200),
              ),
              child: Text('Ghi chú: ${rsv['note']}', style: const TextStyle(fontSize: 12, color: AppColors.slate600)),
            ),
          ],
        ],
      ),
    );
  }
}
