import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';

String _normalizeVnSearch(String input) {
  var str = input.toLowerCase().trim();
  const diacritics = {
    'à': 'a', 'á': 'a', 'ả': 'a', 'ã': 'a', 'ạ': 'a',
    'ă': 'a', 'ằ': 'a', 'ắ': 'a', 'ẳ': 'a', 'ẵ': 'a', 'ặ': 'a',
    'â': 'a', 'ầ': 'a', 'ấ': 'a', 'ẩ': 'a', 'ẫ': 'a', 'ậ': 'a',
    'è': 'e', 'é': 'e', 'ẻ': 'e', 'ẽ': 'e', 'ẹ': 'e',
    'ê': 'e', 'ề': 'e', 'ế': 'e', 'ể': 'e', 'ễ': 'e', 'ệ': 'e',
    'ì': 'i', 'í': 'i', 'ỉ': 'i', 'ĩ': 'i', 'ị': 'i',
    'ò': 'o', 'ó': 'o', 'ỏ': 'o', 'õ': 'o', 'ọ': 'o',
    'ô': 'o', 'ồ': 'o', 'ố': 'o', 'ổ': 'o', 'ỗ': 'o', 'ộ': 'o',
    'ơ': 'o', 'ờ': 'o', 'ớ': 'o', 'ở': 'o', 'ỡ': 'o', 'ợ': 'o',
    'ù': 'u', 'ú': 'u', 'ủ': 'u', 'ũ': 'u', 'ụ': 'u',
    'ư': 'u', 'ừ': 'u', 'ứ': 'u', 'ử': 'u', 'ữ': 'u', 'ự': 'u',
    'ỳ': 'y', 'ý': 'y', 'ỷ': 'y', 'ỹ': 'y', 'ỵ': 'y',
    'đ': 'd',
  };
  diacritics.forEach((k, v) {
    str = str.replaceAll(k, v);
  });
  return str;
}

class AppSelectOption<T> {
  final T value;
  final String label;
  final String? sublabel;
  final String? badge;
  final String? logo;
  final bool disabled;

  const AppSelectOption({
    required this.value,
    required this.label,
    this.sublabel,
    this.badge,
    this.logo,
    this.disabled = false,
  });
}

class AppSelect<T> extends StatelessWidget {
  final String? label;
  final String? placeholder;
  final T? value;
  final List<AppSelectOption<T>> options;
  final ValueChanged<T?>? onChanged;
  final String? error;
  final String? hint;
  final bool required;
  final bool disabled;
  final bool searchable;
  final String? searchPlaceholder;
  final String emptyText;
  final Widget? icon;

  const AppSelect({
    super.key,
    this.label,
    this.placeholder,
    this.value,
    required this.options,
    this.onChanged,
    this.error,
    this.hint,
    this.required = false,
    this.disabled = false,
    this.searchable = false,
    this.searchPlaceholder,
    this.emptyText = 'Không tìm thấy mục phù hợp',
    this.icon,
  });

  AppSelectOption<T>? get _selectedOption {
    for (final opt in options) {
      if (opt.value == value) return opt;
    }
    return null;
  }

  void _openSelectionDialog(BuildContext context) {
    if (disabled || onChanged == null) return;

    final isWide = MediaQuery.sizeOf(context).width >= 600;

    if (isWide) {
      showDialog<T>(
        context: context,
        barrierDismissible: true,
        builder: (ctx) => Dialog(
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480, maxHeight: 560),
            child: _AppSelectContent<T>(
              title: label ?? 'Chọn một mục',
              options: options,
              currentValue: value,
              searchable: searchable || options.length > 5,
              searchPlaceholder: searchPlaceholder,
              emptyText: emptyText,
              onSelect: (opt) {
                Navigator.of(ctx).pop(opt.value);
                onChanged?.call(opt.value);
              },
            ),
          ),
        ),
      );
    } else {
      showModalBottomSheet<T>(
        context: context,
        isScrollControlled: true,
        isDismissible: true,
        enableDrag: true,
        shape: const RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
        ),
        builder: (ctx) => SafeArea(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxHeight: MediaQuery.sizeOf(context).height * 0.75,
            ),
            child: _AppSelectContent<T>(
              title: label ?? 'Chọn một mục',
              options: options,
              currentValue: value,
              searchable: searchable || options.length > 5,
              searchPlaceholder: searchPlaceholder,
              emptyText: emptyText,
              onSelect: (opt) {
                Navigator.of(ctx).pop(opt.value);
                onChanged?.call(opt.value);
              },
            ),
          ),
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final selected = _selectedOption;
    final hasSelection = selected != null;
    final displayText = hasSelection ? selected.label : (placeholder ?? 'Chọn...');

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (label != null) ...[
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: Text(
                  label!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: AppColors.slate700,
                  ),
                ),
              ),
              if (required)
                const Text(
                  ' *',
                  style: TextStyle(
                    fontFamily: 'Inter',
                    color: AppColors.rose500,
                    fontWeight: FontWeight.bold,
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
        ],
        InkWell(
          onTap: disabled ? null : () => _openSelectionDialog(context),
          borderRadius: BorderRadius.circular(8),
          child: Container(
            height: 40,
            padding: const EdgeInsets.symmetric(horizontal: 12),
            decoration: BoxDecoration(
              color: disabled ? AppColors.slate50 : Colors.white,
              borderRadius: BorderRadius.circular(8),
              border: Border.all(
                color: error != null
                    ? AppColors.rose400
                    : AppColors.border,
              ),
            ),
            child: Row(
              children: [
                if (icon != null) ...[
                  icon!,
                  const SizedBox(width: 8),
                ],
                Expanded(
                  child: Text(
                    displayText,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 14,
                      color: hasSelection
                          ? (disabled ? AppColors.slate400 : AppColors.slate900)
                          : AppColors.textMuted,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                const Icon(
                  LucideIcons.chevronDown,
                  size: 16,
                  color: AppColors.slate400,
                ),
              ],
            ),
          ),
        ),
        if (error != null) ...[
          const SizedBox(height: 4),
          Text(
            error!,
            style: const TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              color: AppColors.rose600,
            ),
          ),
        ] else if (hint != null) ...[
          const SizedBox(height: 4),
          Text(
            hint!,
            style: const TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              color: AppColors.slate500,
            ),
          ),
        ],
      ],
    );
  }
}

class _AppSelectContent<T> extends StatefulWidget {
  final String title;
  final List<AppSelectOption<T>> options;
  final T? currentValue;
  final bool searchable;
  final String? searchPlaceholder;
  final String emptyText;
  final ValueChanged<AppSelectOption<T>> onSelect;

  const _AppSelectContent({
    required this.title,
    required this.options,
    required this.currentValue,
    required this.searchable,
    required this.searchPlaceholder,
    required this.emptyText,
    required this.onSelect,
  });

  @override
  State<_AppSelectContent<T>> createState() => _AppSelectContentState<T>();
}

class _AppSelectContentState<T> extends State<_AppSelectContent<T>> {
  String _search = '';

  List<AppSelectOption<T>> get _filteredOptions {
    if (_search.isEmpty) return widget.options;
    final q = _normalizeVnSearch(_search);
    return widget.options.where((opt) {
      final labelNorm = _normalizeVnSearch(opt.label);
      final sublabelNorm = opt.sublabel != null ? _normalizeVnSearch(opt.sublabel!) : '';
      return labelNorm.contains(q) || sublabelNorm.contains(q);
    }).toList();
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _filteredOptions;

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 14, 12, 10),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  widget.title,
                  style: const TextStyle(
                    fontFamily: 'Inter',
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    color: AppColors.slate900,
                  ),
                ),
              ),
              IconButton(
                icon: const Icon(LucideIcons.x, size: 18, color: AppColors.slate400),
                onPressed: () => Navigator.of(context).pop(),
                splashRadius: 18,
              ),
            ],
          ),
        ),
        if (widget.searchable)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: TextField(
              autofocus: false,
              onChanged: (val) => setState(() => _search = val),
              decoration: InputDecoration(
                hintText: widget.searchPlaceholder ?? 'Tìm kiếm...',
                hintStyle: const TextStyle(fontSize: 13, color: AppColors.slate400),
                prefixIcon: const Icon(LucideIcons.search, size: 16, color: AppColors.slate400),
                prefixIconConstraints: const BoxConstraints(minWidth: 36, minHeight: 36),
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                fillColor: AppColors.slate50,
              ),
            ),
          ),
        const Divider(height: 1),
        Flexible(
          child: filtered.isEmpty
              ? Padding(
                  padding: const EdgeInsets.all(24),
                  child: Center(
                    child: Text(
                      widget.emptyText,
                      style: const TextStyle(fontSize: 13, color: AppColors.slate500),
                    ),
                  ),
                )
              : ListView.builder(
                  shrinkWrap: true,
                  itemCount: filtered.length,
                  itemBuilder: (ctx, idx) {
                    final opt = filtered[idx];
                    final isSelected = opt.value == widget.currentValue;

                    return ListTile(
                      enabled: !opt.disabled,
                      dense: true,
                      title: Text(
                        opt.label,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontFamily: 'Inter',
                          fontSize: 14,
                          fontWeight: isSelected ? FontWeight.w600 : FontWeight.w400,
                          color: isSelected ? AppColors.primary700 : AppColors.slate800,
                        ),
                      ),
                      subtitle: opt.sublabel != null
                          ? Text(
                              opt.sublabel!,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontSize: 12, color: AppColors.slate500),
                            )
                          : null,
                      trailing: isSelected
                          ? const Icon(LucideIcons.check, size: 18, color: AppColors.primary600)
                          : null,
                      onTap: opt.disabled ? null : () => widget.onSelect(opt),
                    );
                  },
                ),
        ),
      ],
    );
  }
}
