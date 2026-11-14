import 'dart:convert';
import 'dart:typed_data';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/theme/app_colors.dart';
import 'app_skeleton.dart';
import 'auth_pdf_viewer.dart';

bool isPdfMediaSource(String? src) {
  if (src == null || src.isEmpty) return false;
  final s = src.toLowerCase().trim();
  return s.startsWith('data:application/pdf') ||
      s.endsWith('.pdf') ||
      s.contains('.pdf?') ||
      s.contains('/pdf');
}

class AuthImage extends ConsumerStatefulWidget {
  final String? src;
  final String? alt;
  final double? width;
  final double? height;
  final BoxFit fit;
  final Dio? dio;

  const AuthImage({
    super.key,
    required this.src,
    this.alt,
    this.width,
    this.height,
    this.fit = BoxFit.cover,
    this.dio,
  });

  @override
  ConsumerState<AuthImage> createState() => _AuthImageState();
}

class _AuthImageState extends ConsumerState<AuthImage> {
  Uint8List? _memoryBytes;
  bool _isLoading = false;
  bool _isError = false;

  @override
  void initState() {
    super.initState();
    _loadImage();
  }

  @override
  void didUpdateWidget(covariant AuthImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.src != oldWidget.src) {
      _loadImage();
    }
  }

  Future<void> _loadImage() async {
    final src = widget.src?.trim();
    if (src == null || src.isEmpty) {
      setState(() {
        _memoryBytes = null;
        _isLoading = false;
        _isError = false;
      });
      return;
    }

    // 1. Data URI
    if (src.startsWith('data:')) {
      try {
        final commaIdx = src.indexOf(',');
        final base64Data = commaIdx >= 0 ? src.substring(commaIdx + 1) : src;
        final decoded = base64Decode(base64Data);
        setState(() {
          _memoryBytes = decoded;
          _isLoading = false;
          _isError = false;
        });
      } catch (_) {
        setState(() {
          _isError = true;
          _isLoading = false;
        });
      }
      return;
    }

    // 2. Protected internal API attachment URL
    if (isProtectedApiAttachmentUrl(src)) {
      setState(() {
        _isLoading = true;
        _isError = false;
      });

      try {
        final Dio dio = widget.dio ?? ref.read(dioProvider);
        final bytes = await fetchAuthAttachmentBytes(dio, src);
        if (mounted) {
          setState(() {
            _memoryBytes = bytes;
            _isLoading = false;
            _isError = false;
          });
        }
      } catch (_) {
        if (mounted) {
          setState(() {
            _isError = true;
            _isLoading = false;
          });
        }
      }
      return;
    }

    // 3. External HTTP / HTTPS image URL (e.g. VietQR)
    setState(() {
      _memoryBytes = null;
      _isLoading = false;
      _isError = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final src = widget.src?.trim();

    if (src == null || src.isEmpty) {
      return _buildFallback(LucideIcons.image);
    }

    if (_isLoading) {
      return SizedBox(
        width: widget.width,
        height: widget.height,
        child: const AppSkeleton(),
      );
    }

    if (_isError) {
      return _buildFallback(LucideIcons.imageOff, isError: true);
    }

    if (_memoryBytes != null) {
      return Image.memory(
        _memoryBytes!,
        width: widget.width,
        height: widget.height,
        fit: widget.fit,
        errorBuilder: (_, __, ___) => _buildFallback(LucideIcons.imageOff, isError: true),
      );
    }

    // External URL without Bearer auth
    return Image.network(
      src,
      width: widget.width,
      height: widget.height,
      fit: widget.fit,
      errorBuilder: (_, __, ___) => _buildFallback(LucideIcons.imageOff, isError: true),
    );
  }

  Widget _buildFallback(IconData icon, {bool isError = false}) {
    return Container(
      width: widget.width,
      height: widget.height,
      decoration: BoxDecoration(
        color: isError ? AppColors.rose50 : AppColors.slate100,
        borderRadius: BorderRadius.circular(8),
      ),
      alignment: Alignment.center,
      child: Icon(
        icon,
        size: 20,
        color: isError ? AppColors.rose400 : AppColors.slate400,
      ),
    );
  }
}

class AuthMediaViewer extends StatelessWidget {
  final String src;
  final String title;

  const AuthMediaViewer({
    super.key,
    required this.src,
    this.title = 'Chi tiết tài liệu',
  });

  static Future<void> show(
    BuildContext context, {
    required String src,
    String title = 'Chi tiết tài liệu',
  }) {
    return showDialog<void>(
      context: context,
      barrierColor: AppColors.slate900.withValues(alpha: 0.75),
      builder: (ctx) => Dialog(
        backgroundColor: Colors.transparent,
        insetPadding: const EdgeInsets.all(16),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 800, maxHeight: 680),
          child: Container(
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(16),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text(
                          title,
                          style: const TextStyle(
                            fontFamily: 'Inter',
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                            color: AppColors.slate900,
                          ),
                        ),
                      ),
                      IconButton(
                        icon: const Icon(LucideIcons.x, size: 20, color: AppColors.slate500),
                        onPressed: () => Navigator.of(ctx).pop(),
                        splashRadius: 20,
                      ),
                    ],
                  ),
                ),
                const Divider(height: 1),
                Expanded(
                  child: AuthMediaViewer(src: src, title: title),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (isPdfMediaSource(src)) {
      return AuthPdfViewer(src: src, title: title);
    }

    return InteractiveViewer(
      minScale: 0.5,
      maxScale: 4.0,
      child: Center(
        child: AuthImage(
          src: src,
          fit: BoxFit.contain,
        ),
      ),
    );
  }
}
