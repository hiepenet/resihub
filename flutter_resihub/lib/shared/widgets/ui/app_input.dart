import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../../../core/theme/app_colors.dart';

class AppInput extends StatelessWidget {
  final String? label;
  final String? hint;
  final String? error;
  final String? placeholder;
  final Widget? icon;
  final Widget? rightElement;
  final bool required;
  final bool multiline;
  final int rows;
  final TextEditingController? controller;
  final String? initialValue;
  final ValueChanged<String>? onChanged;
  final VoidCallback? onEditingComplete;
  final ValueChanged<String>? onSubmitted;
  final bool readOnly;
  final bool enabled;
  final bool obscureText;
  final TextInputType? keyboardType;
  final List<TextInputFormatter>? inputFormatters;
  final FocusNode? focusNode;

  const AppInput({
    super.key,
    this.label,
    this.hint,
    this.error,
    this.placeholder,
    this.icon,
    this.rightElement,
    this.required = false,
    this.multiline = false,
    this.rows = 3,
    this.controller,
    this.initialValue,
    this.onChanged,
    this.onEditingComplete,
    this.onSubmitted,
    this.readOnly = false,
    this.enabled = true,
    this.obscureText = false,
    this.keyboardType,
    this.inputFormatters,
    this.focusNode,
  });

  @override
  Widget build(BuildContext context) {
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
        TextFormField(
          focusNode: focusNode,
          controller: controller,
          initialValue: controller == null ? initialValue : null,
          onChanged: onChanged,
          onEditingComplete: onEditingComplete,
          onFieldSubmitted: onSubmitted,
          readOnly: readOnly,
          enabled: enabled,
          obscureText: obscureText,
          keyboardType: keyboardType ?? (multiline ? TextInputType.multiline : null),
          maxLines: multiline ? rows : 1,
          minLines: multiline ? rows : 1,
          inputFormatters: inputFormatters,
          style: const TextStyle(
            fontFamily: 'Inter',
            fontSize: 14,
            color: AppColors.slate900,
          ),
          decoration: InputDecoration(
            hintText: placeholder,
            hintStyle: const TextStyle(
              fontFamily: 'Inter',
              color: AppColors.textMuted,
              fontSize: 14,
            ),
            prefixIcon: icon != null
                ? Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    child: icon,
                  )
                : null,
            prefixIconConstraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            suffixIcon: rightElement != null
                ? Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    child: rightElement,
                  )
                : null,
            suffixIconConstraints: const BoxConstraints(minWidth: 36, minHeight: 36),
            isDense: true,
            contentPadding: EdgeInsets.symmetric(
              horizontal: 12,
              vertical: multiline ? 10 : 10,
            ),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: BorderSide(
                color: error != null ? AppColors.rose400 : AppColors.border,
              ),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: BorderSide(
                color: error != null ? AppColors.rose400 : AppColors.border,
              ),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(8),
              borderSide: BorderSide(
                color: error != null ? AppColors.rose500 : AppColors.primary500,
                width: 2,
              ),
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
