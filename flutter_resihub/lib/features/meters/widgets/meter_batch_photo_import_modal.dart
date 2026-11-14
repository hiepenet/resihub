import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/base64_file.dart';
import '../../../core/utils/meter_batch_photo_helpers.dart';
import '../../../core/utils/validation.dart';
import '../../../shared/providers/toast_provider.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_modal.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/auth_media_viewer.dart';
import '../../ai_gateway/services/ai_service.dart';
import '../../buildings/services/buildings_service.dart';
import '../services/meters_service.dart';

/// Batch Meter Photo Import & AI OCR Modal (FR-030).
/// Port of `frontend/src/components/meters/MeterBatchPhotoImportModal.jsx`.
class MeterBatchPhotoImportModal extends ConsumerStatefulWidget {
  final String initialBuildingId;
  final String period;
  final num anomalyThresholdPct;
  final bool canWriteMeters;
  final VoidCallback? onSaved;
  final VoidCallback? onClose;

  const MeterBatchPhotoImportModal({
    super.key,
    this.initialBuildingId = '',
    required this.period,
    this.anomalyThresholdPct = 30,
    this.canWriteMeters = true,
    this.onSaved,
    this.onClose,
  });

  /// Displays the modal in a full-screen overlay dialog.
  static Future<void> show({
    required BuildContext context,
    String initialBuildingId = '',
    required String period,
    num anomalyThresholdPct = 30,
    bool canWriteMeters = true,
    VoidCallback? onSaved,
  }) {
    return AppModal.show<void>(
      context: context,
      title: 'Import Chỉ số Điện / Nước Hàng loạt từ Ảnh Chụp (AI OCR)',
      subtitle: 'Kỳ chốt: $period • AI nhận diện công tơ từ tên file & mặt đồng hồ (Tối đa $kMaxBatchMeterPhotos ảnh/đợt)',
      size: AppModalSize.full,
      child: MeterBatchPhotoImportModal(
        initialBuildingId: initialBuildingId,
        period: period,
        anomalyThresholdPct: anomalyThresholdPct,
        canWriteMeters: canWriteMeters,
        onSaved: onSaved,
      ),
    );
  }

  @override
  ConsumerState<MeterBatchPhotoImportModal> createState() => _MeterBatchPhotoImportModalState();
}

class _MeterBatchPhotoImportModalState extends ConsumerState<MeterBatchPhotoImportModal> {
  List<Map<String, dynamic>> _buildings = [];
  String _targetBuildingId = '';
  List<Map<String, dynamic>> _buildingMeters = [];

  final List<Map<String, dynamic>> _items = [];
  int _queueTotal = 0;
  int _queueCompleted = 0;
  bool _isQueueRunning = false;
  String? _savingStatus;
  int _sessionGen = 0;

  @override
  void initState() {
    super.initState();
    _targetBuildingId = widget.initialBuildingId;
    _loadBuildingsAndMeters();
  }

  Future<void> _loadBuildingsAndMeters() async {
    try {
      final bldgRes = await ref.read(buildingsServiceProvider).list();
      final list = (bldgRes is Map && bldgRes['data'] is List)
          ? (bldgRes['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : <Map<String, dynamic>>[];

      if (mounted) {
        setState(() {
          _buildings = list;
          if (_targetBuildingId.isEmpty && list.isNotEmpty) {
            _targetBuildingId = list[0]['id']?.toString() ?? '';
          }
        });
        if (_targetBuildingId.isNotEmpty) {
          _fetchBuildingMeters(_targetBuildingId);
        }
      }
    } catch (err) {
      if (mounted) {
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách tòa nhà.'),
            );
      }
    }
  }

  Future<List<Map<String, dynamic>>> _fetchBuildingMeters(String bldgId) async {
    if (bldgId.isEmpty) {
      setState(() => _buildingMeters = []);
      return [];
    }

    try {
      final res = await ref.read(metersServiceProvider).list({
        'building_id': bldgId,
        'period': widget.period,
      });

      final list = (res is Map && res['data'] is List)
          ? (res['data'] as List).whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
          : (res is List)
              ? res.whereType<Map>().map((e) => Map<String, dynamic>.from(e)).toList()
              : <Map<String, dynamic>>[];

      if (mounted) {
        setState(() {
          _buildingMeters = list;
          // Rematch existing items
          final rematched = rematchBatchPhotoItemsForBuilding(_items, list, bldgId);
          _items.clear();
          _items.addAll(rematched);
        });
      }
      return list;
    } catch (err) {
      if (mounted) {
        setState(() {
          _buildingMeters = [];
        });
        ref.read(toastProvider.notifier).error(
              extractErrorMessage(err, 'Không thể tải danh sách công tơ của tòa nhà.'),
            );
      }
      return [];
    }
  }

  Future<void> _pickPhotos() async {
    if (!widget.canWriteMeters) return;
    if (_isQueueRunning) {
      ref.read(toastProvider.notifier).warning('Hệ thống đang đọc lô ảnh hiện tại, vui lòng đợi.');
      return;
    }
    if (_targetBuildingId.isEmpty) {
      ref.read(toastProvider.notifier).warning('Vui lòng chọn Tòa nhà mục tiêu trước khi tải ảnh.');
      return;
    }

    final remainingSlots = kMaxBatchMeterPhotos - _items.length;
    if (remainingSlots <= 0) {
      ref.read(toastProvider.notifier).warning(
            'Mỗi đợt đối soát tối đa $kMaxBatchMeterPhotos ảnh. Vui lòng lưu hoặc xóa bớt dòng trước khi thêm ảnh mới.',
          );
      return;
    }

    // Pick multiple files using FilePicker
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['jpg', 'jpeg', 'png', 'webp'],
      allowMultiple: true,
      withData: true,
    );

    if (result == null || result.files.isEmpty) return;

    final pickedFiles = result.files;
    if (pickedFiles.length > remainingSlots) {
      ref.read(toastProvider.notifier).warning(
            'Chỉ nhận $remainingSlots ảnh đầu tiên để đảm bảo giới hạn tối đa $kMaxBatchMeterPhotos ảnh/đợt.',
          );
    }

    final accepted = pickedFiles.take(remainingSlots).toList();
    final List<Map<String, dynamic>> prepared = [];
    final currentGen = ++_sessionGen;

    for (final file in accepted) {
      final bytes = file.bytes;
      if (bytes == null) continue;

      try {
        final compressedDataUrl = await compressImageBytesToDataUrl(bytes, maxDimension: 1280);
        final match = matchMeterFromFilename(file.name, _buildingMeters);

        prepared.add({
          'localId': 'bmo-${DateTime.now().millisecondsSinceEpoch}-${file.name}',
          'buildingId': _targetBuildingId,
          'fileName': file.name,
          'imageDataUri': compressedDataUrl,
          'matchKind': match.matchKind,
          'meterId': match.meterId,
          'apartmentId': match.apartmentId,
          'apartmentCode': match.apartmentCode,
          'meterTypeHint': match.meterTypeHint,
          'manualMeterAssigned': false,
          'draftReading': '',
          'userEditedReading': false,
          'abnormalNote': '',
          'ocrStatus': 'PENDING',
          'suggestionId': null,
          'confidence': null,
          'detectedMeterType': null,
          'ocrError': '',
        });
      } catch (err) {
        ref.read(toastProvider.notifier).error('Không thể đọc ảnh "${file.name}": $err');
      }
    }

    if (prepared.isEmpty || !mounted || _sessionGen != currentGen) return;

    setState(() {
      _items.addAll(prepared);
      _queueTotal = prepared.length;
      _queueCompleted = 0;
      _isQueueRunning = true;
    });

    // Run OCR with concurrency = 2
    await runBoundedConcurrencyQueue<Map<String, dynamic>, void>(
      prepared,
      kDefaultOcrConcurrency,
      (item, idx) async {
        try {
          await _runOcrForRow(item, currentGen);
        } finally {
          if (mounted && _sessionGen == currentGen) {
            setState(() {
              _queueCompleted++;
            });
          }
        }
      },
    );

    if (mounted && _sessionGen == currentGen) {
      setState(() => _isQueueRunning = false);
    }
  }

  Future<void> _runOcrForRow(Map<String, dynamic> rowSnapshot, int genId) async {
    if (_sessionGen != genId) return;

    final localId = rowSnapshot['localId'];
    setState(() {
      final idx = _items.indexWhere((r) => r['localId'] == localId);
      if (idx >= 0) {
        _items[idx]['ocrStatus'] = 'PROCESSING';
        _items[idx]['ocrError'] = '';
      }
    });

    final matchedMeter = rowSnapshot['meterId'] != null
        ? _buildingMeters.firstWhere((m) => m['id']?.toString() == rowSnapshot['meterId'].toString(), orElse: () => {})
        : null;

    final ocrPayload = <String, dynamic>{
      'period': widget.period,
      'image_base64': rowSnapshot['imageDataUri'],
    };

    if (matchedMeter != null && matchedMeter.isNotEmpty) {
      ocrPayload['meter_id'] = matchedMeter['id'];
      if (matchedMeter['target_contract_id'] != null) {
        ocrPayload['contract_id'] = matchedMeter['target_contract_id'];
      }
    } else {
      ocrPayload['building_id'] = _targetBuildingId;
      if (rowSnapshot['apartmentId'] != null) {
        ocrPayload['apartment_id'] = rowSnapshot['apartmentId'];
      }
    }

    try {
      final res = await ref.read(aiServiceProvider).ocrMeterReading(ocrPayload);
      if (_sessionGen != genId || !mounted) return;

      final data = res is Map ? (res['data'] is Map ? res['data'] : res) : {};
      final out = data['output'] is Map ? data['output'] : {};

      final autoMeterId = rowSnapshot['manualMeterAssigned'] == true
          ? rowSnapshot['meterId']
          : resolveMeterAfterOcr(
              item: rowSnapshot,
              ocrData: data,
              buildingMeters: _buildingMeters,
            );

      final hasAiReading = out['reading'] != null;
      final nextDraft = hasAiReading ? out['reading'].toString() : rowSnapshot['draftReading'];

      setState(() {
        final idx = _items.indexWhere((r) => r['localId'] == localId);
        if (idx >= 0) {
          _items[idx]['meterId'] = autoMeterId ?? _items[idx]['meterId'];
          _items[idx]['draftReading'] = nextDraft;
          _items[idx]['ocrStatus'] = hasAiReading ? 'DONE' : 'NEEDS_MANUAL';
          _items[idx]['suggestionId'] = data['suggestion_id'];
          _items[idx]['confidence'] = data['confidence'];
          _items[idx]['detectedMeterType'] = out['detected_meter_type'];
          _items[idx]['ocrError'] = '';
        }
      });
    } catch (err) {
      if (_sessionGen != genId || !mounted) return;
      setState(() {
        final idx = _items.indexWhere((r) => r['localId'] == localId);
        if (idx >= 0) {
          _items[idx]['ocrStatus'] = 'FAILED';
          _items[idx]['ocrError'] = extractErrorMessage(err, 'Lỗi nhận diện AI');
        }
      });
    }
  }

  Future<void> _handleSaveBatch(String targetStatus) async {
    if (!widget.canWriteMeters) return;

    final evaluation = evaluateBatchPhotoImportItems(
      _items,
      _buildingMeters,
      anomalyThresholdPct: widget.anomalyThresholdPct,
      canWriteMeters: widget.canWriteMeters,
    );

    if (evaluation.saveableRows.isEmpty) {
      ref.read(toastProvider.notifier).warning('Không có dòng nào đủ điều kiện lưu.');
      return;
    }

    setState(() => _savingStatus = targetStatus);

    try {
      final payload = buildBatchPhotoSavePayload(
        saveableRows: evaluation.saveableRows,
        period: widget.period,
        targetStatus: targetStatus,
      );

      final res = await ref.read(metersServiceProvider).recordBatch(payload);

      final savedIds = evaluation.saveableRows.map((r) => r.raw['localId']).toSet();
      final remaining = _items.where((r) => !savedIds.contains(r['localId'])).toList();

      widget.onSaved?.call();

      if (remaining.isEmpty) {
        ref.read(toastProvider.notifier).success(
              res is Map && res['message'] != null
                  ? res['message'].toString()
                  : 'Đã lưu thành công ${payload['readings'].length} chỉ số công tơ.',
            );
        setState(() => _items.clear());
        if (mounted) Navigator.of(context).pop();
      } else {
        setState(() {
          _items.clear();
          _items.addAll(remaining);
        });
        await _fetchBuildingMeters(_targetBuildingId);
        ref.read(toastProvider.notifier).warning(
              'Đã lưu ${payload['readings'].length} chỉ số hợp lệ. Còn ${remaining.length} ảnh cần kiểm tra tiếp.',
            );
      }
    } catch (err) {
      ref.read(toastProvider.notifier).error(
            extractErrorMessage(err, 'Không thể lưu lô chỉ số từ ảnh.'),
          );
    } finally {
      if (mounted) setState(() => _savingStatus = null);
    }
  }

  Widget _buildValidationBadge(BatchPhotoImportRow row) {
    switch (row.validationState) {
      case 'OCR_PROCESSING':
        return const AppBadge(label: 'Đang đọc AI...', variant: AppBadgeVariant.indigo, dot: true);
      case 'MISSING_METER':
        return const AppBadge(label: 'Chọn công tơ', variant: AppBadgeVariant.amber, dot: true);
      case 'LOCKED_BILLED':
        return const AppBadge(label: 'Đã khóa HĐ', variant: AppBadgeVariant.slate, icon: Icon(LucideIcons.lock, size: 10));
      case 'DUPLICATE_METER_TARGET':
        return const AppBadge(label: 'Trùng công tơ', variant: AppBadgeVariant.red, dot: true);
      case 'MISSING_READING':
        return const AppBadge(label: 'Chưa có số', variant: AppBadgeVariant.amber, dot: true);
      case 'INVALID_READING':
        return const AppBadge(label: 'Nhỏ hơn số cũ', variant: AppBadgeVariant.red, dot: true);
      case 'READY_ABNORMAL':
        return AppBadge(label: 'Biến động >${widget.anomalyThresholdPct}%', variant: AppBadgeVariant.amber, dot: true);
      case 'READY':
        return const AppBadge(label: 'Sẵn sàng', variant: AppBadgeVariant.emerald, dot: true);
      default:
        return const SizedBox.shrink();
    }
  }

  @override
  Widget build(BuildContext context) {
    final evaluation = evaluateBatchPhotoImportItems(
      _items,
      _buildingMeters,
      anomalyThresholdPct: widget.anomalyThresholdPct,
      canWriteMeters: widget.canWriteMeters,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        // Controls Row
        Row(
          children: [
            Expanded(
              flex: 2,
              child: AppSelect<String>(
                label: 'Tòa nhà mục tiêu',
                value: _targetBuildingId,
                options: _buildings.map((b) {
                  return AppSelectOption(
                    value: b['id']?.toString() ?? '',
                    label: '${b['name']} (${b['code']})',
                  );
                }).toList(),
                onChanged: (val) {
                  if (val != null && val != _targetBuildingId) {
                    setState(() => _targetBuildingId = val);
                    _fetchBuildingMeters(val);
                  }
                },
              ),
            ),
            const SizedBox(width: 16),
            Expanded(
              flex: 3,
              child: Padding(
                padding: const EdgeInsets.only(top: 20.0),
                child: Row(
                  children: [
                    AppButton(
                      text: 'Tải ảnh chụp (Tối đa $kMaxBatchMeterPhotos ảnh)',
                      icon: const Icon(LucideIcons.cloudUpload, size: 16),
                      variant: AppButtonVariant.primary,
                      onPressed: _isQueueRunning ? null : _pickPhotos,
                    ),
                    if (_items.isNotEmpty) ...[
                      const SizedBox(width: 8),
                      AppButton(
                        text: 'Xóa toàn bộ',
                        variant: AppButtonVariant.outline,
                        onPressed: _isQueueRunning
                            ? null
                            : () {
                                _sessionGen++;
                                setState(() => _items.clear());
                              },
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),

        if (_isQueueRunning) ...[
          const SizedBox(height: 12),
          LinearProgressIndicator(
            value: _queueTotal > 0 ? _queueCompleted / _queueTotal : null,
            backgroundColor: AppColors.slate200,
            valueColor: const AlwaysStoppedAnimation(AppColors.primary500),
          ),
          const SizedBox(height: 4),
          Text(
            'Đang xử lý AI OCR ($_queueCompleted/$_queueTotal ảnh)...',
            style: const TextStyle(fontSize: 12, color: AppColors.slate500),
          ),
        ],

        const SizedBox(height: 16),

        // Items Table
        if (_items.isEmpty) ...[
          Container(
            padding: const EdgeInsets.symmetric(vertical: 48),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              border: Border.all(color: AppColors.border),
              borderRadius: BorderRadius.circular(12),
              color: AppColors.slate50,
            ),
            child: Column(
              children: [
                const Icon(LucideIcons.image, size: 40, color: AppColors.slate400),
                const SizedBox(height: 8),
                const Text(
                  'Chưa có ảnh nào được chọn',
                  style: TextStyle(fontWeight: FontWeight.w600, color: AppColors.slate700),
                ),
                const SizedBox(height: 4),
                Text(
                  'Chọn tòa nhà và nhấn "Tải ảnh chụp" để AI đọc chỉ số công tơ tự động',
                  style: const TextStyle(fontSize: 12, color: AppColors.slate500),
                ),
              ],
            ),
          ),
        ] else ...[
          Container(
            constraints: const BoxConstraints(maxHeight: 420),
            decoration: BoxDecoration(
              border: Border.all(color: AppColors.border),
              borderRadius: BorderRadius.circular(12),
            ),
            child: SingleChildScrollView(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: DataTable(
                  headingRowColor: WidgetStateProperty.all(AppColors.slate50),
                  columns: const [
                    DataColumn(label: Text('Ảnh chụp')),
                    DataColumn(label: Text('Tên file & Trạng thái AI')),
                    DataColumn(label: Text('Công tơ đích')),
                    DataColumn(label: Text('Chỉ số cũ')),
                    DataColumn(label: Text('Chỉ số mới (Draft)')),
                    DataColumn(label: Text('Tiêu thụ & Biến động')),
                    DataColumn(label: Text('Đánh giá')),
                    DataColumn(label: Text('Xóa')),
                  ],
                  rows: evaluation.rows.map((evalRow) {
                    final raw = evalRow.raw;
                    final meter = evalRow.meter;
                    final localId = raw['localId'];

                    return DataRow(
                      cells: [
                        DataCell(
                          InkWell(
                            onTap: () {
                              if (raw['imageDataUri'] != null) {
                                AuthMediaViewer.show(context, src: raw['imageDataUri'].toString());
                              }
                            },
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(6),
                              child: AuthImage(
                                src: raw['imageDataUri']?.toString(),
                                width: 44,
                                height: 44,
                                fit: BoxFit.cover,
                              ),
                            ),
                          ),
                        ),
                        DataCell(
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(
                                raw['fileName']?.toString() ?? '',
                                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
                              ),
                              if (raw['ocrError'] != null && raw['ocrError'].toString().isNotEmpty)
                                Text(
                                  raw['ocrError'].toString(),
                                  style: const TextStyle(fontSize: 11, color: AppColors.rose600),
                                ),
                            ],
                          ),
                        ),
                        DataCell(
                          SizedBox(
                            width: 220,
                            child: DropdownButton<String>(
                              isExpanded: true,
                              value: raw['meterId']?.toString(),
                              hint: const Text('-- Chọn công tơ --', style: TextStyle(fontSize: 12)),
                              items: [
                                const DropdownMenuItem(value: null, child: Text('-- Bỏ chọn --', style: TextStyle(fontSize: 12))),
                                ..._buildingMeters.map((m) {
                                  final type = m['meter_type'] == 'WATER' ? 'Nước' : 'Điện';
                                  return DropdownMenuItem(
                                    value: m['id']?.toString(),
                                    child: Text(
                                      'Căn ${m['apartment_code']} • $type (${m['meter_code']})',
                                      style: const TextStyle(fontSize: 12),
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  );
                                }),
                              ],
                              onChanged: (val) {
                                setState(() {
                                  final idx = _items.indexWhere((r) => r['localId'] == localId);
                                  if (idx >= 0) {
                                    _items[idx]['meterId'] = val;
                                    _items[idx]['manualMeterAssigned'] = true;
                                  }
                                });
                              },
                            ),
                          ),
                        ),
                        DataCell(Text(evalRow.prevReading != null ? evalRow.prevReading.toString() : '—')),
                        DataCell(
                          SizedBox(
                            width: 90,
                            child: AppInput(
                              initialValue: raw['draftReading']?.toString(),
                              onChanged: (val) {
                                final idx = _items.indexWhere((r) => r['localId'] == localId);
                                if (idx >= 0) {
                                  _items[idx]['draftReading'] = val.trim();
                                  _items[idx]['userEditedReading'] = true;
                                }
                                setState(() {});
                              },
                            ),
                          ),
                        ),
                        DataCell(
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(
                                evalRow.consumption != null ? '${evalRow.consumption} ${meter?['unit'] ?? ''}' : '—',
                                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
                              ),
                              if (evalRow.diffPct != null)
                                Text(
                                  '${evalRow.diffPct! > 0 ? '+' : ''}${evalRow.diffPct}%',
                                  style: TextStyle(
                                    fontSize: 11,
                                    color: evalRow.isAbnormal ? AppColors.amber600 : AppColors.slate500,
                                    fontWeight: evalRow.isAbnormal ? FontWeight.bold : FontWeight.normal,
                                  ),
                                ),
                            ],
                          ),
                        ),
                        DataCell(_buildValidationBadge(evalRow)),
                        DataCell(
                          IconButton(
                            icon: const Icon(LucideIcons.trash2, size: 16, color: AppColors.slate400),
                            onPressed: () {
                              setState(() {
                                _items.removeWhere((r) => r['localId'] == localId);
                              });
                            },
                          ),
                        ),
                      ],
                    );
                  }).toList(),
                ),
              ),
            ),
          ),
        ],

        const SizedBox(height: 16),

        // Summary Bar & Action Buttons
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AppColors.slate50,
            borderRadius: BorderRadius.circular(10),
            border: Border.all(color: AppColors.border),
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Wrap(
                spacing: 8,
                children: [
                  AppBadge(label: 'Hợp lệ: ${evaluation.summary.saveableCount}', variant: AppBadgeVariant.emerald),
                  if (evaluation.summary.abnormalSaveableCount > 0)
                    AppBadge(
                      label: 'Cảnh báo >${widget.anomalyThresholdPct}%: ${evaluation.summary.abnormalSaveableCount}',
                      variant: AppBadgeVariant.amber,
                    ),
                  if (evaluation.summary.duplicateCount > 0)
                    AppBadge(label: 'Trùng: ${evaluation.summary.duplicateCount}', variant: AppBadgeVariant.red),
                  if (evaluation.summary.skippedCount > 0)
                    AppBadge(label: 'Bỏ qua: ${evaluation.summary.skippedCount}', variant: AppBadgeVariant.slate),
                ],
              ),
              Row(
                children: [
                  AppButton(
                    text: 'Lưu nháp',
                    variant: AppButtonVariant.outline,
                    loading: _savingStatus == 'DRAFT',
                    onPressed: evaluation.saveableRows.isEmpty || _isQueueRunning
                        ? null
                        : () => _handleSaveBatch('DRAFT'),
                  ),
                  const SizedBox(width: 8),
                  AppButton(
                    text: 'Lưu & Chốt chỉ số',
                    variant: AppButtonVariant.primary,
                    loading: _savingStatus == 'CONFIRMED',
                    onPressed: evaluation.saveableRows.isEmpty || _isQueueRunning
                        ? null
                        : () => _handleSaveBatch('CONFIRMED'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}
