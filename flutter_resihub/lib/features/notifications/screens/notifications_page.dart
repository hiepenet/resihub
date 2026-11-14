import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/constants/statuses.dart';
import '../../../core/storage/app_storage.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../core/utils/notification_navigation.dart';
import '../../../core/utils/validation.dart';
import '../../../core/utils/zalo_format.dart';
import '../../../shared/providers/notification_provider.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/common/confirm_dialog.dart';
import '../../../shared/widgets/common/empty_state.dart';
import '../../../shared/widgets/common/notification_detail_modal.dart';
import '../../../shared/widgets/common/page_header.dart';
import '../../../shared/widgets/common/search_bar_widget.dart';
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
import '../services/announcements_service.dart';
import '../services/notifications_service.dart';

const Map<String, (String label, String variant)> _kNotificationTypeInfo = {
  'ANNOUNCEMENT': ('Thông báo chung BQL', 'sky'),
  'UTILITY_INTERRUPTION': ('Cắt điện / nước tạm thời', 'amber'),
  'MAINTENANCE_NOTICE': ('Lịch bảo trì / Kỹ thuật', 'amber'),
  'HOUSE_RULES': ('Nhắc nhở nội quy', 'indigo'),
  'SECURITY_ALERT': ('Cảnh báo An ninh / PCCC', 'red'),
  'SYSTEM': ('Thông báo hệ thống', 'slate'),
  'PAYMENT_REMINDER': ('Nhắc thanh toán phí', 'indigo'),
  'INVOICE_ISSUED': ('Phát hành hóa đơn', 'emerald'),
  'PAYMENT_CONFIRMED': ('Xác nhận thanh toán', 'emerald'),
  'PAYMENT_REJECTED': ('Từ chối chứng từ', 'red'),
  'MAINTENANCE_UPDATE': ('Cập nhật báo hỏng', 'amber'),
  'SERVICE_REQUEST_CREATED': ('Báo hỏng mới', 'sky'),
  'SERVICE_REQUEST_URGENT': ('Báo hỏng KHẨN CẤP', 'red'),
  'SERVICE_REQUEST_REOPENED': ('Mở lại báo hỏng', 'red'),
  'SERVICE_REQUEST_ESCALATED': ('Quá hạn SLA kỹ thuật', 'red'),
  'SERVICE_REQUEST_SLA_BREACH': ('Quá hạn SLA kỹ thuật', 'red'),
  'SERVICE_UPDATE': ('Cập nhật dịch vụ', 'purple'),
  'SERVICE_TERMINATED': ('Chấm dứt dịch vụ', 'slate'),
  'SERVICE_SUBSCRIPTION_REQUESTED': ('Đăng ký dịch vụ mới', 'sky'),
  'SERVICE_CANCELLATION_REQUESTED': ('Yêu cầu hủy dịch vụ', 'amber'),
  'PAYMENT_REPORTED': ('Cư dân báo đã thanh toán', 'emerald'),
  'CONTRACT_REQUEST_SUBMITTED': ('Đề nghị gia hạn / chấm dứt HĐ', 'indigo'),
  'PENDING_CREDIT_REFUND': ('Chờ duyệt hoàn tín dụng (4 mắt)', 'amber'),
  'CREDIT_REFUND_PENDING': ('Chờ hoàn tiền tín dụng', 'amber'),
  'CREDIT_REFUNDED': ('Đã hoàn tiền tín dụng', 'emerald'),
  'CREDIT_REFUND_REJECTED': ('Từ chối hoàn tín dụng', 'red'),
  'INVOICE_ADJUSTMENT_PENDING': ('Chờ duyệt điều chỉnh HĐ (4 mắt)', 'amber'),
  'INVOICE_ADJUSTED': ('Hóa đơn đã điều chỉnh', 'purple'),
  'AI_BUDGET_WARNING': ('Cảnh báo ngân sách AI', 'amber'),
  'AI_BUDGET_EXCEEDED': ('Chạm trần ngân sách AI', 'red'),
  'CRON_JOB_FAILED': ('Lỗi tiến trình nền', 'red'),
};

const Map<String, (String label, String variant)> _kScopeLabels = {
  'ALL': ('Toàn hệ thống', 'indigo'),
  'BUILDING': ('Toàn Tòa nhà', 'sky'),
  'FLOOR': ('Theo Tầng', 'amber'),
  'APARTMENT': ('Theo Phòng', 'purple'),
};

const List<AppSelectOption<String>> _kScopeOptions = [
  AppSelectOption(value: 'BUILDING', label: '🏢 Toàn tòa nhà (BUILDING)'),
  AppSelectOption(value: 'FLOOR', label: '📑 Theo Tầng cụ thể (FLOOR)'),
  AppSelectOption(value: 'APARTMENT', label: '🚪 Từng Phòng / Căn hộ (APARTMENT)'),
];

const List<AppSelectOption<String>> _kComposeTypeOptions = [
  AppSelectOption(value: 'ANNOUNCEMENT', label: 'Thông báo chung Ban quản lý'),
  AppSelectOption(value: 'UTILITY_INTERRUPTION', label: 'Tạm ngừng cấp điện / nước'),
  AppSelectOption(value: 'MAINTENANCE_NOTICE', label: 'Lịch bảo trì thang máy / PCCC / Kỹ thuật'),
  AppSelectOption(value: 'HOUSE_RULES', label: 'Nhắc nhở nội quy khu vực chung'),
  AppSelectOption(value: 'SECURITY_ALERT', label: 'Cảnh báo An ninh / PCCC khẩn'),
];

/// Admin notifications, resident announcements, and Zalo group integration center.
/// Port of `frontend/src/pages/admin/notifications/NotificationsPage.jsx`.
class NotificationsPage extends ConsumerStatefulWidget {
  final String? initialTab;

  const NotificationsPage({
    super.key,
    this.initialTab,
  });

  @override
  ConsumerState<NotificationsPage> createState() => _NotificationsPageState();
}

class _NotificationsPageState extends ConsumerState<NotificationsPage> {
  late String _activeTab;

  // Main data collections
  List<Map<String, dynamic>> _announcements = [];
  List<Map<String, dynamic>> _zaloGroups = [];
  List<Map<String, dynamic>> _inbox = [];
  int _unreadCount = 0;
  bool _loading = true;

  // Filters
  String _search = '';
  String _annStatusFilter = '';
  String _annScopeFilter = '';
  bool _unreadOnly = false;
  String _zaloScopeFilter = '';
  bool _includeInactiveGroups = false;

  // Location lookups
  List<Map<String, dynamic>> _buildings = [];
  List<Map<String, dynamic>> _floors = [];
  List<Map<String, dynamic>> _apartments = [];

  // Compose Form (MANAGER only)
  String? _editingAnnId;
  String _savingAction = ''; // 'draft' | 'schedule' | 'send' | ''
  bool _zaloManuallyEdited = false;
  String _formTargetScope = 'BUILDING';
  String _formBuildingId = '';
  String _formFloorId = '';
  String _formApartmentId = '';
  String _formType = 'ANNOUNCEMENT';

  late final TextEditingController _titleController;
  late final TextEditingController _bodyController;
  late final TextEditingController _zaloContentController;
  late final TextEditingController _scheduledAtController;

  // Modals
  Map<String, dynamic>? _confirmSendModal; // {'mode': 'compose' | 'existing', 'announcement': ...}
  Map<String, dynamic>? _zaloCopyModal;
  List<String> _checkedZaloGroupIds = [];
  late final TextEditingController _zaloMarkNoteController;
  bool _copiedZaloBody = false;
  bool _markingZalo = false;

  // Zalo Group Create/Edit Modal
  bool _groupModalOpen = false;
  Map<String, dynamic>? _editingGroup;
  List<Map<String, dynamic>> _groupApartments = [];
  bool _groupSubmitting = false;
  String _groupLinkError = '';
  Map<String, dynamic>? _deleteGroupTarget;
  bool _deletingGroup = false;

  String _groupBuildingId = '';
  String _groupScope = 'BUILDING';
  String _groupApartmentId = '';
  late final TextEditingController _groupNameController;
  late final TextEditingController _groupInviteLinkController;
  late final TextEditingController _groupNoteController;
  bool _groupIsActive = true;

  @override
  void initState() {
    super.initState();
    final tab = widget.initialTab;
    if (tab != null && ['announcements', 'zalo_groups', 'inbox'].contains(tab)) {
      _activeTab = tab;
    } else {
      _activeTab = 'announcements';
    }

    _titleController = TextEditingController();
    _bodyController = TextEditingController();
    _zaloContentController = TextEditingController();
    _scheduledAtController = TextEditingController();
    _zaloMarkNoteController = TextEditingController();

    _groupNameController = TextEditingController();
    _groupInviteLinkController = TextEditingController();
    _groupNoteController = TextEditingController();

    _loadBuildings();
    _fetchAllData();
  }

  @override
  void dispose() {
    _titleController.dispose();
    _bodyController.dispose();
    _zaloContentController.dispose();
    _scheduledAtController.dispose();
    _zaloMarkNoteController.dispose();
    _groupNameController.dispose();
    _groupInviteLinkController.dispose();
    _groupNoteController.dispose();
    super.dispose();
  }

  Future<void> _loadBuildings() async {
    try {
      final res = await ref.read(buildingsServiceProvider).list();
      final list = _extractList(res);
      if (mounted) {
        setState(() {
          _buildings = list;
          final selectedBuildingId = ref.read(authProvider).selectedBuildingId;
          if (_formBuildingId.isEmpty) {
            _formBuildingId = selectedBuildingId.isNotEmpty
                ? selectedBuildingId
                : (list.isNotEmpty ? list[0]['id']?.toString() ?? '' : '');
          }
          if (_groupBuildingId.isEmpty) {
            _groupBuildingId = _formBuildingId;
          }
        });
      }
    } catch (_) {}
  }

  List<Map<String, dynamic>> _extractList(dynamic res) {
    if (res is Map && res['data'] is List) {
      return (res['data'] as List)
          .whereType<Map>()
          .map((m) => Map<String, dynamic>.from(m))
          .toList();
    }
    if (res is List) {
      return res.whereType<Map>().map((m) => Map<String, dynamic>.from(m)).toList();
    }
    return [];
  }

  Future<void> _fetchAllData() async {
    setState(() => _loading = true);
    try {
      final selectedBuildingId = ref.read(authProvider).selectedBuildingId;
      final annService = ref.read(announcementsServiceProvider);
      final notifService = ref.read(notificationsServiceProvider);

      final notifFuture = notifService.list();
      final annFuture = annService.listAnnouncements({
        if (selectedBuildingId.isNotEmpty) 'building_id': selectedBuildingId,
        if (_annStatusFilter.isNotEmpty) 'status': _annStatusFilter,
        if (_annScopeFilter.isNotEmpty) 'target_scope': _annScopeFilter,
      });
      final zgFuture = annService.listZaloGroups({
        if (selectedBuildingId.isNotEmpty) 'building_id': selectedBuildingId,
        if (_zaloScopeFilter.isNotEmpty) 'scope': _zaloScopeFilter,
        if (_includeInactiveGroups) 'include_inactive': 'true',
      });

      final results = await Future.wait([notifFuture, annFuture, zgFuture]);
      final notifRes = results[0];
      final annRes = results[1];
      final zgRes = results[2];

      final currentUserId = ref.read(authProvider).user?.id;
      final storage = ref.read(appStorageProvider);

      final rawInbox = _extractList(notifRes);
      final serverUnread = notifRes is Map ? notifRes['unread_count'] : null;
      final merged = mergeOrgNotificationReadState(
        rawInbox,
        currentUserId,
        storage: storage,
        serverUnreadCount: serverUnread,
      );

      if (mounted) {
        setState(() {
          _inbox = merged.notifications;
          _unreadCount = merged.unreadCount;
          _announcements = _extractList(annRes);
          _zaloGroups = _extractList(zgRes);
        });
      }
      ref.read(notificationProvider.notifier).fetchNotifications();
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể tải dữ liệu thông báo & nhóm Zalo.'),
          );
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _updateAutoZaloPreview() {
    if (_zaloManuallyEdited) return;

    final selectedBuilding = _buildings.firstWhere(
      (b) => b['id']?.toString() == _formBuildingId,
      orElse: () => const {},
    );
    final selectedFloor = _floors.firstWhere(
      (f) => f['id']?.toString() == _formFloorId,
      orElse: () => const {},
    );
    final selectedApartment = _apartments.firstWhere(
      (a) => a['id']?.toString() == _formApartmentId,
      orElse: () => const {},
    );

    final autoPreview = buildZaloPreviewText(
      type: _formType,
      title: _titleController.text,
      body: _bodyController.text,
      targetScope: _formTargetScope,
      buildingCode: selectedBuilding['code']?.toString() ?? '',
      buildingName: selectedBuilding['name']?.toString() ?? '',
      floorName: selectedFloor['name']?.toString() ?? '',
      apartmentCode: selectedApartment['code']?.toString() ?? '',
      scheduledOrSentAt: _scheduledAtController.text.isNotEmpty
          ? DateTime.tryParse(_scheduledAtController.text)
          : null,
    );

    _zaloContentController.text = autoPreview;
  }

  Future<void> _loadFloors(String buildingId) async {
    if (buildingId.isEmpty) {
      setState(() => _floors = []);
      return;
    }
    try {
      final res = await ref.read(buildingsServiceProvider).listFloors(buildingId);
      if (mounted) setState(() => _floors = _extractList(res));
    } catch (_) {
      if (mounted) setState(() => _floors = []);
    }
  }

  Future<void> _loadApartments(String buildingId) async {
    if (buildingId.isEmpty) {
      setState(() => _apartments = []);
      return;
    }
    try {
      final res = await ref
          .read(buildingsServiceProvider)
          .listApartments({'building_id': buildingId});
      if (mounted) setState(() => _apartments = _extractList(res));
    } catch (_) {
      if (mounted) setState(() => _apartments = []);
    }
  }

  Future<void> _loadGroupApartments(String buildingId) async {
    if (buildingId.isEmpty) {
      setState(() => _groupApartments = []);
      return;
    }
    try {
      final res = await ref
          .read(buildingsServiceProvider)
          .listApartments({'building_id': buildingId});
      if (mounted) setState(() => _groupApartments = _extractList(res));
    } catch (_) {
      if (mounted) setState(() => _groupApartments = []);
    }
  }

  void _applyQuickTemplate(ZaloQuickTemplate tpl) {
    setState(() {
      _zaloManuallyEdited = false;
      _formType = tpl.type;
      _titleController.text = tpl.defaultTitle;
      _bodyController.text = tpl.bodyTemplate;
    });
    _updateAutoZaloPreview();
  }

  void _resetComposeForm() {
    setState(() {
      _editingAnnId = null;
      _zaloManuallyEdited = false;
      _formTargetScope = 'BUILDING';
      _formFloorId = '';
      _formApartmentId = '';
      _formType = 'ANNOUNCEMENT';
      _titleController.clear();
      _bodyController.clear();
      _zaloContentController.clear();
      _scheduledAtController.clear();
    });
  }

  bool _validateComposeFields() {
    if (_formBuildingId.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn tòa nhà áp dụng thông báo.');
      return false;
    }
    if (_formTargetScope == 'FLOOR' && _formFloorId.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn tầng nhận thông báo.');
      return false;
    }
    if (_formTargetScope == 'APARTMENT' && _formApartmentId.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn căn hộ nhận thông báo.');
      return false;
    }
    if (_titleController.text.trim().isEmpty || _bodyController.text.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng nhập đầy đủ tiêu đề và nội dung bản tin.');
      return false;
    }
    return true;
  }

  Map<String, dynamic> _buildAnnouncementPayload({String? scheduledIso}) {
    final zaloContent = _zaloContentController.text.trim().isNotEmpty
        ? _zaloContentController.text.trim()
        : null;

    return {
      'building_id': _formBuildingId,
      'target_scope': _formTargetScope,
      'floor_id': _formTargetScope == 'FLOOR' ? _formFloorId : null,
      'apartment_id': _formTargetScope == 'APARTMENT' ? _formApartmentId : null,
      'type': _formType,
      'title': _titleController.text.trim(),
      'body': _bodyController.text.trim(),
      'zalo_content': zaloContent,
      'scheduled_at': scheduledIso,
    };
  }

  Future<void> _handleSaveDraft() async {
    if (!_validateComposeFields()) return;
    setState(() => _savingAction = 'draft');
    try {
      final payload = _buildAnnouncementPayload();
      final service = ref.read(announcementsServiceProvider);
      if (_editingAnnId != null) {
        await service.updateAnnouncement(_editingAnnId!, {
          ...payload,
          'status': 'DRAFT',
        });
        ref.read(toastProvider.notifier).success('Đã cập nhật bản nháp thông báo.');
      } else {
        await service.createAnnouncement(payload);
        ref.read(toastProvider.notifier).success('Đã lưu bản nháp thông báo.');
      }
      _resetComposeForm();
      await _fetchAllData();
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể lưu bản nháp thông báo.'),
          );
    } finally {
      if (mounted) setState(() => _savingAction = '');
    }
  }

  Future<void> _handleSaveScheduled() async {
    if (!_validateComposeFields()) return;
    if (_scheduledAtController.text.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn thời điểm hẹn giờ phát hành.');
      return;
    }
    final schedDt = DateTime.tryParse(_scheduledAtController.text);
    if (schedDt == null || schedDt.isBefore(DateTime.now())) {
      ref.read(toastProvider.notifier).warning('Thời điểm hẹn giờ gửi phải nằm trong tương lai.');
      return;
    }

    setState(() => _savingAction = 'schedule');
    try {
      final payload = _buildAnnouncementPayload(scheduledIso: schedDt.toIso8601String());
      final service = ref.read(announcementsServiceProvider);
      if (_editingAnnId != null) {
        await service.updateAnnouncement(_editingAnnId!, {
          ...payload,
          'status': 'SCHEDULED',
        });
        ref.read(toastProvider.notifier).success('Đã cập nhật lịch hẹn giờ phát hành thông báo.');
      } else {
        await service.createAnnouncement(payload);
        ref.read(toastProvider.notifier).success('Đã lên lịch hẹn giờ phát hành thông báo.');
      }
      _resetComposeForm();
      await _fetchAllData();
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể hẹn giờ thông báo.'),
          );
    } finally {
      if (mounted) setState(() => _savingAction = '');
    }
  }

  void _handleRequestImmediateSend() {
    if (!_validateComposeFields()) return;
    setState(() {
      _confirmSendModal = {'mode': 'compose'};
    });
  }

  Future<void> _handleConfirm2StepSend() async {
    if (_confirmSendModal == null) return;
    setState(() => _savingAction = 'send');
    try {
      final mode = _confirmSendModal?['mode']?.toString() ?? 'compose';
      final existingAnn = _confirmSendModal?['announcement'] as Map<String, dynamic>?;
      String? targetId = existingAnn?['id']?.toString() ?? _editingAnnId;

      final service = ref.read(announcementsServiceProvider);

      if (mode == 'compose') {
        final payload = _buildAnnouncementPayload();
        if (targetId != null) {
          await service.updateAnnouncement(targetId, payload);
        } else {
          final createdRes = await service.createAnnouncement(payload);
          if (createdRes is Map && createdRes['data'] is Map) {
            targetId = createdRes['data']['id']?.toString();
          } else if (createdRes is Map) {
            targetId = createdRes['id']?.toString();
          }
        }
      }

      if (targetId != null) {
        final sentRes = await service.sendAnnouncement(targetId, {'confirm_send': true});
        final count = (sentRes is Map && sentRes['data'] is Map)
            ? sentRes['data']['recipient_count'] ?? 0
            : 0;
        ref.read(toastProvider.notifier).success(
              sentRes is Map && sentRes['message'] != null
                  ? sentRes['message'].toString()
                  : 'Đã phát hành thông báo tới $count tài khoản cư dân!',
            );

        setState(() {
          _confirmSendModal = null;
          if (mode == 'compose') {
            _resetComposeForm();
          }
        });
        await _fetchAllData();

        if (sentRes is Map && sentRes['data'] is Map) {
          _openZaloModalForAnnouncement(Map<String, dynamic>.from(sentRes['data'] as Map));
        }
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể phát hành thông báo.'),
          );
    } finally {
      if (mounted) setState(() => _savingAction = '');
    }
  }

  void _handleEditDraftRow(Map<String, dynamic> ann) {
    setState(() {
      _editingAnnId = ann['id']?.toString();
      _zaloManuallyEdited = true;
      _formTargetScope = ann['target_scope']?.toString() ?? 'BUILDING';
      _formBuildingId = ann['building_id']?.toString() ?? '';
      _formFloorId = ann['floor_id']?.toString() ?? '';
      _formApartmentId = ann['apartment_id']?.toString() ?? '';
      _formType = ann['type']?.toString() ?? 'ANNOUNCEMENT';
      _titleController.text = ann['title']?.toString() ?? '';
      _bodyController.text = ann['body']?.toString() ?? '';
      _zaloContentController.text = ann['zalo_content']?.toString() ?? '';
      _scheduledAtController.text = ann['scheduled_at']?.toString() ?? '';
    });
    if (_formTargetScope == 'FLOOR' && _formBuildingId.isNotEmpty) {
      _loadFloors(_formBuildingId);
    }
    if (_formTargetScope == 'APARTMENT' && _formBuildingId.isNotEmpty) {
      _loadApartments(_formBuildingId);
    }
  }

  Future<void> _handleCancelAnnouncement(Map<String, dynamic> ann) async {
    try {
      await ref.read(announcementsServiceProvider).updateAnnouncement(
        ann['id'],
        {'status': 'CANCELLED'},
      );
      ref.read(toastProvider.notifier).success('Đã hủy bản tin thông báo.');
      if (_editingAnnId == ann['id']?.toString()) {
        _resetComposeForm();
      }
      await _fetchAllData();
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể hủy bản tin.'),
          );
    }
  }

  void _openZaloModalForAnnouncement(Map<String, dynamic> ann) {
    setState(() {
      _zaloCopyModal = ann;
      _copiedZaloBody = false;
      _zaloMarkNoteController.clear();

      final existingGroupIds = <String>[];
      if (ann['manual_sent_groups'] is List) {
        for (final g in ann['manual_sent_groups'] as List) {
          if (g is String) existingGroupIds.add(g);
          if (g is Map && g['id'] != null) existingGroupIds.add(g['id'].toString());
        }
      }

      if (existingGroupIds.isNotEmpty) {
        _checkedZaloGroupIds = existingGroupIds;
      } else if (ann['target_zalo_groups'] is List) {
        _checkedZaloGroupIds = (ann['target_zalo_groups'] as List)
            .whereType<Map>()
            .map((g) => g['id']?.toString() ?? '')
            .where((id) => id.isNotEmpty)
            .toList();
      } else {
        _checkedZaloGroupIds = [];
      }
    });
  }

  Future<void> _handleCopyZaloContent(String text) async {
    final ok = await copyZaloRichText(text);
    if (ok) {
      if (mounted) setState(() => _copiedZaloBody = true);
      Future.delayed(const Duration(milliseconds: 2500), () {
        if (mounted) setState(() => _copiedZaloBody = false);
      });
      ref.read(toastProvider.notifier).success(
            'Đã sao chép nội dung chuẩn Zalo (kèm chữ in đậm cho Zalo PC/Web)!',
          );
    } else {
      ref.read(toastProvider.notifier).error(
            'Không thể sao chép tự động, vui lòng bôi đen văn bản để sao chép.',
          );
    }
  }

  Future<void> _handleMarkZaloSentSubmit() async {
    if (_zaloCopyModal == null) return;
    setState(() => _markingZalo = true);
    try {
      final res = await ref.read(announcementsServiceProvider).markZaloSent(
        _zaloCopyModal!['id'],
        {
          'zalo_group_ids': _checkedZaloGroupIds,
          if (_zaloMarkNoteController.text.trim().isNotEmpty)
            'note': _zaloMarkNoteController.text.trim(),
        },
      );
      ref.read(toastProvider.notifier).success(
            res is Map && res['message'] != null
                ? res['message'].toString()
                : 'Đã ghi nhận trạng thái dán thông báo lên nhóm Zalo.',
          );
      if (res is Map && res['data'] is Map) {
        setState(() => _zaloCopyModal = Map<String, dynamic>.from(res['data'] as Map));
      }
      await _fetchAllData();
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể cập nhật trạng thái gửi Zalo.'),
          );
    } finally {
      if (mounted) setState(() => _markingZalo = false);
    }
  }

  // Zalo Group CRUD handlers
  void _openCreateGroupModal() {
    setState(() {
      _editingGroup = null;
      _groupLinkError = '';
      _groupBuildingId = _formBuildingId.isNotEmpty
          ? _formBuildingId
          : (_buildings.isNotEmpty ? _buildings[0]['id']?.toString() ?? '' : '');
      _groupScope = 'BUILDING';
      _groupApartmentId = '';
      _groupNameController.clear();
      _groupInviteLinkController.clear();
      _groupNoteController.clear();
      _groupIsActive = true;
      _groupModalOpen = true;
    });
  }

  void _openEditGroupModal(Map<String, dynamic> grp) {
    setState(() {
      _editingGroup = grp;
      _groupLinkError = '';
      _groupBuildingId = grp['building_id']?.toString() ?? '';
      _groupScope = grp['scope']?.toString() ?? 'BUILDING';
      _groupApartmentId = grp['apartment_id']?.toString() ?? '';
      _groupNameController.text = grp['name']?.toString() ?? '';
      _groupInviteLinkController.text = grp['invite_link']?.toString() ?? '';
      _groupNoteController.text = grp['note']?.toString() ?? '';
      _groupIsActive = grp['is_active'] == true || grp['is_active'] == 1;
      _groupModalOpen = true;
    });
    if (_groupScope == 'APARTMENT' && _groupBuildingId.isNotEmpty) {
      _loadGroupApartments(_groupBuildingId);
    }
  }

  Future<void> _handleSubmitGroup() async {
    if (_groupBuildingId.isEmpty || _groupNameController.text.trim().isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn tòa nhà và nhập tên nhóm Zalo.');
      return;
    }
    if (_groupScope == 'APARTMENT' && _groupApartmentId.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn căn hộ cho nhóm Zalo phạm vi Phòng.');
      return;
    }
    if (_groupInviteLinkController.text.trim().isNotEmpty &&
        !isValidZaloGroupUrl(_groupInviteLinkController.text)) {
      setState(() {
        _groupLinkError =
            'Đường dẫn nhóm Zalo phải bắt đầu bằng https://zalo.me/ hoặc https://chat.zalo.me/';
      });
      return;
    }

    setState(() => _groupSubmitting = true);
    try {
      final payload = {
        'building_id': _groupBuildingId,
        'scope': _groupScope,
        'apartment_id': _groupScope == 'APARTMENT' ? _groupApartmentId : null,
        'name': _groupNameController.text.trim(),
        'invite_link': _groupInviteLinkController.text.trim().isNotEmpty
            ? _groupInviteLinkController.text.trim()
            : null,
        'note': _groupNoteController.text.trim().isNotEmpty
            ? _groupNoteController.text.trim()
            : null,
        'is_active': _groupIsActive,
      };

      final service = ref.read(announcementsServiceProvider);
      if (_editingGroup != null) {
        await service.updateZaloGroup(_editingGroup!['id'], payload);
        ref.read(toastProvider.notifier).success('Đã cập nhật thông tin nhóm Zalo.');
      } else {
        await service.createZaloGroup(payload);
        ref.read(toastProvider.notifier).success('Đã thêm nhóm Zalo vào danh bạ.');
      }
      setState(() => _groupModalOpen = false);
      await _fetchAllData();
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể lưu thông tin nhóm Zalo.'),
          );
    } finally {
      if (mounted) setState(() => _groupSubmitting = false);
    }
  }

  Future<void> _handleConfirmDeleteGroup() async {
    if (_deleteGroupTarget == null) return;
    setState(() => _deletingGroup = true);
    try {
      final res = await ref
          .read(announcementsServiceProvider)
          .deleteZaloGroup(_deleteGroupTarget!['id']);
      ref.read(toastProvider.notifier).success(
            res is Map && res['message'] != null
                ? res['message'].toString()
                : 'Đã xóa nhóm Zalo "${_deleteGroupTarget!['name']}".',
          );
      setState(() => _deleteGroupTarget = null);
      await _fetchAllData();
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể xóa nhóm Zalo.'),
          );
    } finally {
      if (mounted) setState(() => _deletingGroup = false);
    }
  }

  // Inbox mark read
  void _markInboxItemReadLocal(Map<String, dynamic> item) {
    if (item['read_at'] != null && item['read_at'].toString().isNotEmpty) return;
    final nowIso = DateTime.now().toIso8601String();
    setState(() {
      _inbox = _inbox.map((n) {
        if (n['id'] == item['id']) {
          return {...n, 'read_at': nowIso};
        }
        return n;
      }).toList();
      _unreadCount = (_unreadCount - 1).clamp(0, 999999);
    });
    ref.read(notificationProvider.notifier).markAsRead(item['id'], item);
  }

  Future<void> _handleMarkAllRead() async {
    try {
      await ref.read(notificationProvider.notifier).markAllAsRead(_inbox);
      final nowIso = DateTime.now().toIso8601String();
      setState(() {
        _inbox = _inbox.map((n) => {...n, 'read_at': n['read_at'] ?? nowIso}).toList();
        _unreadCount = 0;
      });
      await ref.read(notificationProvider.notifier).fetchNotifications();
      ref.read(toastProvider.notifier).success('Đã đánh dấu đọc tất cả thông báo.');
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể cập nhật trạng thái đã đọc.'),
          );
    }
  }

  Future<void> _openExternalUrl(String url) async {
    final uri = Uri.tryParse(url.trim());
    if (uri != null && await canLaunchUrl(uri)) {
      await launchUrl(uri, mode: LaunchMode.externalApplication);
    } else {
      ref.read(toastProvider.notifier).warning('Không thể mở liên kết: $url');
    }
  }

  @override
  Widget build(BuildContext context) {
    final matrix = ref.watch(permissionProvider);
    final canSendNotifications = matrix.canSendAnnouncements;
    final canManageZaloGroups = matrix.canManageZaloGroups;
    final canDeleteZaloGroups = matrix.canDeleteZaloGroups;

    final filteredAnnouncements = _announcements.where((a) {
      if (_search.trim().isNotEmpty) {
        final q = _search.trim().toLowerCase();
        final title = a['title']?.toString().toLowerCase() ?? '';
        final body = a['body']?.toString().toLowerCase() ?? '';
        final bCode = a['building_code']?.toString().toLowerCase() ?? '';
        final aCode = a['apartment_code']?.toString().toLowerCase() ?? '';
        if (!title.contains(q) && !body.contains(q) && !bCode.contains(q) && !aCode.contains(q)) {
          return false;
        }
      }
      return true;
    }).toList();

    final filteredZaloGroups = _zaloGroups.where((g) {
      if (_search.trim().isNotEmpty) {
        final q = _search.trim().toLowerCase();
        final name = g['name']?.toString().toLowerCase() ?? '';
        final bCode = g['building_code']?.toString().toLowerCase() ?? '';
        final aCode = g['apartment_code']?.toString().toLowerCase() ?? '';
        final note = g['note']?.toString().toLowerCase() ?? '';
        if (!name.contains(q) && !bCode.contains(q) && !aCode.contains(q) && !note.contains(q)) {
          return false;
        }
      }
      return true;
    }).toList();

    final filteredInbox = _inbox.where((n) {
      if (_unreadOnly && n['read_at'] != null && n['read_at'].toString().isNotEmpty) {
        return false;
      }
      if (_search.trim().isNotEmpty) {
        final q = _search.trim().toLowerCase();
        final title = n['title']?.toString().toLowerCase() ?? '';
        final content = n['content']?.toString().toLowerCase() ?? '';
        if (!title.contains(q) && !content.contains(q)) return false;
      }
      return true;
    }).toList();

    final hasActiveModal = _confirmSendModal != null ||
        _zaloCopyModal != null ||
        _groupModalOpen ||
        _deleteGroupTarget != null;

    return Stack(
      children: [
        Positioned.fill(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                PageHeader(
                  title: 'Trung tâm Thông báo & Đồng bộ Nhóm Zalo',
                  subtitle:
                      'Soạn bản tin chuẩn hóa theo Tòa nhà / Tầng / Phòng, theo dõi lượt đọc của cư dân và sao chép 1 chạm sang nhóm Zalo vận hành.',
                  actions: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_unreadCount > 0)
                        AppButton(
                          text: 'Đọc tất cả ($_unreadCount)',
                          variant: AppButtonVariant.outline,
                          icon: const Icon(LucideIcons.checkCheck, size: 16),
                          onPressed: _handleMarkAllRead,
                        ),
                      const SizedBox(width: 8),
                      AppButton(
                        text: 'Làm mới',
                        variant: AppButtonVariant.outline,
                        icon: const Icon(LucideIcons.refreshCw, size: 16),
                        onPressed: _fetchAllData,
                      ),
                    ],
                  ),
                ),

                // Tabs
                AppCard(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                  child: AppTabs(
                    activeTab: _activeTab,
                    onChanged: (tab) => setState(() => _activeTab = tab),
                    tabs: [
                      AppTabItem(
                        id: 'announcements',
                        label: 'Thông báo & Xuất Zalo',
                        icon: const Icon(LucideIcons.bellRing, size: 16),
                        count: filteredAnnouncements.length,
                      ),
                      AppTabItem(
                        id: 'zalo_groups',
                        label: 'Danh bạ Nhóm Zalo',
                        icon: const Icon(LucideIcons.messageSquare, size: 16),
                        count: filteredZaloGroups.length,
                      ),
                      AppTabItem(
                        id: 'inbox',
                        label: 'Hộp thư đến',
                        icon: const Icon(LucideIcons.inbox, size: 16),
                        count: _unreadCount > 0 ? _unreadCount : filteredInbox.length,
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 20),

                // TAB 1: Announcements
                if (_activeTab == 'announcements')
                  _buildAnnouncementsTab(canSendNotifications, filteredAnnouncements),

                // TAB 2: Zalo Groups
                if (_activeTab == 'zalo_groups')
                  _buildZaloGroupsTab(canManageZaloGroups, canDeleteZaloGroups, filteredZaloGroups),

                // TAB 3: Inbox
                if (_activeTab == 'inbox') _buildInboxTab(filteredInbox),
              ],
            ),
          ),
        ),

        // Active Modal Overlay Layer
        if (hasActiveModal)
          Positioned.fill(
            child: Stack(
              children: [
                // Semi-transparent scrim backdrop
                Positioned.fill(
                  child: GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () {
                      if (_savingAction != 'send' &&
                          !_markingZalo &&
                          !_groupSubmitting &&
                          !_deletingGroup) {
                        setState(() {
                          _confirmSendModal = null;
                          _zaloCopyModal = null;
                          _groupModalOpen = false;
                          _deleteGroupTarget = null;
                        });
                      }
                    },
                    child: Container(
                      color: AppColors.slate900.withValues(alpha: 0.5),
                    ),
                  ),
                ),
                // Centered modal container with responsive constraints
                Center(
                  child: SingleChildScrollView(
                    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
                    child: ConstrainedBox(
                      constraints: BoxConstraints(
                        maxWidth: _zaloCopyModal != null ? 672 : 512,
                      ),
                      child: _buildActiveModalContent(canSendNotifications),
                    ),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }

  Widget _buildActiveModalContent(bool canSendNotifications) {
    if (_confirmSendModal != null) {
      return _buildConfirm2StepSendModal();
    }
    if (_zaloCopyModal != null) {
      return _buildZaloCopyModal(canSendNotifications);
    }
    if (_groupModalOpen) {
      return _buildGroupModal();
    }
    if (_deleteGroupTarget != null) {
      return _buildDeleteGroupDialog();
    }
    return const SizedBox.shrink();
  }

  Widget _buildAnnouncementsTab(
    bool canSendNotifications,
    List<Map<String, dynamic>> filteredList,
  ) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final isWide = constraints.maxWidth > 900;
        if (!canSendNotifications) {
          return _buildAnnouncementsListCard(filteredList, canSendNotifications);
        }

        if (isWide) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(flex: 5, child: _buildComposeCard()),
              const SizedBox(width: 20),
              Expanded(flex: 7, child: _buildAnnouncementsListCard(filteredList, canSendNotifications)),
            ],
          );
        }

        return Column(
          children: [
            _buildComposeCard(),
            const SizedBox(height: 20),
            _buildAnnouncementsListCard(filteredList, canSendNotifications),
          ],
        );
      },
    );
  }

  Widget _buildComposeCard() {
    return AppCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppCardHeader(
            title: _editingAnnId != null ? 'Chỉnh sửa bản tin nháp / hẹn giờ' : 'Soạn bản tin mới',
            subtitle: 'Chọn mẫu nhanh, kiểm tra bản xem trước Zalo và xác nhận trước khi phát hành.',
          ),

          // Quick Templates
          const Text(
            'Mẫu thông báo nhanh (1 chạm điền sẵn)',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w600,
              color: AppColors.slate700,
            ),
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: kZaloQuickTemplates.map((tpl) {
              return InkWell(
                onTap: () => _applyQuickTemplate(tpl),
                borderRadius: BorderRadius.circular(8),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                  decoration: BoxDecoration(
                    color: AppColors.primary50,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.primary200),
                  ),
                  child: Text(
                    tpl.label,
                    style: const TextStyle(
                      fontSize: 11,
                      fontWeight: FontWeight.w500,
                      color: AppColors.primary700,
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 16),

          // Form fields
          Row(
            children: [
              Expanded(
                child: AppSelect<String>(
                  label: 'Phạm vi người nhận',
                  value: _formTargetScope,
                  options: _kScopeOptions,
                  onChanged: (val) {
                    if (val != null) {
                      setState(() {
                        _formTargetScope = val;
                        _formFloorId = '';
                        _formApartmentId = '';
                      });
                      if (val == 'FLOOR') _loadFloors(_formBuildingId);
                      if (val == 'APARTMENT') _loadApartments(_formBuildingId);
                      _updateAutoZaloPreview();
                    }
                  },
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: AppSelect<String>(
                  label: 'Tòa nhà áp dụng',
                  value: _formBuildingId.isNotEmpty ? _formBuildingId : null,
                  placeholder: '-- Chọn tòa nhà --',
                  options: _buildings.map((b) {
                    final id = b['id']?.toString() ?? '';
                    final code = b['code']?.toString() ?? '';
                    final name = b['name']?.toString() ?? '';
                    return AppSelectOption(value: id, label: '$code — $name');
                  }).toList(),
                  onChanged: (val) {
                    if (val != null) {
                      setState(() {
                        _formBuildingId = val;
                        _formFloorId = '';
                        _formApartmentId = '';
                      });
                      if (_formTargetScope == 'FLOOR') _loadFloors(val);
                      if (_formTargetScope == 'APARTMENT') _loadApartments(val);
                      _updateAutoZaloPreview();
                    }
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),

          if (_formTargetScope == 'FLOOR') ...[
            AppSelect<String>(
              label: 'Chọn Tầng nhận thông báo',
              value: _formFloorId.isNotEmpty ? _formFloorId : null,
              placeholder: '-- Chọn tầng cụ thể --',
              options: _floors.map((f) {
                final id = f['id']?.toString() ?? '';
                final name = f['name']?.toString() ?? '';
                final level = f['floor_number'] ?? f['level'];
                final label = level != null ? '$name (Tầng $level)' : name;
                return AppSelectOption(value: id, label: label);
              }).toList(),
              onChanged: (val) {
                if (val != null) {
                  setState(() => _formFloorId = val);
                  _updateAutoZaloPreview();
                }
              },
            ),
            const SizedBox(height: 12),
          ],

          if (_formTargetScope == 'APARTMENT') ...[
            AppSelect<String>(
              label: 'Chọn Căn hộ nhận thông báo',
              value: _formApartmentId.isNotEmpty ? _formApartmentId : null,
              placeholder: '-- Chọn căn hộ cụ thể --',
              options: _apartments.map((a) {
                final id = a['id']?.toString() ?? '';
                final code = a['code']?.toString() ?? '';
                return AppSelectOption(value: id, label: 'Căn $code');
              }).toList(),
              onChanged: (val) {
                if (val != null) {
                  setState(() => _formApartmentId = val);
                  _updateAutoZaloPreview();
                }
              },
            ),
            const SizedBox(height: 12),
          ],

          AppSelect<String>(
            label: 'Phân loại bản tin',
            value: _formType,
            options: _kComposeTypeOptions,
            onChanged: (val) {
              if (val != null) {
                setState(() => _formType = val);
                _updateAutoZaloPreview();
              }
            },
          ),
          const SizedBox(height: 12),

          AppInput(
            label: 'Tiêu đề thông báo',
            required: true,
            placeholder: 'VD: Thông báo tạm ngừng cấp nước bảo trì bể ngầm...',
            controller: _titleController,
            onChanged: (_) => _updateAutoZaloPreview(),
          ),
          const SizedBox(height: 12),

          AppInput(
            label: 'Nội dung chi tiết trên Cổng cư dân',
            required: true,
            multiline: true,
            rows: 4,
            placeholder: 'Nhập thời gian áp dụng, khu vực ảnh hưởng và đầu mối liên hệ...',
            controller: _bodyController,
            onChanged: (_) => _updateAutoZaloPreview(),
          ),
          const SizedBox(height: 12),

          // Live Editable Zalo Preview
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
                Row(
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    const Expanded(
                      child: Text(
                        'Xem trước nội dung chuẩn Zalo (có thể chỉnh sửa)',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: AppColors.slate800,
                        ),
                      ),
                    ),
                    if (_zaloManuallyEdited)
                      InkWell(
                        onTap: () {
                          setState(() => _zaloManuallyEdited = false);
                          _updateAutoZaloPreview();
                        },
                        child: const Text(
                          'Khôi phục mẫu tự động',
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w600,
                            color: AppColors.primary600,
                          ),
                        ),
                      ),
                  ],
                ),
                const SizedBox(height: 8),
                AppInput(
                  multiline: true,
                  rows: 6,
                  controller: _zaloContentController,
                  onChanged: (_) => setState(() => _zaloManuallyEdited = true),
                ),
                const SizedBox(height: 6),
                const Text(
                  'Mẹo: Bọc **nội dung** quanh các thông tin quan trọng để tự động in đậm khi dán sang Zalo PC/Web.',
                  style: TextStyle(fontSize: 11, color: AppColors.slate500),
                ),
                const SizedBox(height: 8),
                Container(
                  padding: const EdgeInsets.all(10),
                  width: double.infinity,
                  decoration: BoxDecoration(
                    color: Colors.white,
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.slate200),
                  ),
                  child: RichText(
                    text: TextSpan(
                      style: const TextStyle(
                        fontSize: 12,
                        color: AppColors.slate800,
                        fontFamily: 'Inter',
                        height: 1.4,
                      ),
                      children: parseZaloBoldSegments(_zaloContentController.text).map((seg) {
                        return TextSpan(
                          text: seg.text,
                          style: TextStyle(
                            fontWeight: seg.bold ? FontWeight.w700 : FontWeight.w400,
                            color: seg.bold ? AppColors.slate900 : AppColors.slate700,
                          ),
                        );
                      }).toList(),
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),

          AppInput(
            label: 'Thời điểm hẹn giờ gửi (tùy chọn: YYYY-MM-DDTHH:mm)',
            placeholder: '2026-12-01T08:00',
            controller: _scheduledAtController,
            onChanged: (_) => _updateAutoZaloPreview(),
          ),
          const SizedBox(height: 16),

          Row(
            children: [
              Expanded(
                child: AppButton(
                  text: 'Lưu nháp',
                  variant: AppButtonVariant.outline,
                  loading: _savingAction == 'draft',
                  disabled: _savingAction.isNotEmpty,
                  onPressed: _handleSaveDraft,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: AppButton(
                  text: 'Hẹn giờ gửi',
                  variant: AppButtonVariant.secondary,
                  icon: const Icon(LucideIcons.clock, size: 16),
                  loading: _savingAction == 'schedule',
                  disabled: _savingAction.isNotEmpty,
                  onPressed: _handleSaveScheduled,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),

          AppButton(
            text: 'Phát hành thông báo ngay',
            variant: AppButtonVariant.primary,
            fullWidth: true,
            icon: const Icon(LucideIcons.send, size: 16),
            loading: _savingAction == 'send',
            disabled: _savingAction.isNotEmpty,
            onPressed: _handleRequestImmediateSend,
          ),

          if (_editingAnnId != null) ...[
            const SizedBox(height: 8),
            AppButton(
              text: 'Hủy chế độ chỉnh sửa',
              variant: AppButtonVariant.ghost,
              fullWidth: true,
              size: AppButtonSize.sm,
              onPressed: _resetComposeForm,
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildAnnouncementsListCard(
    List<Map<String, dynamic>> filteredList,
    bool canSendNotifications,
  ) {
    return AppCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Filter Bar
          Container(
            padding: const EdgeInsets.all(16),
            decoration: const BoxDecoration(
              color: AppColors.slate50,
              border: Border(bottom: BorderSide(color: AppColors.border)),
            ),
            child: Wrap(
              spacing: 12,
              runSpacing: 12,
              children: [
                SizedBox(
                  width: 240,
                  child: SearchBarWidget(
                    value: _search,
                    onChanged: (val) => setState(() => _search = val),
                    placeholder: 'Tìm tiêu đề, tòa, căn hộ...',
                  ),
                ),
                SizedBox(
                  width: 180,
                  child: AppSelect<String>(
                    value: _annStatusFilter.isNotEmpty ? _annStatusFilter : null,
                    placeholder: 'Tất cả trạng thái',
                    options: [
                      const AppSelectOption(value: '', label: 'Tất cả trạng thái'),
                      const AppSelectOption(value: 'DRAFT', label: 'Bản nháp'),
                      const AppSelectOption(value: 'SCHEDULED', label: 'Hẹn giờ'),
                      const AppSelectOption(value: 'SENT', label: 'Đã phát hành'),
                      const AppSelectOption(value: 'CANCELLED', label: 'Đã hủy'),
                    ],
                    onChanged: (val) {
                      setState(() => _annStatusFilter = val ?? '');
                      _fetchAllData();
                    },
                  ),
                ),
                SizedBox(
                  width: 180,
                  child: AppSelect<String>(
                    value: _annScopeFilter.isNotEmpty ? _annScopeFilter : null,
                    placeholder: 'Tất cả phạm vi',
                    options: [
                      const AppSelectOption(value: '', label: 'Tất cả phạm vi'),
                      ..._kScopeOptions,
                    ],
                    onChanged: (val) {
                      setState(() => _annScopeFilter = val ?? '');
                      _fetchAllData();
                    },
                  ),
                ),
              ],
            ),
          ),

          if (_loading)
            const Padding(
              padding: EdgeInsets.all(40),
              child: Center(
                child: Text(
                  'Đang tải danh sách thông báo...',
                  style: TextStyle(fontSize: 13, color: AppColors.slate400),
                ),
              ),
            )
          else if (filteredList.isEmpty)
            const EmptyState(
              icon: LucideIcons.bellRing,
              title: 'Chưa có bản tin thông báo nào',
              description:
                  'Các bản tin nháp, hẹn giờ hoặc đã phát hành cùng lịch sử sao chép Zalo sẽ hiển thị tại đây.',
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: filteredList.length,
              separatorBuilder: (_, __) => const Divider(height: 1, color: AppColors.border),
              itemBuilder: (context, idx) {
                final ann = filteredList[idx];
                final type = ann['type']?.toString() ?? 'ANNOUNCEMENT';
                final typeInfo = _kNotificationTypeInfo[type] ?? ('Thông báo', 'sky');
                final scope = ann['target_scope']?.toString() ?? 'BUILDING';
                final scopeMeta = _kScopeLabels[scope] ?? ('Toàn Tòa nhà', 'sky');
                final status = ann['status']?.toString() ?? 'DRAFT';
                final isSent = status == 'SENT';
                final isManualSent = ann['manual_sent_at'] != null;

                return Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Expanded(
                            child: Wrap(
                              spacing: 6,
                              runSpacing: 4,
                              crossAxisAlignment: WrapCrossAlignment.center,
                              children: [
                                StatusBadge(status: status, domain: StatusDomain.announcement),
                                AppBadge(
                                  label: scopeMeta.$1,
                                  variant: AppBadgeVariant.fromString(scopeMeta.$2),
                                ),
                                AppBadge(
                                  label: typeInfo.$1,
                                  variant: AppBadgeVariant.fromString(typeInfo.$2),
                                ),
                                if (isSent)
                                  AppBadge(
                                    label:
                                        'Đã đọc: ${ann['read_count'] ?? 0}/${ann['recipient_count'] ?? 0} cư dân',
                                    variant: AppBadgeVariant.slate,
                                  ),
                                if (isManualSent)
                                  AppBadge(
                                    label: 'Đã dán Zalo • ${formatDateTime(ann['manual_sent_at'])}',
                                    variant: AppBadgeVariant.emerald,
                                  )
                                else
                                  const AppBadge(
                                    label: 'Chưa dán Zalo',
                                    variant: AppBadgeVariant.amber,
                                  ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 8),
                          Text(
                            ann['sent_at'] != null
                                ? 'Phát hành: ${formatDateTime(ann['sent_at'])}'
                                : (ann['scheduled_at'] != null
                                    ? 'Hẹn gửi: ${formatDateTime(ann['scheduled_at'])}'
                                    : formatDateTime(ann['created_at'])),
                            style: const TextStyle(fontSize: 11, color: AppColors.slate400),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),

                      Row(
                        children: [
                          const Icon(LucideIcons.building2, size: 14, color: AppColors.primary500),
                          const SizedBox(width: 4),
                          Text(
                            '${ann['building_code'] ?? ''} — ${ann['building_name'] ?? ''}${ann['floor_name'] != null ? ' • ${ann['floor_name']}' : ''}${ann['apartment_code'] != null ? ' • Căn ${ann['apartment_code']}' : ''}',
                            style: const TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w500,
                              color: AppColors.slate500,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 4),

                      Text(
                        ann['title']?.toString() ?? '',
                        style: const TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          color: AppColors.slate900,
                        ),
                      ),
                      const SizedBox(height: 4),

                      Text(
                        ann['body']?.toString() ?? '',
                        style: const TextStyle(
                          fontSize: 12,
                          color: AppColors.slate600,
                          height: 1.4,
                        ),
                      ),
                      const SizedBox(height: 8),

                      Wrap(
                        alignment: WrapAlignment.spaceBetween,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          Text(
                            'Tạo bởi: ${ann['created_by_name'] ?? 'Ban Quản Lý'}${ann['manual_sent_by_name'] != null ? ' • Xác nhận Zalo: ${ann['manual_sent_by_name']}' : ''}',
                            style: const TextStyle(fontSize: 11, color: AppColors.slate400),
                          ),
                          Wrap(
                            spacing: 8,
                            runSpacing: 4,
                            children: [
                              AppButton(
                                text: canSendNotifications ? 'Sao chép dán Zalo' : 'Xem nội dung Zalo',
                                variant: AppButtonVariant.secondary,
                                size: AppButtonSize.xs,
                                icon: const Icon(LucideIcons.copy, size: 14),
                                onPressed: () => _openZaloModalForAnnouncement(ann),
                              ),
                              if (canSendNotifications && ['DRAFT', 'SCHEDULED'].contains(status)) ...[
                                AppButton(
                                  text: 'Chỉnh sửa',
                                  variant: AppButtonVariant.outline,
                                  size: AppButtonSize.xs,
                                  onPressed: () => _handleEditDraftRow(ann),
                                ),
                                AppButton(
                                  text: 'Phát hành',
                                  variant: AppButtonVariant.primary,
                                  size: AppButtonSize.xs,
                                  icon: const Icon(LucideIcons.send, size: 14),
                                  onPressed: () {
                                    setState(() {
                                      _confirmSendModal = {
                                        'mode': 'existing',
                                        'announcement': ann,
                                      };
                                    });
                                  },
                                ),
                                AppButton(
                                  text: 'Hủy',
                                  variant: AppButtonVariant.danger,
                                  size: AppButtonSize.xs,
                                  icon: const Icon(LucideIcons.xCircle, size: 14),
                                  onPressed: () => _handleCancelAnnouncement(ann),
                                ),
                              ],
                            ],
                          ),
                        ],
                      ),
                    ],
                  ),
                );
              },
            ),
        ],
      ),
    );
  }

  Widget _buildZaloGroupsTab(
    bool canManageZaloGroups,
    bool canDeleteZaloGroups,
    List<Map<String, dynamic>> filteredList,
  ) {
    return AppCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: const BoxDecoration(
              color: AppColors.slate50,
              border: Border(bottom: BorderSide(color: AppColors.border)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Wrap(
                  spacing: 12,
                  runSpacing: 12,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    SizedBox(
                      width: 240,
                      child: SearchBarWidget(
                        value: _search,
                        onChanged: (val) => setState(() => _search = val),
                        placeholder: 'Tìm tên nhóm Zalo, mã tòa, mã phòng...',
                      ),
                    ),
                    SizedBox(
                      width: 200,
                      child: AppSelect<String>(
                        value: _zaloScopeFilter.isNotEmpty ? _zaloScopeFilter : null,
                        placeholder: 'Tất cả loại nhóm',
                        options: const [
                          AppSelectOption(value: '', label: 'Tất cả loại nhóm'),
                          AppSelectOption(value: 'BUILDING', label: 'Nhóm chung Tòa nhà'),
                          AppSelectOption(value: 'APARTMENT', label: 'Nhóm riêng từng Phòng'),
                        ],
                        onChanged: (val) {
                          setState(() => _zaloScopeFilter = val ?? '');
                          _fetchAllData();
                        },
                      ),
                    ),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Checkbox(
                          value: _includeInactiveGroups,
                          onChanged: (v) {
                            setState(() => _includeInactiveGroups = v ?? false);
                            _fetchAllData();
                          },
                        ),
                        const Text(
                          'Hiện cả nhóm ngưng hoạt động',
                          style: TextStyle(fontSize: 12, color: AppColors.slate700),
                        ),
                      ],
                    ),
                  ],
                ),
                if (canManageZaloGroups)
                  AppButton(
                    text: 'Thêm nhóm Zalo',
                    variant: AppButtonVariant.primary,
                    size: AppButtonSize.sm,
                    icon: const Icon(LucideIcons.plus, size: 16),
                    onPressed: _openCreateGroupModal,
                  ),
              ],
            ),
          ),

          if (_loading)
            const Padding(
              padding: EdgeInsets.all(40),
              child: Center(
                child: Text(
                  'Đang tải danh bạ nhóm Zalo...',
                  style: TextStyle(fontSize: 13, color: AppColors.slate400),
                ),
              ),
            )
          else if (filteredList.isEmpty)
            EmptyState(
              icon: LucideIcons.messageSquare,
              title: 'Chưa cấu hình nhóm Zalo vận hành',
              description:
                  'Lưu danh sách link nhóm Zalo Tòa nhà và nhóm Zalo từng Phòng để mở nhanh khi dán thông báo.',
              action: canManageZaloGroups
                  ? AppButton(
                      text: 'Thêm nhóm Zalo đầu tiên',
                      size: AppButtonSize.sm,
                      icon: const Icon(LucideIcons.plus, size: 16),
                      onPressed: _openCreateGroupModal,
                    )
                  : null,
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: filteredList.length,
              separatorBuilder: (_, __) => const Divider(height: 1, color: AppColors.border),
              itemBuilder: (context, idx) {
                final grp = filteredList[idx];
                final isApt = grp['scope'] == 'APARTMENT';
                final isActive = grp['is_active'] == true || grp['is_active'] == 1;
                final link = grp['invite_link']?.toString() ?? '';

                return Padding(
                  padding: const EdgeInsets.all(16),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Wrap(
                              spacing: 8,
                              children: [
                                AppBadge(
                                  label: isApt ? 'Nhóm Phòng ${grp['apartment_code'] ?? ''}' : 'Nhóm chung Tòa nhà',
                                  variant: isApt ? AppBadgeVariant.purple : AppBadgeVariant.sky,
                                ),
                                AppBadge(
                                  label: isActive ? 'Đang hoạt động' : 'Ngưng hoạt động',
                                  variant: isActive ? AppBadgeVariant.emerald : AppBadgeVariant.slate,
                                ),
                                Text(
                                  '${grp['building_code'] ?? ''} — ${grp['building_name'] ?? ''}',
                                  style: const TextStyle(fontSize: 12, color: AppColors.slate500),
                                ),
                              ],
                            ),
                            const SizedBox(height: 4),
                            Text(
                              grp['name']?.toString() ?? '',
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w700,
                                color: AppColors.slate900,
                              ),
                            ),
                            if (grp['note'] != null && grp['note'].toString().isNotEmpty) ...[
                              const SizedBox(height: 2),
                              Text(
                                grp['note'].toString(),
                                style: const TextStyle(fontSize: 12, color: AppColors.slate500),
                              ),
                            ],
                          ],
                        ),
                      ),
                      Wrap(
                        spacing: 8,
                        crossAxisAlignment: WrapCrossAlignment.center,
                        children: [
                          if (link.isNotEmpty)
                            AppButton(
                              text: 'Mở nhóm Zalo',
                              size: AppButtonSize.xs,
                              variant: AppButtonVariant.primary,
                              icon: const Icon(LucideIcons.externalLink, size: 14),
                              onPressed: () => _openExternalUrl(link),
                            )
                          else
                            const Text(
                              'Chưa gắn link zalo.me',
                              style: TextStyle(
                                fontSize: 12,
                                color: AppColors.slate400,
                                fontStyle: FontStyle.italic,
                              ),
                            ),
                          if (canManageZaloGroups)
                            AppButton(
                              text: 'Chỉnh sửa',
                              size: AppButtonSize.xs,
                              variant: AppButtonVariant.outline,
                              onPressed: () => _openEditGroupModal(grp),
                            ),
                          if (canDeleteZaloGroups)
                            AppButton(
                              text: 'Xóa',
                              size: AppButtonSize.xs,
                              variant: AppButtonVariant.danger,
                              icon: const Icon(LucideIcons.trash2, size: 14),
                              onPressed: () => setState(() => _deleteGroupTarget = grp),
                            ),
                        ],
                      ),
                    ],
                  ),
                );
              },
            ),
        ],
      ),
    );
  }

  Widget _buildInboxTab(List<Map<String, dynamic>> filteredList) {
    return AppCard(
      padding: EdgeInsets.zero,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(16),
            decoration: const BoxDecoration(
              color: AppColors.slate50,
              border: Border(bottom: BorderSide(color: AppColors.border)),
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                SizedBox(
                  width: 280,
                  child: SearchBarWidget(
                    value: _search,
                    onChanged: (val) => setState(() => _search = val),
                    placeholder: 'Tìm tiêu đề hoặc nội dung hộp thư...',
                  ),
                ),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Checkbox(
                      value: _unreadOnly,
                      onChanged: (v) => setState(() => _unreadOnly = v ?? false),
                    ),
                    const Text(
                      'Chỉ hiện chưa đọc',
                      style: TextStyle(fontSize: 12, color: AppColors.slate700),
                    ),
                  ],
                ),
              ],
            ),
          ),

          if (_loading)
            const Padding(
              padding: EdgeInsets.all(40),
              child: Center(
                child: Text(
                  'Đang tải hộp thư đến...',
                  style: TextStyle(fontSize: 13, color: AppColors.slate400),
                ),
              ),
            )
          else if (filteredList.isEmpty)
            const EmptyState(
              icon: LucideIcons.bell,
              title: 'Hộp thư đến trống',
              description: 'Bạn đã đọc hết các thông báo hoặc chưa có thông báo hệ thống mới.',
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: filteredList.length,
              separatorBuilder: (_, __) => const Divider(height: 1, color: AppColors.border),
              itemBuilder: (context, idx) {
                final item = filteredList[idx];
                final type = item['type']?.toString() ?? 'SYSTEM';
                final typeInfo = _kNotificationTypeInfo[type] ?? ('Hệ thống', 'slate');
                final isUnread = item['read_at'] == null || item['read_at'].toString().isEmpty;

                return InkWell(
                  onTap: () {
                    _markInboxItemReadLocal(item);
                    NotificationDetailModal.show(context: context, notification: item);
                  },
                  child: Container(
                    color: isUnread ? AppColors.primary50.withValues(alpha: 0.35) : Colors.transparent,
                    padding: const EdgeInsets.all(16),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Container(
                          width: 8,
                          height: 8,
                          margin: const EdgeInsets.only(top: 6),
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            color: isUnread ? AppColors.primary500 : AppColors.slate200,
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                children: [
                                  Row(
                                    children: [
                                      AppBadge(
                                        label: typeInfo.$1,
                                        variant: AppBadgeVariant.fromString(typeInfo.$2),
                                      ),
                                      if (isUnread) ...[
                                        const SizedBox(width: 6),
                                        const AppBadge(
                                          label: 'Mới',
                                          variant: AppBadgeVariant.sky,
                                        ),
                                      ],
                                    ],
                                  ),
                                  Text(
                                    '${formatRelativeTime(item['created_at'])} • ${formatDateTime(item['created_at'])}',
                                    style: const TextStyle(fontSize: 11, color: AppColors.slate400),
                                  ),
                                ],
                              ),
                              const SizedBox(height: 6),
                              Text(
                                item['title']?.toString() ?? '',
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: isUnread ? FontWeight.w700 : FontWeight.w600,
                                  color: isUnread ? AppColors.slate900 : AppColors.slate800,
                                ),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                item['content']?.toString() ?? '',
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: AppColors.slate600,
                                  height: 1.4,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
        ],
      ),
    );
  }

  Widget _buildConfirm2StepSendModal() {
    final mode = _confirmSendModal?['mode']?.toString() ?? 'compose';
    final existingAnn = _confirmSendModal?['announcement'] as Map<String, dynamic>?;

    final title = mode == 'existing' && existingAnn != null
        ? existingAnn['title']?.toString() ?? ''
        : _titleController.text;

    final targetScope = mode == 'existing' && existingAnn != null
        ? existingAnn['target_scope']?.toString() ?? 'BUILDING'
        : _formTargetScope;
    final scopeLabel = _kScopeLabels[targetScope]?.$1 ?? targetScope;

    return AppModal(
      title: 'Xác nhận phát hành bản tin tới Cư dân (Bước 2/2)',
      subtitle: 'Kiểm tra kỹ phạm vi đối tượng nhận trước khi gửi đồng loạt lên Cổng cư dân.',
      onClose: () => setState(() => _confirmSendModal = null),
      footer: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          AppButton(
            text: 'Quay lại kiểm tra',
            variant: AppButtonVariant.outline,
            onPressed: () => setState(() => _confirmSendModal = null),
          ),
          const SizedBox(width: 8),
          AppButton(
            text: 'Xác nhận & Phát hành ngay',
            variant: AppButtonVariant.primary,
            icon: const Icon(LucideIcons.send, size: 16),
            loading: _savingAction == 'send',
            onPressed: _handleConfirm2StepSend,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: AppColors.amber50,
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: AppColors.amber200),
            ),
            child: const Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(LucideIcons.triangleAlert, size: 16, color: AppColors.amber600),
                SizedBox(width: 8),
                Expanded(
                  child: Text(
                    'Hệ thống sẽ gửi thông báo trực tiếp tới tất cả người đứng tên hợp đồng và người ở cùng đang hiệu lực trong phạm vi dưới đây. Sau khi gửi không thể thu hồi.',
                    style: TextStyle(fontSize: 12, color: AppColors.amber900, height: 1.4),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
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
                Text('Phạm vi nhận: $scopeLabel',
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Text('Tiêu đề: $title',
                    style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildZaloCopyModal(bool canSendNotifications) {
    final ann = _zaloCopyModal!;
    final zaloContent = ann['zalo_content']?.toString() ?? '';
    final targetGroups = (ann['target_zalo_groups'] as List?)
            ?.whereType<Map>()
            .map((m) => Map<String, dynamic>.from(m))
            .toList() ??
        [];

    return AppModal(
      title: 'Sao chép & Dán sang nhóm Zalo vận hành',
      subtitle: ann['title']?.toString() ?? '',
      size: AppModalSize.lg,
      onClose: () => setState(() => _zaloCopyModal = null),
      footer: Wrap(
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 8,
        runSpacing: 8,
        children: [
          AppButton(
            text: 'Đóng',
            variant: AppButtonVariant.outline,
            onPressed: () => setState(() => _zaloCopyModal = null),
          ),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              AppButton(
                text: _copiedZaloBody ? 'Đã sao chép!' : 'Sao chép nội dung',
                variant: AppButtonVariant.secondary,
                icon: Icon(_copiedZaloBody ? LucideIcons.check : LucideIcons.copy, size: 16),
                onPressed: () => _handleCopyZaloContent(zaloContent),
              ),
              if (canSendNotifications)
                AppButton(
                  text: 'Xác nhận đã gửi thủ công lên Zalo',
                  variant: AppButtonVariant.primary,
                  icon: const Icon(LucideIcons.checkCheck, size: 16),
                  loading: _markingZalo,
                  onPressed: _handleMarkZaloSentSubmit,
                ),
            ],
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Nội dung đã định dạng sẵn cho nhóm Zalo',
            style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate700),
          ),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(12),
            width: double.infinity,
            decoration: BoxDecoration(
              color: AppColors.slate900,
              borderRadius: BorderRadius.circular(10),
            ),
            child: RichText(
              text: TextSpan(
                style: const TextStyle(
                  fontSize: 12,
                  color: AppColors.slate200,
                  fontFamily: 'Inter',
                  height: 1.4,
                ),
                children: parseZaloBoldSegments(zaloContent).map((seg) {
                  return TextSpan(
                    text: seg.text,
                    style: TextStyle(
                      fontWeight: seg.bold ? FontWeight.w700 : FontWeight.w400,
                      color: seg.bold ? Colors.white : AppColors.slate200,
                    ),
                  );
                }).toList(),
              ),
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'Mẹo trên Zalo PC / Zalo Web: nhấn Ctrl+V để giữ nguyên các mục in đậm.',
            style: TextStyle(fontSize: 11, color: AppColors.slate500),
          ),
          const SizedBox(height: 16),

          Text(
            'Nhóm Zalo đích tương ứng phạm vi bản tin (${targetGroups.length})',
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate700),
          ),
          const SizedBox(height: 8),

          if (targetGroups.isEmpty)
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.slate50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.border),
              ),
              child: const Text(
                'Chưa có nhóm Zalo nào khớp với tòa nhà / căn hộ này trong danh bạ. Bạn vẫn có thể sao chép văn bản phía trên để dán vào Zalo.',
                style: TextStyle(fontSize: 12, color: AppColors.slate500),
              ),
            )
          else
            ListView.builder(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: targetGroups.length,
              itemBuilder: (context, idx) {
                final grp = targetGroups[idx];
                final id = grp['id']?.toString() ?? '';
                final checked = _checkedZaloGroupIds.contains(id);
                final link = grp['invite_link']?.toString() ?? '';

                return Container(
                  margin: const EdgeInsets.only(bottom: 6),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    color: AppColors.primary50.withValues(alpha: 0.5),
                    borderRadius: BorderRadius.circular(8),
                    border: Border.all(color: AppColors.primary200),
                  ),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Row(
                        children: [
                          if (canSendNotifications)
                            Checkbox(
                              value: checked,
                              onChanged: (v) {
                                setState(() {
                                  if (v == true) {
                                    _checkedZaloGroupIds.add(id);
                                  } else {
                                    _checkedZaloGroupIds.remove(id);
                                  }
                                });
                              },
                            ),
                          Text(
                            grp['name']?.toString() ?? '',
                            style: const TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w600,
                              color: AppColors.slate900,
                            ),
                          ),
                        ],
                      ),
                      if (link.isNotEmpty)
                        AppButton(
                          text: 'Mở nhóm Zalo',
                          size: AppButtonSize.xs,
                          icon: const Icon(LucideIcons.externalLink, size: 12),
                          onPressed: () => _openExternalUrl(link),
                        ),
                    ],
                  ),
                );
              },
            ),

          if (ann['manual_sent_at'] != null) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: AppColors.emerald50,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: AppColors.emerald200),
              ),
              child: Text(
                'Đã ghi nhận dán lên Zalo lúc ${formatDateTime(ann['manual_sent_at'])}${ann['manual_sent_by_name'] != null ? ' bởi ${ann['manual_sent_by_name']}' : ''}.',
                style: const TextStyle(fontSize: 12, color: AppColors.emerald700),
              ),
            ),
          ],

          if (canSendNotifications) ...[
            const SizedBox(height: 12),
            AppInput(
              label: 'Ghi chú xác nhận gửi Zalo (tùy chọn)',
              placeholder: 'VD: Đã ghim thông báo đầu nhóm Zalo...',
              controller: _zaloMarkNoteController,
            ),
          ],
        ],
      ),
    );
  }

  Widget _buildGroupModal() {
    return AppModal(
      title: _editingGroup != null ? 'Cập nhật Nhóm Zalo' : 'Thêm Nhóm Zalo vào Danh bạ',
      subtitle: 'Quản lý đường dẫn nhóm Zalo chung của Tòa nhà và nhóm Zalo riêng từng Căn hộ.',
      onClose: () => setState(() => _groupModalOpen = false),
      footer: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          AppButton(
            text: 'Hủy',
            variant: AppButtonVariant.outline,
            onPressed: () => setState(() => _groupModalOpen = false),
          ),
          const SizedBox(width: 8),
          AppButton(
            text: _editingGroup != null ? 'Lưu thay đổi' : 'Thêm nhóm Zalo',
            variant: AppButtonVariant.primary,
            loading: _groupSubmitting,
            onPressed: _handleSubmitGroup,
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: AppSelect<String>(
                  label: 'Tòa nhà',
                  value: _groupBuildingId.isNotEmpty ? _groupBuildingId : null,
                  placeholder: '-- Chọn tòa nhà --',
                  options: _buildings.map((b) {
                    final id = b['id']?.toString() ?? '';
                    final code = b['code']?.toString() ?? '';
                    final name = b['name']?.toString() ?? '';
                    return AppSelectOption(value: id, label: '$code — $name');
                  }).toList(),
                  onChanged: (val) {
                    if (val != null) {
                      setState(() {
                        _groupBuildingId = val;
                        _groupApartmentId = '';
                      });
                      if (_groupScope == 'APARTMENT') _loadGroupApartments(val);
                    }
                  },
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: AppSelect<String>(
                  label: 'Phạm vi nhóm',
                  value: _groupScope,
                  options: const [
                    AppSelectOption(value: 'BUILDING', label: 'Nhóm chung Tòa nhà'),
                    AppSelectOption(value: 'APARTMENT', label: 'Nhóm riêng từng Phòng'),
                  ],
                  onChanged: (val) {
                    if (val != null) {
                      setState(() {
                        _groupScope = val;
                        _groupApartmentId = '';
                      });
                      if (val == 'APARTMENT' && _groupBuildingId.isNotEmpty) {
                        _loadGroupApartments(_groupBuildingId);
                      }
                    }
                  },
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),

          if (_groupScope == 'APARTMENT') ...[
            AppSelect<String>(
              label: 'Căn hộ liên kết',
              value: _groupApartmentId.isNotEmpty ? _groupApartmentId : null,
              placeholder: '-- Chọn căn hộ --',
              options: _groupApartments.map((a) {
                final id = a['id']?.toString() ?? '';
                final code = a['code']?.toString() ?? '';
                return AppSelectOption(value: id, label: 'Căn $code');
              }).toList(),
              onChanged: (val) => setState(() => _groupApartmentId = val ?? ''),
            ),
            const SizedBox(height: 12),
          ],

          AppInput(
            label: 'Tên hiển thị nhóm Zalo',
            required: true,
            placeholder: 'VD: Cư dân Tòa VOP-A hoặc Zalo Hỗ trợ Phòng A101',
            controller: _groupNameController,
          ),
          const SizedBox(height: 12),

          AppInput(
            label: 'Đường dẫn tham gia nhóm (zalo.me)',
            placeholder: 'https://zalo.me/g/...',
            controller: _groupInviteLinkController,
            error: _groupLinkError.isNotEmpty ? _groupLinkError : null,
            onChanged: (_) {
              if (_groupLinkError.isNotEmpty) setState(() => _groupLinkError = '');
            },
          ),
          const SizedBox(height: 12),

          AppInput(
            label: 'Ghi chú vận hành (tùy chọn)',
            multiline: true,
            rows: 2,
            placeholder: 'VD: Nhóm gồm chủ hộ A101 + Kỹ thuật trực ca...',
            controller: _groupNoteController,
          ),
          const SizedBox(height: 12),

          Row(
            children: [
              Checkbox(
                value: _groupIsActive,
                onChanged: (v) => setState(() => _groupIsActive = v ?? true),
              ),
              const Text(
                'Nhóm đang hoạt động (gợi ý tự động khi dán thông báo)',
                style: TextStyle(fontSize: 12, color: AppColors.slate700),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildDeleteGroupDialog() {
    return ConfirmDialog(
      title: 'Xác nhận xóa nhóm Zalo',
      message:
          'Bạn có chắc chắn muốn xóa vĩnh viễn nhóm Zalo "${_deleteGroupTarget?['name'] ?? ''}" khỏi danh bạ vận hành?',
      confirmLabel: 'Xóa nhóm Zalo',
      variant: ConfirmDialogVariant.danger,
      loading: _deletingGroup,
      onConfirm: _handleConfirmDeleteGroup,
      onClose: () => setState(() => _deleteGroupTarget = null),
    );
  }
}
