import 'dart:async';
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';

/// Search input with debouncing, search icon, clear button, and placeholder.
/// Port of `frontend/src/components/common/SearchBar.jsx`.
class SearchBarWidget extends StatefulWidget {
  final String? value;
  final ValueChanged<String>? onChanged;
  final String placeholder;
  final Duration debounceDuration;
  final VoidCallback? onClear;

  const SearchBarWidget({
    super.key,
    this.value,
    this.onChanged,
    this.placeholder = 'Tìm kiếm...',
    this.debounceDuration = const Duration(milliseconds: 300),
    this.onClear,
  });

  @override
  State<SearchBarWidget> createState() => _SearchBarWidgetState();
}

class _SearchBarWidgetState extends State<SearchBarWidget> {
  late TextEditingController _controller;
  Timer? _debounceTimer;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.value ?? '');
  }

  @override
  void didUpdateWidget(covariant SearchBarWidget oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.value != null && widget.value != _controller.text) {
      _controller.text = widget.value!;
    }
  }

  @override
  void dispose() {
    _debounceTimer?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _onTextChanged(String text) {
    _debounceTimer?.cancel();
    _debounceTimer = Timer(widget.debounceDuration, () {
      widget.onChanged?.call(text);
    });
    setState(() {});
  }

  void _handleClear() {
    _controller.clear();
    _debounceTimer?.cancel();
    widget.onChanged?.call('');
    widget.onClear?.call();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final hasText = _controller.text.isNotEmpty;

    return Container(
      height: 38,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.slate200),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          const Padding(
            padding: EdgeInsets.only(left: 10, right: 8),
            child: Icon(
              LucideIcons.search,
              size: 16,
              color: AppColors.slate400,
            ),
          ),
          Expanded(
            child: TextField(
              controller: _controller,
              onChanged: _onTextChanged,
              style: const TextStyle(
                fontSize: 13,
                color: AppColors.slate800,
              ),
              decoration: InputDecoration(
                hintText: widget.placeholder,
                hintStyle: const TextStyle(
                  fontSize: 13,
                  color: AppColors.slate400,
                ),
                border: InputBorder.none,
                isDense: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 8),
              ),
            ),
          ),
          if (hasText)
            InkWell(
              onTap: _handleClear,
              borderRadius: BorderRadius.circular(12),
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                child: Icon(
                  LucideIcons.x,
                  size: 14,
                  color: AppColors.slate400,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
