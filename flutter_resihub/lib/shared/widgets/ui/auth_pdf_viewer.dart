import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/network/dio_client.dart';
import '../../../core/theme/app_colors.dart';
import 'app_skeleton.dart';

import 'auth_pdf_viewer_stub.dart'
    if (dart.library.js_interop) 'auth_pdf_viewer_web.dart';

class AuthPdfViewer extends ConsumerStatefulWidget {
  final Uint8List? bytes;
  final String? src;
  final String title;
  final Dio? dio;

  const AuthPdfViewer({
    super.key,
    this.bytes,
    this.src,
    this.title = 'Bản scan PDF',
    this.dio,
  });

  @override
  ConsumerState<AuthPdfViewer> createState() => _AuthPdfViewerState();
}

class _AuthPdfViewerState extends ConsumerState<AuthPdfViewer> {
  Uint8List? _resolvedBytes;
  bool _isLoading = false;
  bool _isError = false;

  @override
  void initState() {
    super.initState();
    _loadPdf();
  }

  @override
  void didUpdateWidget(covariant AuthPdfViewer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!listEquals(widget.bytes, oldWidget.bytes) || widget.src != oldWidget.src) {
      _loadPdf();
    }
  }

  Future<void> _loadPdf() async {
    if (widget.bytes != null) {
      setState(() {
        _resolvedBytes = widget.bytes;
        _isLoading = false;
        _isError = false;
      });
      return;
    }

    final src = widget.src?.trim();
    if (src == null || src.isEmpty) {
      setState(() {
        _resolvedBytes = null;
        _isLoading = false;
        _isError = false;
      });
      return;
    }

    // Base64 Data URI
    if (src.startsWith('data:')) {
      try {
        final commaIdx = src.indexOf(',');
        final base64Data = commaIdx >= 0 ? src.substring(commaIdx + 1) : src;
        final decoded = base64Decode(base64Data);
        setState(() {
          _resolvedBytes = decoded;
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

    // Network / API fetch
    setState(() {
      _isLoading = true;
      _isError = false;
    });

    try {
      final Dio dio = widget.dio ?? ref.read(dioProvider);
      final bytes = await fetchAuthAttachmentBytes(dio, src);
      if (mounted) {
        setState(() {
          _resolvedBytes = bytes;
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
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return Container(
        padding: const EdgeInsets.all(24),
        alignment: Alignment.center,
        child: const Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            AppSkeleton(width: 48, height: 48),
            SizedBox(height: 12),
            Text(
              'Đang tải tài liệu PDF...',
              style: TextStyle(fontSize: 13, color: AppColors.slate500),
            ),
          ],
        ),
      );
    }

    if (_isError || _resolvedBytes == null) {
      return Container(
        padding: const EdgeInsets.all(24),
        alignment: Alignment.center,
        child: const Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(LucideIcons.fileText, size: 36, color: AppColors.rose400),
            SizedBox(height: 8),
            Text(
              'Không thể tải tài liệu PDF. Vui lòng thử lại.',
              style: TextStyle(fontSize: 13, color: AppColors.rose600),
            ),
          ],
        ),
      );
    }

    return AuthPdfViewerPlatform(
      bytes: _resolvedBytes!,
      title: widget.title,
    );
  }
}
