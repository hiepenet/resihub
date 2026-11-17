import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/ai_helpers.dart';
import '../../../core/utils/date_range.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/service_subscription_meta.dart';
import '../../../core/utils/validation.dart';
import '../../ai_gateway/services/ai_service.dart';
import '../../../shared/widgets/common/service_subscription_meta_fields.dart';
import '../../../shared/widgets/ui/file_upload_field.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/data_table_widget.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
import '../../../shared/widgets/common/stats_card.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/app_tabs.dart';
import '../../auth/providers/auth_provider.dart';
import '../../auth/providers/permission_provider.dart';
import '../../buildings/services/buildings_service.dart';
import '../../services/services/services_service.dart';
import '../../tenants/services/tenants_service.dart';
import '../services/contracts_service.dart';

const Map<String, String> kContractStatusLabels = {
  '': 'Tất cả trạng thái',
  'PENDING_ALL': 'Tất cả chờ phê duyệt (Giá / Gia hạn / Chấm dứt)',
  'DRAFT': 'Bản nháp (DRAFT)',
  'PENDING_APPROVAL': 'Chờ phê duyệt giá (PENDING_APPROVAL)',
  'ACTIVE': 'Đang hiệu lực (ACTIVE)',
  'RENEWAL_PENDING': 'Chờ duyệt gia hạn (RENEWAL_PENDING)',
  'TERMINATION_PENDING': 'Chờ bàn giao chấm dứt (TERMINATION_PENDING)',
  'EXPIRED': 'Đã hết hạn (EXPIRED)',
  'TERMINATED': 'Đã thanh lý (TERMINATED)',
  'CANCELLED': 'Đã hủy (CANCELLED)',
};

const Map<String, String> kRequestTypeLabels = {
  'RENEWAL': 'Gia hạn hợp đồng',
  'TERMINATION': 'Chấm dứt hợp đồng',
  'REGISTRATION': 'Đăng ký thuê mới',
  'REGISTER': 'Đăng ký thuê mới',
};

const Map<String, AppBadgeVariant> kRequestTypeVariants = {
  'RENEWAL': AppBadgeVariant.sky,
  'TERMINATION': AppBadgeVariant.amber,
  'REGISTRATION': AppBadgeVariant.emerald,
  'REGISTER': AppBadgeVariant.emerald,
};

const Map<String, String> kRequestStatusLabels = {
  '': 'Tất cả trạng thái yêu cầu',
  'SUBMITTED': 'Chờ xử lý (SUBMITTED)',
  'APPROVED': 'Đã phê duyệt (APPROVED)',
  'REJECTED': 'Đã từ chối (REJECTED)',
};

const List<AppSelectOption<String>> kRelationshipOptions = [
  AppSelectOption(value: 'family', label: 'Gia đình / Người thân'),
  AppSelectOption(value: 'spouse', label: 'Vợ / Chồng'),
  AppSelectOption(value: 'child', label: 'Con cái'),
  AppSelectOption(value: 'roommate', label: 'Bạn cùng phòng'),
  AppSelectOption(value: 'friend', label: 'Bạn bè'),
  AppSelectOption(value: 'other', label: 'Khác'),
];

/// React ContractsPage.jsx:375,643-644 — giá niêm yết parse số trực tiếp
/// (không formatMoney().replaceAll('.', '') — cách cũ sai khi giá có '.' phân cách hàng nghìn).
String rawNumericString(dynamic raw) {
  if (raw == null) return '';
  final numVal = num.tryParse(raw.toString());
  if (numVal == null) return '';
  return numVal.round().toString();
}

/// React ContractsPage.jsx:136-149 — nhãn trạng thái căn hộ trong option select.
String getAptSelectStatusLabel(String status) {
  switch (status) {
    case 'AVAILABLE':
      return 'Còn trống';
    case 'RESERVED':
      return 'Đã giữ chỗ';
    case 'OCCUPIED':
      return 'Đang có khách thuê (Tạo HĐ nối tiếp)';
    case 'MAINTENANCE':
      return 'Đang bảo trì (Tạo HĐ tương lai)';
    default:
      return status;
  }
}

/// React ContractsPage.jsx:1905-1917 — option căn hộ kèm trạng thái/giá/sublabel/badge.
AppSelectOption<String> buildApartmentSelectOption(Map<String, dynamic> a) {
  final id = a['id']?.toString() ?? '';
  final code = a['code']?.toString() ?? '';
  final status = a['status']?.toString() ?? '';
  final cCount = num.tryParse(a['active_contracts_count']?.toString() ?? '')?.toInt() ?? 0;
  final rCount = num.tryParse(a['held_reservations_count']?.toString() ?? '')?.toInt() ?? 0;
  final badgeParts = <String>[];
  if (cCount > 0) badgeParts.add('$cCount HĐ');
  if (rCount > 0) badgeParts.add('$rCount giữ chỗ');
  final sublabel = [
    a['building_name']?.toString() ?? '',
    a['floor_name']?.toString() ?? '',
  ].where((s) => s.isNotEmpty).join(' · ');
  return AppSelectOption<String>(
    value: id,
    label: '$code — ${getAptSelectStatusLabel(status)} — Niêm yết: ${formatMoney(a['base_rent'])}',
    sublabel: sublabel.isNotEmpty ? sublabel : null,
    badge: badgeParts.isNotEmpty ? badgeParts.join(' · ') : null,
    searchText: code,
  );
}

/// React ContractsPage.jsx:909-959 — map output AI quét hợp đồng sang draft tạo HĐ.
Map<String, dynamic> mapContractAiOutputToDraft(
  Map<String, dynamic> out,
  List<dynamic> apartments,
) {
  final aptCode = out['apartment_code']?.toString().trim().toLowerCase() ?? '';
  Map<String, dynamic>? matched;
  if (aptCode.isNotEmpty) {
    for (final a in apartments) {
      if (a is Map && a['code']?.toString().trim().toLowerCase() == aptCode) {
        matched = Map<String, dynamic>.from(a);
        break;
      }
    }
  }

  String date10(dynamic v) {
    final s = v?.toString() ?? '';
    return s.length >= 10 ? s.substring(0, 10) : s;
  }

  String positiveAmount(dynamic v, {bool allowZero = false}) {
    final n = num.tryParse(v?.toString() ?? '');
    if (n == null) return '';
    if (allowZero ? n < 0 : n <= 0) return '';
    return n.round().toString();
  }

  return {
    'start_date': out['start_date'] != null ? date10(out['start_date']) : '',
    'end_date': out['end_date'] != null ? date10(out['end_date']) : '',
    'rent_amount': positiveAmount(out['rent_amount']),
    'deposit_amount': positiveAmount(out['deposit_amount'], allowZero: true),
    'billing_day': out['billing_day'] != null ? out['billing_day'].toString() : '',
    'payment_due_days':
        out['payment_due_days'] != null ? out['payment_due_days'].toString() : '',
    'note': (out['terms_note']?.toString() ?? out['note']?.toString() ?? '').trim(),
    'apartment_id': matched?['id']?.toString(),
    'building_id': matched?['building_id']?.toString(),
    'tenant_phone': out['tenant_phone']?.toString() ?? '',
    'tenant_id_number': out['tenant_id_number']?.toString() ?? '',
    'tenant_full_name': out['tenant_full_name']?.toString() ?? '',
  };
}

/// Dữ liệu form tạo hợp đồng — lớp thuần để validate/test không cần widget hay provider.
class ContractCreateDraft {
  final String apartmentId;
  final String tenantMode;
  final bool hasLookedUpTenant;
  final Map<String, dynamic> newTenantForm;
  final bool duplicateOutOfScope;
  final String startDate;
  final String endDate;
  final String rentAmount;
  final String depositAmount;
  final String billingDay;
  final String paymentDueDays;
  final List<Map<String, String>> occupants;
  final Map<String, Map<String, dynamic>> selectedServices;
  final List<dynamic> serviceCatalog;
  final List<BusyInterval> busyIntervals;
  final String apartmentStatus;
  final String todayStr;

  const ContractCreateDraft({
    this.apartmentId = 'apt-1',
    this.tenantMode = 'existing',
    this.hasLookedUpTenant = true,
    this.newTenantForm = const {},
    this.duplicateOutOfScope = false,
    this.startDate = '2026-11-20',
    this.endDate = '2027-11-20',
    this.rentAmount = '10000000',
    this.depositAmount = '10000000',
    this.billingDay = '1',
    this.paymentDueDays = '5',
    this.occupants = const [],
    this.selectedServices = const {},
    this.serviceCatalog = const [],
    this.busyIntervals = const [],
    this.apartmentStatus = 'AVAILABLE',
    this.todayStr = '2026-11-17',
  });
}

/// Validate toàn bộ form tạo hợp đồng — port của ContractsPage.jsx:1059-1186.
/// Trả về map lỗi (key khớp React) để UI hiển thị và chặn submit.
Map<String, String> validateContractCreateForm(ContractCreateDraft draft) {
  final errs = <String, String>{};

  if (draft.apartmentId.isEmpty) {
    errs['apartment_id'] = 'Vui lòng chọn căn hộ trống hoặc đã giữ chỗ.';
  }

  if (draft.duplicateOutOfScope) {
    errs['duplicate_identity'] =
        'SĐT hoặc CCCD này đã đăng ký ngoài phạm vi tòa nhà bạn quản lý — không thể tạo trùng hồ sơ định danh.';
  }

  if (draft.tenantMode == 'existing') {
    if (!draft.hasLookedUpTenant) {
      errs['primary_tenant'] = 'Vui lòng tra cứu và chọn cư dân đại diện hợp đồng.';
    }
  } else {
    final name = draft.newTenantForm['full_name']?.toString().trim() ?? '';
    final phone = draft.newTenantForm['phone']?.toString().trim() ?? '';
    final email = draft.newTenantForm['email']?.toString().trim() ?? '';
    final idNumber = draft.newTenantForm['id_number']?.toString().trim() ?? '';
    final password = draft.newTenantForm['password']?.toString() ?? '';
    if (name.isEmpty) errs['new_full_name'] = 'Vui lòng nhập họ và tên khách thuê mới.';
    if (phone.isEmpty) {
      errs['new_phone'] = 'Vui lòng nhập số điện thoại khách thuê.';
    } else if (!isValidPhone(phone)) {
      errs['new_phone'] = 'Số điện thoại không đúng định dạng 10 chữ số Việt Nam.';
    }
    if (email.isNotEmpty && !isValidEmail(email)) {
      errs['new_email'] = 'Địa chỉ email không hợp lệ.';
    }
    if (idNumber.isNotEmpty && !isValidIdNumber(idNumber)) {
      errs['new_id_number'] = 'Số CCCD (9/12 số) hoặc Hộ chiếu không hợp lệ.';
    }
    if (password.isNotEmpty && password.length < 8) {
      errs['new_password'] = 'Mật khẩu đăng nhập ban đầu phải từ 8 ký tự trở lên.';
    }
  }

  final today = toDateOnlyStr(draft.todayStr);
  final status = draft.apartmentStatus.trim().toUpperCase();
  final statusBlocksToday = status == 'OCCUPIED' || status == 'MAINTENANCE';
  final start = toDateOnlyStr(draft.startDate);
  final end = toDateOnlyStr(draft.endDate);

  String startDateError() {
    if (start.isEmpty) return 'Chọn ngày bắt đầu.';
    if (statusBlocksToday && start.compareTo(today) <= 0) {
      return 'Căn hộ đang có khách thuê / bảo trì, ngày bắt đầu hợp đồng mới phải sau hôm nay.';
    }
    final startHits = findOverlappingBusyIntervals(start, start, draft.busyIntervals);
    if (startHits.isNotEmpty) {
      return formatBusyOverlapError(startHits, actionLabel: 'Ngày bắt đầu thuê');
    }
    return '';
  }

  final startErr = startDateError();
  if (startErr.isNotEmpty) errs['start_date'] = startErr;

  if (end.isEmpty) {
    errs['end_date'] = 'Chọn ngày kết thúc.';
  } else {
    final orderErr = getDateOrderError(
      start,
      end,
      strictAfter: true,
      startLabel: 'Ngày bắt đầu thuê',
      endLabel: 'Ngày kết thúc thuê',
    );
    if (orderErr.isNotEmpty) {
      errs['end_date'] = orderErr;
    } else if (startErr.isEmpty) {
      final overlaps = findOverlappingBusyIntervals(start, end, draft.busyIntervals);
      if (overlaps.isNotEmpty) {
        errs['end_date'] =
            formatBusyOverlapError(overlaps, actionLabel: 'Kỳ hạn hợp đồng');
      }
    }
  }

  final rent = num.tryParse(draft.rentAmount) ?? 0;
  if (rent <= 0) errs['rent_amount'] = 'Giá thuê phải lớn hơn 0.';
  if (draft.depositAmount.trim().isNotEmpty &&
      (num.tryParse(draft.depositAmount) ?? 0) < 0) {
    errs['deposit_amount'] = 'Tiền cọc không được âm.';
  }

  final dayRaw = num.tryParse(draft.billingDay);
  if (dayRaw == null || dayRaw != dayRaw.toInt() || dayRaw < 1 || dayRaw > 31) {
    errs['billing_day'] = 'Ngày phát hành hóa đơn phải từ 1 đến 31.';
  }
  final dueRaw = num.tryParse(draft.paymentDueDays);
  if (dueRaw == null || dueRaw != dueRaw.toInt() || dueRaw < 1 || dueRaw > 60) {
    errs['payment_due_days'] = 'Thời hạn thanh toán phải từ 1 đến 60 ngày.';
  }

  final primaryNormPhone = draft.tenantMode == 'new'
      ? normalizePhone(draft.newTenantForm['phone']?.toString())
      : '';
  final seenOccPhones = <String>{};
  for (var i = 0; i < draft.occupants.length; i++) {
    final occ = draft.occupants[i];
    final hasAny = (occ['full_name'] ?? '').isNotEmpty ||
        (occ['phone'] ?? '').isNotEmpty ||
        (occ['id_number'] ?? '').isNotEmpty;
    if (!hasAny) continue;

    if ((occ['full_name'] ?? '').trim().isEmpty) {
      errs['occ_name_$i'] = 'Nhập họ tên thành viên.';
    }
    final normOccPhone = normalizePhone(occ['phone']);
    if (normOccPhone.isEmpty) {
      errs['occ_phone_$i'] = 'Nhập SĐT thành viên.';
    } else if (!isValidPhone(normOccPhone)) {
      errs['occ_phone_$i'] = 'SĐT phải gồm 10 chữ số.';
    } else if (primaryNormPhone.isNotEmpty && normOccPhone == primaryNormPhone) {
      errs['occ_phone_$i'] = 'Trùng SĐT với khách thuê chính.';
    } else if (seenOccPhones.contains(normOccPhone)) {
      errs['occ_phone_$i'] = 'Trùng SĐT giữa các thành viên.';
    } else {
      seenOccPhones.add(normOccPhone);
    }
    final occId = (occ['id_number'] ?? '').trim();
    if (occId.isNotEmpty && !isValidIdNumber(occId)) {
      errs['occ_id_$i'] = 'CCCD/Hộ chiếu không hợp lệ.';
    }
  }

  for (final entry in draft.selectedServices.entries) {
    final cfg = entry.value;
    if (cfg['checked'] != true) continue;
    final svc = draft.serviceCatalog.firstWhere(
      (s) => s is Map && s['id']?.toString() == entry.key,
      orElse: () => null,
    );
    final parking = isParkingService(svc);
    final multi = allowsMultiQuantity(svc);
    final effQty = multi
        ? (int.tryParse(cfg['quantity']?.toString() ?? '1') ?? 1)
        : 1;
    final meta = validateServiceMetaInput(
      isParking: parking,
      quantity: effQty,
      vehiclePlates: cfg['vehicle_plates'],
      note: cfg['note'],
    );
    if (meta.quantityError.isNotEmpty) {
      errs['svc_qty_${entry.key}'] = meta.quantityError;
    }
    if (meta.plateErrors.any((e) => e.isNotEmpty)) {
      errs['svc_plates_${entry.key}'] =
          meta.plateErrors.where((e) => e.isNotEmpty).join('; ');
    }
    if (meta.noteError.isNotEmpty) {
      errs['svc_note_${entry.key}'] = meta.noteError;
    }
  }

  return errs;
}

/// Kẹp giá trị số nguyên trong đoạn [min, max], dùng fallback khi parse lỗi.
int clampIntField(String? raw, int min, int max, int fallback) {
  final value = int.tryParse(raw?.trim() ?? '') ?? fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

class ContractsPage extends ConsumerStatefulWidget {
  final String? initialTab;

  const ContractsPage({super.key, this.initialTab});

  @override
  ConsumerState<ContractsPage> createState() => _ContractsPageState();
}

class _ContractsPageState extends ConsumerState<ContractsPage> {
  late String _activeTab;
  List<dynamic> _contracts = [];
  List<dynamic> _requests = [];
  bool _loading = true;

  String _search = '';
  String _statusFilter = '';
  String _reqStatusFilter = '';

  // Create Modal state
  bool _createOpen = false;
  List<dynamic> _buildings = [];
  List<dynamic> _apartments = [];
  List<dynamic> _serviceCatalog = [];
  bool _loadingRefData = false;
  bool _submittingCreate = false;
  Map<String, String> _createErrors = {};

  // Form fields
  String _createBuildingId = '';
  String _createApartmentId = '';
  String _createStartDate = '';
  String _createEndDate = '';
  String _createRentAmount = '';
  String _createDepositAmount = '';
  String _createBillingCycle = 'monthly';
  String _createBillingDay = '1';
  String _createPaymentDueDays = '5';
  String _createNote = '';

  // Tenant mode: 'existing' | 'new'
  String _tenantMode = 'existing';
  String _tenantIdentifier = '';
  final TextEditingController _tenantIdentifierController = TextEditingController();
  final FocusNode _tenantIdentifierFocusNode = FocusNode();
  bool _tenantLookupLoading = false;
  dynamic _lookedUpTenant;
  String? _tenantLookupMessage;
  bool _tenantLookupInvalidFormat = false;
  bool _tenantLookupOutOfScope = false;
  String _tenantLookupNormalizedPhone = '';
  String _tenantLookupNormalizedId = '';

  // B8 — AI quét hợp đồng giấy/PDF & CCCD (React ContractsPage.jsx:300-309).
  List<String> _contractScanFiles = [];
  bool _contractScanConsent = true;
  bool _extractingContractAi = false;
  Map<String, dynamic>? _contractAiTracker;
  String? _contractAiError;

  // New tenant fields
  final Map<String, dynamic> _newTenantForm = {
    'full_name': '',
    'phone': '',
    'id_number': '',
    'email': '',
    'dob': '',
    'nationality': 'Việt Nam',
    'address': '',
    'password': '',
    'id_image_front': '',
    'id_image_back': '',
  };
  Timer? _dupTimer;
  Map<String, dynamic> _dupInfo = {
    'isDuplicate': false,
    'inScope': true,
    'message': '',
    'canLinkCrossBuilding': false,
    'duplicates': <dynamic>[],
  };

  // Occupants inline
  final List<Map<String, String>> _inlineOccupants = [];

  // Services selection: serviceId -> Map
  final Map<String, Map<String, dynamic>> _selectedServices = {};
  String _customElectricityPrice = '';
  String _customWaterPrice = '';

  // Lịch bận của căn hộ đang chọn (B6)
  List<dynamic> _aptScheduleContracts = [];
  List<dynamic> _aptScheduleReservations = [];
  List<BusyInterval> _busyIntervals = [];
  bool _aptScheduleLoading = false;

  // Request Review / Approve / Reject
  dynamic _approveReqTarget;
  dynamic _rejectReqTarget;
  String _rejectReason = '';
  bool _processingReq = false;

  @override
  void initState() {
    super.initState();
    _activeTab = (widget.initialTab == 'requests') ? 'requests' : 'list';
    _createStartDate = toDateOnlyStr(DateTime.now());
    _createEndDate = addMonthsClampedStr(_createStartDate, 12);
    // React ContractsPage.jsx:2149-2153 — tra cứu khi rời ô (onBlur).
    _tenantIdentifierFocusNode.addListener(() {
      if (!_tenantIdentifierFocusNode.hasFocus &&
          _tenantIdentifier.trim().isNotEmpty &&
          !_tenantLookupLoading &&
          _lookedUpTenant == null) {
        _handleLookupTenant();
      }
    });
    _fetchData();
  }

  @override
  void dispose() {
    _dupTimer?.cancel();
    _tenantIdentifierController.dispose();
    _tenantIdentifierFocusNode.dispose();
    super.dispose();
  }

  Future<void> _fetchData({bool force = false}) async {
    final contractsService = ref.read(contractsServiceProvider);
    final selectedBuildingId = ref.read(authProvider).selectedBuildingId;
    final queryParams = <String, dynamic>{};
    if (selectedBuildingId.isNotEmpty) {
      queryParams['building_id'] = selectedBuildingId;
    }

    final cachedList = contractsService.peekList(queryParams);
    if (cachedList != null && cachedList is Map && cachedList['data'] is List && !force) {
      setState(() {
        _contracts = List<dynamic>.from(cachedList['data']);
        _loading = false;
      });
    } else {
      setState(() => _loading = true);
    }

    try {
      final futures = await Future.wait([
        contractsService.list(queryParams, null, force),
        contractsService.listRequests(queryParams, null, force).catchError((err) {
          ref.read(toastProvider.notifier).error(
                extractErrorMessage(err, 'Không thể tải danh sách đề nghị của cư dân.'),
              );
          return {'data': []};
        }),
      ]);

      final cRes = futures[0];
      final rRes = futures[1];

      setState(() {
        _contracts = (cRes is Map && cRes['data'] is List) ? List<dynamic>.from(cRes['data']) : [];
        _requests = (rRes is Map && rRes['data'] is List) ? List<dynamic>.from(rRes['data']) : [];
      });
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải dữ liệu hợp đồng.'),
          );
    } finally {
      if (mounted) {
        setState(() => _loading = false);
      }
    }
  }

  Future<void> _openCreateModal([String? preselectAptId]) async {
    final selectedBuildingId = ref.read(authProvider).selectedBuildingId;
    final nowStr = toDateOnlyStr(DateTime.now());

    setState(() {
      _createOpen = true;
      _loadingRefData = true;
      _createBuildingId = selectedBuildingId;
      _createApartmentId = preselectAptId ?? '';
      _createStartDate = nowStr;
      _createEndDate = addMonthsClampedStr(nowStr, 12);
      _createRentAmount = '';
      _createDepositAmount = '';
      _createBillingCycle = 'monthly';
      _createBillingDay = '1';
      _createPaymentDueDays = '5';
      _createNote = '';
      _tenantMode = 'existing';
      _tenantIdentifier = '';
      _tenantIdentifierController.clear();
      _lookedUpTenant = null;
      _tenantLookupMessage = null;
      _tenantLookupInvalidFormat = false;
      _tenantLookupOutOfScope = false;
      _tenantLookupNormalizedPhone = '';
      _tenantLookupNormalizedId = '';
      _contractScanFiles = [];
      _contractScanConsent = true;
      _contractAiTracker = null;
      _contractAiError = null;
      _dupInfo = {
        'isDuplicate': false,
        'inScope': true,
        'message': '',
        'canLinkCrossBuilding': false,
        'duplicates': <dynamic>[],
      };
      _newTenantForm.updateAll((key, value) => '');
      _newTenantForm['nationality'] = 'Việt Nam';
      _inlineOccupants.clear();
      _selectedServices.clear();
      _customElectricityPrice = '';
      _customWaterPrice = '';
      _createErrors.clear();
      _aptScheduleContracts = [];
      _aptScheduleReservations = [];
      _busyIntervals = [];
      _aptScheduleLoading = false;
    });

    try {
      final bService = ref.read(buildingsServiceProvider);
      final sService = ref.read(servicesServiceProvider);

      final results = await Future.wait([
        bService.list(),
        bService.listApartments(
          selectedBuildingId.isNotEmpty ? {'building_id': selectedBuildingId} : null,
        ),
        sService.listCatalog({'active_only': 'true'}).catchError((err) {
          ref.read(toastProvider.notifier).error(
                extractErrorMessage(err, 'Không thể tải danh mục dịch vụ.'),
              );
          return {'data': []};
        }),
      ]);

      final bRes = results[0];
      final aRes = results[1];
      final sRes = results[2];

      final bList = (bRes is Map && bRes['data'] is List) ? bRes['data'] as List : [];
      final aList = (aRes is Map && aRes['data'] is List) ? aRes['data'] as List : [];
      final sList = (sRes is Map && sRes['data'] is List) ? sRes['data'] as List : [];

      setState(() {
        _buildings = bList;
        _apartments = aList;
        _serviceCatalog = sList;

        if (preselectAptId != null && preselectAptId.isNotEmpty) {
          final matched = aList.firstWhere(
            (a) => a is Map && a['id']?.toString() == preselectAptId,
            orElse: () => null,
          );
          if (matched is Map) {
            _createBuildingId = matched['building_id']?.toString() ?? _createBuildingId;
            final base = rawNumericString(matched['base_rent']);
            _createRentAmount = base;
            _createDepositAmount = base;
          }
        }
      });
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải danh sách tòa nhà / căn hộ.'),
          );
    } finally {
      if (mounted) {
        setState(() => _loadingRefData = false);
      }
    }
  }

  void _onBuildingChangedInModal(String? buildingId) async {
    setState(() {
      _createBuildingId = buildingId ?? '';
      _createApartmentId = '';
      _createRentAmount = '';
      _createDepositAmount = '';
      _apartments = [];
      _aptScheduleContracts = [];
      _aptScheduleReservations = [];
      _busyIntervals = [];
    });

    if (buildingId == null || buildingId.isEmpty) return;

    try {
      final res = await ref.read(buildingsServiceProvider).listApartments({'building_id': buildingId});
      final aList = (res is Map && res['data'] is List) ? res['data'] as List : [];
      setState(() => _apartments = aList);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải căn hộ của tòa nhà.'),
          );
    }
  }

  void _onApartmentSelected(String? aptId) {
    setState(() {
      _createApartmentId = aptId ?? '';
      _createErrors.remove('apartment_id');
    });

    if (aptId == null || aptId.isEmpty) return;

    final apt = _apartments.firstWhere(
      (a) => a is Map && a['id']?.toString() == aptId,
      orElse: () => null,
    );
    if (apt is Map) {
      final base = rawNumericString(apt['base_rent']);
      setState(() {
        if (_createBuildingId.isEmpty) {
          _createBuildingId = apt['building_id']?.toString() ?? '';
        }
        _createRentAmount = base;
        _createDepositAmount = base;
      });
    }

    if (aptId.isNotEmpty) _fetchApartmentSchedule(aptId);
  }

  String _selectedApartmentStatus() {
    if (_createApartmentId.isEmpty) return '';
    final apt = _apartments.firstWhere(
      (a) => a is Map && a['id']?.toString() == _createApartmentId,
      orElse: () => null,
    );
    return apt is Map ? (apt['status'] ?? '').toString() : '';
  }

  /// Tải lịch hợp đồng / giữ chỗ của căn hộ, tự chọn ngày trống đầu tiên (B6).
  Future<void> _fetchApartmentSchedule(String aptId) async {
    setState(() {
      _aptScheduleLoading = true;
      _aptScheduleContracts = [];
      _aptScheduleReservations = [];
      _busyIntervals = [];
    });

    final todayStr = toDateOnlyStr(DateTime.now());
    try {
      final res = await ref.read(buildingsServiceProvider).getApartment(aptId);
      final detail = (res is Map && res['data'] is Map)
          ? res['data'] as Map
          : <String, dynamic>{};
      if (!mounted || _createApartmentId != aptId) return;

      final contracts = (detail['contracts'] is List)
          ? List<dynamic>.from(detail['contracts'] as List)
          : <dynamic>[];
      final reservations = (detail['reservations'] is List)
          ? List<dynamic>.from(detail['reservations'] as List)
          : <dynamic>[];

      final activeContracts = contracts
          .where((c) =>
              c is Map &&
              kBlockingContractStatuses.contains((c['status'] ?? '').toString()) &&
              toDateOnlyStr(c['terminated_at'] ?? c['end_date']).compareTo(todayStr) >= 0)
          .toList();
      final heldReservations = reservations
          .where((r) =>
              r is Map &&
              (r['status'] ?? '').toString() == 'HELD' &&
              toDateOnlyStr(r['hold_until']).compareTo(todayStr) >= 0)
          .toList();

      final busy = extractApartmentBusyIntervals(
        contracts: activeContracts,
        reservations: heldReservations,
        todayStr: todayStr,
      );

      setState(() {
        _aptScheduleContracts = activeContracts;
        _aptScheduleReservations = heldReservations;
        _busyIntervals = busy;
        _aptScheduleLoading = false;
      });

      final status = (detail['status'] ?? '').toString().toUpperCase();
      final baseSearch = (status == 'OCCUPIED' || status == 'MAINTENANCE')
          ? addDaysStr(todayStr, 1)
          : todayStr;
      final suggestedStart = findFirstAvailableStartDate(baseSearch, busy, minSpanDays: 2);
      if (suggestedStart.isNotEmpty) {
        setState(() {
          _createStartDate = suggestedStart;
          _createEndDate = addMonthsClampedStr(suggestedStart, 12);
          _createErrors.remove('start_date');
          _createErrors.remove('end_date');
        });
      }
    } catch (_) {
      if (mounted) setState(() => _aptScheduleLoading = false);
    }
  }

  /// React ContractsPage.jsx:662-724 — tra cứu theo SĐT/CCCD (gọi được từ onBlur/Enter/nút).
  Future<dynamic> _handleLookupTenant([String? rawValue]) async {
    final raw = (rawValue ?? _tenantIdentifier).trim();
    if (raw.isEmpty) {
      setState(() {
        _lookedUpTenant = null;
        _tenantLookupMessage = null;
        _tenantLookupInvalidFormat = false;
        _tenantLookupOutOfScope = false;
      });
      return null;
    }

    final normPhone = normalizePhone(raw);
    final okPhone = isValidPhone(normPhone);
    final okId = !okPhone && isValidIdNumber(raw);

    if (!okPhone && !okId) {
      setState(() {
        _lookedUpTenant = null;
        _tenantLookupInvalidFormat = true;
        _tenantLookupOutOfScope = false;
        _tenantLookupMessage =
            'Định dạng không hợp lệ. Vui lòng nhập đúng SĐT 10 chữ số (VD: 0912345678) hoặc Số CCCD/Hộ chiếu (9–12 ký tự).';
      });
      return null;
    }

    setState(() {
      _tenantLookupLoading = true;
      _tenantLookupMessage = null;
      _tenantLookupInvalidFormat = false;
      _tenantLookupOutOfScope = false;
      _lookedUpTenant = null;
    });

    try {
      final res = await ref.read(tenantsServiceProvider).lookup(okPhone ? normPhone : raw.replaceAll(RegExp(r'\s+'), ''));
      if (res is Map && res['found'] == true && res['tenant'] != null) {
        setState(() {
          _lookedUpTenant = res['tenant'];
          _tenantLookupMessage = null;
          _createErrors.remove('primary_tenant');
          _createErrors.remove('primary_tenant_id');
        });
        return res['tenant'];
      }

      setState(() {
        _lookedUpTenant = null;
        _tenantLookupOutOfScope = res is Map && res['outOfScopeConflict'] == true;
        _tenantLookupNormalizedPhone = res is Map
            ? res['normalizedPhone']?.toString() ?? (okPhone ? normPhone : '')
            : (okPhone ? normPhone : '');
        _tenantLookupNormalizedId = res is Map
            ? res['normalizedIdNumber']?.toString() ?? (okId ? raw.replaceAll(RegExp(r'\s+'), '') : '')
            : (okId ? raw.replaceAll(RegExp(r'\s+'), '') : '');
        _tenantLookupMessage = (res is Map && res['message'] != null)
            ? res['message'].toString()
            : 'Chưa tìm thấy hồ sơ cư dân khớp với SĐT / CCCD này.';
      });
      return null;
    } catch (err) {
      setState(() {
        _lookedUpTenant = null;
        _tenantLookupOutOfScope = false;
        _tenantLookupMessage = extractErrorMessage(err, 'Không thể tra cứu hồ sơ cư dân.');
      });
      return null;
    } finally {
      if (mounted) {
        setState(() => _tenantLookupLoading = false);
      }
    }
  }

  /// React ContractsPage.jsx:655-660 — nút "Đổi / Nhập lại".
  void _handleClearLookedUpTenant() {
    setState(() {
      _lookedUpTenant = null;
      _tenantLookupMessage = null;
      _tenantLookupInvalidFormat = false;
      _tenantLookupOutOfScope = false;
      _tenantIdentifier = '';
      _tenantIdentifierController.clear();
      _createErrors.remove('primary_tenant_id');
    });
  }

  /// React ContractsPage.jsx:728-737 — tạo cư dân mới với SĐT/CCCD đã normalize.
  void _handleSwitchToNewWithPrefill() {
    setState(() {
      if (_tenantLookupNormalizedPhone.isNotEmpty) {
        _newTenantForm['phone'] = _tenantLookupNormalizedPhone;
      }
      if (_tenantLookupNormalizedId.isNotEmpty) {
        _newTenantForm['id_number'] = _tenantLookupNormalizedId;
      }
      _tenantLookupMessage = null;
      _createErrors.remove('primary_tenant_id');
      _tenantMode = 'new';
    });
  }

  /// React ContractsPage.jsx:739-752 — chuyển sang tra cứu & liên kết liên tòa.
  Future<void> _handleSwitchToCrossBuildingLookup() async {
    final phone = normalizePhone(_newTenantForm['phone']?.toString());
    final id = (_newTenantForm['id_number']?.toString() ?? '').trim();
    final ident = isValidPhone(phone) ? phone : id;
    setState(() {
      _tenantMode = 'existing';
      _tenantIdentifier = ident;
      _tenantIdentifierController.text = ident;
      _createErrors.remove('primary_tenant_id');
    });
    if (ident.isNotEmpty) await _handleLookupTenant(ident);
  }

  /// React ContractsPage.jsx:894-1001 — AI quét hợp đồng → điền nháp form tạo HĐ.
  Future<void> _handleExtractContractAi() async {
    final files = _contractScanFiles.where((s) => s.isNotEmpty).toList();
    if (files.isEmpty) {
      ref.read(toastProvider.notifier).warning(
            'Vui lòng chọn ảnh hoặc tệp PDF hợp đồng trước khi trích xuất AI.',
          );
      return;
    }

    setState(() {
      _extractingContractAi = true;
      _contractAiError = null;
    });

    try {
      final res = await ref.read(aiServiceProvider).extractDocument({
        'document_type': 'CONTRACT',
        'building_id': _createBuildingId.isNotEmpty ? _createBuildingId : null,
        'files': files,
        'privacy_acknowledged': _contractScanConsent,
      });
      final data = (res is Map && res['data'] != null) ? res['data'] : res;
      final out = (data is Map && data['output'] is Map)
          ? Map<String, dynamic>.from(data['output'] as Map)
          : <String, dynamic>{};
      final mapped = mapContractAiOutputToDraft(out, _apartments);

      setState(() {
        if (mapped['apartment_id'] != null) {
          _createApartmentId = mapped['apartment_id'] as String;
        }
        if (mapped['building_id'] != null && mapped['building_id'].toString().isNotEmpty) {
          _createBuildingId = mapped['building_id'].toString();
        }
        if (mapped['start_date'].toString().isNotEmpty) _createStartDate = mapped['start_date'].toString();
        if (mapped['end_date'].toString().isNotEmpty) _createEndDate = mapped['end_date'].toString();
        if (mapped['rent_amount'].toString().isNotEmpty) _createRentAmount = mapped['rent_amount'].toString();
        if (mapped['deposit_amount'].toString().isNotEmpty) _createDepositAmount = mapped['deposit_amount'].toString();
        if (mapped['billing_day'].toString().isNotEmpty) _createBillingDay = mapped['billing_day'].toString();
        if (mapped['payment_due_days'].toString().isNotEmpty) {
          _createPaymentDueDays = mapped['payment_due_days'].toString();
        }
        if (mapped['note'].toString().isNotEmpty) _createNote = mapped['note'].toString();
      });

      final normalizedTenantPhone = normalizePhone(mapped['tenant_phone'].toString());
      final tenantIdNumber = mapped['tenant_id_number'].toString().trim();
      final lookupKey = normalizedTenantPhone.isNotEmpty ? normalizedTenantPhone : tenantIdNumber;
      if (lookupKey.isNotEmpty) {
        setState(() {
          _tenantMode = 'existing';
          _tenantIdentifier = lookupKey;
          _tenantIdentifierController.text = lookupKey;
        });
        final found = await _handleLookupTenant(lookupKey);
        if (found == null) {
          setState(() {
            _tenantMode = 'new';
            if (mapped['tenant_full_name'].toString().isNotEmpty) {
              _newTenantForm['full_name'] = mapped['tenant_full_name'].toString();
            }
            if (mapped['tenant_phone'].toString().isNotEmpty) {
              _newTenantForm['phone'] = normalizePhone(mapped['tenant_phone'].toString());
            }
            if (mapped['tenant_id_number'].toString().isNotEmpty) {
              _newTenantForm['id_number'] = mapped['tenant_id_number'].toString().trim();
            }
          });
        }
      } else if (mapped['tenant_full_name'].toString().isNotEmpty) {
        setState(() {
          _tenantMode = 'new';
          _newTenantForm['full_name'] = mapped['tenant_full_name'].toString();
        });
      }

      final baseConf = data is Map ? data['confidence'] : null;
      final confMap = <String, dynamic>{
        'start_date': out['field_confidences']?['start_date'] ?? baseConf,
        'end_date': out['field_confidences']?['end_date'] ?? baseConf,
        'rent_amount': out['field_confidences']?['rent_amount'] ?? baseConf,
        'deposit_amount': out['field_confidences']?['deposit_amount'] ?? baseConf,
        'billing_day': out['field_confidences']?['billing_day'] ?? baseConf,
        'payment_due_days': out['field_confidences']?['payment_due_days'] ?? baseConf,
        'note': out['field_confidences']?['terms_note'] ?? baseConf,
      };
      setState(() {
        _contractAiTracker = createAiFieldTracker(
          data is Map ? data['suggestion_id']?.toString() : null,
          {
            'start_date': mapped['start_date'],
            'end_date': mapped['end_date'],
            'rent_amount': mapped['rent_amount'],
            'deposit_amount': mapped['deposit_amount'],
            'billing_day': mapped['billing_day'],
            'payment_due_days': mapped['payment_due_days'],
            'note': mapped['note'],
          },
          confMap,
        );
      });
      ref.read(toastProvider.notifier).success(
            'AI đã trích xuất nháp hợp đồng — vui lòng kiểm tra các ô viền nét đứt trước khi lưu.',
          );
    } catch (err) {
      final msg = mapAiErrorToVietnamese(err);
      setState(() => _contractAiError = '${msg.title} ${msg.guidance}'.trim());
    } finally {
      if (mounted) setState(() => _extractingContractAi = false);
    }
  }

  void _onCheckDupTenantRealtime() {
    _dupTimer?.cancel();
    final phone = normalizePhone(_newTenantForm['phone']?.toString());
    final idNumber = (_newTenantForm['id_number']?.toString() ?? '').trim();

    final okPhone = phone.length == 10;
    final okId = idNumber.length >= 9;

    if (!okPhone && !okId) {
      setState(() {
        _dupInfo = {
          'isDuplicate': false,
          'inScope': true,
          'message': '',
          'canLinkCrossBuilding': false,
          'duplicates': <dynamic>[],
        };
      });
      return;
    }

    _dupTimer = Timer(const Duration(milliseconds: 400), () async {
      try {
        final params = <String, dynamic>{};
        if (okPhone) params['phone'] = phone;
        if (okId) params['id_number'] = idNumber;

        final res = await ref.read(tenantsServiceProvider).checkDup(params);
        if (mounted) {
          setState(() {
            _dupInfo = {
              'isDuplicate': res is Map && res['isDuplicate'] == true,
              'inScope': res is Map ? res['inScope'] != false : true,
              'message': (res is Map && res['message'] != null) ? res['message'].toString() : '',
              'canLinkCrossBuilding': res is Map && res['canLinkCrossBuilding'] == true,
              'duplicates': res is Map && res['duplicates'] is List ? res['duplicates'] : <dynamic>[],
            };
          });
        }
      } catch (err) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể kiểm tra trùng cư dân.'),
            );
      }
    });
  }

  Future<void> _handleCreateSubmit() async {
    final draft = ContractCreateDraft(
      apartmentId: _createApartmentId,
      tenantMode: _tenantMode,
      hasLookedUpTenant: _lookedUpTenant != null,
      newTenantForm: _newTenantForm,
      duplicateOutOfScope:
          _dupInfo['isDuplicate'] == true && _dupInfo['inScope'] == false,
      startDate: _createStartDate,
      endDate: _createEndDate,
      rentAmount: _createRentAmount,
      depositAmount: _createDepositAmount,
      billingDay: _createBillingDay,
      paymentDueDays: _createPaymentDueDays,
      occupants: _inlineOccupants,
      selectedServices: _selectedServices,
      serviceCatalog: _serviceCatalog,
      busyIntervals: _busyIntervals,
      apartmentStatus: _selectedApartmentStatus(),
      todayStr: toDateOnlyStr(DateTime.now()),
    );
    final errs = validateContractCreateForm(draft);

    setState(() => _createErrors = errs);
    if (errs.isNotEmpty) {
      final firstServiceErr = errs.entries
          .where((e) => e.key.startsWith('svc_'))
          .map((e) => e.value)
          .cast<String>()
          .toList();
      if (firstServiceErr.isNotEmpty) {
        ref.read(toastProvider.notifier).warning(firstServiceErr.first);
      }
      return;
    }

    final rent = num.tryParse(_createRentAmount) ?? 0;
    setState(() => _submittingCreate = true);
    try {
      final payload = <String, dynamic>{
        'apartment_id': _createApartmentId,
        if (_createBuildingId.isNotEmpty) 'building_id': _createBuildingId,
        'start_date': _createStartDate,
        'end_date': _createEndDate,
        'rent_amount': rent.round(),
        'deposit_amount': (num.tryParse(_createDepositAmount) ?? 0).round(),
        'billing_cycle': _createBillingCycle,
        'billing_day': clampIntField(_createBillingDay, 1, 31, 1),
        'payment_due_days': clampIntField(_createPaymentDueDays, 1, 60, 5),
        'note': _createNote.trim(),
        if (_tenantMode == 'existing')
          'primary_tenant_id': _lookedUpTenant['id']
        else
          'new_tenant': {
            'full_name': _newTenantForm['full_name']?.toString().trim(),
            'phone': normalizePhone(_newTenantForm['phone']?.toString()),
            if (_newTenantForm['id_number']?.toString().isNotEmpty == true)
              'id_number': _newTenantForm['id_number']?.toString().trim(),
            if (_newTenantForm['email']?.toString().isNotEmpty == true)
              'email': _newTenantForm['email']?.toString().trim(),
            if (_newTenantForm['dob']?.toString().isNotEmpty == true) 'dob': _newTenantForm['dob'],
            'nationality': _newTenantForm['nationality']?.toString().trim() ?? 'Việt Nam',
            if (_newTenantForm['address']?.toString().isNotEmpty == true)
              'address': _newTenantForm['address']?.toString().trim(),
            if (_newTenantForm['password']?.toString().isNotEmpty == true)
              'password': _newTenantForm['password'],
            if (_newTenantForm['id_image_front']?.toString().isNotEmpty == true)
              'id_image_front': _newTenantForm['id_image_front'],
            if (_newTenantForm['id_image_back']?.toString().isNotEmpty == true)
              'id_image_back': _newTenantForm['id_image_back'],
          },
        if (_inlineOccupants.isNotEmpty)
          'occupants': _inlineOccupants
              .where((o) => (o['full_name'] ?? '').isNotEmpty)
              .map((o) => {
                    'full_name': o['full_name']!.trim(),
                    'phone': normalizePhone(o['phone']),
                    'relationship': o['relationship'] ?? 'family',
                    if ((o['id_number'] ?? '').isNotEmpty) 'id_number': o['id_number']!.trim(),
                  })
              .toList(),
      };

      // Dịch vụ đi kèm: normalize số lượng / đơn giá / biển số / ghi chú theo React.
      final servicesList = <Map<String, dynamic>>[];
      for (final entry in _selectedServices.entries) {
        final cfg = entry.value;
        if (cfg['checked'] != true) continue;
        final svc = _serviceCatalog.firstWhere(
          (s) => s is Map && s['id']?.toString() == entry.key,
          orElse: () => null,
        );
        final parking = isParkingService(svc);
        final multi = allowsMultiQuantity(svc);
        final qtyRaw = int.tryParse(cfg['quantity']?.toString() ?? '1') ?? 1;
        final qty = !multi
            ? 1
            : (parking && qtyRaw > kMaxParkingQuantity
                ? kMaxParkingQuantity
                : (qtyRaw < 1 ? 1 : qtyRaw));
        final priceRaw = num.tryParse(cfg['unit_price']?.toString() ?? '') ??
            num.tryParse(
                    (svc is Map ? svc['unit_price'] : null)?.toString() ?? '') ??
                0;
        final price = (priceRaw < 0 ? 0 : priceRaw).round();
        final meta = validateServiceMetaInput(
          isParking: parking,
          quantity: qty,
          vehiclePlates: cfg['vehicle_plates'],
          note: cfg['note'],
        );
        servicesList.add({
          'service_id': entry.key,
          'quantity': qty,
          'unit_price': price,
          if (parking) 'vehicle_plates': meta.cleanPlates,
          if (meta.cleanNote.isNotEmpty) 'note': meta.cleanNote,
        });
      }
      if (servicesList.isNotEmpty) {
        payload['services'] = servicesList;
      }

      // Add custom meter prices
      final meterPrices = <Map<String, dynamic>>[];
      final elecNum = num.tryParse(_customElectricityPrice);
      if (elecNum != null && elecNum >= 0) {
        meterPrices.add({'service_code': 'ELECTRICITY', 'unit_price': elecNum.round()});
      }
      final waterNum = num.tryParse(_customWaterPrice);
      if (waterNum != null && waterNum >= 0) {
        meterPrices.add({'service_code': 'WATER', 'unit_price': waterNum.round()});
      }
      if (meterPrices.isNotEmpty) {
        payload['service_prices'] = meterPrices;
      }

      final res = await ref.read(contractsServiceProvider).create(
            payload,
            idempotencyKey: createIdempotencyKey(),
          );

      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã tạo hợp đồng nháp thành công.',
          );
      setState(() => _createOpen = false);

      final createdId = (res is Map && res['data'] is Map) ? res['data']['id']?.toString() : null;
      if (createdId != null && createdId.isNotEmpty) {
        if (mounted) context.push('/admin/contracts/$createdId');
      } else {
        _fetchData(force: true);
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tạo hợp đồng nháp.'),
          );
    } finally {
      if (mounted) {
        setState(() => _submittingCreate = false);
      }
    }
  }

  // Confirm Request Approval
  Future<void> _handleConfirmApproveRequest() async {
    if (_approveReqTarget == null) return;
    final id = _approveReqTarget['id'].toString();

    setState(() => _processingReq = true);
    try {
      final res = await ref.read(contractsServiceProvider).approveRequest(id);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã phê duyệt yêu cầu của cư dân.',
          );
      setState(() => _approveReqTarget = null);
      _fetchData(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể phê duyệt yêu cầu.'),
          );
    } finally {
      if (mounted) {
        setState(() => _processingReq = false);
      }
    }
  }

  // Confirm Request Rejection
  Future<void> _handleConfirmRejectRequest() async {
    if (_rejectReqTarget == null) return;
    final id = _rejectReqTarget['id'].toString();

    setState(() => _processingReq = true);
    try {
      final res = await ref.read(contractsServiceProvider).rejectRequest(id, {
        'reason': _rejectReason.trim(),
      });
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null) ? res['message'].toString() : 'Đã từ chối yêu cầu của cư dân.',
          );
      setState(() {
        _rejectReqTarget = null;
        _rejectReason = '';
      });
      _fetchData(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể từ chối yêu cầu.'),
          );
    } finally {
      if (mounted) {
        setState(() => _processingReq = false);
      }
    }
  }

  /// Form "Thành viên ở cùng" với Select quan hệ — port ContractsPage.jsx:2439-2572 (B4).
  Widget _buildOccupantsBlock() {
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: AppColors.slate50,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: AppColors.slate200),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Expanded(
                child: Text(
                  'Thành viên ở cùng (Tùy chọn)',
                  style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: AppColors.slate800),
                ),
              ),
              const SizedBox(width: 10),
              AppButton(
                text: 'Thêm thành viên ở cùng',
                size: AppButtonSize.xs,
                variant: AppButtonVariant.outline,
                icon: const Icon(LucideIcons.userPlus, size: 14),
                onPressed: () => setState(() {
                  _inlineOccupants.add({
                    'full_name': '',
                    'phone': '',
                    'relationship': 'family',
                    'id_number': '',
                  });
                }),
              ),
            ],
          ),
          for (var i = 0; i < _inlineOccupants.length; i++) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
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
                        'Thành viên #${i + 1}',
                        style: const TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: AppColors.slate700),
                      ),
                      AppButton(
                        text: 'Xóa',
                        size: AppButtonSize.xs,
                        variant: AppButtonVariant.ghost,
                        icon: const Icon(LucideIcons.trash2, size: 13),
                        onPressed: () => setState(() => _inlineOccupants.removeAt(i)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: AppInput(
                          label: 'Họ và tên',
                          required: true,
                          initialValue: _inlineOccupants[i]['full_name'],
                          error: _createErrors['occ_name_$i'],
                          onChanged: (val) => _inlineOccupants[i]['full_name'] = val,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppInput(
                          label: 'Số điện thoại',
                          required: true,
                          initialValue: _inlineOccupants[i]['phone'],
                          error: _createErrors['occ_phone_$i'],
                          onChanged: (val) => _inlineOccupants[i]['phone'] = val,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 10),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(
                        child: AppSelect<String>(
                          label: 'Quan hệ',
                          value: _inlineOccupants[i]['relationship'] ?? 'family',
                          options: kRelationshipOptions,
                          onChanged: (val) => setState(() {
                            _inlineOccupants[i]['relationship'] = val ?? 'family';
                          }),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppInput(
                          label: 'Số CCCD / Hộ chiếu',
                          initialValue: _inlineOccupants[i]['id_number'],
                          error: _createErrors['occ_id_$i'],
                          onChanged: (val) => _inlineOccupants[i]['id_number'] = val,
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
    );
  }

  /// Một dòng dịch vụ: chip bật/tắt + cấu hình số lượng / đơn giá / biển số / ghi chú (B5).
  Widget _buildServiceRow(dynamic svcRaw) {
    if (svcRaw is! Map) return const SizedBox.shrink();
    final sId = svcRaw['id']?.toString() ?? '';
    final parking = isParkingService(svcRaw);
    final multi = allowsMultiQuantity(svcRaw);
    final cfg = _selectedServices[sId] ?? <String, dynamic>{};
    final isChecked = cfg['checked'] == true;
    final unitPriceDefault = svcRaw['unit_price'] ?? svcRaw['base_price'] ?? 0;

    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: isChecked ? Colors.white : AppColors.slate50,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(
          color: isChecked ? AppColors.primary300 : AppColors.slate200,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          FilterChip(
            selected: isChecked,
            label: Text(
              '${svcRaw['name'] ?? ''} (${formatMoney(unitPriceDefault)})'
              '${multi ? ' • theo số lượng' : ' • trọn gói'}',
            ),
            onSelected: (val) {
              setState(() {
                if (val) {
                  final plates = parking ? <dynamic>[''] : <dynamic>[];
                  _selectedServices[sId] = {
                    'checked': true,
                    'quantity': '1',
                    'unit_price': unitPriceDefault,
                    'vehicle_plates': plates,
                    'note': '',
                  };
                } else {
                  _selectedServices.remove(sId);
                }
              });
            },
          ),
          if (isChecked) ...[
            const SizedBox(height: 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (multi)
                  Expanded(
                    child: AppInput(
                      label: 'Số lượng${parking ? ' (tối đa $kMaxParkingQuantity)' : ''}',
                      initialValue: (cfg['quantity'] ?? '1').toString(),
                      keyboardType: TextInputType.number,
                      error: _createErrors['svc_qty_$sId'],
                      onChanged: (val) {
                        final plates = parking
                            ? syncVehiclePlatesArray(cfg['vehicle_plates'], val)
                            : <dynamic>[];
                        setState(() {
                          _selectedServices[sId] = {
                            ...cfg,
                            'quantity': val,
                            'vehicle_plates': plates,
                          };
                          _createErrors.remove('svc_qty_$sId');
                          _createErrors.remove('svc_plates_$sId');
                        });
                      },
                    ),
                  ),
                if (multi) const SizedBox(width: 12),
                Expanded(
                  child: AppInput(
                    label: 'Đơn giá áp dụng (VND)',
                    initialValue: (cfg['unit_price'] ?? unitPriceDefault).toString(),
                    keyboardType: TextInputType.number,
                    onChanged: (val) {
                      _selectedServices[sId] = {...cfg, 'unit_price': val};
                    },
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            ServiceSubscriptionMetaFields(
              isParking: parking,
              quantity: int.tryParse((cfg['quantity'] ?? '1').toString()) ?? 1,
              vehiclePlates: cfg['vehicle_plates'] is List
                  ? List<dynamic>.from(cfg['vehicle_plates'] as List)
                  : <dynamic>[],
              note: (cfg['note'] ?? '').toString(),
              plateErrors: _createErrors['svc_plates_$sId']?.isNotEmpty == true
                  ? _createErrors['svc_plates_$sId']!.split('; ')
                  : const [],
              noteError: _createErrors['svc_note_$sId'] ?? '',
              onPlateChange: (idx, val) {
                final plates = syncVehiclePlatesArray(
                  cfg['vehicle_plates'],
                  cfg['quantity'] ?? '1',
                );
                if (idx < plates.length) plates[idx] = val;
                setState(() {
                  _selectedServices[sId] = {...cfg, 'vehicle_plates': plates};
                  _createErrors.remove('svc_plates_$sId');
                });
              },
              onNoteChange: (val) {
                setState(() {
                  _selectedServices[sId] = {...cfg, 'note': val};
                  _createErrors.remove('svc_note_$sId');
                });
              },
            ),
          ],
        ],
      ),
    );
  }

  /// Hiển thị lịch hợp đồng / giữ chỗ đang chồng lấn khoảng ngày đang chọn (B6).
  Widget? _buildApartmentScheduleCard() {
    if (_createApartmentId.isEmpty) return null;
    if (!_aptScheduleLoading &&
        _aptScheduleContracts.isEmpty &&
        _aptScheduleReservations.isEmpty) {
      return null;
    }
    final apt = _apartments.firstWhere(
      (a) => a is Map && a['id']?.toString() == _createApartmentId,
      orElse: () => null,
    );
    final code = apt is Map ? (apt['code'] ?? '').toString() : '';
    final overlaps = findOverlappingBusyIntervals(
      _createStartDate,
      _createEndDate,
      _busyIntervals,
    );
    return Container(
      margin: const EdgeInsets.only(top: 10),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: const Color(0xFFFFFBE6),
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: const Color(0xFFFDE68A)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Lịch đã thuê & đang giữ chỗ — Căn $code',
            style: const TextStyle(
                fontFamily: 'Inter', fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.slate800),
          ),
          const SizedBox(height: 6),
          if (_aptScheduleLoading)
            const Text('Đang tải lịch căn hộ...',
                style: TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate500)),
          for (final c in _aptScheduleContracts)
            if (c is Map)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  'Hợp đồng (${c['status'] ?? ''}): ${formatDate(c['start_date'])} → ${formatDate(c['terminated_at'] ?? c['end_date'])}${c['tenant_name'] != null ? ' • ${c['tenant_name']}' : ''}',
                  style: const TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate700),
                ),
              ),
          for (final r in _aptScheduleReservations)
            if (r is Map)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  'Giữ chỗ: ${formatDate(r['hold_from'] ?? r['created_at'])} → ${formatDate(r['hold_until'])}${r['prospect_name'] != null ? ' • ${r['prospect_name']}' : ''}',
                  style: const TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate700),
                ),
              ),
          if (overlaps.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                formatBusyOverlapError(overlaps, actionLabel: 'Kỳ hạn hợp đồng'),
                style: const TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.rose600),
              ),
            ),
        ],
      ),
    );
  }

  Widget? _buildActiveOverlayModal() {
    if (_createOpen) {
      return AppModal(
        title: 'Tạo hợp đồng thuê nháp (DRAFT)',
        subtitle: 'Khởi tạo hợp đồng mới, đính kèm gói dịch vụ và quét AI giấy tờ tùy thân',
        size: AppModalSize.xl,
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
              text: 'Lưu hợp đồng nháp',
              loading: _submittingCreate,
              onPressed: _handleCreateSubmit,
            ),
          ],
        ),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // B8 — AI quét hợp đồng giấy/PDF (React ContractsPage.jsx:894-1048).
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
                    const Row(
                      children: [
                        Icon(LucideIcons.sparkles, size: 16, color: AppColors.secondary600),
                        SizedBox(width: 8),
                        Text(
                          'Quét hợp đồng giấy / CCCD bằng AI (AI-01)',
                          style: TextStyle(
                            fontFamily: 'Inter',
                            fontWeight: FontWeight.w600,
                            color: Color(0xFF1E1B4B),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 8),
                    FileUploadField(
                      label: 'Chọn ảnh hoặc tệp PDF hợp đồng để trích xuất',
                      multiple: true,
                      value: _contractScanFiles,
                      onChanged: (val) {
                        if (val is List) {
                          setState(() => _contractScanFiles = val.cast<String>());
                        } else if (val is String && val.isNotEmpty) {
                          setState(() => _contractScanFiles = [val]);
                        }
                      },
                    ),
                    const SizedBox(height: 8),
                    Row(
                      children: [
                        Checkbox(
                          value: _contractScanConsent,
                          onChanged: (v) =>
                              setState(() => _contractScanConsent = v ?? true),
                        ),
                        const Expanded(
                          child: Text(
                            'Đồng thuận quyền riêng tư trước khi gửi AI',
                            style: TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate700),
                          ),
                        ),
                      ],
                    ),
                    if (_contractAiError != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Text(
                          _contractAiError!,
                          style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.rose600),
                        ),
                      ),
                    Wrap(
                      spacing: 8,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        AppButton(
                          text: 'Quét hợp đồng',
                          icon: const Icon(LucideIcons.sparkles, size: 16),
                          loading: _extractingContractAi,
                          variant: AppButtonVariant.primary,
                          onPressed: _handleExtractContractAi,
                        ),
                        if (_contractAiTracker?['suggestionId'] != null)
                          AppButton(
                            text: 'Hủy nháp AI',
                            variant: AppButtonVariant.ghost,
                            onPressed: () => setState(() => _contractAiTracker = null),
                          ),
                      ],
                    ),
                    if (_contractAiTracker != null)
                      const Padding(
                        padding: EdgeInsets.only(top: 8),
                        child: Text(
                          'AI đã trích xuất nháp hợp đồng — vui lòng kiểm tra các ô trước khi lưu.',
                          style: TextStyle(fontFamily: 'Inter', fontSize: 11, color: Color(0xFF3730A3)),
                        ),
                      ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              // 1. Tòa nhà & Căn hộ
              const Text(
                '1. Thông tin Bất động sản',
                style: TextStyle(fontFamily: 'Inter', fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.slate900),
              ),
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: AppSelect<String>(
                      label: 'Tòa nhà',
                      placeholder: 'Chọn tòa nhà',
                      value: _createBuildingId.isNotEmpty ? _createBuildingId : null,
                      options: _buildings.map((b) {
                        final id = b['id']?.toString() ?? '';
                        final name = b['name']?.toString() ?? '';
                        final code = b['code']?.toString() ?? '';
                        return AppSelectOption(
                          value: id,
                          label: code.isNotEmpty ? '$name ($code)' : name,
                        );
                      }).toList(),
                      onChanged: _onBuildingChangedInModal,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppSelect<String>(
                      label: 'Căn hộ',
                      required: true,
                      placeholder: _loadingRefData
                          ? 'Đang tải căn hộ...'
                          : _apartments.isEmpty
                              ? 'Không có căn hộ khả dụng'
                              : '-- Chọn căn hộ --',
                      searchPlaceholder: 'Tìm mã căn hộ, trạng thái, giá thuê...',
                      value: _createApartmentId.isNotEmpty ? _createApartmentId : null,
                      options: _apartments
                          .whereType<Map>()
                          .map((a) => buildApartmentSelectOption(Map<String, dynamic>.from(a)))
                          .toList(),
                      onChanged: _onApartmentSelected,
                    ),
                  ),
                ],
              ),
              if (_createErrors['apartment_id'] != null)
                Padding(
                  padding: const EdgeInsets.only(top: 4),
                  child: Text(
                    _createErrors['apartment_id']!,
                    style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.rose600),
                  ),
                ),
              _buildApartmentScheduleCard() ?? const SizedBox.shrink(),
              const SizedBox(height: 16),

              // 2. Khách thuê chính
              const Text(
                '2. Khách thuê đại diện (Chính)',
                style: TextStyle(fontFamily: 'Inter', fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.slate900),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  ChoiceChip(
                    label: const Text('Đã có hồ sơ (Tra cứu)'),
                    selected: _tenantMode == 'existing',
                    onSelected: (val) {
                      if (val) setState(() => _tenantMode = 'existing');
                    },
                  ),
                  const SizedBox(width: 10),
                  ChoiceChip(
                    label: const Text('+ Tạo cư dân mới'),
                    selected: _tenantMode == 'new',
                    onSelected: (val) {
                      if (val) setState(() => _tenantMode = 'new');
                    },
                  ),
                ],
              ),
              const SizedBox(height: 10),

              if (_tenantMode == 'existing') ...[
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'SĐT hoặc CCCD khách thuê',
                        placeholder: 'Nhập chính xác SĐT 10 số hoặc số CCCD/Hộ chiếu của cư dân...',
                        controller: _tenantIdentifierController,
                        focusNode: _tenantIdentifierFocusNode,
                        onChanged: (val) {
                          _tenantIdentifier = val;
                          if (_tenantLookupMessage != null) {
                            setState(() => _tenantLookupMessage = null);
                          }
                        },
                        onEditingComplete: () {
                          if (_tenantIdentifier.trim().isNotEmpty && !_tenantLookupLoading) {
                            _handleLookupTenant();
                          }
                        },
                        onSubmitted: (_) {
                          if (_tenantIdentifier.trim().isNotEmpty && !_tenantLookupLoading) {
                            _handleLookupTenant();
                          }
                        },
                      ),
                    ),
                    const SizedBox(width: 10),
                    Padding(
                      padding: const EdgeInsets.only(top: 24),
                      child: AppButton(
                        text: 'Tra cứu',
                        icon: const Icon(LucideIcons.search, size: 16),
                        loading: _tenantLookupLoading,
                        onPressed: _handleLookupTenant,
                      ),
                    ),
                  ],
                ),
                if (_tenantLookupMessage != null)
                  Container(
                    margin: const EdgeInsets.only(top: 6),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: _tenantLookupInvalidFormat || _tenantLookupOutOfScope
                          ? AppColors.rose50
                          : AppColors.amber50,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(
                        color: _tenantLookupInvalidFormat || _tenantLookupOutOfScope
                            ? AppColors.rose200
                            : AppColors.amber200,
                      ),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            _tenantLookupMessage!,
                            style: TextStyle(
                              fontFamily: 'Inter',
                              fontSize: 12,
                              color: _tenantLookupInvalidFormat || _tenantLookupOutOfScope
                                  ? AppColors.rose700
                                  : AppColors.amber700,
                            ),
                          ),
                        ),
                        if (!_tenantLookupInvalidFormat && !_tenantLookupOutOfScope)
                          AppButton(
                            text: '+ Tạo cư dân mới',
                            variant: AppButtonVariant.primary,
                            size: AppButtonSize.xs,
                            onPressed: _handleSwitchToNewWithPrefill,
                          ),
                      ],
                    ),
                  ),
                if (_lookedUpTenant != null)
                  Container(
                    margin: const EdgeInsets.only(top: 10),
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.emerald50,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: AppColors.emerald200),
                    ),
                    child: Row(
                      children: [
                        const Icon(LucideIcons.checkCircle2, color: AppColors.emerald600, size: 20),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Wrap(
                                spacing: 6,
                                crossAxisAlignment: WrapCrossAlignment.center,
                                children: [
                                  Text(
                                    'Đã xác thực cư dân: ${_lookedUpTenant['masked_name'] ?? _lookedUpTenant['full_name'] ?? ''}',
                                    style: const TextStyle(fontFamily: 'Inter', fontWeight: FontWeight.w600, color: AppColors.emerald700),
                                  ),
                                  if (_lookedUpTenant['cross_building_link'] == true)
                                    const AppBadge(label: 'Liên kết liên tòa (Bảo mật PII)', variant: AppBadgeVariant.indigo),
                                ],
                              ),
                              Text(
                                'SĐT: ${_lookedUpTenant['masked_phone'] ?? _lookedUpTenant['phone'] ?? '—'} • CCCD: ${_lookedUpTenant['masked_id_number'] ?? maskIdNumber(_lookedUpTenant['id_number'])}',
                                style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.emerald700),
                              ),
                            ],
                          ),
                        ),
                        AppButton(
                          text: 'Đổi / Nhập lại',
                          variant: AppButtonVariant.outline,
                          size: AppButtonSize.xs,
                          onPressed: _handleClearLookedUpTenant,
                        ),
                      ],
                    ),
                  ),
                if (_createErrors['primary_tenant'] != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      _createErrors['primary_tenant']!,
                      style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.rose600),
                    ),
                  ),
              ] else ...[
                // New tenant form with CCCD OCR & CheckDup
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'Họ và tên cư dân',
                        required: true,
                        initialValue: _newTenantForm['full_name']?.toString(),
                        error: _createErrors['new_full_name'],
                        onChanged: (val) => _newTenantForm['full_name'] = val,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: AppInput(
                        label: 'Số điện thoại',
                        required: true,
                        initialValue: _newTenantForm['phone']?.toString(),
                        error: _createErrors['new_phone'],
                        onChanged: (val) {
                          _newTenantForm['phone'] = val;
                          _onCheckDupTenantRealtime();
                        },
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'CCCD / Hộ chiếu',
                        initialValue: _newTenantForm['id_number']?.toString(),
                        error: _createErrors['new_id_number'],
                        onChanged: (val) {
                          _newTenantForm['id_number'] = val;
                          _onCheckDupTenantRealtime();
                        },
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: AppInput(
                        label: 'Email',
                        initialValue: _newTenantForm['email']?.toString(),
                        error: _createErrors['new_email'],
                        onChanged: (val) => _newTenantForm['email'] = val,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: AppInput(
                        label: 'Mật khẩu đăng nhập ban đầu (tối thiểu 8 ký tự)',
                        obscureText: true,
                        initialValue: _newTenantForm['password']?.toString(),
                        error: _createErrors['new_password'],
                        onChanged: (val) => _newTenantForm['password'] = val,
                      ),
                    ),
                  ],
                ),
                if (_dupInfo['isDuplicate'] == true)
                  Container(
                    margin: const EdgeInsets.only(top: 6),
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: AppColors.amber50,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: AppColors.amber200),
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            _dupInfo['message']?.toString() ??
                                'Phát hiện SĐT/CCCD đã có trong hệ thống.',
                            style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.amber700),
                          ),
                        ),
                        if (_dupInfo['inScope'] == false && _dupInfo['canLinkCrossBuilding'] == true)
                          AppButton(
                            text: 'Chuyển sang Tra cứu & Liên kết cư dân',
                            variant: AppButtonVariant.primary,
                            size: AppButtonSize.xs,
                            onPressed: _handleSwitchToCrossBuildingLookup,
                          ),
                      ],
                    ),
                  ),
                if (_createErrors['duplicate_identity'] != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      _createErrors['duplicate_identity']!,
                      style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.rose600),
                    ),
                  ),
              ],
              const SizedBox(height: 16),

              // 2b. Thành viên ở cùng (B4) — khai báo sẵn người ở ghép / gia đình
              _buildOccupantsBlock(),
              const SizedBox(height: 16),

              // 3. Thời hạn & Giá thuê
              const Text(
                '3. Kỳ hạn thuê & Tài chính',
                style: TextStyle(fontFamily: 'Inter', fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.slate900),
              ),
              const SizedBox(height: 8),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: AppInput(
                      key: ValueKey('start_$_createStartDate'),
                      label: 'Ngày bắt đầu',
                      required: true,
                      initialValue: _createStartDate,
                      error: _createErrors['start_date'],
                      onChanged: (val) => _createStartDate = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      key: ValueKey('end_$_createEndDate'),
                      label: 'Ngày kết thúc',
                      required: true,
                      initialValue: _createEndDate,
                      error: _createErrors['end_date'],
                      onChanged: (val) => _createEndDate = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Giá thuê / tháng (VND)',
                      required: true,
                      initialValue: _createRentAmount,
                      error: _createErrors['rent_amount'],
                      onChanged: (val) => _createRentAmount = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Tiền đặt cọc (VND)',
                      initialValue: _createDepositAmount,
                      error: _createErrors['deposit_amount'],
                      onChanged: (val) => _createDepositAmount = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: AppSelect<String>(
                      label: 'Chu kỳ thanh toán',
                      value: _createBillingCycle,
                      options: const [
                        AppSelectOption(value: 'monthly', label: 'Hàng tháng'),
                        AppSelectOption(value: 'quarterly', label: '3 tháng / lần'),
                      ],
                      onChanged: (val) => setState(() => _createBillingCycle = val ?? 'monthly'),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Ngày chốt hóa đơn (1–31)',
                      initialValue: _createBillingDay,
                      error: _createErrors['billing_day'],
                      onChanged: (val) => _createBillingDay = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Hạn thanh toán (ngày)',
                      initialValue: _createPaymentDueDays,
                      error: _createErrors['payment_due_days'],
                      onChanged: (val) => _createPaymentDueDays = val,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              AppInput(
                label: 'Ghi chú hợp đồng',
                multiline: true,
                rows: 2,
                initialValue: _createNote,
                onChanged: (val) => _createNote = val,
              ),
              const SizedBox(height: 16),

              // 4. Biểu phí điện nước thỏa thuận riêng
              const Text(
                '4. Đơn giá Điện / Nước theo chỉ số (Tùy chọn thỏa thuận riêng)',
                style: TextStyle(fontFamily: 'Inter', fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.slate900),
              ),
              const SizedBox(height: 8),
              Row(
                children: [
                  Expanded(
                    child: AppInput(
                      label: 'Giá Điện (VND/kWh)',
                      placeholder: 'Theo bảng giá tòa',
                      initialValue: _customElectricityPrice,
                      onChanged: (val) => _customElectricityPrice = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Giá Nước (VND/m³)',
                      placeholder: 'Theo bảng giá tòa',
                      initialValue: _customWaterPrice,
                      onChanged: (val) => _customWaterPrice = val,
                    ),
                  ),
                ],
              ),
              if (_serviceCatalog.isNotEmpty) ...[
                const SizedBox(height: 16),
                const Text(
                  '5. Gói dịch vụ đính kèm theo hợp đồng',
                  style: TextStyle(fontFamily: 'Inter', fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.slate900),
                ),
                const SizedBox(height: 8),
                ..._serviceCatalog.map(_buildServiceRow),
              ],
            ],
          ),
        ),
      );
    }

    if (_rejectReqTarget != null) {
      return ConfirmDialog(
        title: 'Từ chối yêu cầu của cư dân',
        message: 'Bạn có chắc chắn muốn từ chối yêu cầu này? Vui lòng cung cấp lý do từ chối.',
        confirmLabel: 'Xác nhận từ chối',
        variant: ConfirmDialogVariant.danger,
        loading: _processingReq,
        onClose: () => setState(() => _rejectReqTarget = null),
        onConfirm: _handleConfirmRejectRequest,
      );
    }

    if (_approveReqTarget != null) {
      return ConfirmDialog(
        title: 'Phê duyệt yêu cầu của cư dân',
        message: 'Xác nhận phê duyệt yêu cầu "${kRequestTypeLabels[_approveReqTarget['type']] ?? _approveReqTarget['type']}" của cư dân ${_approveReqTarget['resident_name']}?',
        confirmLabel: 'Phê duyệt',
        variant: ConfirmDialogVariant.primary,
        loading: _processingReq,
        onClose: () => setState(() => _approveReqTarget = null),
        onConfirm: _handleConfirmApproveRequest,
      );
    }

    return null;
  }

  @override
  Widget build(BuildContext context) {
    final permissions = ref.watch(permissionProvider);
    final canManage = permissions.canManageContracts;
    final canApprove = permissions.canApproveContracts;

    // Filter contracts
    final q = _search.trim().toLowerCase();
    final filteredContracts = _contracts.where((c) {
      if (c is! Map) return false;
      if (_statusFilter == 'PENDING_ALL') {
        if (!['PENDING_APPROVAL', 'RENEWAL_PENDING', 'TERMINATION_PENDING'].contains(c['status'])) {
          return false;
        }
      } else if (_statusFilter.isNotEmpty && c['status'] != _statusFilter) {
        return false;
      }
      if (q.isNotEmpty) {
        final code = 'hđ-${c['id']?.toString().substring(0, c['id'].toString().length >= 8 ? 8 : c['id'].toString().length) ?? ''}'.toLowerCase();
        final haystacks = [
          code,
          c['id'],
          c['apartment_code'],
          c['building_name'],
          c['tenant_name'],
          c['tenant_phone'],
        ].where((s) => s != null).map((s) => s.toString().toLowerCase()).join(' ');
        if (!haystacks.contains(q)) return false;
      }
      return true;
    }).toList();

    // Filter requests
    final filteredRequests = _requests.where((r) {
      if (r is! Map) return false;
      if (_reqStatusFilter.isNotEmpty && r['status'] != _reqStatusFilter) return false;
      if (q.isNotEmpty) {
        final haystacks = [
          r['apartment_code'],
          r['building_name'],
          r['resident_name'],
          r['resident_phone'],
          r['note'],
        ].where((s) => s != null).map((s) => s.toString().toLowerCase()).join(' ');
        if (!haystacks.contains(q)) return false;
      }
      return true;
    }).toList();

    // Stats
    int activeCount = 0;
    int pendingCount = 0;
    int draftsCount = 0;
    for (final c in _contracts) {
      if (c is! Map) continue;
      final st = c['status']?.toString();
      if (st == 'ACTIVE') activeCount++;
      if (['PENDING_APPROVAL', 'RENEWAL_PENDING', 'TERMINATION_PENDING'].contains(st)) pendingCount++;
      if (st == 'DRAFT') draftsCount++;
    }
    final pendingReqsCount = _requests.where((r) => r is Map && r['status'] == 'SUBMITTED').length;

    // Tabs
    final tabs = [
      AppTabItem(id: 'list', label: 'Danh sách HĐ', count: _contracts.length),
      AppTabItem(id: 'requests', label: 'Yêu cầu cư dân', count: pendingReqsCount),
    ];

    // Contracts columns
    final contractColumns = [
      DataTableColumn<dynamic>(
        key: 'code',
        label: 'Mã HĐ',
        width: 130,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          final id = row['id']?.toString() ?? '';
          final shortId = id.length >= 8 ? id.substring(0, 8).toUpperCase() : id.toUpperCase();
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                'HĐ-$shortId',
                style: const TextStyle(fontFamily: 'monospace', fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.primary600),
              ),
              if (row['parent_contract_id'] != null)
                const Text('HĐ nối tiếp', style: TextStyle(fontFamily: 'Inter', fontSize: 10, color: AppColors.slate400)),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'apartment_code',
        label: 'Căn hộ / Tòa nhà',
        width: 180,
        sortable: true,
        sortValue: (r) => (r is Map ? r['apartment_code']?.toString() ?? '' : ''),
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                row['apartment_code']?.toString() ?? '—',
                style: const TextStyle(fontFamily: 'Inter', fontWeight: FontWeight.w600, color: AppColors.slate900),
              ),
              Text(
                row['building_name']?.toString() ?? '—',
                style: const TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate500),
                overflow: TextOverflow.ellipsis,
              ),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'tenant_name',
        label: 'Khách thuê chính',
        width: 200,
        sortable: true,
        sortValue: (r) => (r is Map ? r['tenant_name']?.toString() ?? '' : ''),
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                row['tenant_name']?.toString() ?? '—',
                style: const TextStyle(fontFamily: 'Inter', fontWeight: FontWeight.w600, color: AppColors.slate800),
              ),
              Text(
                row['tenant_phone']?.toString() ?? '—',
                style: const TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate500),
              ),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'start_date',
        label: 'Kỳ hạn hợp đồng',
        width: 180,
        align: TextAlign.center,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(formatDate(row['start_date']), style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.slate700)),
              Text('→ ${formatDate(row['end_date'])}', style: const TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate500)),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'rent_amount',
        label: 'Giá thuê / Cọc',
        width: 170,
        align: TextAlign.right,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          return Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(formatMoney(row['rent_amount']), style: const TextStyle(fontFamily: 'Inter', fontWeight: FontWeight.w700, color: AppColors.slate900)),
              Text('Cọc: ${formatMoney(row['deposit_amount'])}', style: const TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate500)),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'status',
        label: 'Trạng thái',
        width: 150,
        align: TextAlign.center,
        render: (row) {
          final st = row is Map ? row['status']?.toString() ?? 'DRAFT' : 'DRAFT';
          return StatusBadge(status: st, domain: StatusDomain.contract);
        },
      ),
      DataTableColumn<dynamic>(
        key: 'actions',
        label: 'Thao tác',
        width: 130,
        align: TextAlign.center,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          final id = row['id']?.toString() ?? '';
          return AppButton(
            text: 'Chi tiết',
            size: AppButtonSize.xs,
            variant: AppButtonVariant.ghost,
            icon: const Icon(LucideIcons.eye, size: 14),
            onPressed: () => context.push('/admin/contracts/$id'),
          );
        },
      ),
    ];

    // Requests columns
    final requestColumns = [
      DataTableColumn<dynamic>(
        key: 'type',
        label: 'Loại đề nghị',
        width: 160,
        align: TextAlign.center,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          final type = row['type']?.toString() ?? '';
          final label = kRequestTypeLabels[type] ?? type;
          final variant = kRequestTypeVariants[type] ?? AppBadgeVariant.slate;
          return AppBadge(label: label, variant: variant);
        },
      ),
      DataTableColumn<dynamic>(
        key: 'apartment_code',
        label: 'Căn hộ / Tòa nhà',
        width: 180,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(row['apartment_code']?.toString() ?? '—', style: const TextStyle(fontFamily: 'Inter', fontWeight: FontWeight.w600, color: AppColors.slate900)),
              Text(row['building_name']?.toString() ?? '—', style: const TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate500)),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'resident_name',
        label: 'Cư dân gửi yêu cầu',
        width: 180,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(row['resident_name']?.toString() ?? '—', style: const TextStyle(fontFamily: 'Inter', fontWeight: FontWeight.w600, color: AppColors.slate800)),
              Text(row['resident_phone']?.toString() ?? '—', style: const TextStyle(fontFamily: 'Inter', fontSize: 11, color: AppColors.slate500)),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'desired_date',
        label: 'Ngày mong muốn / Gửi',
        width: 160,
        align: TextAlign.center,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(formatDate(row['desired_date']), style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.slate800)),
              if (row['created_at'] != null)
                Text('Gửi: ${formatDate(row['created_at'])}', style: const TextStyle(fontFamily: 'Inter', fontSize: 10, color: AppColors.slate400)),
            ],
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'note',
        label: 'Nội dung / Lý do',
        flex: 2,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          return Text(
            row['note']?.toString() ?? '—',
            style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.slate700),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
          );
        },
      ),
      DataTableColumn<dynamic>(
        key: 'status',
        label: 'Trạng thái xử lý',
        width: 140,
        align: TextAlign.center,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          final st = row['status']?.toString() ?? 'SUBMITTED';
          final variant = st == 'APPROVED' ? AppBadgeVariant.emerald : st == 'REJECTED' ? AppBadgeVariant.red : AppBadgeVariant.amber;
          final label = st == 'APPROVED' ? 'Đã duyệt' : st == 'REJECTED' ? 'Đã từ chối' : 'Chờ duyệt';
          return AppBadge(label: label, variant: variant);
        },
      ),
      DataTableColumn<dynamic>(
        key: 'actions',
        label: 'Thao tác',
        width: 220,
        align: TextAlign.center,
        render: (row) {
          if (row is! Map) return const SizedBox.shrink();
          final isPending = row['status'] == 'SUBMITTED';
          if (!isPending || !canApprove) {
            return const Text('—', style: TextStyle(fontFamily: 'Inter', color: AppColors.slate400));
          }
          return SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AppButton(
                  text: 'Duyệt',
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.primary,
                  icon: const Icon(LucideIcons.checkCircle2, size: 14),
                  onPressed: () => setState(() => _approveReqTarget = row),
                ),
                const SizedBox(width: 6),
                AppButton(
                  text: 'Từ chối',
                  size: AppButtonSize.xs,
                  variant: AppButtonVariant.outline,
                  icon: const Icon(LucideIcons.xCircle, size: 14),
                  onPressed: () => setState(() {
                    _rejectReqTarget = row;
                    _rejectReason = '';
                  }),
                ),
              ],
            ),
          );
        },
      ),
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
                    title: 'Quản lý Hợp đồng',
                    subtitle: 'Theo dõi hợp đồng thuê căn hộ, bản in A4 pháp lý và phê duyệt 4 mắt',
                    actions: canManage
                        ? AppButton(
                            text: 'Tạo hợp đồng',
                            variant: AppButtonVariant.primary,
                            icon: const Icon(LucideIcons.plus, size: 16),
                            onPressed: () => _openCreateModal(),
                          )
                        : null,
                  ),
                  const SizedBox(height: 16),

                  // KPI Cards
                  LayoutBuilder(
                    builder: (context, constraints) {
                      final cols = constraints.maxWidth >= 900
                          ? 4
                          : (constraints.maxWidth >= 500 ? 2 : 1);
                      final itemWidth =
                          ((constraints.maxWidth - (cols - 1) * 16) / cols).floorToDouble();
                      final cards = [
                        StatsCard(title: 'Đang hiệu lực', value: activeCount, icon: LucideIcons.fileCheck, color: 'emerald'),
                        StatsCard(title: 'Chờ phê duyệt', value: pendingCount, icon: LucideIcons.clock, color: 'amber'),
                        StatsCard(title: 'Bản nháp (DRAFT)', value: draftsCount, icon: LucideIcons.fileEdit, color: 'sky'),
                        StatsCard(title: 'Yêu cầu cư dân', value: pendingReqsCount, icon: LucideIcons.inbox, color: 'rose'),
                      ];
                      return Wrap(
                        spacing: 16,
                        runSpacing: 16,
                        children: [
                          for (final card in cards) SizedBox(width: itemWidth, child: card),
                        ],
                      );
                    },
                  ),
                  const SizedBox(height: 20),

                  // Tabs
                  AppTabs(
                    tabs: tabs,
                    activeTab: _activeTab,
                    onChanged: (id) => setState(() => _activeTab = id),
                  ),
                  const SizedBox(height: 16),

                  // Filter Row
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
                            placeholder: 'Tìm theo mã HĐ, căn hộ, cư dân, SĐT...',
                            value: _search,
                            onChanged: (val) => setState(() => _search = val),
                          ),
                        ),
                        if (_activeTab == 'list')
                          SizedBox(
                            width: 280,
                            child: AppSelect<String>(
                              placeholder: 'Tất cả trạng thái',
                              value: _statusFilter.isNotEmpty ? _statusFilter : null,
                              options: kContractStatusLabels.entries
                                  .map((e) => AppSelectOption(value: e.key, label: e.value))
                                  .toList(),
                              onChanged: (val) => setState(() => _statusFilter = val ?? ''),
                            ),
                          )
                        else
                          SizedBox(
                            width: 240,
                            child: AppSelect<String>(
                              placeholder: 'Tất cả trạng thái yêu cầu',
                              value: _reqStatusFilter.isNotEmpty ? _reqStatusFilter : null,
                              options: kRequestStatusLabels.entries
                                  .map((e) => AppSelectOption(value: e.key, label: e.value))
                                  .toList(),
                              onChanged: (val) => setState(() => _reqStatusFilter = val ?? ''),
                            ),
                          ),
                        IconButton(
                          tooltip: 'Tải lại dữ liệu',
                          icon: const Icon(LucideIcons.refreshCw, size: 18, color: AppColors.slate600),
                          onPressed: () => _fetchData(force: true),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 16),

                  // Table Content
                  if (_activeTab == 'list')
                    AppCard(
                      padding: EdgeInsets.zero,
                      child: DataTableWidget<dynamic>(
                        columns: contractColumns,
                        data: filteredContracts,
                        loading: _loading,
                        onRowClick: (row) {
                          if (row is Map && row['id'] != null) {
                            context.push('/admin/contracts/${row['id']}');
                          }
                        },
                      ),
                    )
                  else
                    AppCard(
                      padding: EdgeInsets.zero,
                      child: DataTableWidget<dynamic>(
                        columns: requestColumns,
                        data: filteredRequests,
                        loading: _loading,
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
                    maxWidth: 860,
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
}
