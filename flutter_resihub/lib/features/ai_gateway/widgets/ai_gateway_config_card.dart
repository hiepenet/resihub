import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../../../shared/widgets/ui/app_badge.dart';
import '../../../shared/widgets/ui/app_button.dart';
import '../../../shared/widgets/ui/app_card.dart';
import '../../../shared/widgets/ui/app_input.dart';
import '../../../shared/widgets/ui/app_select.dart';
import '../../../shared/widgets/ui/money_input.dart';
import '../services/ai_service.dart';

const List<AppSelectOption<String>> kAiModelOptions = [
  AppSelectOption(
    value: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash (Cân bằng tốc độ & đa phương thức — Khuyến nghị)',
  ),
  AppSelectOption(
    value: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash (Phản hồi nhanh ~2s & rất ổn định trên Free Tier)',
  ),
  AppSelectOption(
    value: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite (Tối ưu chi phí tác vụ nhẹ)',
  ),
  AppSelectOption(
    value: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite (Tiết kiệm chi phí, ngữ cảnh 1M token)',
  ),
  AppSelectOption(
    value: 'gemini-4-argon',
    label: 'Gemini 4 Argon (Suy luận sâu tài liệu phức tạp — Yêu cầu Paid Tier)',
  ),
];

/// Reusable AI Gateway & Gemini Configuration Card.
/// Port of `frontend/src/components/settings/AiGatewayConfigCard.jsx`.
class AiGatewayConfigCard extends ConsumerStatefulWidget {
  final Map<String, dynamic> aiConfig;
  final ValueChanged<Map<String, dynamic>>? onChange;
  final bool apiKeyConfigured;
  final bool canEdit;
  final VoidCallback? onReset;
  final bool resetting;

  const AiGatewayConfigCard({
    super.key,
    required this.aiConfig,
    this.onChange,
    this.apiKeyConfigured = false,
    this.canEdit = false,
    this.onReset,
    this.resetting = false,
  });

  @override
  ConsumerState<AiGatewayConfigCard> createState() => _AiGatewayConfigCardState();
}

class _AiGatewayConfigCardState extends ConsumerState<AiGatewayConfigCard> {
  Map<String, dynamic>? _usage;
  bool _loadingUsage = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _loadUsage();
    });
  }

  Future<void> _loadUsage() async {
    setState(() => _loadingUsage = true);
    try {
      final aiService = ref.read(aiServiceProvider);
      final res = await aiService.getUsageSummary();
      if (mounted) {
        if (res is Map && res['data'] is Map) {
          setState(() => _usage = Map<String, dynamic>.from(res['data'] as Map));
        } else if (res is Map) {
          setState(() => _usage = Map<String, dynamic>.from(res));
        }
      }
    } catch (_) {
      // Non-blocking fallback if usage endpoint is temporarily unavailable
    } finally {
      if (mounted) {
        setState(() => _loadingUsage = false);
      }
    }
  }

  void _setField(String key, dynamic value) {
    if (!widget.canEdit || widget.onChange == null) return;
    widget.onChange!({
      ...widget.aiConfig,
      key: value,
    });
  }

  void _setTaskFlag(String taskKey, bool checked) {
    if (!widget.canEdit || widget.onChange == null) return;
    final currentTasks = widget.aiConfig['tasks'] is Map ? Map<String, dynamic>.from(widget.aiConfig['tasks'] as Map) : <String, dynamic>{};
    currentTasks[taskKey] = checked;

    widget.onChange!({
      ...widget.aiConfig,
      'tasks': currentTasks,
    });
  }

  @override
  Widget build(BuildContext context) {
    final effectiveKeyOk = (_usage?['api_key_configured'] as bool?) ?? widget.apiKeyConfigured;
    final isEnabled = widget.aiConfig['enabled'] != false;
    final rawTasks = widget.aiConfig['tasks'] is Map ? widget.aiConfig['tasks'] as Map : const {};

    final budgetPct = math.min(100.0, math.max(0.0, double.tryParse(_usage?['monthly_budget_pct']?.toString() ?? '') ?? 0.0));
    final tokenPct = math.min(100.0, math.max(0.0, double.tryParse(_usage?['monthly_token_pct']?.toString() ?? '') ?? 0.0));
    final warnActive = _usage?['warn_triggered'] == true;

    final tasks = [
      {
        'key': 'cccd_extract',
        'title': 'AI-01a: Quét CCCD',
        'desc': 'Trích xuất Họ tên, Số CCCD, Ngày sinh, Quê quán',
      },
      {
        'key': 'contract_extract',
        'title': 'AI-01b: Quét Hợp đồng',
        'desc': 'Đọc ảnh chụp / PDF scan hợp đồng giấy sang bản nháp',
      },
      {
        'key': 'meter_ocr',
        'title': 'AI-02: OCR Đồng hồ',
        'desc': 'Đọc chỉ số điện/nước & cảnh báo ảnh mờ, lóa',
      },
      {
        'key': 'ticket_triage',
        'title': 'AI-03: Phân loại Báo hỏng',
        'desc': 'Tự động gợi ý danh mục, độ khẩn & người xử lý',
      },
    ];

    return AppCard(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Cổng Trợ lý AI — Gemini Gateway (M15)',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        color: AppColors.slate900,
                      ),
                    ),
                    SizedBox(height: 4),
                    Text(
                      'Nguyên tắc cốt lõi PRD 12.1: AI chỉ đề xuất nháp — người dùng xác nhận mới ghi vào cơ sở dữ liệu. Hỗ trợ Kill Switch tổng & hạn mức chi phí tháng.',
                      style: TextStyle(fontSize: 12, color: AppColors.slate500),
                    ),
                  ],
                ),
              ),
              Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  AppBadge(
                    label: effectiveKeyOk ? 'GEMINI_API_KEY đã kết nối' : 'Chưa cấu hình GEMINI_API_KEY',
                    variant: effectiveKeyOk ? AppBadgeVariant.emerald : AppBadgeVariant.red,
                    dot: true,
                  ),
                  AppButton(
                    text: 'Làm mới thống kê',
                    size: AppButtonSize.xs,
                    variant: AppButtonVariant.outline,
                    icon: const Icon(LucideIcons.refreshCw, size: 13),
                    loading: _loadingUsage,
                    onPressed: _loadUsage,
                  ),
                  if (widget.canEdit && widget.onReset != null)
                    AppButton(
                      text: 'Khôi phục mặc định',
                      size: AppButtonSize.xs,
                      variant: AppButtonVariant.outline,
                      icon: const Icon(LucideIcons.rotateCcw, size: 13),
                      loading: widget.resetting,
                      onPressed: widget.onReset,
                    ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 16),

          if (!effectiveKeyOk) ...[
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: AppColors.rose50,
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: AppColors.rose200),
              ),
              child: const Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(LucideIcons.circleX, size: 16, color: AppColors.rose600),
                  SizedBox(width: 10),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Máy chủ Backend chưa nhận biến môi trường GEMINI_API_KEY',
                          style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.rose800),
                        ),
                        SizedBox(height: 2),
                        Text(
                          'Khóa kết nối Gemini chỉ lưu trên biến môi trường máy chủ (api/.env), tuyệt đối không gửi xuống trình duyệt. Khi chưa cấu hình, mọi biểu mẫu vẫn nhập thủ công bình thường.',
                          style: TextStyle(fontSize: 11, color: AppColors.rose700),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 16),
          ],

          // Master Kill Switch
          InkWell(
            onTap: widget.canEdit ? () => _setField('enabled', !isEnabled) : null,
            borderRadius: BorderRadius.circular(10),
            child: Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: isEnabled ? AppColors.emerald50.withValues(alpha: 0.6) : AppColors.rose50.withValues(alpha: 0.7),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(
                  color: isEnabled ? AppColors.emerald200 : AppColors.rose300,
                ),
              ),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Checkbox(
                    value: isEnabled,
                    onChanged: widget.canEdit ? (val) => _setField('enabled', val ?? false) : null,
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Text(
                              'Bật AI Gateway toàn tổ chức (Master Switch)',
                              style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: AppColors.slate900),
                            ),
                            const SizedBox(width: 8),
                            AppBadge(
                              label: isEnabled ? 'ĐANG BẬT' : 'ĐÃ NGẮT (KILL SWITCH)',
                              variant: isEnabled ? AppBadgeVariant.emerald : AppBadgeVariant.red,
                            ),
                          ],
                        ),
                        const SizedBox(height: 4),
                        const Text(
                          'Bỏ chọn để ngắt tức thì mọi lời gọi ra Gemini API khi cần kiểm soát chi phí hoặc bảo trì (R-09 / PRD 12.6). Luồng nhập tay không bị ảnh hưởng.',
                          style: TextStyle(fontSize: 11, color: AppColors.slate600),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),

          // 4 Task Flags
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: tasks.map((t) {
              final taskKey = t['key']!;
              final checked = rawTasks[taskKey] != false;

              return SizedBox(
                width: 280,
                child: InkWell(
                  onTap: widget.canEdit && isEnabled ? () => _setTaskFlag(taskKey, !checked) : null,
                  borderRadius: BorderRadius.circular(10),
                  child: Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: checked && isEnabled ? AppColors.amber50.withValues(alpha: 0.4) : AppColors.slate50,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color: checked && isEnabled ? AppColors.amber300 : AppColors.border,
                      ),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Checkbox(
                          value: checked,
                          onChanged: widget.canEdit && isEnabled ? (val) => _setTaskFlag(taskKey, val ?? false) : null,
                        ),
                        const SizedBox(width: 6),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                t['title']!,
                                style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: AppColors.slate900),
                              ),
                              const SizedBox(height: 2),
                              Text(
                                t['desc']!,
                                style: const TextStyle(fontSize: 11, color: AppColors.slate500),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              );
            }).toList(),
          ),
          const SizedBox(height: 20),

          // Configuration Inputs
          Wrap(
            spacing: 16,
            runSpacing: 16,
            children: [
              SizedBox(
                width: 320,
                child: AppSelect<String>(
                  label: 'Mô hình Gemini mặc định',
                  disabled: !widget.canEdit,
                  value: widget.aiConfig['model']?.toString() ?? 'gemini-3.8-flash',
                  options: kAiModelOptions,
                  onChanged: (val) => _setField('model', val),
                ),
              ),
              SizedBox(
                width: 300,
                child: MoneyInput(
                  label: 'Trần ngân sách AI tháng (VNĐ)',
                  disabled: !widget.canEdit,
                  value: widget.aiConfig['monthly_budget_vnd'] ?? 1000000,
                  hint: 'Tự động chặn gọi mới khi chạm 100% hạn mức tháng',
                  onChanged: (val) => _setField('monthly_budget_vnd', int.tryParse(val.replaceAll(RegExp(r'\D'), '')) ?? 0),
                ),
              ),
              SizedBox(
                width: 220,
                child: AppInput(
                  label: 'Trần Token tháng (Input + Output)',
                  placeholder: '5000000',
                  initialValue: (widget.aiConfig['monthly_token_limit'] ?? 5000000).toString(),
                  enabled: widget.canEdit,
                  hint: 'Cảnh báo Quản trị viên khi đạt ${widget.aiConfig['warn_percent'] ?? 80}%',
                  onChanged: (val) => _setField('monthly_token_limit', int.tryParse(val) ?? 5000000),
                ),
              ),
              SizedBox(
                width: 220,
                child: AppInput(
                  label: 'Ngưỡng tin cậy OCR Đồng hồ (0.50 – 0.99)',
                  placeholder: '0.85',
                  initialValue: (widget.aiConfig['ocr_threshold'] ?? 0.85).toString(),
                  enabled: widget.canEdit,
                  hint: 'Dưới ngưỡng này AI để trống ô chỉ số để nhập tay (AC-014.1)',
                  onChanged: (val) => _setField('ocr_threshold', double.tryParse(val) ?? 0.85),
                ),
              ),
              SizedBox(
                width: 220,
                child: AppInput(
                  label: 'Ngưỡng tin cậy Quét CCCD / HĐ',
                  placeholder: '0.75',
                  initialValue: (widget.aiConfig['extract_threshold'] ?? 0.75).toString(),
                  enabled: widget.canEdit,
                  hint: 'Mặc định 0.75 (75%)',
                  onChanged: (val) => _setField('extract_threshold', double.tryParse(val) ?? 0.75),
                ),
              ),
              SizedBox(
                width: 220,
                child: AppInput(
                  label: 'Ngưỡng tin cậy Phân loại Báo hỏng',
                  placeholder: '0.65',
                  initialValue: (widget.aiConfig['triage_threshold'] ?? 0.65).toString(),
                  enabled: widget.canEdit,
                  hint: 'Dưới ngưỡng sẽ gắn nhãn Cần phân loại thủ công (AC-011.2)',
                  onChanged: (val) => _setField('triage_threshold', double.tryParse(val) ?? 0.65),
                ),
              ),
            ],
          ),

          // Usage & KPIs summary
          if (_usage != null) ...[
            const SizedBox(height: 20),
            const Divider(color: AppColors.border),
            const SizedBox(height: 16),

            if (warnActive) ...[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: AppColors.amber50,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: AppColors.amber300),
                ),
                child: Row(
                  children: [
                    const Icon(LucideIcons.shieldAlert, size: 16, color: AppColors.amber600),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        'Chi phí hoặc sản lượng token AI kỳ ${_usage!['period']} đã vượt ngưỡng cảnh báo ${_usage!['warn_percent'] ?? 80}%.',
                        style: const TextStyle(fontSize: 12, color: AppColors.amber900),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
            ],

            Wrap(
              spacing: 16,
              runSpacing: 16,
              children: [
                SizedBox(
                  width: 340,
                  child: Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.slate50,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.border),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          'Chi phí ước tính kỳ ${_usage!['period'] ?? ''}',
                          style: const TextStyle(fontSize: 11, color: AppColors.slate600),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${formatMoney(_usage!['monthly_cost_vnd'])} / ${formatMoney(_usage!['monthly_budget_vnd'])}',
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.slate900),
                        ),
                        const SizedBox(height: 8),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(4),
                          child: LinearProgressIndicator(
                            value: (budgetPct / 100.0).clamp(0.0, 1.0),
                            backgroundColor: AppColors.slate200,
                            valueColor: AlwaysStoppedAnimation<Color>(
                              budgetPct >= 80 ? AppColors.rose500 : AppColors.emerald500,
                            ),
                            minHeight: 6,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          '${_usage!['monthly_calls'] ?? 0} lượt gọi AI • Đã dùng $budgetPct% ngân sách',
                          style: const TextStyle(fontSize: 10, color: AppColors.slate500),
                        ),
                      ],
                    ),
                  ),
                ),

                SizedBox(
                  width: 340,
                  child: Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.slate50,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.border),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Sản lượng Token tháng',
                          style: TextStyle(fontSize: 11, color: AppColors.slate600),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          '${_usage!['monthly_tokens_used'] ?? 0} tok',
                          style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700, color: AppColors.slate900),
                        ),
                        const SizedBox(height: 8),
                        ClipRRect(
                          borderRadius: BorderRadius.circular(4),
                          child: LinearProgressIndicator(
                            value: (tokenPct / 100.0).clamp(0.0, 1.0),
                            backgroundColor: AppColors.slate200,
                            valueColor: AlwaysStoppedAnimation<Color>(
                              tokenPct >= 80 ? AppColors.amber500 : AppColors.primary500,
                            ),
                            minHeight: 6,
                          ),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          'Hạn mức: ${_usage!['monthly_token_limit'] ?? 0} token ($tokenPct%)',
                          style: const TextStyle(fontSize: 10, color: AppColors.slate500),
                        ),
                      ],
                    ),
                  ),
                ),

                SizedBox(
                  width: 340,
                  child: Container(
                    padding: const EdgeInsets.all(14),
                    decoration: BoxDecoration(
                      color: AppColors.amber50.withValues(alpha: 0.5),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: AppColors.amber200),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Row(
                          mainAxisAlignment: MainAxisAlignment.spaceBetween,
                          children: [
                            Expanded(
                              child: Text(
                                'Chỉ số mục tiêu G6 (PRD Mục 4)',
                                style: TextStyle(fontSize: 11, fontWeight: FontWeight.w700, color: AppColors.slate900),
                              ),
                            ),
                            SizedBox(width: 4),
                            Icon(LucideIcons.sparkles, size: 14, color: AppColors.amber600),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Text(
                          'Chấp nhận trường trích xuất không sửa: ${_usage!['kpi_g6']?['exact_field_acceptance_rate_pct'] ?? 'Chưa có mẫu'}% (Mục tiêu ≥ ${_usage!['kpi_g6']?['target_pct'] ?? 70}%)',
                          style: const TextStyle(fontSize: 11, color: AppColors.slate700),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          'Giữ nguyên phân loại báo hỏng: ${_usage!['kpi_g6']?['triage_keep_rate_pct'] ?? 'Chưa có mẫu'}% (Mục tiêu ≥ ${_usage!['kpi_g6']?['triage_target_pct'] ?? 80}%)',
                          style: const TextStyle(fontSize: 11, color: AppColors.slate700),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}
