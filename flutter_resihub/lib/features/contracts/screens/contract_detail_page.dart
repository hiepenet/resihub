import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/date_range.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/loading_spinner.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/app_tabs.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../../../shared/widgets/ui/html_print_preview_modal.dart';
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../../buildings/services/buildings_service.dart';
import '../services/contracts_service.dart';

const List<AppSelectOption<String>> kRelationshipOptions = [
  AppSelectOption(value: 'family', label: 'Gia đình / Người thân'),
  AppSelectOption(value: 'spouse', label: 'Vợ / Chồng'),
  AppSelectOption(value: 'child', label: 'Con cái'),
  AppSelectOption(value: 'roommate', label: 'Bạn cùng phòng'),
  AppSelectOption(value: 'friend', label: 'Bạn bè'),
  AppSelectOption(value: 'other', label: 'Khác'),
];

class ContractDetailPage extends ConsumerStatefulWidget {
  final String contractId;
  final String? initialModal;

  const ContractDetailPage({
    super.key,
    required this.contractId,
    this.initialModal,
  });

  @override
  ConsumerState<ContractDetailPage> createState() => _ContractDetailPageState();
}

class _ContractDetailPageState extends ConsumerState<ContractDetailPage> {
  dynamic _contract;
  List<dynamic> _occupants = [];
  List<dynamic> _amendments = [];
  List<dynamic> _servicePrices = [];
  bool _loading = true;
  String _activeTab = 'overview';

  // Printing
  bool _printing = false;

  // Confirm state
  String? _confirmType; // 'activate' | 'approve' | 'approve_termination'
  bool _processingConfirm = false;

  // Edit draft modal
  bool _editDraftOpen = false;
  String _editStartDate = '';
  String _editEndDate = '';
  String _editRentAmount = '';
  String _editDepositAmount = '';
  String _editBillingCycle = 'monthly';
  String _editBillingDay = '1';
  String _editPaymentDueDays = '5';
  String _editNote = '';
  bool _savingDraft = false;

  // Cancel draft modal
  bool _cancelOpen = false;
  String _cancelReason = '';
  bool _cancelling = false;

  // Renew modal
  bool _renewOpen = false;
  String _renewEndDate = '';
  String _renewRentAmount = '';
  String _renewDepositAmount = '';
  String _renewNote = '';
  bool _submittingRenew = false;

  // Amend modal
  bool _amendOpen = false;
  String _amendEffectiveFrom = '';
  String _amendEndDate = '';
  String _amendRentAmount = '';
  String _amendDepositAmount = '';
  String _amendReason = '';
  bool _submittingAmend = false;

  // Reject amend modal
  dynamic _rejectAmendTarget;
  String _rejectAmendReason = '';
  bool _submittingRejectAmend = false;

  // Transfer room modal
  bool _transferOpen = false;
  List<dynamic> _availableApts = [];
  String _transferNewAptId = '';
  String _transferStartDate = '';
  String _transferEndDate = '';
  String _transferRentAmount = '';
  String _transferDepositAmount = '';
  bool _transferDeposit = true;
  String _transferNote = '';
  bool _submittingTransfer = false;

  // Terminate modal
  bool _terminateOpen = false;
  String _terminateDate = '';
  String _terminateReason = 'Thỏa thuận thanh lý hợp đồng trước hạn';
  String _terminateNote = '';
  bool _submittingTerminate = false;

  // Reject Price (return to DRAFT) modal
  bool _rejectPriceOpen = false;
  String _rejectPriceReason = '';
  bool _submittingRejectPrice = false;

  // Reject Termination modal
  bool _rejectTermOpen = false;
  String _rejectTermReason = '';
  bool _submittingRejectTerm = false;

  // Occupants add modal
  bool _occModalOpen = false;
  final Map<String, String> _occForm = {
    'full_name': '',
    'phone': '',
    'relationship': 'family',
    'id_number': '',
    'email': '',
    'dob': '',
  };
  Map<String, String> _occErrors = {};
  bool _submittingOcc = false;

  // Remove occupant confirm
  dynamic _removeOccTarget;
  bool _removingOcc = false;

  // Service price modal
  bool _spModalOpen = false;
  String _spServiceCode = 'INTERNET';
  String _spUnitPrice = '';
  String _spEffectiveFrom = '';
  bool _submittingSp = false;

  @override
  void initState() {
    super.initState();
    _loadAll();
  }

  Future<void> _loadAll({bool force = false}) async {
    final contractsService = ref.read(contractsServiceProvider);
    final cached = contractsService.peekById(widget.contractId);
    if (cached != null && cached is Map && cached['data'] is Map && !force) {
      _applyContractData(cached['data']);
      setState(() => _loading = false);
    } else {
      setState(() => _loading = true);
    }

    try {
      final res = await contractsService.getById(widget.contractId, force: force);
      final data = (res is Map && res['data'] is Map) ? res['data'] : null;
      if (data != null) {
        _applyContractData(data);
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải thông tin chi tiết hợp đồng.'),
          );
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  void _applyContractData(dynamic data) {
    if (data is! Map) return;
    setState(() {
      _contract = data;
      _occupants = (data['occupants'] is List) ? List<dynamic>.from(data['occupants']) : [];
      _amendments = (data['amendments'] is List) ? List<dynamic>.from(data['amendments']) : [];
      _servicePrices = (data['service_prices'] is List) ? List<dynamic>.from(data['service_prices']) : [];
    });
  }

  // Print A4 HTML
  Future<void> _handlePrintA4() async {
    setState(() => _printing = true);
    try {
      final html = await ref.read(contractsServiceProvider).getTemplateHtml(widget.contractId);
      if (mounted) {
        final idStr = _contract?['id']?.toString() ?? '';
        final shortId = idStr.length >= 8 ? idStr.substring(0, 8) : idStr;
        final code = idStr.isNotEmpty ? 'HĐ-${shortId.toUpperCase()}' : 'Hợp đồng';
        await HtmlPrintPreviewModal.show(
          context,
          title: 'Bản in A4 — $code',
          htmlContent: html,
        );
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải mẫu in hợp đồng A4.'),
          );
    } finally {
      if (mounted) {
        setState(() => _printing = false);
      }
    }
  }

  // Upload Scan
  Future<void> _handleUploadScan(dynamic base64Val) async {
    if (base64Val == null || base64Val.toString().isEmpty) return;
    try {
      final res = await ref.read(contractsServiceProvider).uploadScan(
        widget.contractId,
        {'file_base64': base64Val.toString(), 'image_base64': base64Val.toString()},
      );
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã đính kèm bản scan thành công.',
          );
      _loadAll(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải lên bản scan hợp đồng.'),
          );
    }
  }

  // Confirm Lifecycle Action (activate / approve / approve_termination)
  Future<void> _handleConfirmAction() async {
    if (_confirmType == null) return;
    setState(() => _processingConfirm = true);
    try {
      final cService = ref.read(contractsServiceProvider);
      final idem = createIdempotencyKey();

      if (_confirmType == 'activate') {
        final res = await cService.activate(widget.contractId, {}, idempotencyKey: idem);
        ref.read(toastProvider.notifier).success(
              (res is Map && res['message'] != null) ? res['message'].toString() : 'Kích hoạt hợp đồng thành công!',
            );
      } else if (_confirmType == 'approve') {
        final res = await cService.approve(widget.contractId, {}, idempotencyKey: idem);
        ref.read(toastProvider.notifier).success(
              (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã phê duyệt và kích hoạt hợp đồng thành công!',
            );
      } else if (_confirmType == 'approve_termination') {
        final res = await cService.approveTermination(widget.contractId);
        ref.read(toastProvider.notifier).success(
              (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã phê duyệt chấm dứt hợp đồng.',
            );
      }
      setState(() => _confirmType = null);
      _loadAll(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Thao tác không thành công.'),
          );
    } finally {
      if (mounted) {
        setState(() => _processingConfirm = false);
      }
    }
  }

  // Save Edit Draft
  Future<void> _handleSaveDraft() async {
    setState(() => _savingDraft = true);
    try {
      final res = await ref.read(contractsServiceProvider).update(widget.contractId, {
        'start_date': _editStartDate,
        'end_date': _editEndDate,
        'rent_amount': (num.tryParse(_editRentAmount) ?? 0).round(),
        'deposit_amount': (num.tryParse(_editDepositAmount) ?? 0).round(),
        'billing_cycle': _editBillingCycle,
        'billing_day': int.tryParse(_editBillingDay) ?? 1,
        'payment_due_days': int.tryParse(_editPaymentDueDays) ?? 5,
        'note': _editNote.trim(),
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Cập nhật bản nháp hợp đồng thành công.',
          );
      setState(() => _editDraftOpen = false);
      _loadAll(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể cập nhật hợp đồng nháp.'),
          );
    } finally {
      if (mounted) {
        setState(() => _savingDraft = false);
      }
    }
  }

  // Cancel Draft
  Future<void> _handleCancelDraft() async {
    setState(() => _cancelling = true);
    try {
      final res = await ref.read(contractsServiceProvider).cancel(widget.contractId, {
        'reason': _cancelReason.trim(),
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã hủy hợp đồng nháp.',
          );
      setState(() {
        _cancelOpen = false;
        _cancelReason = '';
      });
      _loadAll(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể hủy hợp đồng nháp.'),
          );
    } finally {
      if (mounted) {
        setState(() => _cancelling = false);
      }
    }
  }

  // Renew Submit
  Future<void> _handleRenewSubmit() async {
    if (_renewEndDate.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn ngày kết thúc mới.');
      return;
    }
    setState(() => _submittingRenew = true);
    try {
      final res = await ref.read(contractsServiceProvider).renew(
        widget.contractId,
        {
          'new_end_date': _renewEndDate,
          'rent_amount': (num.tryParse(_renewRentAmount) ?? 0).round(),
          'deposit_amount': (num.tryParse(_renewDepositAmount) ?? 0).round(),
          'note': _renewNote.trim(),
        },
        idempotencyKey: createIdempotencyKey(),
      );
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã tạo hợp đồng gia hạn nối tiếp.',
          );
      setState(() => _renewOpen = false);

      final nextId = (res is Map && res['data'] is Map) ? res['data']['id']?.toString() : null;
      if (nextId != null && mounted) {
        context.push('/admin/contracts/$nextId');
      } else {
        _loadAll(force: true);
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tạo hợp đồng gia hạn.'),
          );
    } finally {
      if (mounted) {
        setState(() => _submittingRenew = false);
      }
    }
  }

  // Create Amendment Submit
  Future<void> _handleAmendSubmit() async {
    if (_amendReason.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do lập phụ lục hợp đồng.');
      return;
    }
    setState(() => _submittingAmend = true);
    try {
      final changes = <String, dynamic>{};
      if (_amendEndDate.isNotEmpty) changes['end_date'] = _amendEndDate;
      final rent = num.tryParse(_amendRentAmount);
      if (rent != null && rent > 0) changes['rent_amount'] = rent.round();
      final dep = num.tryParse(_amendDepositAmount);
      if (dep != null && dep >= 0) changes['deposit_amount'] = dep.round();

      final res = await ref.read(contractsServiceProvider).createAmendment(widget.contractId, {
        'changes': changes,
        'effective_from': _amendEffectiveFrom.isNotEmpty ? _amendEffectiveFrom : null,
        'reason': _amendReason.trim(),
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã gửi đề xuất phụ lục hợp đồng.',
          );
      setState(() {
        _amendOpen = false;
        _activeTab = 'amendments';
      });
      _loadAll(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tạo phụ lục hợp đồng.'),
          );
    } finally {
      if (mounted) {
        setState(() => _submittingAmend = false);
      }
    }
  }

  // Approve Amendment
  Future<void> _handleApproveAmendment(String versionId) async {
    try {
      final res = await ref.read(contractsServiceProvider).approveAmendment(widget.contractId, versionId);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã phê duyệt phụ lục hợp đồng.',
          );
      _loadAll(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể phê duyệt phụ lục.'),
          );
    }
  }

  // Reject Amendment
  Future<void> _handleRejectAmendmentSubmit() async {
    if (_rejectAmendTarget == null) return;
    final verId = _rejectAmendTarget['id'].toString();
    setState(() => _submittingRejectAmend = true);
    try {
      final res = await ref.read(contractsServiceProvider).rejectAmendment(widget.contractId, verId, {
        'reason': _rejectAmendReason.trim(),
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã từ chối phụ lục hợp đồng.',
          );
      setState(() {
        _rejectAmendTarget = null;
        _rejectAmendReason = '';
      });
      _loadAll(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể từ chối phụ lục.'),
          );
    } finally {
      if (mounted) {
        setState(() => _submittingRejectAmend = false);
      }
    }
  }

  // Open Transfer Room
  Future<void> _handleOpenTransfer() async {
    if (_contract == null) return;
    final curEnd = toDateOnlyStr(_contract['end_date']);
    final today = toDateOnlyStr(DateTime.now());

    setState(() {
      _transferNewAptId = '';
      _transferStartDate = today;
      _transferEndDate = curEnd.isNotEmpty && curEnd.compareTo(today) > 0 ? curEnd : addMonthsClampedStr(today, 12);
      _transferRentAmount = _contract['rent_amount'] != null ? _contract['rent_amount'].toString() : '';
      _transferDepositAmount = _contract['deposit_amount'] != null ? _contract['deposit_amount'].toString() : '';
      _transferDeposit = true;
      _transferNote = '';
      _transferOpen = true;
      _availableApts = [];
    });

    final bId = _contract['building_id']?.toString();
    if (bId == null || bId.isEmpty) return;

    try {
      final res = await ref.read(buildingsServiceProvider).listApartments({'building_id': bId});
      final list = (res is Map && res['data'] is List)
          ? (res['data'] as List).where((a) => a is Map && a['status'] == 'AVAILABLE' && a['id']?.toString() != _contract['apartment_id']?.toString()).toList()
          : [];
      setState(() => _availableApts = list);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải danh sách căn trống cùng tòa.'),
          );
    }
  }

  // Transfer Room Submit
  Future<void> _handleTransferSubmit() async {
    if (_transferNewAptId.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn căn hộ chuyển đến.');
      return;
    }
    setState(() => _submittingTransfer = true);
    try {
      final res = await ref.read(contractsServiceProvider).transferRoom(
        widget.contractId,
        {
          'new_apartment_id': _transferNewAptId,
          'new_start_date': _transferStartDate,
          'new_end_date': _transferEndDate,
          'new_rent_amount': (num.tryParse(_transferRentAmount) ?? 0).round(),
          'new_deposit_amount': (num.tryParse(_transferDepositAmount) ?? 0).round(),
          'transfer_deposit': _transferDeposit,
          if (_transferNote.trim().isNotEmpty) 'note': _transferNote.trim(),
        },
        idempotencyKey: createIdempotencyKey(),
      );
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã tạo hợp đồng nháp đổi phòng thành công!',
          );
      setState(() => _transferOpen = false);

      final newContract = (res is Map && res['data'] is Map && res['data']['new_contract'] is Map)
          ? res['data']['new_contract']
          : null;
      if (newContract != null && newContract['id'] != null && mounted) {
        context.push('/admin/contracts/${newContract['id']}');
      } else {
        _loadAll(force: true);
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể khởi tạo hợp đồng đổi phòng.'),
          );
    } finally {
      if (mounted) {
        setState(() => _submittingTransfer = false);
      }
    }
  }

  // Terminate Submit
  Future<void> _handleTerminateSubmit() async {
    if (_terminateDate.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn ngày chấm dứt hợp đồng.');
      return;
    }
    setState(() => _submittingTerminate = true);
    try {
      final res = await ref.read(contractsServiceProvider).terminate(
        widget.contractId,
        {
          'terminated_date': _terminateDate,
          'reason': _terminateReason.trim(),
          if (_terminateNote.trim().isNotEmpty) 'note': _terminateNote.trim(),
        },
        idempotencyKey: createIdempotencyKey(),
      );
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã chấm dứt hợp đồng thành công.',
          );
      setState(() => _terminateOpen = false);
      _loadAll(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể chấm dứt hợp đồng.'),
          );
    } finally {
      if (mounted) {
        setState(() => _submittingTerminate = false);
      }
    }
  }

  // Reject Price Submit (alias: rejectContract)
  Future<void> _handleRejectPriceSubmit() async {
    if (_rejectPriceReason.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do từ chối phê duyệt hợp đồng.');
      return;
    }
    setState(() => _submittingRejectPrice = true);
    try {
      final res = await ref.read(contractsServiceProvider).rejectContract(
        widget.contractId,
        _rejectPriceReason.trim(),
      );
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã từ chối phê duyệt, hợp đồng chuyển về DRAFT.',
          );
      setState(() {
        _rejectPriceOpen = false;
        _rejectPriceReason = '';
      });
      _loadAll(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể từ chối hợp đồng.'),
          );
    } finally {
      if (mounted) {
        setState(() => _submittingRejectPrice = false);
      }
    }
  }

  // Reject Termination Submit
  Future<void> _handleRejectTerminationSubmit() async {
    if (_rejectTermReason.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do từ chối chấm dứt.');
      return;
    }
    setState(() => _submittingRejectTerm = true);
    try {
      final res = await ref.read(contractsServiceProvider).rejectTermination(widget.contractId, {
        'reason': _rejectTermReason.trim(),
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã hủy lịch chấm dứt, hợp đồng giữ hiệu lực ACTIVE.',
          );
      setState(() {
        _rejectTermOpen = false;
        _rejectTermReason = '';
      });
      _loadAll(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể từ chối chấm dứt.'),
          );
    } finally {
      if (mounted) {
        setState(() => _submittingRejectTerm = false);
      }
    }
  }

  // Add Occupant Submit
  Future<void> _handleAddOccupantSubmit() async {
    final errs = <String, String>{};
    if ((_occForm['full_name'] ?? '').trim().isEmpty) errs['full_name'] = 'Vui lòng nhập họ tên.';
    if ((_occForm['phone'] ?? '').trim().isEmpty) {
      errs['phone'] = 'Vui lòng nhập số điện thoại.';
    } else if (!isValidPhone(_occForm['phone']!)) {
      errs['phone'] = 'Số điện thoại không hợp lệ.';
    }
    setState(() => _occErrors = errs);
    if (errs.isNotEmpty) return;

    setState(() => _submittingOcc = true);
    try {
      final res = await ref.read(contractsServiceProvider).addOccupant(widget.contractId, {
        'full_name': _occForm['full_name']!.trim(),
        'phone': normalizePhone(_occForm['phone']!),
        'relationship': _occForm['relationship'] ?? 'family',
        if ((_occForm['id_number'] ?? '').isNotEmpty) 'id_number': _occForm['id_number']!.trim(),
        if ((_occForm['email'] ?? '').isNotEmpty) 'email': _occForm['email']!.trim(),
        if ((_occForm['dob'] ?? '').isNotEmpty) 'dob': _occForm['dob'],
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã thêm thành viên ở cùng.',
          );
      setState(() {
        _occModalOpen = false;
        _occForm.updateAll((key, value) => key == 'relationship' ? 'family' : '');
      });
      final oRes = await ref.read(contractsServiceProvider).listOccupants(widget.contractId, force: true);
      if (oRes is Map && oRes['data'] is List) {
        setState(() => _occupants = List<dynamic>.from(oRes['data']));
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể thêm thành viên.'),
          );
    } finally {
      if (mounted) {
        setState(() => _submittingOcc = false);
      }
    }
  }

  // Remove Occupant
  Future<void> _handleConfirmRemoveOccupant() async {
    if (_removeOccTarget == null) return;
    final tId = _removeOccTarget['tenant_id']?.toString() ?? _removeOccTarget['id']?.toString();
    if (tId == null || tId.isEmpty) return;

    setState(() => _removingOcc = true);
    try {
      final res = await ref.read(contractsServiceProvider).removeOccupant(widget.contractId, tId);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã gỡ thành viên khỏi hợp đồng.',
          );
      setState(() => _removeOccTarget = null);
      final oRes = await ref.read(contractsServiceProvider).listOccupants(widget.contractId, force: true);
      if (oRes is Map && oRes['data'] is List) {
        setState(() => _occupants = List<dynamic>.from(oRes['data']));
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể gỡ thành viên.'),
          );
    } finally {
      if (mounted) {
        setState(() => _removingOcc = false);
      }
    }
  }

  // Add Service Price
  Future<void> _handleAddServicePrice() async {
    final price = num.tryParse(_spUnitPrice);
    if (price == null || price < 0) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập đơn giá hợp lệ (>= 0).');
      return;
    }
    setState(() => _submittingSp = true);
    try {
      final res = await ref.read(contractsServiceProvider).addServicePrice(widget.contractId, {
        'service_code': _spServiceCode,
        'unit_price': price.round(),
        if (_spEffectiveFrom.isNotEmpty) 'effective_from': _spEffectiveFrom,
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã lưu đơn giá dịch vụ theo hợp đồng.',
          );
      setState(() => _spModalOpen = false);
      final spRes = await ref.read(contractsServiceProvider).listServicePrices(widget.contractId, force: true);
      if (spRes is Map && spRes['data'] is List) {
        setState(() => _servicePrices = List<dynamic>.from(spRes['data']));
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể cập nhật giá dịch vụ.'),
          );
    } finally {
      if (mounted) {
        setState(() => _submittingSp = false);
      }
    }
  }

  // Remove Service Price
  Future<void> _handleRemoveServicePrice(String priceId) async {
    try {
      await ref.read(contractsServiceProvider).removeServicePrice(widget.contractId, priceId);
      ref.read(toastProvider.notifier).success('Đã xóa cấu hình giá dịch vụ.');
      final spRes = await ref.read(contractsServiceProvider).listServicePrices(widget.contractId, force: true);
      if (spRes is Map && spRes['data'] is List) {
        setState(() => _servicePrices = List<dynamic>.from(spRes['data']));
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể xóa đơn giá dịch vụ.'),
          );
    }
  }

  Widget? _buildActiveOverlayModal() {
    if (_editDraftOpen) {
      return AppModal(
        title: 'Chỉnh sửa hợp đồng nháp (DRAFT)',
        subtitle: 'Cập nhật lại giá thuê, tiền cọc hoặc kỳ hạn trước khi ký kết',
        size: AppModalSize.lg,
        onClose: () => setState(() => _editDraftOpen = false),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Hủy',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _editDraftOpen = false),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Lưu thay đổi',
              loading: _savingDraft,
              onPressed: _handleSaveDraft,
            ),
          ],
        ),
        child: SingleChildScrollView(
          child: Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Ngày bắt đầu',
                      initialValue: _editStartDate,
                      onChanged: (val) => _editStartDate = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Ngày kết thúc',
                      initialValue: _editEndDate,
                      onChanged: (val) => _editEndDate = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Giá thuê (VND)',
                      initialValue: _editRentAmount,
                      onChanged: (val) => _editRentAmount = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Tiền cọc (VND)',
                      initialValue: _editDepositAmount,
                      onChanged: (val) => _editDepositAmount = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Ghi chú',
                multiline: true,
                rows: 2,
                initialValue: _editNote,
                onChanged: (val) => _editNote = val,
              ),
            ],
          ),
        ),
      );
    }

    if (_cancelOpen) {
      return AppModal(
        title: 'Hủy hợp đồng nháp',
        size: AppModalSize.sm,
        onClose: () => setState(() => _cancelOpen = false),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Đóng',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _cancelOpen = false),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Xác nhận hủy',
              variant: AppButtonVariant.danger,
              loading: _cancelling,
              onPressed: _handleCancelDraft,
            ),
          ],
        ),
        child: AppInput(
          label: 'Lý do hủy hợp đồng',
          multiline: true,
          rows: 3,
          placeholder: 'Nhập lý do hủy...',
          initialValue: _cancelReason,
          onChanged: (val) => _cancelReason = val,
        ),
      );
    }

    if (_renewOpen) {
      return AppModal(
        title: 'Gia hạn hợp đồng (Tạo hợp đồng nối tiếp)',
        size: AppModalSize.md,
        onClose: () => setState(() => _renewOpen = false),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Hủy bỏ',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _renewOpen = false),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Tạo HĐ gia hạn',
              icon: const Icon(LucideIcons.refreshCw, size: 16),
              loading: _submittingRenew,
              onPressed: _handleRenewSubmit,
            ),
          ],
        ),
        child: SingleChildScrollView(
          child: Column(
            children: [
              AppInput(
                label: 'Ngày kết thúc mới',
                initialValue: _renewEndDate,
                onChanged: (val) => _renewEndDate = val,
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Giá thuê kỳ mới (VND)',
                      initialValue: _renewRentAmount,
                      onChanged: (val) => _renewRentAmount = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Tiền cọc kỳ mới (VND)',
                      initialValue: _renewDepositAmount,
                      onChanged: (val) => _renewDepositAmount = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Ghi chú gia hạn',
                multiline: true,
                rows: 2,
                initialValue: _renewNote,
                onChanged: (val) => _renewNote = val,
              ),
            ],
          ),
        ),
      );
    }

    if (_amendOpen) {
      return AppModal(
        title: 'Lập phụ lục điều chỉnh hợp đồng',
        subtitle: 'Đề xuất điều chỉnh các điều khoản và gửi cấp thẩm quyền duyệt 4 mắt',
        size: AppModalSize.md,
        onClose: () => setState(() => _amendOpen = false),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Hủy bỏ',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _amendOpen = false),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Gửi đề xuất phụ lục',
              icon: const Icon(LucideIcons.filePlus2, size: 16),
              loading: _submittingAmend,
              onPressed: _handleAmendSubmit,
            ),
          ],
        ),
        child: SingleChildScrollView(
          child: Column(
            children: [
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Giá thuê mới (VND)',
                      initialValue: _amendRentAmount,
                      onChanged: (val) => _amendRentAmount = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Tiền cọc mới (VND)',
                      initialValue: _amendDepositAmount,
                      onChanged: (val) => _amendDepositAmount = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Hiệu lực từ ngày',
                      initialValue: _amendEffectiveFrom,
                      onChanged: (val) => _amendEffectiveFrom = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Ngày kết thúc mới',
                      initialValue: _amendEndDate,
                      onChanged: (val) => _amendEndDate = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Lý do lập phụ lục',
                required: true,
                multiline: true,
                rows: 2,
                initialValue: _amendReason,
                onChanged: (val) => _amendReason = val,
              ),
            ],
          ),
        ),
      );
    }

    if (_rejectAmendTarget != null) {
      return AppModal(
        title: 'Từ chối phụ lục hợp đồng',
        size: AppModalSize.sm,
        onClose: () => setState(() => _rejectAmendTarget = null),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Hủy',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _rejectAmendTarget = null),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Xác nhận từ chối',
              variant: AppButtonVariant.danger,
              loading: _submittingRejectAmend,
              onPressed: _handleRejectAmendmentSubmit,
            ),
          ],
        ),
        child: AppInput(
          label: 'Lý do từ chối',
          required: true,
          multiline: true,
          rows: 3,
          placeholder: 'Nhập lý do từ chối phụ lục...',
          initialValue: _rejectAmendReason,
          onChanged: (val) => _rejectAmendReason = val,
        ),
      );
    }

    if (_transferOpen) {
      return AppModal(
        title: 'Đổi phòng & Kết chuyển cọc (Quy trình 4 mắt)',
        size: AppModalSize.md,
        onClose: () => setState(() => _transferOpen = false),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Hủy bỏ',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _transferOpen = false),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Tạo nháp HĐ đổi phòng',
              icon: const Icon(LucideIcons.arrowRightLeft, size: 16),
              loading: _submittingTransfer,
              onPressed: _handleTransferSubmit,
            ),
          ],
        ),
        child: SingleChildScrollView(
          child: Column(
            children: [
              AppSelect<String>(
                label: 'Chọn căn hộ trống cần chuyển đến',
                placeholder: _availableApts.isEmpty ? 'Không có căn trống cùng tòa' : 'Chọn căn hộ',
                value: _transferNewAptId.isNotEmpty ? _transferNewAptId : null,
                options: _availableApts.map((a) {
                  final id = a['id']?.toString() ?? '';
                  final code = a['code']?.toString() ?? '';
                  final base = a['base_rent'] != null ? ' - ${formatMoney(a['base_rent'])}' : '';
                  return AppSelectOption(value: id, label: '$code$base');
                }).toList(),
                onChanged: (val) {
                  setState(() {
                    _transferNewAptId = val ?? '';
                    final matched = _availableApts.firstWhere((a) => a['id']?.toString() == val, orElse: () => null);
                    if (matched is Map && matched['base_rent'] != null) {
                      _transferRentAmount = matched['base_rent'].toString();
                    }
                  });
                },
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Ngày chuyển phòng',
                      initialValue: _transferStartDate,
                      onChanged: (val) => _transferStartDate = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Ngày kết thúc HĐ mới',
                      initialValue: _transferEndDate,
                      onChanged: (val) => _transferEndDate = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Giá thuê mới (VND)',
                      initialValue: _transferRentAmount,
                      onChanged: (val) => _transferRentAmount = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Tiền cọc mới (VND)',
                      initialValue: _transferDepositAmount,
                      onChanged: (val) => _transferDepositAmount = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Checkbox(
                    value: _transferDeposit,
                    onChanged: (v) => setState(() => _transferDeposit = v ?? true),
                  ),
                  const Expanded(
                    child: Text(
                      'Tự động kết chuyển sổ cọc hiện tại sang hợp đồng mới khi được phê duyệt',
                      style: TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.slate700),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              AppInput(
                label: 'Ghi chú chuyển phòng',
                multiline: true,
                rows: 2,
                initialValue: _transferNote,
                onChanged: (val) => _transferNote = val,
              ),
            ],
          ),
        ),
      );
    }

    if (_terminateOpen) {
      return AppModal(
        title: 'Thanh lý / Chấm dứt hợp đồng',
        subtitle: 'Chấm dứt hiệu lực hợp đồng ngay lập tức và mở hạn hoàn cọc 5 ngày',
        size: AppModalSize.md,
        onClose: () => setState(() => _terminateOpen = false),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Hủy bỏ',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _terminateOpen = false),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Xác nhận chấm dứt',
              variant: AppButtonVariant.danger,
              loading: _submittingTerminate,
              onPressed: _handleTerminateSubmit,
            ),
          ],
        ),
        child: SingleChildScrollView(
          child: Column(
            children: [
              AppInput(
                label: 'Ngày chấm dứt hợp đồng',
                initialValue: _terminateDate,
                onChanged: (val) => _terminateDate = val,
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Lý do chấm dứt (Audit Log)',
                required: true,
                initialValue: _terminateReason,
                onChanged: (val) => _terminateReason = val,
              ),
              const SizedBox(height: 12),
              AppInput(
                label: 'Ghi chú bàn giao',
                multiline: true,
                rows: 2,
                initialValue: _terminateNote,
                onChanged: (val) => _terminateNote = val,
              ),
            ],
          ),
        ),
      );
    }

    if (_rejectPriceOpen) {
      return AppModal(
        title: 'Từ chối phê duyệt hợp đồng (trả về bản nháp)',
        size: AppModalSize.sm,
        onClose: () => setState(() => _rejectPriceOpen = false),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Hủy',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _rejectPriceOpen = false),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Xác nhận từ chối',
              variant: AppButtonVariant.danger,
              loading: _submittingRejectPrice,
              onPressed: _handleRejectPriceSubmit,
            ),
          ],
        ),
        child: AppInput(
          label: 'Lý do từ chối mức giá ưu đãi',
          required: true,
          multiline: true,
          rows: 3,
          placeholder: 'Nhập lý do từ chối để người lập điều chỉnh...',
          initialValue: _rejectPriceReason,
          onChanged: (val) => _rejectPriceReason = val,
        ),
      );
    }

    if (_rejectTermOpen) {
      return AppModal(
        title: 'Hủy lịch chấm dứt hợp đồng',
        size: AppModalSize.sm,
        onClose: () => setState(() => _rejectTermOpen = false),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Đóng',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _rejectTermOpen = false),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Xác nhận hủy lịch',
              variant: AppButtonVariant.danger,
              loading: _submittingRejectTerm,
              onPressed: _handleRejectTerminationSubmit,
            ),
          ],
        ),
        child: AppInput(
          label: 'Lý do hủy lịch chấm dứt',
          required: true,
          multiline: true,
          rows: 3,
          placeholder: 'Nhập lý do...',
          initialValue: _rejectTermReason,
          onChanged: (val) => _rejectTermReason = val,
        ),
      );
    }

    if (_occModalOpen) {
      return AppModal(
        title: 'Thêm thành viên cùng lưu trú',
        size: AppModalSize.md,
        onClose: () => setState(() => _occModalOpen = false),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Hủy',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _occModalOpen = false),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Thêm vào HĐ',
              icon: const Icon(LucideIcons.userPlus, size: 16),
              loading: _submittingOcc,
              onPressed: _handleAddOccupantSubmit,
            ),
          ],
        ),
        child: SingleChildScrollView(
          child: Column(
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Họ và tên',
                      required: true,
                      initialValue: _occForm['full_name'],
                      error: _occErrors['full_name'],
                      onChanged: (val) => _occForm['full_name'] = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Số điện thoại',
                      required: true,
                      initialValue: _occForm['phone'],
                      error: _occErrors['phone'],
                      onChanged: (val) => _occForm['phone'] = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AppSelect<String>(
                      label: 'Quan hệ',
                      value: _occForm['relationship'],
                      options: kRelationshipOptions,
                      onChanged: (val) => setState(() => _occForm['relationship'] = val ?? 'family'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'CCCD / Hộ chiếu',
                      initialValue: _occForm['id_number'],
                      onChanged: (val) => _occForm['id_number'] = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Email',
                      initialValue: _occForm['email'],
                      onChanged: (val) => _occForm['email'] = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Ngày sinh',
                      initialValue: _occForm['dob'],
                      onChanged: (val) => _occForm['dob'] = val,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      );
    }

    if (_removeOccTarget != null) {
      return ConfirmDialog(
        title: 'Gỡ thành viên khỏi hợp đồng',
        message: 'Bạn có chắc muốn gỡ "${_removeOccTarget['full_name']}" khỏi hợp đồng này? Hồ sơ định danh vẫn được bảo lưu.',
        confirmLabel: 'Gỡ thành viên',
        variant: ConfirmDialogVariant.danger,
        loading: _removingOcc,
        onClose: () => setState(() => _removeOccTarget = null),
        onConfirm: _handleConfirmRemoveOccupant,
      );
    }

    if (_spModalOpen) {
      return AppModal(
        title: 'Cấu hình đơn giá dịch vụ theo hợp đồng',
        size: AppModalSize.sm,
        onClose: () => setState(() => _spModalOpen = false),
        footer: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            AppButton(
              text: 'Hủy',
              variant: AppButtonVariant.outline,
              onPressed: () => setState(() => _spModalOpen = false),
            ),
            const SizedBox(width: 10),
            AppButton(
              text: 'Lưu đơn giá',
              loading: _submittingSp,
              onPressed: _handleAddServicePrice,
            ),
          ],
        ),
        child: Column(
          children: [
            AppInput(
              label: 'Mã dịch vụ (service_code)',
              initialValue: _spServiceCode,
              onChanged: (val) => _spServiceCode = val,
            ),
            const SizedBox(height: 12),
            AppInput(
              label: 'Đơn giá áp dụng (VND)',
              required: true,
              initialValue: _spUnitPrice,
              onChanged: (val) => _spUnitPrice = val,
            ),
            const SizedBox(height: 12),
            AppInput(
              label: 'Hiệu lực từ ngày',
              initialValue: _spEffectiveFrom,
              onChanged: (val) => _spEffectiveFrom = val,
            ),
          ],
        ),
      );
    }

    if (_confirmType != null) {
      final isActivate = _confirmType == 'activate';
      final isApprove = _confirmType == 'approve';
      return ConfirmDialog(
        title: isActivate
            ? 'Kích hoạt hợp đồng thuê'
            : isApprove
                ? 'Phê duyệt HĐ giá ưu đãi'
                : 'Phê duyệt chấm dứt hợp đồng',
        message: isActivate
            ? 'Xác nhận kích hoạt hợp đồng? Hệ thống sẽ chuyển trạng thái căn hộ và mở sổ cọc bảo đảm.'
            : isApprove
                ? 'Xác nhận phê duyệt mức giá và kích hoạt hợp đồng sang ACTIVE?'
                : 'Xác nhận phê duyệt chấm dứt hợp đồng? Căn hộ sẽ chuyển sang Bảo trì.',
        confirmLabel: 'Xác nhận thực hiện',
        variant: isActivate || isApprove ? ConfirmDialogVariant.primary : ConfirmDialogVariant.warning,
        loading: _processingConfirm,
        onClose: () => setState(() => _confirmType = null),
        onConfirm: _handleConfirmAction,
      );
    }

    return null;
  }

  @override
  Widget build(BuildContext context) {
    if (_loading && _contract == null) {
      return const Scaffold(
        backgroundColor: AppColors.slate50,
        body: Center(child: LoadingSpinner(label: 'Đang tải chi tiết hợp đồng...')),
      );
    }

    if (_contract == null) {
      return Scaffold(
        backgroundColor: AppColors.slate50,
        body: Center(
          child: EmptyState(
            title: 'Không tìm thấy hợp đồng',
            description: 'Hợp đồng không tồn tại hoặc bạn không có quyền truy cập.',
            action: AppButton(
              text: 'Về danh sách hợp đồng',
              variant: AppButtonVariant.primary,
              onPressed: () => context.push('/admin/contracts'),
            ),
          ),
        ),
      );
    }

    final permissions = ref.watch(permissionProvider);
    final user = ref.watch(authProvider).user;
    final currentUserId = user?.id;

    final isOwner = permissions.isOwner;
    final isSysAdmin = permissions.isSysAdmin;
    final isManager = permissions.isManager;
    final canManageOps = isManager;
    final canTerminateContracts = permissions.canTerminateContracts;
    final canApproveContractAmendments = permissions.canApproveContractAmendments;

    final status = _contract['status']?.toString() ?? 'DRAFT';
    final hasBuildingOwner = _contract['has_building_owner'] == true;
    final isRoomTransfer = _contract['is_room_transfer'] == true;
    final apartmentBaseRent = num.tryParse(_contract['apartment_base_rent']?.toString() ?? '0') ?? 0;
    final rentAmount = num.tryParse(_contract['rent_amount']?.toString() ?? '0') ?? 0;
    final isContractDiscounted = apartmentBaseRent > 0 && rentAmount < apartmentBaseRent * 0.9;

    // 4-eyes approval permission check
    final canApprovePrice = isOwner ||
        (isSysAdmin && !hasBuildingOwner) ||
        (isManager && isRoomTransfer && !hasBuildingOwner && !isContractDiscounted);

    final isProposer = _contract['created_by'] != null &&
        currentUserId != null &&
        _contract['created_by'].toString() == currentUserId;
    const allowSelfApproval = false;
    final canPerformApproval = canApprovePrice && (!isProposer || allowSelfApproval);

    final idStr = _contract['id']?.toString() ?? '';
    final contractCode = 'HĐ-${idStr.substring(0, idStr.length >= 8 ? 8 : idStr.length).toUpperCase()}';
    final attachments = (_contract['attachments'] is List) ? List<dynamic>.from(_contract['attachments']) : [];

    // Tabs
    final tabs = [
      AppTabItem(id: 'overview', label: 'Chi tiết & Bản scan', count: attachments.length),
      AppTabItem(id: 'occupants', label: 'Người ở cùng', count: _occupants.length),
      AppTabItem(id: 'amendments', label: 'Phụ lục hợp đồng', count: _amendments.length),
      AppTabItem(id: 'history', label: 'Giá dịch vụ riêng', count: _servicePrices.length),
    ];

    final overlayModal = _buildActiveOverlayModal();

    return Scaffold(
      backgroundColor: AppColors.slate50,
      body: Stack(
        children: [
          Positioned.fill(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  PageHeader(
                    title: 'Hợp đồng $contractCode — Căn ${_contract['apartment_code'] ?? '—'}',
                    subtitle: 'Tòa nhà: ${_contract['building_name'] ?? '—'} • Khách thuê chính: ${_contract['tenant_name'] ?? '—'}',
                    actions: Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        AppButton(
                          text: 'Xem & In hợp đồng A4',
                          variant: AppButtonVariant.outline,
                          icon: const Icon(LucideIcons.printer, size: 16),
                          loading: _printing,
                          onPressed: _handlePrintA4,
                        ),

                        // MANAGER Operational Actions
                        if (canManageOps && status == 'DRAFT') ...[
                          AppButton(
                            text: 'Sửa nháp',
                            variant: AppButtonVariant.outline,
                            icon: const Icon(LucideIcons.pencil, size: 16),
                            onPressed: () {
                              setState(() {
                                _editStartDate = toDateOnlyStr(_contract['start_date']);
                                _editEndDate = toDateOnlyStr(_contract['end_date']);
                                _editRentAmount = _contract['rent_amount'] != null ? _contract['rent_amount'].toString() : '';
                                _editDepositAmount = _contract['deposit_amount'] != null ? _contract['deposit_amount'].toString() : '';
                                _editBillingCycle = _contract['billing_cycle']?.toString() ?? 'monthly';
                                _editBillingDay = _contract['billing_day']?.toString() ?? '1';
                                _editPaymentDueDays = _contract['payment_due_days']?.toString() ?? '5';
                                _editNote = _contract['note']?.toString() ?? '';
                                _editDraftOpen = true;
                              });
                            },
                          ),
                          AppButton(
                            text: 'Hủy nháp',
                            variant: AppButtonVariant.outline,
                            icon: const Icon(LucideIcons.xCircle, size: 16),
                            onPressed: () => setState(() => _cancelOpen = true),
                          ),
                          AppButton(
                            text: 'Kích hoạt HĐ',
                            variant: AppButtonVariant.primary,
                            icon: const Icon(LucideIcons.checkCircle2, size: 16),
                            onPressed: () => setState(() => _confirmType = 'activate'),
                          ),
                        ],

                        if (canManageOps && ['ACTIVE', 'RENEWAL_PENDING', 'EXPIRED'].contains(status))
                          AppButton(
                            text: 'Gia hạn HĐ',
                            variant: AppButtonVariant.outline,
                            icon: const Icon(LucideIcons.refreshCw, size: 16),
                            onPressed: () {
                              final curEnd = toDateOnlyStr(_contract['end_date']);
                              setState(() {
                                _renewEndDate = addMonthsClampedStr(curEnd, 12);
                                _renewRentAmount = _contract['rent_amount'] != null ? _contract['rent_amount'].toString() : '';
                                _renewDepositAmount = _contract['deposit_amount'] != null ? _contract['deposit_amount'].toString() : '';
                                _renewNote = 'Gia hạn nối tiếp từ hợp đồng $contractCode';
                                _renewOpen = true;
                              });
                            },
                          ),

                        if (canManageOps && ['ACTIVE', 'RENEWAL_PENDING'].contains(status))
                          AppButton(
                            text: 'Phụ lục điều chỉnh',
                            variant: AppButtonVariant.outline,
                            icon: const Icon(LucideIcons.filePlus2, size: 16),
                            onPressed: () {
                              setState(() {
                                _amendEndDate = toDateOnlyStr(_contract['end_date']);
                                _amendRentAmount = _contract['rent_amount'] != null ? _contract['rent_amount'].toString() : '';
                                _amendDepositAmount = _contract['deposit_amount'] != null ? _contract['deposit_amount'].toString() : '';
                                _amendEffectiveFrom = toDateOnlyStr(DateTime.now());
                                _amendReason = '';
                                _amendOpen = true;
                              });
                            },
                          ),

                        if (canManageOps && status == 'ACTIVE')
                          AppButton(
                            text: 'Chuyển phòng',
                            variant: AppButtonVariant.soft,
                            icon: const Icon(LucideIcons.arrowRightLeft, size: 16),
                            onPressed: _handleOpenTransfer,
                          ),

                        if (canTerminateContracts && ['ACTIVE', 'RENEWAL_PENDING'].contains(status))
                          AppButton(
                            text: 'Thanh lý / Chấm dứt HĐ',
                            variant: AppButtonVariant.danger,
                            icon: const Icon(LucideIcons.xCircle, size: 16),
                            onPressed: () {
                              setState(() {
                                _terminateDate = toDateOnlyStr(DateTime.now());
                                _terminateReason = 'Khách thuê trả phòng / Thanh lý hợp đồng';
                                _terminateNote = '';
                                _terminateOpen = true;
                              });
                            },
                          ),

                        // OWNER / SYS_ADMIN Approval Buttons for PENDING_APPROVAL
                        if (status == 'PENDING_APPROVAL' && canPerformApproval) ...[
                          AppButton(
                            text: 'Từ chối (trả về nháp)',
                            variant: AppButtonVariant.danger,
                            icon: const Icon(LucideIcons.xCircle, size: 16),
                            onPressed: () {
                              setState(() {
                                _rejectPriceReason = '';
                                _rejectPriceOpen = true;
                              });
                            },
                          ),
                          AppButton(
                            text: isRoomTransfer ? 'Phê duyệt đổi phòng & kết chuyển cọc' : 'Phê duyệt HĐ giá ưu đãi',
                            variant: AppButtonVariant.primary,
                            icon: const Icon(LucideIcons.shieldCheck, size: 16),
                            onPressed: () => setState(() => _confirmType = 'approve'),
                          ),
                        ],

                        if (canTerminateContracts && status == 'TERMINATION_PENDING') ...[
                          AppButton(
                            text: 'Hủy lịch chấm dứt',
                            variant: AppButtonVariant.outline,
                            icon: const Icon(LucideIcons.xCircle, size: 16),
                            onPressed: () => setState(() => _rejectTermOpen = true),
                          ),
                          AppButton(
                            text: 'Chốt trả phòng & Chấm dứt ngay',
                            variant: AppButtonVariant.danger,
                            icon: const Icon(LucideIcons.checkCircle2, size: 16),
                            onPressed: () => setState(() => _confirmType = 'approve_termination'),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Status timeline banner
                  Container(
                    padding: const EdgeInsets.all(16),
                    decoration: BoxDecoration(
                      color: Colors.white,
                      borderRadius: BorderRadius.circular(12),
                      border: Border.all(color: AppColors.slate200),
                    ),
                    child: Row(
                      children: [
                        StatusBadge(status: status, domain: StatusDomain.contract),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            status == 'PENDING_APPROVAL'
                                ? 'Hợp đồng đang chờ Chủ sở hữu tòa nhà (hoặc Quản trị hệ thống) phê duyệt 4 mắt.'
                                : status == 'DRAFT'
                                    ? 'Hợp đồng đang ở trạng thái Bản nháp — vui lòng in A4 và tải lên bản scan ký kết trước khi kích hoạt.'
                                    : status == 'ACTIVE'
                                        ? 'Hợp đồng đang có hiệu lực. Mọi thay đổi tài chính cần lập Phụ lục điều chỉnh.'
                                        : 'Hợp đồng đang ở trạng thái $status.',
                            style: const TextStyle(fontFamily: 'Inter', fontSize: 13, color: AppColors.slate700),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Tabs
                  AppTabs(
                    tabs: tabs,
                    activeTab: _activeTab,
                    onChanged: (id) => setState(() => _activeTab = id),
                  ),
                  const SizedBox(height: 16),

                  // Tab 1: Overview & Scan
                  if (_activeTab == 'overview')
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        // Left: Commercial info
                        Expanded(
                          flex: 3,
                          child: AppCard(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                const Text(
                                  'Thông tin điều khoản hợp đồng',
                                  style: TextStyle(fontFamily: 'Inter', fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.slate900),
                                ),
                                const SizedBox(height: 12),
                                _buildInfoRow('Căn hộ & Tòa nhà', '${_contract['apartment_code'] ?? '—'} — ${_contract['building_name'] ?? '—'}'),
                                _buildInfoRow('Khách thuê đại diện', '${_contract['tenant_name'] ?? '—'} (${_contract['tenant_phone'] ?? '—'})'),
                                _buildInfoRow('Giá thuê hàng tháng', formatMoney(_contract['rent_amount'])),
                                _buildInfoRow('Tiền đặt cọc bảo đảm', formatMoney(_contract['deposit_amount'])),
                                _buildInfoRow('Kỳ hạn thuê', '${formatDate(_contract['start_date'])} → ${formatDate(_contract['end_date'])}'),
                                _buildInfoRow(
                                  'Chu kỳ & Ngày chốt',
                                  '${_contract['billing_cycle'] == 'quarterly' ? '3 tháng / lần' : 'Hàng tháng'} • Ngày ${_contract['billing_day'] ?? 1} • Hạn ${_contract['payment_due_days'] ?? 5} ngày',
                                ),
                                if (_contract['note'] != null && _contract['note'].toString().isNotEmpty)
                                  _buildInfoRow('Ghi chú hợp đồng', _contract['note'].toString()),
                              ],
                            ),
                          ),
                        ),
                        const SizedBox(width: 16),

                        // Right: Scan Attachments
                        Expanded(
                          flex: 2,
                          child: AppCard(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                  children: [
                                    const Expanded(
                                      child: Text(
                                        'Bản scan ký kết (AC-009.2)',
                                        style: TextStyle(fontFamily: 'Inter', fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.slate900),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    AppBadge(
                                      label: '${attachments.length} tệp',
                                      variant: attachments.isNotEmpty ? AppBadgeVariant.emerald : AppBadgeVariant.amber,
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 12),
                                if (attachments.isEmpty)
                                  const Padding(
                                    padding: EdgeInsets.symmetric(vertical: 20),
                                    child: Center(
                                      child: Text(
                                        'Chưa đính kèm bản scan hợp đồng đã ký kết.',
                                        style: TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.slate400),
                                      ),
                                    ),
                                  )
                                else
                                  Wrap(
                                    spacing: 8,
                                    runSpacing: 8,
                                    children: attachments.map((att) {
                                      final id = att['id']?.toString() ?? '';
                                      final url = '/api/v1/attachments/$id/view';
                                      return InkWell(
                                        onTap: () => AuthMediaViewer.show(context, src: url, title: 'Bản scan hợp đồng $contractCode'),
                                        child: Container(
                                          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                                          decoration: BoxDecoration(
                                            color: AppColors.slate50,
                                            borderRadius: BorderRadius.circular(8),
                                            border: Border.all(color: AppColors.slate200),
                                          ),
                                          child: const Row(
                                            mainAxisSize: MainAxisSize.min,
                                            children: [
                                              Icon(LucideIcons.fileText, size: 14, color: AppColors.primary600),
                                              SizedBox(width: 6),
                                              Text('Xem bản scan', style: TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.primary700)),
                                            ],
                                          ),
                                        ),
                                      );
                                    }).toList(),
                                  ),
                                const SizedBox(height: 12),
                                if (canManageOps)
                                  FileUploadField(
                                    label: 'Đính kèm bản scan đã ký (PDF / Ảnh)',
                                    onChanged: _handleUploadScan,
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),

                  // Tab 2: Occupants
                  if (_activeTab == 'occupants')
                    AppCard(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              const Text(
                                'Thành viên cùng lưu trú',
                                style: TextStyle(fontFamily: 'Inter', fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.slate900),
                              ),
                              if (canManageOps)
                                AppButton(
                                  text: 'Thêm thành viên',
                                  size: AppButtonSize.sm,
                                  icon: const Icon(LucideIcons.userPlus, size: 14),
                                  onPressed: () => setState(() => _occModalOpen = true),
                                ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          DataTableWidget<dynamic>(
                            columns: [
                              DataTableColumn<dynamic>(
                                key: 'full_name',
                                label: 'Họ và tên',
                                render: (r) => Text(r['full_name']?.toString() ?? '—', style: const TextStyle(fontWeight: FontWeight.w600)),
                              ),
                              DataTableColumn<dynamic>(
                                key: 'relationship',
                                label: 'Quan hệ',
                                align: TextAlign.center,
                                render: (r) => AppBadge(label: r['relationship']?.toString() ?? 'Khác', variant: AppBadgeVariant.indigo),
                              ),
                              DataTableColumn<dynamic>(
                                key: 'phone',
                                label: 'Số điện thoại',
                                align: TextAlign.center,
                                render: (r) => Text(r['phone']?.toString() ?? '—'),
                              ),
                              DataTableColumn<dynamic>(
                                key: 'id_number',
                                label: 'CCCD / Hộ chiếu',
                                align: TextAlign.center,
                                render: (r) => Text(maskIdNumber(r['id_number'])),
                              ),
                              if (canManageOps)
                                DataTableColumn<dynamic>(
                                  key: 'actions',
                                  label: 'Thao tác',
                                  align: TextAlign.center,
                                  render: (r) => AppButton(
                                    text: 'Gỡ',
                                    size: AppButtonSize.xs,
                                    variant: AppButtonVariant.danger,
                                    onPressed: () => setState(() => _removeOccTarget = r),
                                  ),
                                ),
                            ],
                            data: _occupants,
                            loading: false,
                          ),
                        ],
                      ),
                    ),

                  // Tab 3: Amendments
                  if (_activeTab == 'amendments')
                    AppCard(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              const Text(
                                'Phụ lục hợp đồng đã lập',
                                style: TextStyle(fontFamily: 'Inter', fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.slate900),
                              ),
                              if (canManageOps && ['ACTIVE', 'RENEWAL_PENDING'].contains(status))
                                AppButton(
                                  text: 'Tạo phụ lục',
                                  size: AppButtonSize.sm,
                                  icon: const Icon(LucideIcons.filePlus2, size: 14),
                                  onPressed: () => setState(() => _amendOpen = true),
                                ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          if (_amendments.isEmpty)
                            const EmptyState(
                              title: 'Chưa có phụ lục hợp đồng',
                              description: 'Mọi điều chỉnh giá, cọc hoặc kỳ hạn sẽ được lưu vết phiên bản tại đây.',
                            )
                          else
                            Column(
                              children: _amendments.map((am) {
                                final isApproved = am['approved_by'] != null;
                                final isRejected = am['diff']?['status'] == 'REJECTED';
                                final isPending = !isApproved && !isRejected;

                                final isAmendCreator = am['created_by'] != null &&
                                    currentUserId != null &&
                                    am['created_by'].toString() == currentUserId;
                                final canApproveThisAmend = canApproveContractAmendments && (!isAmendCreator || allowSelfApproval);

                                return Container(
                                  margin: const EdgeInsets.only(bottom: 12),
                                  padding: const EdgeInsets.all(14),
                                  decoration: BoxDecoration(
                                    color: Colors.white,
                                    borderRadius: BorderRadius.circular(10),
                                    border: Border.all(color: AppColors.slate200),
                                  ),
                                  child: Column(
                                    crossAxisAlignment: CrossAxisAlignment.start,
                                    children: [
                                      Row(
                                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                        children: [
                                          Text(
                                            'Phiên bản #${am['version_no'] ?? '—'} (Hiệu lực từ: ${formatDate(am['effective_from'])})',
                                            style: const TextStyle(fontWeight: FontWeight.w700, color: AppColors.slate900),
                                          ),
                                          AppBadge(
                                            label: isApproved ? 'Đã duyệt' : isRejected ? 'Đã từ chối' : 'Chờ duyệt 4 mắt',
                                            variant: isApproved ? AppBadgeVariant.emerald : isRejected ? AppBadgeVariant.red : AppBadgeVariant.amber,
                                          ),
                                        ],
                                      ),
                                      const SizedBox(height: 6),
                                      Text('Lý do: ${am['reason'] ?? '—'}', style: const TextStyle(fontSize: 12, color: AppColors.slate600)),
                                      if (isPending && canApproveThisAmend) ...[
                                        const SizedBox(height: 8),
                                        Row(
                                          mainAxisAlignment: MainAxisAlignment.end,
                                          children: [
                                            AppButton(
                                              text: 'Từ chối',
                                              size: AppButtonSize.xs,
                                              variant: AppButtonVariant.outline,
                                              onPressed: () => setState(() {
                                                _rejectAmendTarget = am;
                                                _rejectAmendReason = '';
                                              }),
                                            ),
                                            const SizedBox(width: 8),
                                            AppButton(
                                              text: 'Phê duyệt',
                                              size: AppButtonSize.xs,
                                              variant: AppButtonVariant.primary,
                                              onPressed: () => _handleApproveAmendment(am['id'].toString()),
                                            ),
                                          ],
                                        ),
                                      ],
                                    ],
                                  ),
                                );
                              }).toList(),
                            ),
                        ],
                      ),
                    ),

                  // Tab 4: Service prices
                  if (_activeTab == 'history')
                    AppCard(
                      padding: const EdgeInsets.all(16),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Row(
                            mainAxisAlignment: MainAxisAlignment.spaceBetween,
                            children: [
                              const Text(
                                'Đơn giá dịch vụ riêng theo hợp đồng',
                                style: TextStyle(fontFamily: 'Inter', fontSize: 14, fontWeight: FontWeight.w700, color: AppColors.slate900),
                              ),
                              if (canManageOps)
                                AppButton(
                                  text: 'Thêm giá riêng',
                                  size: AppButtonSize.sm,
                                  icon: const Icon(LucideIcons.plus, size: 14),
                                  onPressed: () => setState(() => _spModalOpen = true),
                                ),
                            ],
                          ),
                          const SizedBox(height: 12),
                          if (_servicePrices.isEmpty)
                            const Text('Đang áp dụng biểu phí dịch vụ niêm yết của tòa nhà.', style: TextStyle(fontSize: 12, color: AppColors.slate400))
                          else
                            DataTableWidget<dynamic>(
                              columns: [
                                DataTableColumn<dynamic>(
                                  key: 'service_code',
                                  label: 'Mã dịch vụ',
                                  render: (r) => Text(r['service_code']?.toString() ?? '—', style: const TextStyle(fontWeight: FontWeight.w600)),
                                ),
                                DataTableColumn<dynamic>(
                                  key: 'unit_price',
                                  label: 'Đơn giá áp dụng',
                                  align: TextAlign.right,
                                  render: (r) => Text(formatMoney(r['unit_price']), style: const TextStyle(fontWeight: FontWeight.w700)),
                                ),
                                DataTableColumn<dynamic>(
                                  key: 'effective_from',
                                  label: 'Hiệu lực từ',
                                  align: TextAlign.center,
                                  render: (r) => Text(formatDate(r['effective_from'])),
                                ),
                                if (canManageOps)
                                  DataTableColumn<dynamic>(
                                    key: 'actions',
                                    label: 'Thao tác',
                                    align: TextAlign.center,
                                    render: (r) => IconButton(
                                      icon: const Icon(LucideIcons.trash2, size: 16, color: AppColors.rose600),
                                      onPressed: () => _handleRemoveServicePrice(r['id'].toString()),
                                    ),
                                  ),
                              ],
                              data: _servicePrices,
                              loading: false,
                            ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),

          // Viewport Scrim Modal Overlay
          if (overlayModal != null)
            Positioned.fill(
              child: Container(
                color: Colors.black.withValues(alpha: 0.5),
                alignment: Alignment.center,
                padding: const EdgeInsets.all(24),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxWidth: 720,
                    maxHeight: MediaQuery.sizeOf(context).height * 0.9,
                  ),
                  child: Material(
                    color: Colors.transparent,
                    child: overlayModal,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildInfoRow(String label, String value) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 160,
            child: Text(label, style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.slate500)),
          ),
          Expanded(
            child: Text(value, style: const TextStyle(fontFamily: 'Inter', fontSize: 13, fontWeight: FontWeight.w600, color: AppColors.slate800)),
          ),
        ],
      ),
    );
  }
}
