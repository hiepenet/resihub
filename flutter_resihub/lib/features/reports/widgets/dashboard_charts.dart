import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';

import '../../../core/theme/app_colors.dart';
import '../../../core/utils/format.dart';
import '../utils/chart_helpers.dart';

// ─── 1. Revenue Trend Line Chart (3 Lines) ──────────────────────────────────

class RevenueTrendLineChart extends StatelessWidget {
  final RevenueTrendData data;

  const RevenueTrendLineChart({
    super.key,
    required this.data,
  });

  @override
  Widget build(BuildContext context) {
    if (data.labels.isEmpty) {
      return const Center(child: Text('Không có dữ liệu kỳ'));
    }

    final billedSpots = <FlSpot>[];
    final settledSpots = <FlSpot>[];
    final collectedSpots = <FlSpot>[];

    double maxY = 0;
    for (int i = 0; i < data.labels.length; i++) {
      final b = data.billed[i];
      final s = data.invoiceSettled[i];
      final c = data.collected[i];
      billedSpots.add(FlSpot(i.toDouble(), b));
      settledSpots.add(FlSpot(i.toDouble(), s));
      collectedSpots.add(FlSpot(i.toDouble(), c));
      if (b > maxY) maxY = b;
      if (s > maxY) maxY = s;
      if (c > maxY) maxY = c;
    }
    if (maxY == 0) maxY = 1000000;
    maxY = maxY * 1.15;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Legend
        Wrap(
          spacing: 16,
          runSpacing: 8,
          alignment: WrapAlignment.center,
          children: const [
            _ChartLegendItem(color: Color(0xFF0EA5E9), label: 'Phát hành'),
            _ChartLegendItem(color: Color(0xFF8B5CF6), label: 'Tất toán HĐ', isDashed: true),
            _ChartLegendItem(color: Color(0xFF10B981), label: 'Thực thu'),
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: LineChart(
            LineChartData(
              minY: 0,
              maxY: maxY,
              lineTouchData: LineTouchData(
                touchTooltipData: LineTouchTooltipData(
                  getTooltipItems: (touchedSpots) {
                    return touchedSpots.map((spot) {
                      final name = switch (spot.barIndex) {
                        0 => 'Phát hành',
                        1 => 'Tất toán',
                        _ => 'Thực thu',
                      };
                      return LineTooltipItem(
                        '$name: ${formatMoney(spot.y)}',
                        TextStyle(
                          color: spot.bar.color ?? Colors.white,
                          fontWeight: FontWeight.w600,
                          fontSize: 12,
                        ),
                      );
                    }).toList();
                  },
                ),
              ),
              gridData: FlGridData(
                show: true,
                drawVerticalLine: false,
                horizontalInterval: maxY / 4,
                getDrawingHorizontalLine: (val) => const FlLine(
                  color: AppColors.slate100,
                  strokeWidth: 1,
                ),
              ),
              titlesData: FlTitlesData(
                leftTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 64,
                    interval: maxY / 4,
                    getTitlesWidget: (value, meta) {
                      if (value < 0 || value > maxY * 0.98) return const SizedBox.shrink();
                      return Text(
                        formatCompactMoney(value),
                        style: const TextStyle(fontSize: 10, color: AppColors.slate500),
                      );
                    },
                  ),
                ),
                rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                bottomTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 26,
                    interval: 1,
                    getTitlesWidget: (value, meta) {
                      final idx = value.toInt();
                      if (idx >= 0 && idx < data.labels.length) {
                        return Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            data.labels[idx],
                            style: const TextStyle(fontSize: 10, color: AppColors.slate600),
                          ),
                        );
                      }
                      return const SizedBox.shrink();
                    },
                  ),
                ),
              ),
              borderData: FlBorderData(show: false),
              lineBarsData: [
                // 1. Phát hành (Billed)
                LineChartBarData(
                  spots: billedSpots,
                  isCurved: true,
                  color: const Color(0xFF0EA5E9),
                  barWidth: 2.5,
                  belowBarData: BarAreaData(
                    show: true,
                    color: const Color(0xFF0EA5E9).withValues(alpha: 0.08),
                  ),
                  dotData: const FlDotData(show: true),
                ),
                // 2. Tất toán HĐ (Settled)
                LineChartBarData(
                  spots: settledSpots,
                  isCurved: true,
                  color: const Color(0xFF8B5CF6),
                  barWidth: 2,
                  dashArray: [4, 4],
                  dotData: const FlDotData(show: true),
                ),
                // 3. Thực thu (Collected)
                LineChartBarData(
                  spots: collectedSpots,
                  isCurved: true,
                  color: const Color(0xFF10B981),
                  barWidth: 2.5,
                  belowBarData: BarAreaData(
                    show: true,
                    color: const Color(0xFF10B981).withValues(alpha: 0.08),
                  ),
                  dotData: const FlDotData(show: true),
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

// ─── 2. Revenue By Source Stacked Bar Chart ─────────────────────────────────

class RevenueSourceStackedBarChart extends StatelessWidget {
  final RevenueSourceData data;
  final VoidCallback? onTap;

  const RevenueSourceStackedBarChart({
    super.key,
    required this.data,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    if (data.labels.isEmpty) {
      return const Center(child: Text('Không có dữ liệu nguồn thu'));
    }

    final barGroups = <BarChartGroupData>[];
    double maxY = 0;

    for (int i = 0; i < data.labels.length; i++) {
      final rent = data.rent[i];
      final ele = data.electricity[i];
      final w = data.water[i];
      final s = data.service[i];
      final o = data.other[i];

      final y1 = rent;
      final y2 = y1 + ele;
      final y3 = y2 + w;
      final y4 = y3 + s;
      final y5 = y4 + o;

      if (y5 > maxY) maxY = y5;

      barGroups.add(
        BarChartGroupData(
          x: i,
          barRods: [
            BarChartRodData(
              toY: y5,
              width: 18,
              borderRadius: BorderRadius.circular(3),
              rodStackItems: [
                BarChartRodStackItem(0, y1, const Color(0xFF0EA5E9)),
                BarChartRodStackItem(y1, y2, const Color(0xFFF59E0B)),
                BarChartRodStackItem(y2, y3, const Color(0xFF06B6D4)),
                BarChartRodStackItem(y3, y4, const Color(0xFF10B981)),
                BarChartRodStackItem(y4, y5, const Color(0xFF8B5CF6)),
              ],
            ),
          ],
        ),
      );
    }
    if (maxY == 0) maxY = 1000000;
    maxY = maxY * 1.15;

    final chartWidget = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Legend for 5 sources
        Wrap(
          spacing: 12,
          runSpacing: 6,
          alignment: WrapAlignment.center,
          children: const [
            _ChartLegendItem(color: Color(0xFF0EA5E9), label: 'Tiền thuê phòng'),
            _ChartLegendItem(color: Color(0xFFF59E0B), label: 'Điện'),
            _ChartLegendItem(color: Color(0xFF06B6D4), label: 'Nước'),
            _ChartLegendItem(color: Color(0xFF10B981), label: 'Dịch vụ'),
            _ChartLegendItem(color: Color(0xFF8B5CF6), label: 'Khác'),
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: BarChart(
            BarChartData(
              maxY: maxY,
              barGroups: barGroups,
              gridData: FlGridData(
                show: true,
                drawVerticalLine: false,
                horizontalInterval: maxY / 4,
                getDrawingHorizontalLine: (val) => const FlLine(
                  color: AppColors.slate100,
                  strokeWidth: 1,
                ),
              ),
              titlesData: FlTitlesData(
                leftTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 64,
                    interval: maxY / 4,
                    getTitlesWidget: (value, meta) {
                      if (value < 0 || value > maxY * 0.98) return const SizedBox.shrink();
                      return Text(
                        formatCompactMoney(value),
                        style: const TextStyle(fontSize: 10, color: AppColors.slate500),
                      );
                    },
                  ),
                ),
                rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                bottomTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 26,
                    interval: 1,
                    getTitlesWidget: (value, meta) {
                      final idx = value.toInt();
                      if (idx >= 0 && idx < data.labels.length) {
                        return Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            data.labels[idx],
                            style: const TextStyle(fontSize: 10, color: AppColors.slate600),
                          ),
                        );
                      }
                      return const SizedBox.shrink();
                    },
                  ),
                ),
              ),
              borderData: FlBorderData(show: false),
            ),
          ),
        ),
      ],
    );

    if (onTap != null) {
      return InkWell(onTap: onTap, child: chartWidget);
    }
    return chartWidget;
  }
}

// ─── 3. Receivables Aging Bar Chart (5 Buckets with Drill-down) ─────────────

class ReceivablesAgingBarChart extends StatelessWidget {
  final ReceivablesAgingChartData data;
  final ValueChanged<String>? onBucketTap;

  const ReceivablesAgingBarChart({
    super.key,
    required this.data,
    this.onBucketTap,
  });

  @override
  Widget build(BuildContext context) {
    if (data.labels.isEmpty) {
      return const Center(child: Text('Không có dữ liệu tuổi nợ'));
    }

    final barGroups = <BarChartGroupData>[];
    double maxY = 0;

    for (int i = 0; i < data.labels.length; i++) {
      final amt = data.amounts[i];
      if (amt > maxY) maxY = amt;

      barGroups.add(
        BarChartGroupData(
          x: i,
          barRods: [
            BarChartRodData(
              toY: amt,
              color: data.colors[i],
              width: 24,
              borderRadius: BorderRadius.circular(4),
            ),
          ],
        ),
      );
    }
    if (maxY == 0) maxY = 1000000;
    maxY = maxY * 1.15;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Clickable interactive aging chips row
        Wrap(
          spacing: 8,
          runSpacing: 6,
          alignment: WrapAlignment.center,
          children: [
            for (int i = 0; i < data.bucketKeys.length; i++)
              InkWell(
                onTap: () => onBucketTap?.call(data.bucketKeys[i]),
                borderRadius: BorderRadius.circular(6),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                  decoration: BoxDecoration(
                    color: data.colors[i].withValues(alpha: 0.12),
                    borderRadius: BorderRadius.circular(6),
                    border: Border.all(color: data.colors[i].withValues(alpha: 0.4)),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 8,
                        height: 8,
                        decoration: BoxDecoration(
                          color: data.colors[i],
                          shape: BoxShape.circle,
                        ),
                      ),
                      const SizedBox(width: 4),
                      Text(
                        '${data.labels[i]} (${data.counts[i]})',
                        style: TextStyle(
                          fontSize: 10,
                          fontWeight: FontWeight.w600,
                          color: data.colors[i],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: BarChart(
            BarChartData(
              maxY: maxY,
              barGroups: barGroups,
              barTouchData: BarTouchData(
                touchCallback: (FlTouchEvent event, barTouchResponse) {
                  if (event is FlTapUpEvent && barTouchResponse != null && barTouchResponse.spot != null) {
                    final idx = barTouchResponse.spot!.touchedBarGroupIndex;
                    if (idx >= 0 && idx < data.bucketKeys.length) {
                      onBucketTap?.call(data.bucketKeys[idx]);
                    }
                  }
                },
                touchTooltipData: BarTouchTooltipData(
                  getTooltipItem: (group, groupIndex, rod, rodIndex) {
                    final label = data.labels[groupIndex];
                    final count = data.counts[groupIndex];
                    return BarTooltipItem(
                      '$label\n${formatMoney(rod.toY)} ($count khoản)',
                      const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 11),
                    );
                  },
                ),
              ),
              gridData: FlGridData(
                show: true,
                drawVerticalLine: false,
                horizontalInterval: maxY / 4,
                getDrawingHorizontalLine: (val) => const FlLine(
                  color: AppColors.slate100,
                  strokeWidth: 1,
                ),
              ),
              titlesData: FlTitlesData(
                leftTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 64,
                    interval: maxY / 4,
                    getTitlesWidget: (value, meta) {
                      if (value < 0 || value > maxY * 0.98) return const SizedBox.shrink();
                      return Text(
                        formatCompactMoney(value),
                        style: const TextStyle(fontSize: 10, color: AppColors.slate500),
                      );
                    },
                  ),
                ),
                rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                bottomTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 26,
                    interval: 1,
                    getTitlesWidget: (value, meta) {
                      final idx = value.toInt();
                      if (idx >= 0 && idx < data.labels.length) {
                        return Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            data.labels[idx],
                            style: const TextStyle(fontSize: 10, color: AppColors.slate600),
                          ),
                        );
                      }
                      return const SizedBox.shrink();
                    },
                  ),
                ),
              ),
              borderData: FlBorderData(show: false),
            ),
          ),
        ),
      ],
    );
  }
}

// ─── 4. Occupancy Trend Line Chart ──────────────────────────────────────────

class OccupancyTrendLineChart extends StatelessWidget {
  final OccupancyTrendData data;
  final VoidCallback? onTap;

  const OccupancyTrendLineChart({
    super.key,
    required this.data,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    if (data.labels.isEmpty) {
      return const Center(child: Text('Chưa có dữ liệu tỷ lệ lấp đầy'));
    }

    final spots = <FlSpot>[];
    for (int i = 0; i < data.labels.length; i++) {
      spots.add(FlSpot(i.toDouble(), data.rates[i]));
    }

    final chartWidget = LineChart(
      LineChartData(
        minY: 0,
        maxY: 100,
        lineTouchData: LineTouchData(
          touchTooltipData: LineTouchTooltipData(
            getTooltipItems: (touchedSpots) {
              return touchedSpots.map((spot) {
                final idx = spot.spotIndex;
                final pt = idx < data.metaPoints.length ? data.metaPoints[idx] : null;
                final period = idx < data.labels.length ? data.labels[idx] : '';
                return LineTooltipItem(
                  'Cuối kỳ $period\n${spot.y}% (${pt?.occupied ?? 0}/${pt?.exploitable ?? 0} căn)',
                  const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 11),
                );
              }).toList();
            },
          ),
        ),
        gridData: FlGridData(
          show: true,
          drawVerticalLine: false,
          horizontalInterval: 25,
          getDrawingHorizontalLine: (val) => const FlLine(
            color: AppColors.slate100,
            strokeWidth: 1,
          ),
        ),
        titlesData: FlTitlesData(
          leftTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 42,
              interval: 25,
              getTitlesWidget: (value, meta) {
                return Text(
                  '${value.toInt()}%',
                  style: const TextStyle(fontSize: 10, color: AppColors.slate500),
                );
              },
            ),
          ),
          rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
          bottomTitles: AxisTitles(
            sideTitles: SideTitles(
              showTitles: true,
              reservedSize: 26,
              interval: 1,
              getTitlesWidget: (value, meta) {
                final idx = value.toInt();
                if (idx >= 0 && idx < data.labels.length) {
                  return Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(
                      data.labels[idx],
                      style: const TextStyle(fontSize: 10, color: AppColors.slate600),
                    ),
                  );
                }
                return const SizedBox.shrink();
              },
            ),
          ),
        ),
        borderData: FlBorderData(show: false),
        lineBarsData: [
          LineChartBarData(
            spots: spots,
            isCurved: true,
            color: const Color(0xFF0EA5E9),
            barWidth: 3,
            belowBarData: BarAreaData(
              show: true,
              color: const Color(0xFF0EA5E9).withValues(alpha: 0.12),
            ),
            dotData: const FlDotData(show: true),
          ),
        ],
      ),
    );

    if (onTap != null) {
      return InkWell(onTap: onTap, child: chartWidget);
    }
    return chartWidget;
  }
}

// ─── 5. Reports Building Aging Stacked Bar Chart (5 Buckets) ────────────────

class BuildingAgingStackedBarChart extends StatelessWidget {
  final ReportsBuildingAgingData data;

  const BuildingAgingStackedBarChart({
    super.key,
    required this.data,
  });

  @override
  Widget build(BuildContext context) {
    if (data.labels.isEmpty) {
      return const Center(child: Text('Không có dữ liệu tuổi nợ theo tòa'));
    }

    final barGroups = <BarChartGroupData>[];
    double maxY = 0;

    for (int i = 0; i < data.labels.length; i++) {
      final cnd = data.currentNotDue[i];
      final b0 = data.bucket0To15[i];
      final b16 = data.bucket16To30[i];
      final b31 = data.bucket31To60[i];
      final bo = data.bucketOver60[i];

      final y1 = cnd;
      final y2 = y1 + b0;
      final y3 = y2 + b16;
      final y4 = y3 + b31;
      final y5 = y4 + bo;

      if (y5 > maxY) maxY = y5;

      barGroups.add(
        BarChartGroupData(
          x: i,
          barRods: [
            BarChartRodData(
              toY: y5,
              width: 22,
              borderRadius: BorderRadius.circular(4),
              rodStackItems: [
                BarChartRodStackItem(0, y1, const Color(0xFF94A3B8)),
                BarChartRodStackItem(y1, y2, const Color(0xFF38BDF8)),
                BarChartRodStackItem(y2, y3, const Color(0xFFFBBF24)),
                BarChartRodStackItem(y3, y4, const Color(0xFFF97316)),
                BarChartRodStackItem(y4, y5, const Color(0xFFE11D48)),
              ],
            ),
          ],
        ),
      );
    }
    if (maxY == 0) maxY = 1000000;
    maxY = maxY * 1.15;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Wrap(
          spacing: 12,
          runSpacing: 6,
          alignment: WrapAlignment.center,
          children: const [
            _ChartLegendItem(color: Color(0xFF94A3B8), label: 'Chưa đến hạn'),
            _ChartLegendItem(color: Color(0xFF38BDF8), label: '1–15 ngày'),
            _ChartLegendItem(color: Color(0xFFFBBF24), label: '16–30 ngày'),
            _ChartLegendItem(color: Color(0xFFF97316), label: '31–60 ngày'),
            _ChartLegendItem(color: Color(0xFFE11D48), label: '>60 ngày'),
          ],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: BarChart(
            BarChartData(
              maxY: maxY,
              barGroups: barGroups,
              gridData: FlGridData(
                show: true,
                drawVerticalLine: false,
                horizontalInterval: maxY / 4,
                getDrawingHorizontalLine: (val) => const FlLine(
                  color: AppColors.slate100,
                  strokeWidth: 1,
                ),
              ),
              titlesData: FlTitlesData(
                leftTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 64,
                    interval: maxY / 4,
                    getTitlesWidget: (value, meta) {
                      if (value < 0 || value > maxY * 0.98) return const SizedBox.shrink();
                      return Text(
                        formatCompactMoney(value),
                        style: const TextStyle(fontSize: 10, color: AppColors.slate500),
                      );
                    },
                  ),
                ),
                rightTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                topTitles: const AxisTitles(sideTitles: SideTitles(showTitles: false)),
                bottomTitles: AxisTitles(
                  sideTitles: SideTitles(
                    showTitles: true,
                    reservedSize: 26,
                    interval: 1,
                    getTitlesWidget: (value, meta) {
                      final idx = value.toInt();
                      if (idx >= 0 && idx < data.labels.length) {
                        return Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Text(
                            data.labels[idx],
                            style: const TextStyle(fontSize: 10, color: AppColors.slate600),
                          ),
                        );
                      }
                      return const SizedBox.shrink();
                    },
                  ),
                ),
              ),
              borderData: FlBorderData(show: false),
            ),
          ),
        ),
      ],
    );
  }
}

// ─── Reusable Legend Item ───────────────────────────────────────────────────

class _ChartLegendItem extends StatelessWidget {
  final Color color;
  final String label;
  final bool isDashed;

  const _ChartLegendItem({
    required this.color,
    required this.label,
    this.isDashed = false,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 14,
          height: 4,
          decoration: BoxDecoration(
            color: color,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
        const SizedBox(width: 5),
        Text(
          label,
          style: const TextStyle(
            fontSize: 11,
            color: AppColors.slate600,
            fontWeight: FontWeight.w500,
          ),
        ),
      ],
    );
  }
}
