import 'dart:typed_data';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/base64_file.dart';
import 'auth_media_viewer.dart';

class FileUploadField extends StatefulWidget {
  final String? label;
  final dynamic value;
  final ValueChanged<dynamic>? onChanged;
  final bool multiple;
  final int maxFiles;
  final int maxSizeMB;
  final bool allowPdf;
  final String? hint;
  final bool compressImage;

  const FileUploadField({
    super.key,
    this.label,
    this.value,
    this.onChanged,
    this.multiple = false,
    this.maxFiles = 3,
    this.maxSizeMB = 5,
    this.allowPdf = true,
    this.hint,
    this.compressImage = true,
  });

  @override
  State<FileUploadField> createState() => _FileUploadFieldState();
}

class _FileUploadFieldState extends State<FileUploadField> {
  String? _error;
  bool _isProcessing = false;

  List<String> get _currentFiles {
    if (widget.value == null) return const [];
    if (widget.value is List) {
      return (widget.value as List).map((e) => e.toString()).where((s) => s.isNotEmpty).toList();
    }
    final str = widget.value.toString().trim();
    return str.isNotEmpty ? [str] : const [];
  }

  Future<void> _pickCamera() async {
    final picker = ImagePicker();
    final picked = await picker.pickImage(source: ImageSource.camera);
    if (picked != null) {
      final bytes = await picked.readAsBytes();
      await _processFileBytes(bytes, 'image/jpeg');
    }
  }

  Future<void> _pickGallery() async {
    final picker = ImagePicker();
    if (widget.multiple) {
      final pickedList = await picker.pickMultiImage();
      for (final p in pickedList) {
        final bytes = await p.readAsBytes();
        await _processFileBytes(bytes, 'image/jpeg');
      }
    } else {
      final picked = await picker.pickImage(source: ImageSource.gallery);
      if (picked != null) {
        final bytes = await picked.readAsBytes();
        await _processFileBytes(bytes, 'image/jpeg');
      }
    }
  }

  Future<void> _pickPdf() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['pdf'],
      allowMultiple: widget.multiple,
      withData: true,
    );

    if (result != null && result.files.isNotEmpty) {
      for (final f in result.files) {
        final bytes = f.bytes;
        if (bytes != null) {
          await _processFileBytes(bytes, 'application/pdf');
        }
      }
    }
  }

  Future<void> _processFileBytes(Uint8List bytes, String mimeType) async {
    final maxBytes = (mimeType == 'application/pdf' ? 10 : widget.maxSizeMB) * 1024 * 1024;
    if (bytes.length > maxBytes) {
      setState(() {
        _error = 'Tệp vượt quá dung lượng tối đa cho phép (${widget.maxSizeMB}MB).';
      });
      return;
    }

    setState(() {
      _isProcessing = true;
      _error = null;
    });

    try {
      String dataUrl;
      if (mimeType == 'application/pdf') {
        dataUrl = encodeBytesToDataUrl(bytes, mimeType: 'application/pdf');
      } else {
        if (widget.compressImage) {
          dataUrl = await compressImageBytesToDataUrl(bytes);
        } else {
          dataUrl = encodeBytesToDataUrl(bytes, mimeType: mimeType);
        }
      }

      final files = List<String>.from(_currentFiles);
      if (widget.multiple) {
        if (files.length < widget.maxFiles) {
          files.add(dataUrl);
          widget.onChanged?.call(files);
        }
      } else {
        widget.onChanged?.call(dataUrl);
      }
    } catch (e) {
      setState(() {
        _error = 'Lỗi xử lý tệp: $e';
      });
    } finally {
      if (mounted) {
        setState(() {
          _isProcessing = false;
        });
      }
    }
  }

  void _showPickOptions() {
    showModalBottomSheet<void>(
      context: context,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(16)),
      ),
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              ListTile(
                leading: const Icon(LucideIcons.camera, color: AppColors.primary500),
                title: const Text('Chụp ảnh camera'),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _pickCamera();
                },
              ),
              ListTile(
                leading: const Icon(LucideIcons.image, color: AppColors.primary500),
                title: const Text('Chọn ảnh từ thư viện'),
                onTap: () {
                  Navigator.of(ctx).pop();
                  _pickGallery();
                },
              ),
              if (widget.allowPdf)
                ListTile(
                  leading: const Icon(LucideIcons.fileText, color: AppColors.rose500),
                  title: const Text('Chọn tệp PDF'),
                  onTap: () {
                    Navigator.of(ctx).pop();
                    _pickPdf();
                  },
                ),
            ],
          ),
        ),
      ),
    );
  }

  void _removeFile(int index) {
    if (widget.multiple) {
      final list = List<String>.from(_currentFiles);
      if (index >= 0 && index < list.length) {
        list.removeAt(index);
        widget.onChanged?.call(list);
      }
    } else {
      widget.onChanged?.call('');
    }
  }

  @override
  Widget build(BuildContext context) {
    final files = _currentFiles;
    final canAddMore = widget.multiple ? files.length < widget.maxFiles : files.isEmpty;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (widget.label != null) ...[
          Text(
            widget.label!,
            style: const TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              fontWeight: FontWeight.w500,
              color: AppColors.slate700,
            ),
          ),
          const SizedBox(height: 6),
        ],

        if (canAddMore)
          InkWell(
            onTap: _isProcessing ? null : _showPickOptions,
            borderRadius: BorderRadius.circular(12),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 16),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                  color: AppColors.slate300,
                  style: BorderStyle.solid,
                ),
                color: Colors.white,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _isProcessing
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(
                          LucideIcons.cloudUpload,
                          size: 24,
                          color: AppColors.primary500,
                        ),
                  const SizedBox(height: 6),
                  Text(
                    'Nhấn để tải ${widget.allowPdf ? 'tệp scan / ảnh' : 'ảnh'} lên${widget.multiple ? ' (${files.length}/${widget.maxFiles})' : ''}',
                    style: const TextStyle(
                      fontFamily: 'Inter',
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: AppColors.slate700,
                    ),
                  ),
                  if (widget.hint != null) ...[
                    const SizedBox(height: 2),
                    Text(
                      widget.hint!,
                      style: const TextStyle(
                        fontFamily: 'Inter',
                        fontSize: 11,
                        color: AppColors.slate400,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),

        if (_error != null) ...[
          const SizedBox(height: 4),
          Text(
            _error!,
            style: const TextStyle(
              fontFamily: 'Inter',
              fontSize: 12,
              color: AppColors.rose600,
            ),
          ),
        ],

        if (files.isNotEmpty) ...[
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: List.generate(files.length, (idx) {
              final file = files[idx];
              final isPdf = isPdfMediaSource(file);

              return Stack(
                clipBehavior: Clip.none,
                children: [
                  InkWell(
                    onTap: () => AuthMediaViewer.show(context, src: file),
                    borderRadius: BorderRadius.circular(8),
                    child: Container(
                      width: 72,
                      height: 72,
                      decoration: BoxDecoration(
                        color: AppColors.slate50,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: AppColors.border),
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: isPdf
                          ? const Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              children: [
                                Icon(LucideIcons.fileText, color: AppColors.rose500, size: 24),
                                SizedBox(height: 2),
                                Text(
                                  'PDF',
                                  style: TextStyle(
                                    fontSize: 10,
                                    fontWeight: FontWeight.bold,
                                    color: AppColors.rose600,
                                  ),
                                ),
                              ],
                            )
                          : AuthImage(
                              src: file,
                              width: 72,
                              height: 72,
                              fit: BoxFit.cover,
                            ),
                    ),
                  ),
                  Positioned(
                    top: -4,
                    right: -4,
                    child: InkWell(
                      onTap: () => _removeFile(idx),
                      borderRadius: BorderRadius.circular(999),
                      child: Container(
                        padding: const EdgeInsets.all(2),
                        decoration: BoxDecoration(
                          color: AppColors.slate900.withValues(alpha: 0.75),
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(
                          LucideIcons.x,
                          size: 12,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ),
                ],
              );
            }),
          ),
        ],
      ],
    );
  }
}
