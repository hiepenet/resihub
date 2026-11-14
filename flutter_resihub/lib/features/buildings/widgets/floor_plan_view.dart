import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/date_range.dart';
import '../../../core/utils/deposit_ui_helpers.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/status_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/app_skeleton.dart';
import '../../auth/providers/permission_provider.dart';
import '../services/buildings_service.dart';
import 'bulk_apartment_modal.dart';
import 'floor_modal.dart';

String computeSuggestedHoldUntil(
  String startStr,
  List<BusyInterval> busyIntervals, {
  int maxHoldDays = 30,
}) {
  if (startStr.isEmpty) return '';
  final defaultSpan = math.min(5, math.max(1, maxHoldDays));
  final defaultUntil = addDaysStr(startStr, defaultSpan);
  BusyInterval? nextBusy;
  for (final iv in busyIntervals) {
    if (iv.from.isNotEmpty && iv.from.compareTo(startStr) > 0) {
      if (nextBusy == null || iv.from.compareTo(nextBusy.from) < 0) {
        nextBusy = iv;
      }
    }
  }
  if (nextBusy == null) return defaultUntil;
  final maxBeforeBusy = addDaysStr(nextBusy.from, -1);
  final minValidUntil = addDaysStr(startStr, 1);
  if (maxBeforeBusy.compareTo(minValidUntil) < 0) return minValidUntil;
  return minDateStr([defaultUntil, maxBeforeBusy]);
}

List<Map<String, dynamic>> sortFloorsAsc(dynamic list) {
  if (list is! List) return [];
  final floors = list
      .whereType<Map>()
      .map((e) => Map<String, dynamic>.from(e))
      .toList();
  floors.sort((a, b) {
    final lvlA = int.tryParse(a['level']?.toString() ?? '0') ?? 0;
    final lvlB = int.tryParse(b['level']?.toString() ?? '0') ?? 0;
    return lvlA.compareTo(lvlB);
  });
  return floors;
}

class ApartmentStatusStyle {
  final String label;
  final Color dotColor;
  final Color bgColor;
  final Color borderColor;
  final Color textColor;

  const ApartmentStatusStyle({
    required this.label,
    required this.dotColor,
    required this.bgColor,
    required this.borderColor,
    required this.textColor,
  });
}

ApartmentStatusStyle getApartmentStatusStyle(String? status) {
  switch (status) {
    case 'AVAILABLE':
      return const ApartmentStatusStyle(
        label: 'Còn trống',
        dotColor: Color(0xFF10B981),
        bgColor: Color(0xFFECFDF5),
        borderColor: Color(0xFFA7F3D0),
        textColor: Color(0xFF047857),
      );
    case 'OCCUPIED':
      return const ApartmentStatusStyle(
        label: 'Đang thuê',
        dotColor: Color(0xFFF43F5E),
        bgColor: Color(0xFFFFF1F2),
        borderColor: Color(0xFFFECDD3),
        textColor: Color(0xFFBE123C),
      );
    case 'RESERVED':
      return const ApartmentStatusStyle(
        label: 'Đã giữ chỗ',
        dotColor: Color(0xFFF59E0B),
        bgColor: Color(0xFFFFFBEB),
        borderColor: Color(0xFFFDE68A),
        textColor: Color(0xFFB45309),
      );
    case 'MAINTENANCE':
      return const ApartmentStatusStyle(
        label: 'Đang bảo trì',
        dotColor: Color(0xFF94A3B8),
        bgColor: Color(0xFFF1F5F9),
        borderColor: Color(0xFFE2E8F0),
        textColor: Color(0xFF334155),
      );
    case 'BLOCKED':
      return const ApartmentStatusStyle(
        label: 'Tạm khóa',
        dotColor: Color(0xFFA855F7),
        bgColor: Color(0xFFFAF5FF),
        borderColor: Color(0xFFE9D5FF),
        textColor: Color(0xFF7E22CE),
      );
    case 'INACTIVE':
      return const ApartmentStatusStyle(
        label: 'Ngưng khai thác',
        dotColor: Color(0xFFA855F7),
        bgColor: Color(0xFFFAF5FF),
        borderColor: Color(0xFFE9D5FF),
        textColor: Color(0xFF7E22CE),
      );
    default:
      return const ApartmentStatusStyle(
        label: 'Còn trống',
        dotColor: Color(0xFF10B981),
        bgColor: Color(0xFFECFDF5),
        borderColor: Color(0xFFA7F3D0),
        textColor: Color(0xFF047857),
      );
  }
}

/// Port of `FloorPlanView` in `frontend/src/pages/admin/buildings/FloorPlanPage.jsx`.
class FloorPlanView extends ConsumerStatefulWidget {
  final String buildingId;
  final bool embedded;
  final bool highlightPendingConfirm;
  final Widget? buildingSelector;
  final dynamic initialBuilding;
  final dynamic initialZones;
  final VoidCallback? onFloorsChanged;

  const FloorPlanView({
    super.key,
    required this.buildingId,
    this.embedded = false,
    this.highlightPendingConfirm = false,
    this.buildingSelector,
    this.initialBuilding,
    this.initialZones,
    this.onFloorsChanged,
  });

  @override
  ConsumerState<FloorPlanView> createState() => _FloorPlanViewState();
}

class _FloorPlanViewState extends ConsumerState<FloorPlanView> {
  Map<String, dynamic>? _building;
  List<Map<String, dynamic>> _floorMap = [];
  List<Map<String, dynamic>> _zones = [];
  List<Map<String, dynamic>> _pendingConfirms = [];
  Map<String, dynamic> _cancelPolicy = kDefaultReservationCancelPolicy;
  String _statusFilter = 'ALL';
  String _zoneFilter = 'ALL';
  bool _loading = true;

  // Selected apartment drawer / modal
  Map<String, dynamic>? _selectedApt;
  Map<String, dynamic>? _aptDetail;
  bool _detailLoading = false;

  // Modals
  bool _floorModalOpen = false;
  String _floorModalMode = 'bulk';
  Map<String, dynamic>? _deleteFloorTarget;
  bool _deletingFloor = false;

  bool _aptModalOpen = false;
  final _aptCodeController = TextEditingController();
  String _aptFloorId = '';
  final String _aptZoneId = '';
  String _aptType = '1PN';
  int _aptBedrooms = 1;
  double _aptAreaM2 = 45;
  int _aptBaseRent = 8500000;

  bool _bulkModalOpen = false;

  // Reservation Modal
  bool _resModalOpen = false;
  final _resProspectNameController = TextEditingController();
  final _resPhoneController = TextEditingController();
  final _resHoldAmountController = TextEditingController(text: '2000000');
  String _resMethod = 'BANK_TRANSFER';
  final _resHoldFromController = TextEditingController();
  final _resHoldUntilController = TextEditingController();
  final _resNoteController = TextEditingController();

  // Reject Modal
  Map<String, dynamic>? _rejectReservation;
  final _rejectReasonController = TextEditingController();
  bool _rejectModalOpen = false;

  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _loadInitialCache();
    _fetchFloorPlan();
  }

  @override
  void didUpdateWidget(covariant FloorPlanView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.buildingId != oldWidget.buildingId) {
      _loadInitialCache();
      _fetchFloorPlan();
    }
  }

  @override
  void dispose() {
    _aptCodeController.dispose();
    _resProspectNameController.dispose();
    _resPhoneController.dispose();
    _resHoldAmountController.dispose();
    _resHoldFromController.dispose();
    _resHoldUntilController.dispose();
    _resNoteController.dispose();
    _rejectReasonController.dispose();
    super.dispose();
  }

  void _loadInitialCache() {
    final service = ref.read(buildingsServiceProvider);
    if (widget.initialBuilding is Map) {
      _building = Map<String, dynamic>.from(widget.initialBuilding as Map);
    } else {
      final cachedBld = service.peekById(widget.buildingId);
      if (cachedBld is Map && cachedBld['data'] is Map) {
        _building = Map<String, dynamic>.from(cachedBld['data'] as Map);
      }
    }

    final cachedFm = service.peekFloorMap(widget.buildingId);
    if (cachedFm is Map && cachedFm['data'] is List) {
      _floorMap = sortFloorsAsc(cachedFm['data']);
      _loading = false;
    }

    if (widget.initialZones is List) {
      _zones = (widget.initialZones as List)
          .whereType<Map>()
          .map((e) => Map<String, dynamic>.from(e))
          .toList();
    } else {
      final cachedZ = service.peekZones(widget.buildingId);
      if (cachedZ is Map && cachedZ['data'] is List) {
        _zones = (cachedZ['data'] as List)
            .whereType<Map>()
            .map((e) => Map<String, dynamic>.from(e))
            .toList();
      }
    }
  }

  Future<void> _fetchFloorPlan({bool force = false}) async {
    if (widget.buildingId.isEmpty) return;
    final service = ref.read(buildingsServiceProvider);

    service.getReservationCancelPolicy().then((res) {
      if (mounted && res is Map && res['data'] is Map) {
        setState(() {
          _cancelPolicy = {..._cancelPolicy, ...Map<String, dynamic>.from(res['data'] as Map)};
        });
      }
    }).catchError((_) {});

    if (_floorMap.isEmpty) {
      setState(() => _loading = true);
    }

    try {
      final bldFuture = (widget.initialBuilding is Map && !force)
          ? Future.value({'data': widget.initialBuilding})
          : service.getById(widget.buildingId, force: force);
      final fmFuture = service.getFloorMap(widget.buildingId, force: force);
      final zoneFuture = (widget.initialZones is List && !force)
          ? Future.value({'data': widget.initialZones})
          : service.listZones(widget.buildingId, force: force).catchError((_) => {'data': []});
      final pendingFuture = service.listReservations(
        {'building_id': widget.buildingId, 'status': 'PENDING_CONFIRM', 'limit': 50},
        force,
      ).catchError((_) => {'data': []});

      final results = await Future.wait<dynamic>([bldFuture, fmFuture, zoneFuture, pendingFuture]);
      if (!mounted) return;

      final bRes = results[0];
      final fmRes = results[1];
      final zRes = results[2];
      final pendRes = results[3];

      setState(() {
        if (bRes is Map && bRes['data'] is Map) {
          _building = Map<String, dynamic>.from(bRes['data'] as Map);
        }
        if (fmRes is Map && fmRes['data'] is List) {
          _floorMap = sortFloorsAsc(fmRes['data']);
        }
        if (zRes is Map && zRes['data'] is List) {
          _zones = (zRes['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
        }
        if (pendRes is Map && pendRes['data'] is List) {
          _pendingConfirms = (pendRes['data'] as List)
              .whereType<Map>()
              .map((e) => Map<String, dynamic>.from(e))
              .toList();
        }
        _loading = false;
      });
    } catch (err) {
      if (mounted) {
        setState(() => _loading = false);
        ref.read(toastProvider.notifier).error(extractErrorMessage(err));
      }
    }
  }

  Future<void> _handleOpenAptDrawer(Map<String, dynamic> apt) async {
    setState(() {
      _selectedApt = apt;
      _aptDetail = null;
      _detailLoading = true;
    });
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.getApartment(apt['id'].toString());
      if (mounted) {
        setState(() {
          _aptDetail = res is Map && res['data'] is Map
              ? Map<String, dynamic>.from(res['data'] as Map)
              : apt;
          _detailLoading = false;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _aptDetail = apt;
          _detailLoading = false;
        });
      }
    }
  }

  Future<void> _handleConfirmPayment(Map<String, dynamic> rsv) async {
    final id = rsv['id']?.toString();
    if (id == null) return;
    setState(() => _submitting = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.confirmReservationPayment(id, {});
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : 'Đã xác nhận tiền về và khóa giữ chỗ căn hộ.',
          );
      _fetchFloorPlan(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _handleRejectPayment() async {
    final rsv = _rejectReservation;
    final id = rsv?['id']?.toString();
    final reason = _rejectReasonController.text.trim();
    if (id == null) return;
    if (reason.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập lý do từ chối biên lai chuyển khoản.');
      return;
    }
    setState(() => _submitting = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.rejectReservationPayment(id, {'reason': reason});
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : 'Đã từ chối yêu cầu giữ chỗ.',
          );
      setState(() {
        _rejectModalOpen = false;
        _rejectReservation = null;
      });
      _fetchFloorPlan(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _handleCreateApartment() async {
    final code = _aptCodeController.text.trim().toUpperCase();
    if (code.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập mã căn hộ.');
      return;
    }
    setState(() => _submitting = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      await service.createApartment({
        'building_id': widget.buildingId,
        'floor_id': _aptFloorId.isEmpty ? (_floorMap.isNotEmpty ? _floorMap[0]['id'] : null) : _aptFloorId,
        'zone_id': _aptZoneId.isEmpty ? null : _aptZoneId,
        'code': code,
        'type': _aptType,
        'bedrooms': _aptBedrooms,
        'area_m2': _aptAreaM2,
        'base_rent': _aptBaseRent,
      });
      ref.read(toastProvider.notifier).success('Đã tạo căn hộ $code.');
      setState(() => _aptModalOpen = false);
      _fetchFloorPlan(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _handleConfirmDeleteFloor() async {
    final target = _deleteFloorTarget;
    final floorId = target?['id']?.toString();
    if (floorId == null) return;
    setState(() => _deletingFloor = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      final res = await service.deleteFloor(widget.buildingId, floorId);
      ref.read(toastProvider.notifier).success(
            (res is Map && res['message'] != null)
                ? res['message'].toString()
                : 'Đã xóa tầng.',
          );
      setState(() => _deleteFloorTarget = null);
      await _fetchFloorPlan(force: true);
      widget.onFloorsChanged?.call();
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err, 'Không thể xóa tầng.'));
    } finally {
      if (mounted) setState(() => _deletingFloor = false);
    }
  }

  Future<void> _handleCreateReservation() async {
    final apt = _selectedApt;
    if (apt == null) return;
    final name = _resProspectNameController.text.trim();
    final phone = _resPhoneController.text.trim();
    final holdAmt = int.tryParse(_resHoldAmountController.text.replaceAll(RegExp(r'\D'), '')) ?? 0;
    if (name.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập họ tên khách đặt giữ chỗ.');
      return;
    }
    if (phone.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập số điện thoại.');
      return;
    }
    if (holdAmt <= 0) {
      ref.read(toastProvider.notifier).warning('Tiền đặt cọc giữ chỗ phải là số nguyên dương VND.');
      return;
    }

    setState(() => _submitting = true);
    try {
      final service = ref.read(buildingsServiceProvider);
      await service.createReservation({
        'apartment_id': apt['id'],
        'prospect_name': name,
        'phone': phone,
        'hold_amount': holdAmt,
        'method': _resMethod,
        'hold_from': _resHoldFromController.text.trim().isEmpty ? null : _resHoldFromController.text.trim(),
        'hold_until': _resHoldUntilController.text.trim(),
        'note': _resNoteController.text.trim(),
      });
      ref.read(toastProvider.notifier).success('Đã ghi nhận đặt cọc giữ chỗ thành công.');
      setState(() {
        _resModalOpen = false;
        _selectedApt = null;
      });
      _fetchFloorPlan(force: true);
    } catch (err) {
      ref.read(toastProvider.notifier).error(extractErrorMessage(err));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final permissions = ref.watch(permissionProvider);
    final canEditRealEstate = permissions.canEditRealEstate;
    final canManageBuildings = permissions.canManageBuildings;
    final isManager = permissions.isManager;

    if (_loading && _floorMap.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(24.0),
        child: AppSkeleton(),
      );
    }

    final todayStr = toDateOnlyStr(DateTime.now());
    final maxInternalHoldDays = int.tryParse(_cancelPolicy['max_hold_days']?.toString() ?? '30') ?? 30;

    final aptDetailOrSelected = _aptDetail ?? _selectedApt;
    final contractsList = (aptDetailOrSelected?['contracts'] is List)
        ? (aptDetailOrSelected!['contracts'] as List)
        : const [];
    final reservationsList = (aptDetailOrSelected?['reservations'] is List)
        ? (aptDetailOrSelected!['reservations'] as List)
        : const [];

    final resBusyIntervals = extractApartmentBusyIntervals(
      contracts: contractsList,
      reservations: reservationsList,
      todayStr: todayStr,
    );

    final earliestResStart = findFirstAvailableStartDate(
      (_selectedApt?['status'] == 'MAINTENANCE') ? addDaysStr(todayStr, 1) : todayStr,
      resBusyIntervals,
      minSpanDays: 2,
    );

    final hasOverlayModal = _selectedApt != null ||
        _resModalOpen ||
        _floorModalOpen ||
        _bulkModalOpen ||
        _aptModalOpen ||
        _rejectModalOpen ||
        _deleteFloorTarget != null;

    return Stack(
      children: [
        SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
          if (!widget.embedded) ...[
            PageHeader(
              title: 'Sơ đồ tầng — ${_building?['name'] ?? ''}',
              subtitle: 'Nhấn vào từng ô căn hộ để xem thông tin nhanh, đối chiếu sao kê giữ chỗ, bảo trì hoặc bàn giao phòng',
              breadcrumbs: [
                const BreadcrumbItem(label: 'Bất động sản', to: '/admin/buildings'),
                if (_building?['id'] != null)
                  BreadcrumbItem(
                    label: _building?['code']?.toString() ?? 'Tòa nhà',
                    to: '/admin/buildings/${_building!['id']}',
                  ),
                const BreadcrumbItem(label: 'Sơ đồ tầng'),
              ],
              actions: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (widget.buildingSelector != null) widget.buildingSelector!,
                  if (canEditRealEstate) ...[
                    const SizedBox(width: 8),
                    AppButton(
                      text: 'Tạo hàng loạt',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.sm,
                      icon: const Icon(LucideIcons.copyPlus, size: 14),
                      onPressed: () => setState(() => _bulkModalOpen = true),
                    ),
                    const SizedBox(width: 8),
                    AppButton(
                      text: 'Thêm tầng',
                      variant: AppButtonVariant.outline,
                      size: AppButtonSize.sm,
                      icon: const Icon(LucideIcons.layers, size: 14),
                      onPressed: () => setState(() {
                        _floorModalMode = 'bulk';
                        _floorModalOpen = true;
                      }),
                    ),
                    const SizedBox(width: 8),
                    AppButton(
                      text: 'Thêm căn hộ',
                      size: AppButtonSize.sm,
                      icon: const Icon(LucideIcons.plus, size: 14),
                      onPressed: () => setState(() {
                        _aptFloorId = _floorMap.isNotEmpty ? _floorMap[0]['id'].toString() : '';
                        _aptCodeController.clear();
                        _aptModalOpen = true;
                      }),
                    ),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],

          // Pending confirmations queue
          if (_pendingConfirms.isNotEmpty || widget.highlightPendingConfirm) ...[
            AppCard(
              padding: const EdgeInsets.all(16),
              border: Border.all(color: AppColors.amber200),
              color: const Color(0xFFFFFBEB),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Wrap(
                    alignment: WrapAlignment.spaceBetween,
                    crossAxisAlignment: WrapCrossAlignment.center,
                    spacing: 8,
                    runSpacing: 4,
                    children: [
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(LucideIcons.clock, size: 16, color: AppColors.amber600),
                          const SizedBox(width: 8),
                          Text(
                            'Yêu cầu Giữ chỗ Online chờ đối chiếu sao kê (${_pendingConfirms.length})',
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                          ),
                        ],
                      ),
                      const Text(
                        'Căn hộ vẫn mở trống cho tới khi Quản lý xác nhận tiền đã về',
                        style: TextStyle(fontSize: 12, color: AppColors.amber900),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  if (_pendingConfirms.isEmpty)
                    const Text('Không có yêu cầu giữ chỗ chờ xác nhận sao kê tại tòa nhà này.',
                        style: TextStyle(fontSize: 12, color: AppColors.slate600))
                  else
                    Wrap(
                      spacing: 12,
                      runSpacing: 12,
                      children: _pendingConfirms.map((r) {
                        return Container(
                          width: 420,
                          padding: const EdgeInsets.all(12),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(12),
                            border: Border.all(color: AppColors.amber200),
                          ),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Wrap(
                                spacing: 8,
                                runSpacing: 4,
                                crossAxisAlignment: WrapCrossAlignment.center,
                                children: [
                                  Text('Căn ${r['apartment_code']}',
                                      style: const TextStyle(fontWeight: FontWeight.bold, color: AppColors.primary700)),
                                  FittedBox(
                                    fit: BoxFit.scaleDown,
                                    child: StatusBadge(status: r['status']?.toString(), domain: StatusDomain.reservation),
                                  ),
                                  Text(formatMoney(r['hold_amount']),
                                      style: const TextStyle(fontWeight: FontWeight.bold)),
                                ],
                              ),
                              const SizedBox(height: 4),
                              Text('${r['prospect_name']} (${r['phone']})',
                                  style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w500)),
                              Text('Giữ đến: ${formatDate(r['hold_until'])}',
                                  style: const TextStyle(fontSize: 11, color: AppColors.slate500)),
                              const SizedBox(height: 8),
                              Wrap(
                                spacing: 6,
                                runSpacing: 6,
                                children: [
                                  if (isManager) ...[
                                    AppButton(
                                      text: 'Xác nhận tiền về',
                                      variant: AppButtonVariant.success,
                                      size: AppButtonSize.xs,
                                      icon: const Icon(LucideIcons.checkCircle2, size: 14),
                                      loading: _submitting,
                                      onPressed: () => _handleConfirmPayment(r),
                                    ),
                                    AppButton(
                                      text: 'Từ chối',
                                      variant: AppButtonVariant.danger,
                                      size: AppButtonSize.xs,
                                      icon: const Icon(LucideIcons.xCircle, size: 14),
                                      onPressed: () {
                                        setState(() {
                                          _rejectReservation = r;
                                          _rejectReasonController.clear();
                                          _rejectModalOpen = true;
                                        });
                                      },
                                    ),
                                  ],
                                ],
                              ),
                            ],
                          ),
                        );
                      }).toList(),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],

          // Filter & Legend Card
          AppCard(
            padding: const EdgeInsets.all(12),
            child: Wrap(
              alignment: WrapAlignment.spaceBetween,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 8,
              runSpacing: 8,
              children: [
                Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    FilterChip(
                      label: const Text('Tất cả trạng thái'),
                      selected: _statusFilter == 'ALL',
                      onSelected: (_) => setState(() => _statusFilter = 'ALL'),
                    ),
                    ...['AVAILABLE', 'OCCUPIED', 'RESERVED', 'MAINTENANCE', 'INACTIVE'].map((st) {
                      final style = getApartmentStatusStyle(st);
                      final label = st == 'INACTIVE' ? 'Tạm khóa / Ngưng' : style.label;
                      return FilterChip(
                        avatar: Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(color: style.dotColor, shape: BoxShape.circle),
                        ),
                        label: Text(label),
                        selected: _statusFilter == st,
                        onSelected: (_) => setState(() {
                          _statusFilter = _statusFilter == st ? 'ALL' : st;
                        }),
                      );
                    }),
                  ],
                ),
                if (_zones.isNotEmpty)
                  SizedBox(
                    width: 220,
                    child: AppSelect<String>(
                      value: _zoneFilter,
                      options: [
                        AppSelectOption(value: 'ALL', label: 'Tất cả phân khu (${_zones.length})'),
                        ..._zones.map((z) => AppSelectOption(
                              value: z['id'].toString(),
                              label: (z['name'] ?? z['code']).toString(),
                            )),
                        const AppSelectOption(value: 'UNASSIGNED', label: 'Chưa gán khu'),
                      ],
                      onChanged: (val) => setState(() => _zoneFilter = val ?? 'ALL'),
                    ),
                  ),
                if (widget.embedded && canEditRealEstate) ...[
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      AppButton(
                        text: 'Tạo hàng loạt',
                        variant: AppButtonVariant.outline,
                        size: AppButtonSize.xs,
                        icon: const Icon(LucideIcons.copyPlus, size: 14),
                        onPressed: () => setState(() => _bulkModalOpen = true),
                      ),
                      const SizedBox(width: 6),
                      AppButton(
                        text: 'Thêm tầng',
                        variant: AppButtonVariant.outline,
                        size: AppButtonSize.xs,
                        icon: const Icon(LucideIcons.layers, size: 14),
                        onPressed: () => setState(() {
                          _floorModalMode = 'bulk';
                          _floorModalOpen = true;
                        }),
                      ),
                      const SizedBox(width: 6),
                      AppButton(
                        text: 'Thêm căn hộ',
                        size: AppButtonSize.xs,
                        icon: const Icon(LucideIcons.plus, size: 14),
                        onPressed: () => setState(() {
                          _aptFloorId = _floorMap.isNotEmpty ? _floorMap[0]['id'].toString() : '';
                          _aptCodeController.clear();
                          _aptModalOpen = true;
                        }),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),

          // Floor rows
          if (_floorMap.isEmpty)
            AppCard(
              padding: const EdgeInsets.all(32),
              child: EmptyState(
                icon: LucideIcons.doorOpen,
                title: 'Chưa có dữ liệu tầng',
                description: 'Hãy khởi tạo các tầng và căn hộ cho tòa nhà này.',
                action: canEditRealEstate
                    ? Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          AppButton(
                            text: 'Thêm tầng hàng loạt',
                            icon: const Icon(LucideIcons.layers, size: 14),
                            onPressed: () => setState(() {
                              _floorModalMode = 'bulk';
                              _floorModalOpen = true;
                            }),
                          ),
                          const SizedBox(width: 8),
                          AppButton(
                            text: 'Thêm từng tầng',
                            variant: AppButtonVariant.outline,
                            icon: const Icon(LucideIcons.plus, size: 14),
                            onPressed: () => setState(() {
                              _floorModalMode = 'single';
                              _floorModalOpen = true;
                            }),
                          ),
                        ],
                      )
                    : null,
              ),
            )
          else
            ..._floorMap.map((floor) {
              final rawApts = (floor['apartments'] is List)
                  ? (floor['apartments'] as List)
                  : const [];
              final apts = rawApts.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).where((a) {
                final status = a['status']?.toString() ?? 'AVAILABLE';
                final matchStatus = _statusFilter == 'ALL'
                    ? true
                    : _statusFilter == 'INACTIVE'
                        ? (status == 'INACTIVE' || status == 'BLOCKED')
                        : status == _statusFilter;
                final zId = a['zone_id']?.toString() ?? '';
                final matchZone = _zoneFilter == 'ALL'
                    ? true
                    : _zoneFilter == 'UNASSIGNED'
                        ? zId.isEmpty
                        : zId == _zoneFilter;
                return matchStatus && matchZone;
              }).toList();

              return Container(
                margin: const EdgeInsets.only(bottom: 12),
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: AppColors.slate200),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      width: 140,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            (floor['name'] ?? 'Tầng ${floor['level']}').toString(),
                            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 14),
                          ),
                          Text('${rawApts.length} căn hộ',
                              style: const TextStyle(fontSize: 12, color: AppColors.slate400)),
                          if (canManageBuildings) ...[
                            const SizedBox(height: 8),
                            AppButton(
                              text: 'Xóa tầng',
                              size: AppButtonSize.xs,
                              variant: AppButtonVariant.ghost,
                              icon: const Icon(LucideIcons.trash2, size: 14),
                              disabled: rawApts.isNotEmpty,
                              onPressed: rawApts.isNotEmpty
                                  ? null
                                  : () => setState(() => _deleteFloorTarget = floor),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 16),
                    Expanded(
                      child: apts.isEmpty
                          ? const Padding(
                              padding: EdgeInsets.symmetric(vertical: 8.0),
                              child: Text('Không có căn hộ khớp bộ lọc ở tầng này.',
                                  style: TextStyle(fontSize: 12, color: AppColors.slate400)),
                            )
                          : Wrap(
                              spacing: 10,
                              runSpacing: 10,
                              children: apts.map((apt) {
                                final st = getApartmentStatusStyle(apt['status']?.toString());
                                final pendingForApt = _pendingConfirms
                                    .where((p) => p['apartment_id'] == apt['id'])
                                    .length;
                                return InkWell(
                                  borderRadius: BorderRadius.circular(12),
                                  onTap: () => _handleOpenAptDrawer(apt),
                                  child: Container(
                                    width: 130,
                                    padding: const EdgeInsets.all(10),
                                    decoration: BoxDecoration(
                                      color: st.bgColor,
                                      borderRadius: BorderRadius.circular(12),
                                      border: Border.all(color: st.borderColor),
                                    ),
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Row(
                                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                          children: [
                                            Text(apt['code']?.toString() ?? '',
                                                style: TextStyle(
                                                    fontWeight: FontWeight.bold,
                                                    fontSize: 13,
                                                    color: st.textColor)),
                                            Container(
                                              width: 8,
                                              height: 8,
                                              decoration: BoxDecoration(
                                                color: st.dotColor,
                                                shape: BoxShape.circle,
                                              ),
                                            ),
                                          ],
                                        ),
                                        const SizedBox(height: 4),
                                        Text(
                                          '${apt['type'] ?? '1PN'} · ${apt['area_m2'] ?? 0}m²${apt['zone_code'] != null ? ' · ${apt['zone_code']}' : ''}',
                                          style: TextStyle(fontSize: 11, color: st.textColor.withValues(alpha: 0.8)),
                                        ),
                                        const SizedBox(height: 2),
                                        Text(
                                          formatMoney(apt['base_rent']),
                                          style: TextStyle(
                                              fontSize: 11,
                                              fontWeight: FontWeight.bold,
                                              color: st.textColor),
                                        ),
                                        if (pendingForApt > 0) ...[
                                          const SizedBox(height: 4),
                                          Container(
                                            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                                            decoration: BoxDecoration(
                                              color: const Color(0xFFFEF3C7),
                                              borderRadius: BorderRadius.circular(4),
                                            ),
                                            child: Text(
                                              '$pendingForApt chờ sao kê',
                                              style: const TextStyle(
                                                  fontSize: 10,
                                                  fontWeight: FontWeight.bold,
                                                  color: AppColors.amber900),
                                            ),
                                          ),
                                        ],
                                      ],
                                    ),
                                  ),
                                );
                              }).toList(),
                            ),
                    ),
                  ],
                ),
              );
            }),
        ],
      ),
    ),

    if (hasOverlayModal)
      Positioned.fill(
        child: Container(
          color: AppColors.slate900.withValues(alpha: 0.45),
          alignment: Alignment.center,
          child: SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 672),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Modal for Apartment Detail
                  if (_selectedApt != null && !_resModalOpen)
            AppModal(
              onClose: () => setState(() => _selectedApt = null),
              title: 'Căn hộ ${_selectedApt!['code']}',
              subtitle: '${_building?['code'] ?? ''} — ${_building?['name'] ?? ''}',
              size: AppModalSize.md,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: AppColors.slate50,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.slate200),
                    ),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('Trạng thái hiện tại',
                                style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                            const SizedBox(height: 4),
                            StatusBadge(
                              status: (_aptDetail ?? _selectedApt)?['status']?.toString(),
                              domain: StatusDomain.apartment,
                            ),
                          ],
                        ),
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            const Text('Giá thuê niêm yết',
                                style: TextStyle(fontSize: 11, color: AppColors.slate500)),
                            const SizedBox(height: 4),
                            Text(
                              '${formatMoney((_aptDetail ?? _selectedApt)?['base_rent'])}/tháng',
                              style: const TextStyle(
                                  fontWeight: FontWeight.bold,
                                  color: AppColors.primary700,
                                  fontSize: 14),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 12),
                  if (_detailLoading)
                    const Padding(
                      padding: EdgeInsets.all(16.0),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  else ...[
                    // Contracts & Reservations summary
                    if (contractsList.isNotEmpty) ...[
                      const Text('Hợp đồng gần nhất',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12)),
                      const SizedBox(height: 6),
                      ...contractsList.take(2).map((c) => Container(
                            margin: const EdgeInsets.only(bottom: 6),
                            padding: const EdgeInsets.all(8),
                            decoration: BoxDecoration(
                              color: AppColors.slate50,
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: AppColors.slate200),
                            ),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Text('${c['tenant_name'] ?? 'Cư dân'} (${c['tenant_phone'] ?? ''})',
                                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500)),
                                StatusBadge(status: c['status']?.toString(), domain: StatusDomain.contract),
                              ],
                            ),
                          )),
                      const SizedBox(height: 10),
                    ],
                    if (reservationsList.isNotEmpty) ...[
                      const Text('Đang giữ chỗ',
                          style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: AppColors.amber900)),
                      const SizedBox(height: 6),
                      ...reservationsList.map((r) => Container(
                            margin: const EdgeInsets.only(bottom: 6),
                            padding: const EdgeInsets.all(8),
                            decoration: BoxDecoration(
                              color: const Color(0xFFFFFBEB),
                              borderRadius: BorderRadius.circular(8),
                              border: Border.all(color: AppColors.amber200),
                            ),
                            child: Row(
                              mainAxisAlignment: MainAxisAlignment.spaceBetween,
                              children: [
                                Text('${r['prospect_name']} (${r['phone']})',
                                    style: const TextStyle(fontSize: 12)),
                                Text(formatMoney(r['hold_amount']),
                                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
                              ],
                            ),
                          )),
                      const SizedBox(height: 10),
                    ],
                  ],

                  // Quick action buttons
                  const Divider(),
                  const Text('Thao tác nhanh',
                      style: TextStyle(fontWeight: FontWeight.bold, fontSize: 12, color: AppColors.slate700)),
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      if (isManager &&
                          ['AVAILABLE', 'RESERVED', 'OCCUPIED']
                              .contains(_selectedApt?['status'])) ...[
                        AppButton(
                          text: 'Đặt cọc giữ chỗ',
                          variant: AppButtonVariant.warning,
                          size: AppButtonSize.sm,
                          icon: const Icon(LucideIcons.bookmarkPlus, size: 14),
                          onPressed: () {
                            final startStr = earliestResStart.isNotEmpty ? earliestResStart : todayStr;
                            final untilStr = computeSuggestedHoldUntil(
                              startStr,
                              resBusyIntervals,
                              maxHoldDays: maxInternalHoldDays,
                            );
                            _resProspectNameController.clear();
                            _resPhoneController.clear();
                            _resHoldAmountController.text =
                                (_cancelPolicy['default_hold_amount'] ?? 2000000).toString();
                            _resHoldFromController.text = startStr;
                            _resHoldUntilController.text = untilStr;
                            _resNoteController.clear();
                            setState(() => _resModalOpen = true);
                          },
                        ),
                        AppButton(
                          text: 'Tạo hợp đồng thuê',
                          size: AppButtonSize.sm,
                          icon: const Icon(LucideIcons.plus, size: 14),
                          onPressed: () {
                            context.push('/admin/contracts?apartment_id=${_selectedApt!['id']}');
                          },
                        ),
                      ],
                      if (canEditRealEstate && _selectedApt?['status'] == 'MAINTENANCE')
                        AppButton(
                          text: 'Nghiệm thu & Bàn giao',
                          variant: AppButtonVariant.success,
                          size: AppButtonSize.sm,
                          icon: const Icon(LucideIcons.checkCircle2, size: 14),
                          onPressed: () {
                            context.push('/admin/apartments/${_selectedApt!['id']}');
                          },
                        ),
                      if (canEditRealEstate &&
                          ['AVAILABLE', 'OCCUPIED'].contains(_selectedApt?['status']))
                        AppButton(
                          text: 'Chuyển sang Bảo trì',
                          variant: AppButtonVariant.outline,
                          size: AppButtonSize.sm,
                          icon: const Icon(LucideIcons.wrench, size: 14),
                          loading: _submitting,
                          onPressed: () async {
                            final aptId = _selectedApt!['id'].toString();
                            setState(() => _submitting = true);
                            try {
                              final service = ref.read(buildingsServiceProvider);
                              await service.updateApartment(aptId, {'status': 'MAINTENANCE'});
                              ref.read(toastProvider.notifier).success('Đã chuyển trạng thái sang Đang bảo trì.');
                              setState(() => _selectedApt = null);
                              _fetchFloorPlan(force: true);
                            } catch (err) {
                              ref.read(toastProvider.notifier).error(extractErrorMessage(err));
                            } finally {
                              if (mounted) setState(() => _submitting = false);
                            }
                          },
                        ),
                    ],
                  ),
                ],
              ),
            ),

          // Reservation Modal
          if (_resModalOpen)
            AppModal(
              onClose: () => setState(() => _resModalOpen = false),
              title: 'Đặt cọc giữ chỗ — Căn ${_selectedApt?['code'] ?? ''}',
              subtitle: 'Giữ chỗ nội bộ tối đa $maxInternalHoldDays ngày theo chính sách FR-067',
              size: AppModalSize.md,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: AppInput(
                          label: 'Họ tên khách đặt giữ chỗ',
                          required: true,
                          controller: _resProspectNameController,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppInput(
                          label: 'Số điện thoại',
                          required: true,
                          controller: _resPhoneController,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: AppInput(
                          label: 'Tiền cọc giữ chỗ (VND)',
                          required: true,
                          controller: _resHoldAmountController,
                          keyboardType: TextInputType.number,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppSelect<String>(
                          label: 'Phương thức thu tiền',
                          value: _resMethod,
                          options: const [
                            AppSelectOption(value: 'BANK_TRANSFER', label: 'Chuyển khoản'),
                            AppSelectOption(value: 'CASH', label: 'Tiền mặt'),
                          ],
                          onChanged: (v) => setState(() => _resMethod = v ?? 'BANK_TRANSFER'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  if (earliestResStart.isNotEmpty && earliestResStart.compareTo(todayStr) > 0)
                    Container(
                      padding: const EdgeInsets.all(10),
                      margin: const EdgeInsets.only(bottom: 12),
                      decoration: BoxDecoration(
                        color: const Color(0xFFFFFBEB),
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AppColors.amber200),
                      ),
                      child: Text(
                        'Căn hộ đang có lịch thuê/giữ chỗ nên hệ thống đã tự gợi ý ngày trống gần nhất từ ${formatDate(earliestResStart)}.',
                        style: const TextStyle(color: AppColors.amber900, fontSize: 12),
                      ),
                    ),
                  Row(
                    children: [
                      Expanded(
                        child: AppInput(
                          label: 'Giữ chỗ từ ngày',
                          required: true,
                          controller: _resHoldFromController,
                          placeholder: 'YYYY-MM-DD',
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppInput(
                          label: 'Đến hết ngày',
                          required: true,
                          controller: _resHoldUntilController,
                          placeholder: 'YYYY-MM-DD',
                          onChanged: (_) => setState(() {}),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Ghi chú',
                    controller: _resNoteController,
                    multiline: true,
                    rows: 2,
                  ),
                  const SizedBox(height: 20),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      AppButton(
                        text: 'Hủy',
                        variant: AppButtonVariant.outline,
                        onPressed: () => setState(() => _resModalOpen = false),
                      ),
                      const SizedBox(width: 8),
                      AppButton(
                        text: 'Xác nhận giữ chỗ',
                        loading: _submitting,
                        onPressed: _handleCreateReservation,
                      ),
                    ],
                  ),
                ],
              ),
            ),

          // Reject Payment Modal
          if (_rejectModalOpen)
            AppModal(
              onClose: () => setState(() => _rejectModalOpen = false),
              title: 'Từ chối xác nhận biên lai giữ chỗ',
              subtitle: 'Khách: ${_rejectReservation?['prospect_name'] ?? ''}',
              size: AppModalSize.sm,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AppInput(
                    label: 'Lý do từ chối biên lai (bắt buộc)',
                    required: true,
                    controller: _rejectReasonController,
                    multiline: true,
                    rows: 3,
                    placeholder: 'VD: Sao kê ngân hàng chưa ghi nhận hoặc biên lai không hợp lệ...',
                  ),
                  const SizedBox(height: 16),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      AppButton(
                        text: 'Hủy',
                        variant: AppButtonVariant.outline,
                        onPressed: () => setState(() => _rejectModalOpen = false),
                      ),
                      const SizedBox(width: 8),
                      AppButton(
                        text: 'Xác nhận từ chối',
                        variant: AppButtonVariant.danger,
                        loading: _submitting,
                        onPressed: _handleRejectPayment,
                      ),
                    ],
                  ),
                ],
              ),
            ),

          // Add Apartment Modal
          if (_aptModalOpen)
            AppModal(
              onClose: () => setState(() => _aptModalOpen = false),
              title: 'Thêm căn hộ mới',
              size: AppModalSize.md,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: AppSelect<String>(
                          label: 'Chọn tầng',
                          value: _aptFloorId,
                          options: _floorMap
                              .map((f) => AppSelectOption(
                                    value: f['id'].toString(),
                                    label: (f['name'] ?? 'Tầng ${f['level']}').toString(),
                                  ))
                              .toList(),
                          onChanged: (v) => setState(() => _aptFloorId = v ?? ''),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppInput(
                          label: 'Mã căn hộ',
                          required: true,
                          controller: _aptCodeController,
                          placeholder: 'VD: A1101',
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Row(
                    children: [
                      Expanded(
                        child: AppSelect<String>(
                          label: 'Loại căn',
                          value: _aptType,
                          options: kApartmentTypes
                              .map((t) => AppSelectOption(value: t, label: t))
                              .toList(),
                          onChanged: (v) => setState(() => _aptType = v ?? '1PN'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppInput(
                          label: 'Số phòng ngủ',
                          keyboardType: TextInputType.number,
                          controller: TextEditingController(text: _aptBedrooms.toString()),
                          onChanged: (v) => _aptBedrooms = int.tryParse(v) ?? 1,
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: AppInput(
                          label: 'Diện tích (m²)',
                          keyboardType: TextInputType.number,
                          controller: TextEditingController(text: _aptAreaM2.toString()),
                          onChanged: (v) => _aptAreaM2 = double.tryParse(v) ?? 45,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  AppInput(
                    label: 'Giá thuê niêm yết (VND/tháng)',
                    required: true,
                    keyboardType: TextInputType.number,
                    controller: TextEditingController(text: _aptBaseRent.toString()),
                    onChanged: (v) => _aptBaseRent = int.tryParse(v) ?? 8500000,
                  ),
                  const SizedBox(height: 20),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      AppButton(
                        text: 'Hủy',
                        variant: AppButtonVariant.outline,
                        onPressed: () => setState(() => _aptModalOpen = false),
                      ),
                      const SizedBox(width: 8),
                      AppButton(
                        text: 'Tạo căn hộ',
                        loading: _submitting,
                        onPressed: _handleCreateApartment,
                      ),
                    ],
                  ),
                ],
              ),
            ),

          // Floor Modal
          FloorModal(
            open: _floorModalOpen,
            onClose: () => setState(() => _floorModalOpen = false),
            buildingId: widget.buildingId,
            existingFloors: _floorMap,
            initialMode: _floorModalMode,
            onCreated: (_) {
              _fetchFloorPlan(force: true);
              widget.onFloorsChanged?.call();
            },
          ),

          // Bulk Apartment Modal
          BulkApartmentModal(
            open: _bulkModalOpen,
            onClose: () => setState(() => _bulkModalOpen = false),
            buildingId: widget.buildingId,
            floors: _floorMap,
            zones: _zones,
            onCreated: (_) => _fetchFloorPlan(force: true),
          ),

          // Delete Floor Confirm Dialog
          if (_deleteFloorTarget != null)
            ConfirmDialog(
              onClose: () => setState(() => _deleteFloorTarget = null),
              onConfirm: _handleConfirmDeleteFloor,
              loading: _deletingFloor,
              variant: ConfirmDialogVariant.danger,
              title: 'Xác nhận xóa tầng',
              confirmLabel: 'Xóa tầng',
              message:
                  'Bạn có chắc chắn muốn xóa vĩnh viễn "${_deleteFloorTarget!['name'] ?? 'Tầng ${_deleteFloorTarget!['level']}'}"?',
            ),
                ],
              ),
            ),
          ),
        ),
      ),
    ],
  );
}
}
