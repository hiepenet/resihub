import 'package:flutter/material.dart';

const List<String> kDashboardAgingBucketKeys = [
  'current_not_due',
  '0_15',
  '16_30',
  '31_60',
  'over_60',
];

class AgingBucketMeta {
  final String key;
  final String label;
  final Color color;

  const AgingBucketMeta({
    required this.key,
    required this.label,
    required this.color,
  });
}

const List<AgingBucketMeta> kDashboardAgingBucketMeta = [
  AgingBucketMeta(key: 'current_not_due', label: 'Chưa đến hạn', color: Color(0xFF94A3B8)),
  AgingBucketMeta(key: '0_15', label: '1–15 ngày', color: Color(0xFF38BDF8)),
  AgingBucketMeta(key: '16_30', label: '16–30 ngày', color: Color(0xFFFBBF24)),
  AgingBucketMeta(key: '31_60', label: '31–60 ngày', color: Color(0xFFF97316)),
  AgingBucketMeta(key: 'over_60', label: '>60 ngày', color: Color(0xFFE11D48)),
];

double toNonNegativeNumber(dynamic val) {
  if (val == null) return 0.0;
  final n = num.tryParse(val.toString());
  if (n != null && n.isFinite && n > 0) {
    return n.toDouble();
  }
  return 0.0;
}

// ─── Revenue Trend (3 Lines) ────────────────────────────────────────────────

class RevenueTrendData {
  final List<String> labels;
  final List<double> billed;
  final List<double> invoiceSettled;
  final List<double> collected;

  const RevenueTrendData({
    required this.labels,
    required this.billed,
    required this.invoiceSettled,
    required this.collected,
  });
}

RevenueTrendData buildRevenueTrendChartData(dynamic revenueSeries) {
  final rows = revenueSeries is List ? revenueSeries : const [];
  final labels = <String>[];
  final billed = <double>[];
  final invoiceSettled = <double>[];
  final collected = <double>[];

  for (final item in rows) {
    if (item is Map) {
      final period = item['period'] ?? item['month'] ?? '';
      labels.add(period.toString());
      billed.add(toNonNegativeNumber(item['billed']));
      invoiceSettled.add(toNonNegativeNumber(item['invoice_settled']));
      collected.add(toNonNegativeNumber(item['collected']));
    }
  }

  return RevenueTrendData(
    labels: labels,
    billed: billed,
    invoiceSettled: invoiceSettled,
    collected: collected,
  );
}

// ─── Revenue By Source (Stacked 5 Sources) ──────────────────────────────────

class RevenueSourceItem {
  final String key;
  final String label;
  final Color color;

  const RevenueSourceItem({
    required this.key,
    required this.label,
    required this.color,
  });
}

const List<RevenueSourceItem> kRevenueSourceDefs = [
  RevenueSourceItem(key: 'rent', label: 'Tiền thuê phòng', color: Color(0xFF0EA5E9)),
  RevenueSourceItem(key: 'electricity', label: 'Tiền điện', color: Color(0xFFF59E0B)),
  RevenueSourceItem(key: 'water', label: 'Tiền nước', color: Color(0xFF06B6D4)),
  RevenueSourceItem(key: 'service', label: 'Phí dịch vụ', color: Color(0xFF10B981)),
  RevenueSourceItem(key: 'other', label: 'Phí trễ hạn & Khác', color: Color(0xFF8B5CF6)),
];

class RevenueSourceData {
  final List<String> labels;
  final List<double> rent;
  final List<double> electricity;
  final List<double> water;
  final List<double> service;
  final List<double> other;

  const RevenueSourceData({
    required this.labels,
    required this.rent,
    required this.electricity,
    required this.water,
    required this.service,
    required this.other,
  });
}

RevenueSourceData buildRevenueBySourceChartData(dynamic sourceSeries) {
  final rows = sourceSeries is List ? sourceSeries : const [];
  final labels = <String>[];
  final rent = <double>[];
  final electricity = <double>[];
  final water = <double>[];
  final service = <double>[];
  final other = <double>[];

  for (final item in rows) {
    if (item is Map) {
      labels.add((item['period'] ?? '').toString());
      rent.add(toNonNegativeNumber(item['rent']));
      electricity.add(toNonNegativeNumber(item['electricity']));
      water.add(toNonNegativeNumber(item['water']));
      service.add(toNonNegativeNumber(item['service']));
      other.add(toNonNegativeNumber(item['other']));
    }
  }

  return RevenueSourceData(
    labels: labels,
    rent: rent,
    electricity: electricity,
    water: water,
    service: service,
    other: other,
  );
}

// ─── Receivables Aging (5 Buckets) ──────────────────────────────────────────

class ReceivablesAgingChartData {
  final List<String> bucketKeys;
  final List<String> labels;
  final List<double> amounts;
  final List<int> counts;
  final List<Color> colors;

  const ReceivablesAgingChartData({
    required this.bucketKeys,
    required this.labels,
    required this.amounts,
    required this.counts,
    required this.colors,
  });
}

ReceivablesAgingChartData buildReceivablesAgingChartData(dynamic receivablesAging) {
  final Map<String, dynamic> aging = receivablesAging is Map ? receivablesAging.cast<String, dynamic>() : {};
  final rawBuckets = aging['buckets'] is List ? aging['buckets'] as List : const [];
  final byKey = <String, Map<String, dynamic>>{};

  for (final b in rawBuckets) {
    if (b is Map && b['key'] != null) {
      byKey[b['key'].toString()] = b.cast<String, dynamic>();
    }
  }

  final bucketKeys = <String>[];
  final labels = <String>[];
  final amounts = <double>[];
  final counts = <int>[];
  final colors = <Color>[];

  for (final meta in kDashboardAgingBucketMeta) {
    bucketKeys.add(meta.key);
    labels.add(meta.label);
    colors.add(meta.color);
    final bucket = byKey[meta.key];
    amounts.add(toNonNegativeNumber(bucket?['amount']));
    final c = num.tryParse(bucket?['count']?.toString() ?? '0')?.toInt() ?? 0;
    counts.add(c > 0 ? c : 0);
  }

  return ReceivablesAgingChartData(
    bucketKeys: bucketKeys,
    labels: labels,
    amounts: amounts,
    counts: counts,
    colors: colors,
  );
}

// ─── Occupancy Trend ────────────────────────────────────────────────────────

class OccupancyMetaPoint {
  final int occupied;
  final int exploitable;

  const OccupancyMetaPoint({
    required this.occupied,
    required this.exploitable,
  });
}

class OccupancyTrendData {
  final List<String> labels;
  final List<double> rates;
  final List<OccupancyMetaPoint> metaPoints;

  const OccupancyTrendData({
    required this.labels,
    required this.rates,
    required this.metaPoints,
  });
}

OccupancyTrendData buildOccupancyTrendChartData(dynamic occupancySeries) {
  final rows = occupancySeries is List ? occupancySeries : const [];
  final labels = <String>[];
  final rates = <double>[];
  final metaPoints = <OccupancyMetaPoint>[];

  for (final item in rows) {
    if (item is Map) {
      labels.add((item['period'] ?? '').toString());
      final occ = num.tryParse(item['occupied']?.toString() ?? '0')?.toInt() ?? 0;
      final exp = num.tryParse(item['exploitable']?.toString() ?? '0')?.toInt() ?? 0;
      metaPoints.add(OccupancyMetaPoint(
        occupied: occ > 0 ? occ : 0,
        exploitable: exp > 0 ? exp : 0,
      ));

      final rawRate = num.tryParse(item['occupancy_rate']?.toString() ?? '0')?.toDouble() ?? 0.0;
      final clampedRate = rawRate.clamp(0.0, 100.0);
      rates.add(clampedRate);
    }
  }

  return OccupancyTrendData(
    labels: labels,
    rates: rates,
    metaPoints: metaPoints,
  );
}

// ─── Guard Helpers ──────────────────────────────────────────────────────────

bool hasRevenueChartData(dynamic revenueSeries, dynamic sourceSeries) {
  final revRows = revenueSeries is List ? revenueSeries : const [];
  final revHasPositive = revRows.any((r) {
    if (r is! Map) return false;
    final b = num.tryParse(r['billed']?.toString() ?? '0') ?? 0;
    final c = num.tryParse(r['collected']?.toString() ?? '0') ?? 0;
    return b > 0 || c > 0;
  });

  final srcRows = sourceSeries is List ? sourceSeries : const [];
  final srcHasPositive = srcRows.any((s) {
    if (s is! Map) return false;
    final rent = num.tryParse(s['rent']?.toString() ?? '0') ?? 0;
    final ele = num.tryParse(s['electricity']?.toString() ?? '0') ?? 0;
    final w = num.tryParse(s['water']?.toString() ?? '0') ?? 0;
    final svc = num.tryParse(s['service']?.toString() ?? '0') ?? 0;
    final o = num.tryParse(s['other']?.toString() ?? '0') ?? 0;
    return rent > 0 || ele > 0 || w > 0 || svc > 0 || o > 0;
  });

  return revHasPositive || srcHasPositive;
}

bool hasAgingChartData(dynamic receivablesAging) {
  if (receivablesAging is! Map) return false;
  final totalDebt = num.tryParse(receivablesAging['total_debt']?.toString() ?? '0') ?? 0;
  if (totalDebt > 0) return true;

  final buckets = receivablesAging['buckets'] is List ? receivablesAging['buckets'] as List : const [];
  return buckets.any((b) {
    if (b is! Map) return false;
    final a = num.tryParse(b['amount']?.toString() ?? '0') ?? 0;
    return a > 0;
  });
}

bool hasOccupancyChartData(dynamic totalApartments, dynamic occupancySeries) {
  final total = num.tryParse(totalApartments?.toString() ?? '0') ?? 0;
  if (total > 0) return true;

  final occRows = occupancySeries is List ? occupancySeries : const [];
  return occRows.any((o) {
    if (o is! Map) return false;
    final exp = num.tryParse(o['exploitable']?.toString() ?? '0') ?? 0;
    return exp > 0;
  });
}

// ─── Reports Building Aging Chart Data ─────────────────────────────────────

class ReportsBuildingAgingData {
  final List<String> labels;
  final List<double> currentNotDue;
  final List<double> bucket0To15;
  final List<double> bucket16To30;
  final List<double> bucket31To60;
  final List<double> bucketOver60;

  const ReportsBuildingAgingData({
    required this.labels,
    required this.currentNotDue,
    required this.bucket0To15,
    required this.bucket16To30,
    required this.bucket31To60,
    required this.bucketOver60,
  });
}

ReportsBuildingAgingData buildReportsBuildingAgingChartData(dynamic agingByBuildingRows) {
  final rows = agingByBuildingRows is List ? agingByBuildingRows : const [];
  final labels = <String>[];
  final currentNotDue = <double>[];
  final bucket0To15 = <double>[];
  final bucket16To30 = <double>[];
  final bucket31To60 = <double>[];
  final bucketOver60 = <double>[];

  for (final item in rows) {
    if (item is Map) {
      final code = item['building_code'] ?? item['building_name'] ?? '';
      labels.add(code.toString());
      currentNotDue.add(toNonNegativeNumber(item['current_not_due']));
      bucket0To15.add(toNonNegativeNumber(item['bucket_0_15']));
      bucket16To30.add(toNonNegativeNumber(item['bucket_16_30']));
      bucket31To60.add(toNonNegativeNumber(item['bucket_31_60']));
      bucketOver60.add(toNonNegativeNumber(item['bucket_over_60']));
    }
  }

  return ReportsBuildingAgingData(
    labels: labels,
    currentNotDue: currentNotDue,
    bucket0To15: bucket0To15,
    bucket16To30: bucket16To30,
    bucket31To60: bucket31To60,
    bucketOver60: bucketOver60,
  );
}

// ─── Payments URL Query Resolver ────────────────────────────────────────────

class ResolvedPaymentsQuery {
  final String? tab;
  final String agingBucket;
  final String creditStatus;

  const ResolvedPaymentsQuery({
    this.tab,
    required this.agingBucket,
    required this.creditStatus,
  });
}

ResolvedPaymentsQuery resolvePaymentsUrlQuery(String searchStr) {
  var clean = searchStr.trim();
  if (clean.startsWith('?')) {
    clean = clean.substring(1);
  }
  final uri = Uri(query: clean);
  final params = uri.queryParameters;

  final rawTab = params['tab'];
  final creditStatus = params['status'] ?? '';
  final rawBucket = params['bucket'] ?? '';
  final agingBucket = kDashboardAgingBucketKeys.contains(rawBucket) ? rawBucket : '';

  String? tab;
  if (rawTab == 'aging' || agingBucket.isNotEmpty) {
    tab = 'aging';
  } else if (rawTab == 'credits' ||
      rawTab == 'refunds' ||
      creditStatus == 'PENDING_DIRECT_REFUND') {
    tab = 'credits';
  } else if (rawTab == 'overpayments' || rawTab == 'transactions') {
    tab = rawTab;
  }

  return ResolvedPaymentsQuery(
    tab: tab,
    agingBucket: agingBucket,
    creditStatus: creditStatus,
  );
}
