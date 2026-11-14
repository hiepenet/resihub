import 'dart:async';
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
  'PENDING_ALL': 'Tất cả chờ duyệt (Giá / Gia hạn / Chấm dứt)',
  'DRAFT': 'Bản nháp (DRAFT)',
  'PENDING_APPROVAL': 'Chờ duyệt giá (PENDING_APPROVAL)',
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
  'SUBMITTED': 'Chờ duyệt (SUBMITTED)',
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
  bool _tenantLookupLoading = false;
  dynamic _lookedUpTenant;
  String? _tenantLookupMessage;

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
  };

  // Occupants inline
  final List<Map<String, String>> _inlineOccupants = [];

  // Services selection: serviceId -> Map
  final Map<String, Map<String, dynamic>> _selectedServices = {};
  String _customElectricityPrice = '';
  String _customWaterPrice = '';

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
    _fetchData();
  }

  @override
  void dispose() {
    _dupTimer?.cancel();
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
      _lookedUpTenant = null;
      _tenantLookupMessage = null;
      _newTenantForm.updateAll((key, value) => '');
      _newTenantForm['nationality'] = 'Việt Nam';
      _inlineOccupants.clear();
      _selectedServices.clear();
      _customElectricityPrice = '';
      _customWaterPrice = '';
      _createErrors.clear();
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
            final base = matched['base_rent'] != null
                ? formatMoney(matched['base_rent'], showSymbol: false).replaceAll('.', '')
                : '';
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
      final base = apt['base_rent'] != null
          ? formatMoney(apt['base_rent'], showSymbol: false).replaceAll('.', '')
          : '';
      setState(() {
        if (_createBuildingId.isEmpty) {
          _createBuildingId = apt['building_id']?.toString() ?? '';
        }
        _createRentAmount = base;
        _createDepositAmount = base;
      });
    }
  }

  Future<void> _handleLookupTenant() async {
    final raw = _tenantIdentifier.trim();
    if (raw.isEmpty) {
      setState(() {
        _lookedUpTenant = null;
        _tenantLookupMessage = 'Vui lòng nhập SĐT hoặc CCCD.';
      });
      return;
    }

    final normPhone = normalizePhone(raw);
    final isPhone = isValidPhone(normPhone);
    final isId = !isPhone && isValidIdNumber(raw);

    if (!isPhone && !isId) {
      setState(() {
        _lookedUpTenant = null;
        _tenantLookupMessage = 'Định dạng không hợp lệ (10 số đối với SĐT, 9–12 số đối với CCCD).';
      });
      return;
    }

    setState(() {
      _tenantLookupLoading = true;
      _tenantLookupMessage = null;
      _lookedUpTenant = null;
    });

    try {
      final res = await ref.read(tenantsServiceProvider).lookup(isPhone ? normPhone : raw);
      if (res is Map && res['found'] == true && res['tenant'] != null) {
        setState(() {
          _lookedUpTenant = res['tenant'];
          _tenantLookupMessage = null;
          _createErrors.remove('primary_tenant');
        });
      } else {
        setState(() {
          _lookedUpTenant = null;
          _tenantLookupMessage = (res is Map && res['message'] != null)
              ? res['message'].toString()
              : 'Không tìm thấy hồ sơ cư dân với SĐT/CCCD này.';
        });
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Lỗi tra cứu cư dân.'),
          );
      setState(() {
        _lookedUpTenant = null;
        _tenantLookupMessage = 'Lỗi tra cứu cư dân.';
      });
    } finally {
      if (mounted) {
        setState(() => _tenantLookupLoading = false);
      }
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
        _dupInfo = {'isDuplicate': false, 'inScope': true, 'message': ''};
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
    final errs = <String, String>{};

    if (_createApartmentId.isEmpty) {
      errs['apartment_id'] = 'Vui lòng chọn căn hộ.';
    }

    if (_tenantMode == 'existing') {
      if (_lookedUpTenant == null) {
        errs['primary_tenant'] = 'Vui lòng tra cứu và chọn cư dân đại diện hợp đồng.';
      }
    } else {
      final name = _newTenantForm['full_name']?.toString().trim() ?? '';
      final phone = _newTenantForm['phone']?.toString().trim() ?? '';
      if (name.isEmpty) errs['new_full_name'] = 'Vui lòng nhập họ và tên cư dân.';
      if (phone.isEmpty) {
        errs['new_phone'] = 'Vui lòng nhập số điện thoại.';
      } else if (!isValidPhone(phone)) {
        errs['new_phone'] = 'Số điện thoại không đúng định dạng 10 số.';
      }
    }

    if (_createStartDate.isEmpty) errs['start_date'] = 'Chọn ngày bắt đầu.';
    if (_createEndDate.isEmpty) errs['end_date'] = 'Chọn ngày kết thúc.';
    if (_createStartDate.isNotEmpty && _createEndDate.isNotEmpty && _createEndDate.compareTo(_createStartDate) <= 0) {
      errs['end_date'] = 'Ngày kết thúc phải sau ngày bắt đầu.';
    }

    final rent = num.tryParse(_createRentAmount) ?? 0;
    if (rent <= 0) errs['rent_amount'] = 'Giá thuê phải lớn hơn 0.';

    setState(() => _createErrors = errs);
    if (errs.isNotEmpty) return;

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
        'billing_day': int.tryParse(_createBillingDay) ?? 1,
        'payment_due_days': int.tryParse(_createPaymentDueDays) ?? 5,
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

      // Add selected services
      final servicesList = <Map<String, dynamic>>[];
      for (final entry in _selectedServices.entries) {
        final cfg = entry.value;
        if (cfg['checked'] == true) {
          servicesList.add({
            'service_id': entry.key,
            'quantity': cfg['quantity'] ?? 1,
            'unit_price': cfg['unit_price'] ?? 0,
            if (cfg['vehicle_plates'] is List) 'vehicle_plates': cfg['vehicle_plates'],
            if (cfg['note']?.toString().isNotEmpty == true) 'note': cfg['note'],
          });
        }
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
                        return AppSelectOption(value: id, label: name);
                      }).toList(),
                      onChanged: _onBuildingChangedInModal,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppSelect<String>(
                      label: 'Căn hộ',
                      required: true,
                      placeholder: _loadingRefData ? 'Đang tải...' : 'Chọn căn hộ trống',
                      value: _createApartmentId.isNotEmpty ? _createApartmentId : null,
                      options: _apartments.map((a) {
                        final id = a['id']?.toString() ?? '';
                        final code = a['code']?.toString() ?? '';
                        final base = a['base_rent'] != null ? ' - ${formatMoney(a['base_rent'])}' : '';
                        return AppSelectOption(value: id, label: '$code$base');
                      }).toList(),
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
                        placeholder: 'Nhập SĐT (10 số) hoặc CCCD...',
                        initialValue: _tenantIdentifier,
                        onChanged: (val) => _tenantIdentifier = val,
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
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      _tenantLookupMessage!,
                      style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.amber700),
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
                              Text(
                                _lookedUpTenant['full_name']?.toString() ?? '',
                                style: const TextStyle(fontFamily: 'Inter', fontWeight: FontWeight.w600, color: AppColors.emerald700),
                              ),
                              Text(
                                'SĐT: ${_lookedUpTenant['phone'] ?? '—'} • CCCD: ${maskIdNumber(_lookedUpTenant['id_number'])}',
                                style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.emerald700),
                              ),
                            ],
                          ),
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
                        onChanged: (val) => _newTenantForm['email'] = val,
                      ),
                    ),
                  ],
                ),
                if (_dupInfo['isDuplicate'] == true)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      _dupInfo['message']?.toString() ?? 'Phát hiện SĐT/CCCD đã có trong hệ thống.',
                      style: const TextStyle(fontFamily: 'Inter', fontSize: 12, color: AppColors.amber700),
                    ),
                  ),
              ],
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
                      onChanged: (val) => _createBillingDay = val,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: AppInput(
                      label: 'Hạn thanh toán (ngày)',
                      initialValue: _createPaymentDueDays,
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
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: _serviceCatalog.map((svc) {
                    if (svc is! Map) return const SizedBox.shrink();
                    final sId = svc['id']?.toString() ?? '';
                    final isChecked = _selectedServices[sId]?['checked'] == true;
                    return FilterChip(
                      selected: isChecked,
                      label: Text('${svc['name'] ?? ''} (${formatMoney(svc['base_price'])})'),
                      onSelected: (val) {
                        setState(() {
                          if (val) {
                            _selectedServices[sId] = {
                              'checked': true,
                              'quantity': 1,
                              'unit_price': svc['base_price'],
                            };
                          } else {
                            _selectedServices.remove(sId);
                          }
                        });
                      },
                    );
                  }).toList(),
                ),
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
        width: 100,
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
                      final isWide = constraints.maxWidth >= 900;
                      return GridView.count(
                        crossAxisCount: isWide ? 4 : 2,
                        crossAxisSpacing: 16,
                        mainAxisSpacing: 16,
                        childAspectRatio: isWide ? 2.2 : 1.7,
                        shrinkWrap: true,
                        physics: const NeverScrollableScrollPhysics(),
                        children: [
                          StatsCard(title: 'Đang hiệu lực', value: activeCount, icon: LucideIcons.fileCheck, color: 'emerald'),
                          StatsCard(title: 'Chờ phê duyệt', value: pendingCount, icon: LucideIcons.clock, color: 'amber'),
                          StatsCard(title: 'Bản nháp (DRAFT)', value: draftsCount, icon: LucideIcons.fileEdit, color: 'sky'),
                          StatsCard(title: 'Yêu cầu cư dân', value: pendingReqsCount, icon: LucideIcons.inbox, color: 'rose'),
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
