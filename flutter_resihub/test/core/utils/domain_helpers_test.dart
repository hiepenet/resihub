import 'package:flutter_test/flutter_test.dart';

import 'package:flutter_resihub/core/utils/billing_helpers.dart';
import 'package:flutter_resihub/core/utils/deposit_ui_helpers.dart';
import 'package:flutter_resihub/core/utils/meter_batch_photo_helpers.dart';
import 'package:flutter_resihub/core/utils/ai_helpers.dart';
import 'package:flutter_resihub/core/utils/vietqr_banks.dart';
import 'package:flutter_resihub/core/utils/service_subscription_meta.dart';

void main() {
  group('1. Billing & Financial Calculations (billing_helpers.dart)', () {
    test('roundVND implements ROUND(x, -3) half-to-away-from-zero matching billing.js', () {
      expect(roundVND(123456), equals(123000));
      expect(roundVND(123500), equals(124000));
      expect(roundVND(123600), equals(124000));
      expect(roundVND(-123600), equals(-124000));
      expect(roundVND(-123456), equals(-123000));
      expect(roundVND(0), equals(0));
      expect(roundVND(null), equals(0));
      expect(roundVND(''), equals(0));
      expect(roundVND('abc'), equals(0));
      expect(roundVND(500), equals(1000));
      expect(roundVND(499), equals(0));
      expect(roundVND(1500), equals(2000));
    });

    test('todayVietnamYmd returns YYYY-MM-DD in UTC+7 (Asia/Ho_Chi_Minh)', () {
      final utcMorning = DateTime.utc(2026, 11, 14, 2, 0); // 09:00 VN
      expect(todayVietnamYmd(utcMorning), equals('2026-11-14'));

      final utcNightBefore = DateTime.utc(2026, 11, 13, 20, 0); // 03:00 VN next day (14th)
      expect(todayVietnamYmd(utcNightBefore), equals('2026-11-14'));
    });

    test('resolvePrdAgingBucket maps days overdue to PRD buckets', () {
      expect(resolvePrdAgingBucket(0), equals('current_not_due'));
      expect(resolvePrdAgingBucket(-5), equals('current_not_due'));
      expect(resolvePrdAgingBucket(1), equals('0_15'));
      expect(resolvePrdAgingBucket(15), equals('0_15'));
      expect(resolvePrdAgingBucket(16), equals('16_30'));
      expect(resolvePrdAgingBucket(30), equals('16_30'));
      expect(resolvePrdAgingBucket(31), equals('31_60'));
      expect(resolvePrdAgingBucket(60), equals('31_60'));
      expect(resolvePrdAgingBucket(61), equals('over_60'));
      expect(resolvePrdAgingBucket(120), equals('over_60'));

      expect(kPrdAgingBuckets.containsKey('current_not_due'), isTrue);
      expect(kPrdAgingBuckets['current_not_due']?.label, equals('Chưa đến hạn'));
      expect(kPrdAgingBuckets['over_60']?.variant, equals('red'));
    });

    test('previewSubscriptionProrata computes pro-rata and zero-usage correctly', () {
      // Zero usage
      final zeroRes = previewSubscriptionProrata(
        unitPrice: 100000,
        quantity: 1,
        zeroUsage: true,
      );
      expect(zeroRes.amount, equals(0));
      expect(zeroRes.formattedAmount, equals('0 ₫'));
      expect(zeroRes.description, contains('Miễn phí sử dụng'));

      // Inverted dates (end < start)
      final invRes = previewSubscriptionProrata(
        unitPrice: 100000,
        quantity: 1,
        startDate: '2026-11-20',
        endDate: '2026-11-10',
        periodYm: '2026-11',
      );
      expect(invRes.amount, equals(0));
      expect(invRes.description, contains('Ngày kết thúc trước ngày bắt đầu'));

      // Partial month: 15 days in November (30 days total) -> exactly 50%
      final proratedRes = previewSubscriptionProrata(
        unitPrice: 100000,
        quantity: 1,
        startDate: '2026-11-01',
        endDate: '2026-11-15',
        periodYm: '2026-11',
      );
      expect(proratedRes.daysInMonth, equals(30));
      expect(proratedRes.activeDays, equals(15));
      expect(proratedRes.isProrated, isTrue);
      expect(proratedRes.amount, equals(50000));
      expect(proratedRes.daysRatio, equals('15/30'));

      // Full month
      final fullRes = previewSubscriptionProrata(
        unitPrice: 200000,
        quantity: 2,
        periodYm: '2026-11',
      );
      expect(fullRes.activeDays, equals(30));
      expect(fullRes.isProrated, isFalse);
      expect(fullRes.amount, equals(400000));
      expect(fullRes.toString(), equals('400.000 ₫'));
    });

    test('canConfirmInvoiceVoid requires exact code and non-empty reason', () {
      expect(
        canConfirmInvoiceVoid(
          invoice: 'INV-2026-001',
          typedInvoiceCode: 'INV-2026-001',
          reason: 'Sai chỉ số nước',
        ),
        isTrue,
      );

      // Wrong code
      expect(
        canConfirmInvoiceVoid(
          invoice: 'INV-2026-001',
          typedInvoiceCode: 'INV-2026-999',
          reason: 'Lý do hợp lệ',
        ),
        isFalse,
      );

      // Missing reason
      expect(
        canConfirmInvoiceVoid(
          invoice: 'INV-2026-001',
          typedInvoiceCode: 'INV-2026-001',
          reason: '   ',
        ),
        isFalse,
      );

      // With Map invoice object
      expect(
        canConfirmInvoiceVoid(
          invoice: {'invoice_code': 'INV-MAP-123'},
          typedInvoiceCode: 'INV-MAP-123',
          reason: 'Đổi phòng',
        ),
        isTrue,
      );
    });

    test('canActorApproveInvoiceAdjustment and canActorApproveCreditRefund 4-eyes checks', () {
      // 1. OWNER different from creator can approve
      expect(
        canActorApproveInvoiceAdjustment(
          actor: {'id': 'user-owner', 'roles': ['OWNER']},
          record: {'created_by': 'user-manager'},
          buildingHasActiveOwner: true,
        ),
        isTrue,
      );

      // 2. Self-approval blocked when allowSelfApproval = false
      expect(
        canActorApproveInvoiceAdjustment(
          actor: {'id': 'user-1', 'roles': ['OWNER']},
          record: {'created_by': 'user-1'},
          allowSelfApproval: false,
        ),
        isFalse,
      );

      // 3. Self-approval allowed when allowSelfApproval = true
      expect(
        canActorApproveInvoiceAdjustment(
          actor: {'id': 'user-1', 'roles': ['OWNER']},
          record: {'created_by': 'user-1'},
          allowSelfApproval: true,
        ),
        isTrue,
      );

      // 4. SYS_ADMIN blocked when buildingHasActiveOwner = true
      expect(
        canActorApproveInvoiceAdjustment(
          actor: {'id': 'user-admin', 'roles': ['SYS_ADMIN']},
          record: {'created_by': 'user-manager'},
          buildingHasActiveOwner: true,
        ),
        isFalse,
      );

      // 5. SYS_ADMIN fallback allowed when buildingHasActiveOwner = false
      expect(
        canActorApproveInvoiceAdjustment(
          actor: {'id': 'user-admin', 'roles': ['SYS_ADMIN']},
          record: {'created_by': 'user-manager'},
          buildingHasActiveOwner: false,
        ),
        isTrue,
      );

      // canActorApproveCreditRefund delegates to the same rules
      expect(
        canActorApproveCreditRefund(
          actor: {'id': 'user-admin', 'roles': ['SYS_ADMIN']},
          record: {'created_by': 'user-manager'},
          buildingHasActiveOwner: false,
        ),
        isTrue,
      );
    });

    test('evaluateClientMeterAnomaly detects anomalies > threshold % (default 30%)', () {
      // Empty input
      final empty = evaluateClientMeterAnomaly(
        prevReading: 100,
        currentReading: '',
      );
      expect(empty.hasInput, isFalse);
      expect(empty.isInvalid, isFalse);
      expect(empty.isAbnormal, isFalse);

      // Invalid (current < prev)
      final invalid = evaluateClientMeterAnomaly(
        prevReading: 100,
        currentReading: 95,
      );
      expect(invalid.hasInput, isTrue);
      expect(invalid.isInvalid, isTrue);
      expect(invalid.isAbnormal, isFalse);

      // No baseline average available
      final noBaseline = evaluateClientMeterAnomaly(
        prevReading: 100,
        currentReading: 150,
        baselineAvg: null,
      );
      expect(noBaseline.consumption, equals(50));
      expect(noBaseline.diffPct, isNull);
      expect(noBaseline.isAbnormal, isFalse);

      // Normal within 30% threshold (baseline 100, current 125 -> +25%)
      final normal = evaluateClientMeterAnomaly(
        prevReading: 1000,
        currentReading: 1125,
        baselineAvg: 100,
      );
      expect(normal.consumption, equals(125));
      expect(normal.diffPct, equals(25));
      expect(normal.isAbnormal, isFalse);

      // Abnormal > 30% threshold (baseline 100, current 135 -> +35%)
      final abnormal = evaluateClientMeterAnomaly(
        prevReading: 1000,
        currentReading: 1135,
        baselineAvg: 100,
      );
      expect(abnormal.consumption, equals(135));
      expect(abnormal.diffPct, equals(35));
      expect(abnormal.isAbnormal, isTrue);
    });

    test('computeMeterEstimatedAmount applies tier pricing and roundVND', () {
      expect(computeMeterEstimatedAmount(null), isNull);
      expect(computeMeterEstimatedAmount(-5), isNull);
      expect(computeMeterEstimatedAmount(0), equals(0));

      // Uses effective_unit_price over unit_price
      final meterRow = {
        'unit_price': 3500,
        'effective_unit_price': 4000,
      };
      // 55 kWh * 4000 = 220000
      expect(computeMeterEstimatedAmount(55, meterRow), equals(220000));

      // Fallback to unit_price if effective is absent
      final fallbackRow = {'unit_price': 3500};
      // 33.3 * 3500 = 116550 -> roundVND -> 117000
      expect(computeMeterEstimatedAmount(33.3, fallbackRow), equals(117000));
    });

    test('summarizeSkippedContracts categorizes reasons correctly', () {
      final skipped = [
        {'apartment_code': 'A101', 'reason_code': 'MISSING_CONFIRMED_METER_READING'},
        {'apartment_code': 'A102', 'reason_code': 'MISSING_CONFIRMED_METER_READING'},
        {'apartment_code': 'A103', 'reason_code': 'ZERO_BILLABLE_AMOUNT'},
        {'contract_code': 'CTR-004', 'reason_code': 'ALREADY_EXISTS'},
      ];

      final summary = summarizeSkippedContracts(skipped);
      expect(summary.totalSkipped, equals(4));
      expect(summary.missingMeterCount, equals(2));
      expect(summary.missingMeterApartments, equals(['A101', 'A102']));
      expect(summary.zeroBillableCount, equals(1));
      expect(summary.zeroBillableApartments, equals(['A103']));
      expect(summary.otherCount, equals(1));
      expect(summary.message, contains('Thiếu chỉ số đồng hồ'));
      expect(summary.message, contains('Không phát sinh khoản thu'));
    });

    test('resolveResidentInvoiceTotalsSummary computes subtotal, remaining, and breakdown flag', () {
      final summary = resolveResidentInvoiceTotalsSummary({
        'total_amount': 2500000,
        'paid_amount': 1000000,
        'adjustment_amount': -200000,
        'credit_offset_amount': 300000,
        'status': 'PARTIALLY_PAID',
      });

      expect(summary.totalAmount, equals(2500000));
      expect(summary.paidAmount, equals(1000000));
      expect(summary.remainingAmount, equals(1500000));
      expect(summary.adjustmentAmount, equals(-200000));
      expect(summary.creditOffsetAmount, equals(300000));
      expect(summary.showPreTotalBreakdown, isTrue);

      // Void invoice has remainingAmount = 0
      final voidSummary = resolveResidentInvoiceTotalsSummary({
        'total_amount': 2000000,
        'paid_amount': 0,
        'status': 'VOID',
      });
      expect(voidSummary.remainingAmount, equals(0));
    });

    test('resolveResidentInvoiceLineMeterImage extracts url only for electricity & water', () {
      expect(
        resolveResidentInvoiceLineMeterImage({
          'item_type': 'ELECTRICITY',
          'meter_image_url': 'https://s3.example.com/meter1.jpg',
        }),
        equals('https://s3.example.com/meter1.jpg'),
      );

      expect(
        resolveResidentInvoiceLineMeterImage({
          'item_type': 'WATER',
          'formula_meta': {'image_url': 'https://s3.example.com/water.jpg'},
        }),
        equals('https://s3.example.com/water.jpg'),
      );

      expect(
        resolveResidentInvoiceLineMeterImage({
          'item_type': 'PARKING',
          'meter_image_url': 'https://s3.example.com/parking.jpg',
        }),
        isNull,
      );
    });

    test('resolveMeterSlotView maps overlapping contract slots properly', () {
      final meter = {
        'id': 'meter-1',
        'target_contract_id': 'c-1',
        'overlapping_contracts': [
          {
            'contract_id': 'c-1',
            'contract_code': 'HD-001',
            'slot_index': 1,
            'total_slots': 2,
            'reading_id': 'r-1',
            'current_reading': 150,
          },
          {
            'contract_id': 'c-2',
            'contract_code': 'HD-002',
            'slot_index': 2,
            'total_slots': 2,
            'reading_id': 'r-2',
            'current_reading': 280,
          },
        ],
      };

      final view = resolveMeterSlotView(meter, 'c-2');
      expect(view['target_contract_id'], equals('c-2'));
      expect(view['target_contract_code'], equals('HD-002'));
      expect(view['period_current_reading'], equals(280));
      expect(view['period_slot_index'], equals(2));
    });
  });

  group('2. Deposit & 4-Eyes Settlement UI Helpers (deposit_ui_helpers.dart)', () {
    test('computeSuggestedCancelSplit calculates refund split based on holdUntil days', () {
      // 0 hold amount
      final zeroSplit = computeSuggestedCancelSplit(holdAmount: 0);
      expect(zeroSplit.refundedAmount, equals(0));
      expect(zeroSplit.forfeitedAmount, equals(0));

      // >= full_refund_before_days (>= 3 days left) -> 100% refund
      final fullSplit = computeSuggestedCancelSplit(
        holdAmount: 2000000,
        holdUntil: '2026-11-20',
        todayStr: '2026-11-15', // 5 days left
      );
      expect(fullSplit.refundedAmount, equals(2000000));
      expect(fullSplit.forfeitedAmount, equals(0));

      // < 0 days left (expired) -> 0% refund, 100% forfeit
      final expiredSplit = computeSuggestedCancelSplit(
        holdAmount: 2000000,
        holdUntil: '2026-11-10',
        todayStr: '2026-11-15',
      );
      expect(expiredSplit.refundedAmount, equals(0));
      expect(expiredSplit.forfeitedAmount, equals(2000000));

      // In between (1 day left) -> 50% partial refund rounded to thousand
      final partialSplit = computeSuggestedCancelSplit(
        holdAmount: 2500000,
        holdUntil: '2026-11-16',
        todayStr: '2026-11-15',
      );
      expect(partialSplit.refundedAmount, equals(1250000));
      expect(partialSplit.forfeitedAmount, equals(1250000));
    });

    test('canActorApproveDepositRow & canActorApproveReservationRow 4-eyes checks', () {
      expect(
        canActorApproveDepositRow(
          isOwner: true,
          currentUserId: 'u-owner',
          createdBy: 'u-mgr',
        ),
        isTrue,
      );

      // Self-approval prevented
      expect(
        canActorApproveDepositRow(
          isOwner: true,
          currentUserId: 'u-1',
          createdBy: 'u-1',
          allowSelfApproval: false,
        ),
        isFalse,
      );

      // SYS_ADMIN fallback
      expect(
        canActorApproveDepositRow(
          isSysAdmin: true,
          buildingHasActiveOwner: true,
        ),
        isFalse,
      );
      expect(
        canActorApproveDepositRow(
          isSysAdmin: true,
          buildingHasActiveOwner: false,
        ),
        isTrue,
      );

      // Reservation row follows same policy
      expect(
        canActorApproveReservationRow(
          isSysAdmin: true,
          buildingHasActiveOwner: false,
        ),
        isTrue,
      );
    });

    test('getResidentDisputeWindowState manages 7-day countdown and closed status', () {
      final now = DateTime(2026, 11, 14, 12, 0);

      // Explicitly closed
      final closedState = getResidentDisputeWindowState({
        'status': 'REFUNDED',
        'settlement': {'post_settlement_dispute_closed': true},
      }, now);
      expect(closedState.canDispute, isFalse);
      expect(closedState.daysRemaining, equals(0));
      expect(closedState.lockedReason, equals('FINALIZED'));

      // Pending approval allows dispute
      final pendingState = getResidentDisputeWindowState({
        'status': 'PENDING_APPROVAL',
      }, now);
      expect(pendingState.canDispute, isTrue);
      expect(pendingState.daysRemaining, isNull);

      // Refunded 2 days ago -> 5 days remaining
      final payout2DaysAgo = now.subtract(const Duration(days: 2)).toIso8601String();
      final activeWindow = getResidentDisputeWindowState({
        'status': 'REFUNDED',
        'settlement': {'payout_at': payout2DaysAgo},
      }, now);
      expect(activeWindow.canDispute, isTrue);
      expect(activeWindow.daysRemaining, equals(5));

      // Refunded 8 days ago -> expired
      final payout8DaysAgo = now.subtract(const Duration(days: 8)).toIso8601String();
      final expiredWindow = getResidentDisputeWindowState({
        'status': 'REFUNDED',
        'settlement': {'payout_at': payout8DaysAgo},
      }, now);
      expect(expiredWindow.canDispute, isFalse);
      expect(expiredWindow.daysRemaining, equals(0));
      expect(expiredWindow.lockedReason, equals('EXPIRED'));
    });

    test('resolveSettlementPayoutSummary distinguishes deposit and credit refund', () {
      final summary = resolveSettlementPayoutSummary({
        'deposit_refund_amount': 2000000,
        'credit_refund_amount': 350000,
      });

      expect(summary.depositRefund, equals(2000000));
      expect(summary.creditRefund, equals(350000));
      expect(summary.totalPayout, equals(2350000));
      expect(summary.requiresUncPayout, isTrue);

      // Credit only payout still requires UNC payout
      final creditOnly = resolveSettlementPayoutSummary({
        'deposit_refund_amount': 0,
        'credit_refund_amount': 500000,
      });
      expect(creditOnly.requiresUncPayout, isTrue);

      final zeroPayout = resolveSettlementPayoutSummary({
        'deposit_refund_amount': 0,
        'credit_refund_amount': 0,
      });
      expect(zeroPayout.requiresUncPayout, isFalse);
    });
  });

  group('3. Meter Batch Photo Helpers (meter_batch_photo_helpers.dart)', () {
    test('constants match specification', () {
      expect(kMaxBatchMeterPhotos, equals(30));
      expect(kDefaultOcrConcurrency, equals(2));
    });

    test('detectMeterTypeHintFromText recognizes electricity and water markers', () {
      expect(detectMeterTypeHintFromText('A101_DIEN.jpg'), equals('ELECTRICITY'));
      expect(detectMeterTypeHintFromText('p202_kwh.png'), equals('ELECTRICITY'));
      expect(detectMeterTypeHintFromText('A101_NUOC.jpg'), equals('WATER'));
      expect(detectMeterTypeHintFromText('b303_m3.jpeg'), equals('WATER'));
      expect(detectMeterTypeHintFromText('A101.jpg'), isNull);
    });

    test('matchMeterFromFilename prioritizes longest apartment code to prevent prefix collision', () {
      final meters = [
        {
          'id': 'm-a10',
          'apartment_id': 'apt-10',
          'apartment_code': 'A10',
          'meter_code': 'M-A10-E',
          'meter_type': 'ELECTRICITY',
        },
        {
          'id': 'm-a100',
          'apartment_id': 'apt-100',
          'apartment_code': 'A100',
          'meter_code': 'M-A100-E',
          'meter_type': 'ELECTRICITY',
        },
        {
          'id': 'm-a1001-e',
          'apartment_id': 'apt-1001',
          'apartment_code': 'A1001',
          'meter_code': 'M-A1001-E',
          'meter_type': 'ELECTRICITY',
        },
        {
          'id': 'm-a1001-w',
          'apartment_id': 'apt-1001',
          'apartment_code': 'A1001',
          'meter_code': 'M-A1001-W',
          'meter_type': 'WATER',
        },
      ];

      // File 'A1001_dien.jpg' MUST match A1001 (ELECTRICITY), NOT A100 or A10
      final match1 = matchMeterFromFilename('A1001_dien.jpg', meters);
      expect(match1.matchKind, equals('EXACT_METER'));
      expect(match1.apartmentCode, equals('A1001'));
      expect(match1.meterId, equals('m-a1001-e'));

      // File 'A1001 (1).jpg' has apartment only
      final match2 = matchMeterFromFilename('A1001 (1).jpg', meters);
      expect(match2.matchKind, equals('APARTMENT_ONLY'));
      expect(match2.apartmentCode, equals('A1001'));
      expect(match2.meterId, isNull);

      // Exact meter_code match priority
      final matchExact = matchMeterFromFilename('IMG_M-A100-E.jpg', meters);
      expect(matchExact.matchKind, equals('EXACT_METER'));
      expect(matchExact.meterId, equals('m-a100'));
    });

    test('runBoundedConcurrencyQueue preserves order and limits parallel executions', () async {
      int active = 0;
      int maxActive = 0;

      final items = [10, 20, 30, 40, 50];
      final results = await runBoundedConcurrencyQueue<int, int>(
        items,
        2,
        (item, index) async {
          active++;
          if (active > maxActive) maxActive = active;
          await Future.delayed(Duration(milliseconds: 10 * (5 - index)));
          active--;
          return item * 2;
        },
      );

      expect(maxActive, lessThanOrEqualTo(2));
      expect(results.length, equals(5));
      expect(results.map((r) => r.value).toList(), equals([20, 40, 60, 80, 100]));
    });

    test('evaluateBatchPhotoImportItems detects duplicates, missing readings, and anomalies', () {
      final buildingMeters = [
        {
          'id': 'm-1',
          'apartment_code': 'A101',
          'meter_type': 'ELECTRICITY',
          'last_known_reading': 100,
          'baseline_avg_consumption': 50,
          'unit_price': 3500,
        },
        {
          'id': 'm-2',
          'apartment_code': 'A102',
          'meter_type': 'ELECTRICITY',
          'last_known_reading': 200,
          'period_reading_billed': true, // locked
        },
      ];

      final items = [
        {
          'id': 'it-1',
          'fileName': 'A101_dien.jpg',
          'meterId': 'm-1',
          'draftReading': '155', // consumption = 55 (normal vs baseline 50: +10%)
        },
        {
          'id': 'it-2',
          'fileName': 'A102_dien.jpg',
          'meterId': 'm-2',
          'draftReading': '210',
        },
        {
          'id': 'it-3',
          'fileName': 'A103_unknown.jpg',
          'meterId': null,
          'draftReading': '50',
        },
      ];

      final eval = evaluateBatchPhotoImportItems(items, buildingMeters);
      expect(eval.summary.totalCount, equals(3));
      expect(eval.summary.saveableCount, equals(1)); // only it-1 is saveable
      expect(eval.summary.lockedCount, equals(1)); // m-2 is billed
      expect(eval.summary.missingMeterCount, equals(1)); // it-3 has no meter
      expect(eval.rows[0].validationState, equals('READY'));
      expect(eval.rows[1].validationState, equals('LOCKED_BILLED'));
      expect(eval.rows[2].validationState, equals('MISSING_METER'));
    });
  });

  group('4. AI Helpers (ai_helpers.dart)', () {
    test('kDefaultAiConfig and mergeAiConfigState normalize model and retain overrides', () {
      expect(kDefaultAiConfig['model'], equals('gemini-3.8-flash'));

      final merged = mergeAiConfigState({
        'model': 'gemini-2.5-flash',
        'ocr_threshold': 0.85,
        'tasks': {'cccd_extract': false},
      });

      // Legacy gemini-2.5-flash normalized to gemini-3.8-flash
      expect(merged['model'], equals('gemini-3.8-flash'));
      expect(merged['ocr_threshold'], equals(0.85));
      expect((merged['tasks'] as Map)['cccd_extract'], isFalse);
      expect((merged['tasks'] as Map)['contract_extract'], isTrue);
    });

    test('getAiTriageBadgeMeta and canOneClickApplyAiTriage', () {
      final suggestedMeta = getAiTriageBadgeMeta('SUGGESTED');
      expect(suggestedMeta?['variant'], equals('amber'));
      expect(suggestedMeta?['sparkles'], isTrue);

      final reviewMeta = getAiTriageBadgeMeta('NEEDS_MANUAL_REVIEW');
      expect(reviewMeta?['variant'], equals('red'));
      expect(reviewMeta?['needsManualWarning'], isTrue);

      expect(
        canOneClickApplyAiTriage({
          'ai_suggested_category': 'PLUMBING',
          'ai_suggested_priority': 'HIGH',
          'ai_triage_status': 'SUGGESTED',
        }),
        isTrue,
      );

      // Already applied cannot be one-click applied again
      expect(
        canOneClickApplyAiTriage({
          'ai_suggested_category': 'PLUMBING',
          'ai_suggested_priority': 'HIGH',
          'ai_triage_status': 'APPLIED',
        }),
        isFalse,
      );
    });

    test('formatConfidenceBadge categorizes confidence levels', () {
      final low = formatConfidenceBadge(0.5, 0.75);
      expect(low.percentText, equals('50%'));
      expect(low.tone, equals('rose'));
      expect(low.isUncertain, isTrue);

      final medium = formatConfidenceBadge(0.8, 0.75);
      expect(medium.percentText, equals('80%'));
      expect(medium.tone, equals('amber'));
      expect(medium.isUncertain, isFalse);

      final high = formatConfidenceBadge(0.95, 0.75);
      expect(high.percentText, equals('95%'));
      expect(high.tone, equals('emerald'));
      expect(high.isUncertain, isFalse);
    });

    test('createAiFieldTracker and markFieldConfirmedOrEdited track manual modifications', () {
      final tracker = createAiFieldTracker(
        'sug-001',
        {'fullName': 'NGUYEN VAN A', 'idNumber': '001234567890'},
        {'fullName': 0.95, 'idNumber': 0.6},
      );

      expect(tracker['suggestionId'], equals('sug-001'));
      final fields = tracker['fields'] as Map<String, dynamic>;
      expect(fields['fullName']['suggestedValue'], equals('NGUYEN VAN A'));

      // Confirm without edit
      final confirmed = markFieldConfirmedOrEdited(tracker, 'fullName', 'NGUYEN VAN A');
      final confirmedFields = confirmed['fields'] as Map<String, dynamic>;
      expect(confirmedFields['fullName']['confirmed'], isTrue);
      expect(confirmedFields['fullName']['edited'], isFalse);

      // Edit with different value
      final edited = markFieldConfirmedOrEdited(tracker, 'fullName', 'NGUYEN VAN B');
      final editedFields = edited['fields'] as Map<String, dynamic>;
      expect(editedFields['fullName']['confirmed'], isTrue);
      expect(editedFields['fullName']['edited'], isTrue);
    });
  });

  group('5. VietQR Banks (vietqr_banks.dart)', () {
    test('kFallbackVietQrBanks has official banks list', () {
      expect(kFallbackVietQrBanks.isNotEmpty, isTrue);
      expect(kFallbackVietQrBanks.any((b) => b['code'] == 'VCB'), isTrue);
      expect(kFallbackVietQrBanks.any((b) => b['bin'] == '970407'), isTrue); // Techcombank
    });

    test('matchVietQrBank matches by code, bin, or bank_name', () {
      final matchByCode = matchVietQrBank(kFallbackVietQrBanks, {'bank_code': 'VCB'});
      expect(matchByCode?['shortName'], equals('Vietcombank'));

      final matchByBin = matchVietQrBank(kFallbackVietQrBanks, {'bank_bin': '970422'});
      expect(matchByBin?['shortName'], equals('MBBank'));

      final matchByName = matchVietQrBank(kFallbackVietQrBanks, {'bank_name': 'Techcombank'});
      expect(matchByName?['code'], equals('TCB'));
    });

    test('buildVietQrBankOptions creates rich option objects and prepends legacy bank if unlisted', () {
      final options = buildVietQrBankOptions(kFallbackVietQrBanks, {
        'bank_name': 'Ngan Hang Co Phien A (Old)',
        'bank_code': 'NHCP-A',
      });

      expect(options.first['value'], equals('Ngan Hang Co Phien A (Old)'));
      expect(options.first['sublabel'], equals('Ngân hàng hiện tại'));
    });
  });

  group('6. Service Subscription Meta & Parking License Plates (service_subscription_meta.dart)', () {
    test('isParkingService and allowsMultiQuantity identify services', () {
      expect(isParkingService('PARKING'), isTrue);
      expect(isParkingService('WATER'), isFalse);
      expect(isParkingService({'category': 'PARKING'}), isTrue);
      expect(isParkingService({'service_category': 'PARKING'}), isTrue);

      expect(allowsMultiQuantity({'billing_type': 'QUANTITY'}), isTrue);
      expect(allowsMultiQuantity({'category': 'PARKING'}), isTrue);
      expect(allowsMultiQuantity({'billing_type': 'FIXED'}), isFalse);
    });

    test('syncVehiclePlatesArray clamps between 1 and 10 and resizes gracefully', () {
      expect(syncVehiclePlatesArray([], 3), equals(['', '', '']));
      expect(syncVehiclePlatesArray(['29A-12345'], 2), equals(['29A-12345', '']));
      expect(syncVehiclePlatesArray(['1', '2', '3'], 1), equals(['1']));
      expect(syncVehiclePlatesArray(null, 15).length, equals(kMaxParkingQuantity));
    });

    test('validateServiceMetaInput validates quantities and catches duplicate license plates', () {
      // 1. Invalid quantity
      final invalidQty = validateServiceMetaInput(
        isParking: true,
        quantity: 0,
        vehiclePlates: [],
      );
      expect(invalidQty.valid, isFalse);
      expect(invalidQty.quantityError, contains('phải là số nguyên dương'));

      // 2. Parking quantity > 10
      final exceedQty = validateServiceMetaInput(
        isParking: true,
        quantity: 11,
        vehiclePlates: [],
      );
      expect(exceedQty.valid, isFalse);
      expect(exceedQty.quantityError, contains('tối đa 10 xe'));

      // 3. Duplicate license plates (case and space insensitive)
      final dupPlates = validateServiceMetaInput(
        isParking: true,
        quantity: 2,
        vehiclePlates: ['29A-123.45', ' 29a-123.45 '],
      );
      expect(dupPlates.valid, isFalse);
      expect(dupPlates.plateErrors[1], contains('bị trùng lặp'));

      // 4. Valid parking registration
      final validPkg = validateServiceMetaInput(
        isParking: true,
        quantity: 2,
        vehiclePlates: ['29A-123.45', '51B-678.90'],
        note: 'Gửi 1 ô tô và 1 xe máy',
      );
      expect(validPkg.valid, isTrue);
      expect(validPkg.cleanPlates, equals(['29A-123.45', '51B-678.90']));
      expect(validPkg.cleanNote, equals('Gửi 1 ô tô và 1 xe máy'));
    });
  });
}
