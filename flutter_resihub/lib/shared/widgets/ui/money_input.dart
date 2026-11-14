import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/money_input_helpers.dart';

class MoneyInput extends StatefulWidget {
  final String? label;
  final String? hint;
  final String? error;
  final bool required;
  final bool allowNegative;
  final dynamic value;
  final ValueChanged<String>? onChanged;
  final VoidCallback? onEditingComplete;
  final String? placeholder;
  final bool disabled;
  final Widget? icon;
  final Widget? rightElement;
  final FocusNode? focusNode;

  const MoneyInput({
    super.key,
    this.label,
    this.hint,
    this.error,
    this.required = false,
    this.allowNegative = false,
    this.value,
    this.onChanged,
    this.onEditingComplete,
    this.placeholder,
    this.disabled = false,
    this.icon,
    this.rightElement,
    this.focusNode,
  });

  @override
  State<MoneyInput> createState() => MoneyInputState();
}

class MoneyInputState extends State<MoneyInput> {
  late final TextEditingController controller;
  late FocusNode _internalFocusNode;
  String _rawMoneyValue = '';

  FocusNode get effectiveFocusNode => widget.focusNode ?? _internalFocusNode;

  @override
  void initState() {
    super.initState();
    _internalFocusNode = FocusNode(onKeyEvent: _handleKeyEvent);
    if (widget.focusNode != null) {
      widget.focusNode!.onKeyEvent = _handleKeyEvent;
    }
    _rawMoneyValue = normalizeMoneyPropValue(widget.value, allowNegative: widget.allowNegative);
    final initialDisplay = formatMoneyInputDisplay(widget.value, allowNegative: widget.allowNegative);
    controller = TextEditingController(text: initialDisplay);
  }

  @override
  void didUpdateWidget(covariant MoneyInput oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.value != oldWidget.value) {
      final newClean = normalizeMoneyPropValue(widget.value, allowNegative: widget.allowNegative);
      if (newClean != _rawMoneyValue) {
        _rawMoneyValue = newClean;
        final formatted = formatMoneyInputDisplay(widget.value, allowNegative: widget.allowNegative);
        controller.value = TextEditingValue(
          text: formatted,
          selection: TextSelection.collapsed(offset: formatted.length),
        );
      }
    }
  }

  @override
  void dispose() {
    controller.dispose();
    _internalFocusNode.dispose();
    super.dispose();
  }

  bool handleSeparatorKey(String key) {
    final sel = controller.selection;
    final sepResult = handleMoneySeparatorKey(
      controller.text,
      sel.start,
      sel.end,
      key,
      allowNegative: widget.allowNegative,
    );

    if (sepResult.handled) {
      _rawMoneyValue = sepResult.rawValue ?? '';
      final disp = sepResult.displayValue ?? '';
      final nextCaret = (sepResult.nextCaretIndex ?? disp.length).clamp(0, disp.length);
      controller.value = TextEditingValue(
        text: disp,
        selection: TextSelection.collapsed(offset: nextCaret),
      );
      widget.onChanged?.call(_rawMoneyValue);
      return true;
    }
    return false;
  }

  KeyEventResult _handleKeyEvent(FocusNode node, KeyEvent event) {
    if (event is KeyDownEvent) {
      final keyName = event.logicalKey == LogicalKeyboardKey.backspace
          ? 'Backspace'
          : (event.logicalKey == LogicalKeyboardKey.delete ? 'Delete' : null);

      if (keyName != null && handleSeparatorKey(keyName)) {
        return KeyEventResult.handled;
      }
    }
    return KeyEventResult.ignored;
  }

  void _onTextChanged(String domText) {
    final caret = controller.selection.baseOffset;
    final parsed = parseMoneyUserEdit(
      domText,
      caret,
      allowNegative: widget.allowNegative,
    );

    _rawMoneyValue = parsed.rawValue;
    final nextCaret = parsed.nextCaretIndex.clamp(0, parsed.displayValue.length);

    controller.value = TextEditingValue(
      text: parsed.displayValue,
      selection: TextSelection.collapsed(offset: nextCaret),
    );

    widget.onChanged?.call(parsed.rawValue);
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (widget.label != null) ...[
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                widget.label!,
                style: const TextStyle(
                  fontFamily: 'Inter',
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: AppColors.slate700,
                ),
              ),
              if (widget.required)
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
        TextField(
          controller: controller,
          focusNode: effectiveFocusNode,
          enabled: !widget.disabled,
          keyboardType: widget.allowNegative ? TextInputType.text : TextInputType.number,
          inputFormatters: [
            FilteringTextInputFormatter.allow(
              widget.allowNegative ? RegExp(r'[-0-9.]') : RegExp(r'[0-9.]'),
            ),
          ],
          onChanged: _onTextChanged,
          onEditingComplete: widget.onEditingComplete,
          style: const TextStyle(
            fontFamily: 'monospace',
            fontSize: 14,
            color: AppColors.slate900,
          ),
          decoration: InputDecoration(
            hintText: widget.placeholder,
            hintStyle: const TextStyle(
              fontFamily: 'Inter',
              color: AppColors.textMuted,
              fontSize: 14,
            ),
            prefixIcon: widget.icon != null
                ? Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    child: widget.icon,
                  )
                : null,
            prefixIconConstraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            suffixIcon: widget.rightElement != null
                ? Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    child: widget.rightElement,
                  )
                : null,
            suffixIconConstraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            isDense: true,
            contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: BorderSide(
                color: widget.error != null ? AppColors.rose400 : AppColors.border,
              ),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: BorderSide(
                color: widget.error != null ? AppColors.rose400 : AppColors.border,
              ),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: BorderSide(
                color: widget.error != null ? AppColors.rose500 : AppColors.primary500,
                width: 2,
              ),
            ),
          ),
        ),
        if (widget.error != null) ...[
          const SizedBox(height: 4),
          Text(
            widget.error!,
            style: const TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              color: AppColors.rose600,
            ),
          ),
        ] else if (widget.hint != null) ...[
          const SizedBox(height: 4),
          Text(
            widget.hint!,
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
