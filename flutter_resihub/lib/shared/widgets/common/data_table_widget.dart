import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/theme/app_colors.dart';
import '../ui/app_skeleton.dart';
import 'empty_state.dart';

class DataTableColumn<T> {
  final String key;
  final String label;
  final bool sortable;
  final Comparable Function(T row)? sortValue;
  final TextAlign align;
  final Widget Function(T row)? render;
  final String Function(T row)? cellText;
  final int flex;
  final double? width;

  const DataTableColumn({
    required this.key,
    required this.label,
    this.sortable = false,
    this.sortValue,
    this.align = TextAlign.left,
    this.render,
    this.cellText,
    this.flex = 1,
    this.width,
  });
}

/// Generic, responsive data table with sorting, pagination, loading skeleton,
/// and empty state. Port of `frontend/src/components/common/DataTable.jsx`.
class DataTableWidget<T> extends StatefulWidget {
  final List<DataTableColumn<T>> columns;
  final List<T> data;
  final dynamic Function(T row)? rowKey;
  final bool loading;
  final int pageSize;
  final String emptyTitle;
  final String emptyDescription;
  final Widget? emptyAction;
  final void Function(T row)? onRowClick;
  final bool embedded;

  const DataTableWidget({
    super.key,
    required this.columns,
    required this.data,
    this.rowKey,
    this.loading = false,
    this.pageSize = 12,
    this.emptyTitle = 'Chưa có dữ liệu',
    this.emptyDescription = 'Không tìm thấy bản ghi nào khớp với bộ lọc hiện tại.',
    this.emptyAction,
    this.onRowClick,
    this.embedded = false,
  });

  @override
  State<DataTableWidget<T>> createState() => _DataTableWidgetState<T>();
}

class _DataTableWidgetState<T> extends State<DataTableWidget<T>> {
  String? _sortCol;
  bool _sortAsc = true;
  int _page = 1;

  void _handleSort(String colKey, bool sortable) {
    if (!sortable) return;
    setState(() {
      if (_sortCol == colKey) {
        _sortAsc = !_sortAsc;
      } else {
        _sortCol = colKey;
        _sortAsc = true;
      }
    });
  }

  List<T> _getSortedData() {
    if (_sortCol == null) return widget.data;
    final colDef = widget.columns.firstWhere(
      (c) => c.key == _sortCol,
      orElse: () => widget.columns.first,
    );

    final sorted = List<T>.from(widget.data);
    sorted.sort((a, b) {
      final Comparable? va;
      final Comparable? vb;

      if (colDef.sortValue != null) {
        va = colDef.sortValue!(a);
        vb = colDef.sortValue!(b);
      } else if (a is Map && b is Map) {
        va = a[_sortCol] as Comparable?;
        vb = b[_sortCol] as Comparable?;
      } else if (colDef.cellText != null) {
        va = colDef.cellText!(a);
        vb = colDef.cellText!(b);
      } else {
        va = null;
        vb = null;
      }

      if (va == vb) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;

      return _sortAsc ? va.compareTo(vb) : vb.compareTo(va);
    });
    return sorted;
  }

  @override
  Widget build(BuildContext context) {
    final borderDecor = BoxDecoration(
      color: Colors.white,
      borderRadius: widget.embedded ? BorderRadius.zero : BorderRadius.circular(16),
      border: Border.all(color: AppColors.slate200),
      boxShadow: widget.embedded
          ? null
          : const [
              BoxShadow(
                color: Color(0x06000000),
                blurRadius: 4,
                offset: Offset(0, 1),
              ),
            ],
    );

    if (widget.loading) {
      return Container(
        decoration: borderDecor,
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            for (int i = 0; i < 5; i++)
              Padding(
                padding: const EdgeInsets.only(bottom: 12.0),
                child: AppSkeleton(
                  height: 40,
                  width: double.infinity,
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
          ],
        ),
      );
    }

    if (widget.data.isEmpty) {
      return Container(
        decoration: borderDecor,
        child: EmptyState(
          title: widget.emptyTitle,
          description: widget.emptyDescription,
          action: widget.emptyAction,
        ),
      );
    }

    final sortedData = _getSortedData();
    final totalPages = math.max(1, (sortedData.length / widget.pageSize).ceil());
    final safePage = math.min(_page, totalPages);
    final startIndex = (safePage - 1) * widget.pageSize;
    final endIndex = math.min(startIndex + widget.pageSize, sortedData.length);
    final pagedData = sortedData.sublist(startIndex, endIndex);

    return Container(
      decoration: borderDecor,
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Table layout
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: ConstrainedBox(
              constraints: const BoxConstraints(minWidth: 600),
              child: Table(
                defaultVerticalAlignment: TableCellVerticalAlignment.middle,
                columnWidths: {
                  for (int i = 0; i < widget.columns.length; i++)
                    i: widget.columns[i].width != null
                        ? FixedColumnWidth(widget.columns[i].width!)
                        : FlexColumnWidth(widget.columns[i].flex.toDouble()),
                },
                children: [
                  // Header Row
                  TableRow(
                    decoration: const BoxDecoration(
                      color: AppColors.slate50,
                      border: Border(bottom: BorderSide(color: AppColors.slate200)),
                    ),
                    children: [
                      for (final col in widget.columns)
                        InkWell(
                          onTap: col.sortable ? () => _handleSort(col.key, col.sortable) : null,
                          child: Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                            child: Row(
                              mainAxisAlignment: col.align == TextAlign.right
                                  ? MainAxisAlignment.end
                                  : col.align == TextAlign.center
                                      ? MainAxisAlignment.center
                                      : MainAxisAlignment.start,
                              children: [
                                Flexible(
                                  child: Text(
                                    col.label,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.w600,
                                      color: AppColors.slate600,
                                    ),
                                  ),
                                ),
                                if (col.sortable) ...[
                                  const SizedBox(width: 4),
                                  Icon(
                                    LucideIcons.arrowUpDown,
                                    size: 13,
                                    color: _sortCol == col.key
                                        ? AppColors.primary600
                                        : AppColors.slate400,
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ),
                    ],
                  ),
                  // Data Rows
                  for (final row in pagedData)
                    TableRow(
                      decoration: const BoxDecoration(
                        border: Border(bottom: BorderSide(color: AppColors.slate100)),
                      ),
                      children: [
                        for (final col in widget.columns)
                          InkWell(
                            onTap: widget.onRowClick != null ? () => widget.onRowClick!(row) : null,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                              child: col.render != null
                                  ? col.render!(row)
                                  : Text(
                                      col.cellText != null
                                          ? col.cellText!(row)
                                          : (row is Map ? row[col.key]?.toString() ?? '—' : '—'),
                                      style: const TextStyle(
                                        fontSize: 13,
                                        color: AppColors.slate700,
                                      ),
                                      textAlign: col.align,
                                    ),
                            ),
                          ),
                      ],
                    ),
                ],
              ),
            ),
          ),
          // Pagination footer
          if (sortedData.length > widget.pageSize) ...[
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              decoration: const BoxDecoration(
                color: AppColors.slate50,
                border: Border(top: BorderSide(color: AppColors.slate200)),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'Hiển thị ${startIndex + 1}–$endIndex / ${sortedData.length} bản ghi',
                    style: const TextStyle(
                      fontSize: 12,
                      color: AppColors.slate500,
                    ),
                  ),
                  Row(
                    children: [
                      IconButton(
                        icon: const Icon(LucideIcons.chevronLeft, size: 16),
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                        onPressed: safePage <= 1
                            ? null
                            : () => setState(() => _page = math.max(1, safePage - 1)),
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8.0),
                        child: Text(
                          'Trang $safePage / $totalPages',
                          style: const TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
                            color: AppColors.slate700,
                          ),
                        ),
                      ),
                      IconButton(
                        icon: const Icon(LucideIcons.chevronRight, size: 16),
                        padding: EdgeInsets.zero,
                        constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
                        onPressed: safePage >= totalPages
                            ? null
                            : () => setState(() => _page = math.min(totalPages, safePage + 1)),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
