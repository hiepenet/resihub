import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;

import 'package:flutter_resihub/core/utils/format.dart';
import 'package:flutter_resihub/core/utils/validation.dart';
import 'package:flutter_resihub/core/utils/money_input_helpers.dart';
import 'package:flutter_resihub/core/utils/date_range.dart';
import 'package:flutter_resihub/core/utils/base64_file.dart';
import 'package:flutter_resihub/core/utils/idempotency.dart';
import 'package:flutter_resihub/core/utils/zalo_format.dart';
import 'package:flutter_resihub/core/utils/file_exporter.dart';

void main() {
  group('Formatters (format.dart)', () {
    test('formatMoney formats amounts with dots and ₫ symbol', () {
      expect(formatMoney(0), equals('0 ₫'));
      expect(formatMoney(null), equals('0 ₫'));
      expect(formatMoney(''), equals('0 ₫'));
      expect(formatMoney(1000000), equals('1.000.000 ₫'));
      expect(formatMoney(8500000), equals('8.500.000 ₫'));
      expect(formatMoney('8500000'), equals('8.500.000 ₫'));
      expect(formatMoney(123456789), equals('123.456.789 ₫'));
      expect(formatMoney(1000000, showSymbol: false), equals('1.000.000'));
      expect(formatMoney(0, showSymbol: false), equals('0'));
    });

    test('formatCompactMoney formats billions and millions correctly', () {
      expect(formatCompactMoney(0), equals('0 ₫'));
      expect(formatCompactMoney(500000), equals('500.000 ₫'));
      expect(formatCompactMoney(1000000), equals('1 tr ₫'));
      expect(formatCompactMoney(2500000), equals('2.5 tr ₫'));
      expect(formatCompactMoney(1000000000), equals('1 tỷ ₫'));
      expect(formatCompactMoney(1500000000), equals('1.50 tỷ ₫'));
      expect(formatCompactMoney(2050000000), equals('2.05 tỷ ₫'));
      expect(formatCompactMoney(-2500000), equals('-2.5 tr ₫'));
    });

    test('formatDate formats DateTime and ISO string to dd/MM/yyyy', () {
      expect(formatDate(null), equals('—'));
      expect(formatDate(''), equals('—'));
      expect(formatDate('invalid-date'), equals('—'));
      expect(formatDate('2026-11-14'), equals('14/11/2026'));
      expect(formatDate(DateTime(2026, 11, 14)), equals('14/11/2026'));
      expect(formatDate('2026-05-03T10:20:30Z'), equals('03/05/2026'));
    });

    test('formatDateTime formats DateTime and ISO string to dd/MM/yyyy HH:mm', () {
      expect(formatDateTime(null), equals('—'));
      expect(formatDateTime(''), equals('—'));
      expect(formatDateTime(DateTime(2026, 11, 14, 9, 5)), equals('14/11/2026 09:05'));
      expect(formatDateTime(DateTime(2026, 11, 14, 18, 45)), equals('14/11/2026 18:45'));
    });

    test('formatDateTime and formatDate convert UTC ISO string to local timezone', () {
      final utcDt = DateTime.utc(2026, 11, 14, 10, 0);
      final localDt = utcDt.toLocal();
      final expectedHour = localDt.hour.toString().padLeft(2, '0');
      final expectedMinute = localDt.minute.toString().padLeft(2, '0');
      final expectedDay = localDt.day.toString().padLeft(2, '0');
      final expectedMonth = localDt.month.toString().padLeft(2, '0');
      final expectedYear = localDt.year.toString().padLeft(4, '0');
      final expectedDateTime = '$expectedDay/$expectedMonth/$expectedYear $expectedHour:$expectedMinute';

      expect(formatDateTime(utcDt.toIso8601String()), equals(expectedDateTime));
      expect(formatDate(utcDt.toIso8601String()), equals('$expectedDay/$expectedMonth/$expectedYear'));
    });

    test('formatRelativeTime handles seconds, minutes, hours, days, and older', () {
      final now = DateTime(2026, 11, 14, 12, 0, 0);
      expect(formatRelativeTime(null, now: now), equals(''));
      expect(formatRelativeTime('invalid', now: now), equals(''));
      // < 60s
      expect(formatRelativeTime(now.subtract(const Duration(seconds: 30)), now: now), equals('Vừa xong'));
      // < 1h
      expect(formatRelativeTime(now.subtract(const Duration(minutes: 15)), now: now), equals('15 phút trước'));
      // < 24h
      expect(formatRelativeTime(now.subtract(const Duration(hours: 3)), now: now), equals('3 giờ trước'));
      // < 7d
      expect(formatRelativeTime(now.subtract(const Duration(days: 2)), now: now), equals('2 ngày trước'));
      // >= 7d falls back to formatDate
      expect(formatRelativeTime(now.subtract(const Duration(days: 10)), now: now), equals('04/11/2026'));
    });

    test('getCurrentPeriod returns YYYY-MM period string', () {
      final date = DateTime(2026, 11, 14);
      expect(getCurrentPeriod(date), equals('2026-11'));
      expect(getCurrentPeriod(DateTime(2026, 1, 5)), equals('2026-01'));
    });

    test('getCurrentPeriod uses Asia/Ho_Chi_Minh (UTC+7), not device local time', () {
      // UTC 2026-11-30 20:00 -> +7 = 2026-12-01 -> period flips to 2026-12.
      expect(getCurrentPeriod(DateTime.utc(2026, 11, 30, 20, 0)), equals('2026-12'));
      // UTC 2026-10-31 20:00 -> +7 = 2026-11-01 -> period flips to 2026-11.
      expect(getCurrentPeriod(DateTime.utc(2026, 10, 31, 20, 0)), equals('2026-11'));
      // UTC 2026-11-16 18:00 -> +7 = 2026-11-17 01:00 -> still 2026-11.
      expect(getCurrentPeriod(DateTime.utc(2026, 11, 16, 18, 0)), equals('2026-11'));
      // Local 2026-11-17 01:00 -> still 2026-11 after UTC+7 normalization.
      expect(getCurrentPeriod(DateTime(2026, 11, 17, 1, 0)), equals('2026-11'));
    });

    test('maskPhone masks middle digits', () {
      expect(maskPhone(null), equals('—'));
      expect(maskPhone(''), equals('—'));
      expect(maskPhone('0912'), equals('09***'));
      expect(maskPhone('091234'), equals('09***'));
      expect(maskPhone('0912345678'), equals('091****678'));
      expect(maskPhone('+84912345678'), equals('+84****678'));
    });

    test('maskIdNumber masks all but last 4 digits', () {
      expect(maskIdNumber(null), equals('—'));
      expect(maskIdNumber(''), equals('—'));
      expect(maskIdNumber('123'), equals('****123'));
      expect(maskIdNumber('1234'), equals('****1234'));
      expect(maskIdNumber('123456789'), equals('*****6789'));
      expect(maskIdNumber('012345678901'), equals('********8901'));
    });
  });

  group('Validation (validation.dart)', () {
    test('isValidPhone validates Vietnamese phone numbers', () {
      expect(isValidPhone('0912345678'), isTrue);
      expect(isValidPhone('+84912345678'), isTrue);
      expect(isValidPhone('091 234 5678'), isTrue);
      expect(isValidPhone('091-234-5678'), isTrue);
      expect(isValidPhone('(091) 234.5678'), isTrue);
      expect(isValidPhone('123456789'), isFalse); // Missing 0 or +84
      expect(isValidPhone('09123456789'), isFalse); // 11 digits
      expect(isValidPhone(''), isFalse);
      expect(isValidPhone(null), isFalse);
    });

    test('normalizePhone cleans up phone number and converts +84 to 0', () {
      expect(normalizePhone('+84912345678'), equals('0912345678'));
      expect(normalizePhone('091-234-5678'), equals('0912345678'));
      expect(normalizePhone('  +84 91 234 5678 '), equals('0912345678'));
    });

    test('isValidEmail validates emails correctly', () {
      expect(isValidEmail('test@resihub.vn'), isTrue);
      expect(isValidEmail('user.name+tag@domain.co'), isTrue);
      expect(isValidEmail('invalid'), isFalse);
      expect(isValidEmail('user@'), isFalse);
      expect(isValidEmail('@domain.com'), isFalse);
      expect(isValidEmail(''), isFalse);
      expect(isValidEmail(null), isFalse);
    });

    test('isValidIdNumber validates 9/12-digit CCCD and Passport format', () {
      expect(isValidIdNumber('123456789'), isTrue); // 9 digits
      expect(isValidIdNumber('012345678901'), isTrue); // 12 digits
      expect(isValidIdNumber('B1234567'), isTrue); // Passport: 1 letter + 7 digits
      expect(isValidIdNumber('c12345678'), isTrue); // Passport: 1 letter + 8 digits (case-insensitive)
      expect(isValidIdNumber('12345'), isFalse);
      expect(isValidIdNumber('1234567890'), isFalse); // 10 digits
      expect(isValidIdNumber('AB1234567'), isFalse); // 2 letters
      expect(isValidIdNumber(''), isFalse);
      expect(isValidIdNumber(null), isFalse);
    });

    test('extractErrorMessage extracts message from various error structures', () {
      expect(extractErrorMessage({'message': 'Lỗi server'}), equals('Lỗi server'));
      expect(extractErrorMessage(Exception('Lỗi ngoại lệ')), contains('Lỗi ngoại lệ'));
      expect(extractErrorMessage(null), equals('Đã xảy ra lỗi. Vui lòng thử lại.'));
      expect(extractErrorMessage(null, 'Custom fallback'), equals('Custom fallback'));
    });
  });

  group('MoneyInput Helpers (money_input_helpers.dart)', () {
    test('normalizeMoneyPropValue strips Postgres .00 decimals without 100x multiplication', () {
      // Postgres NUMERIC(14,2) string: "8500000.00" -> "8500000"
      expect(normalizeMoneyPropValue('8500000.00'), equals('8500000'));
      expect(normalizeMoneyPropValue('220000.5'), equals('220001'));
      expect(normalizeMoneyPropValue('8.500.000'), equals('8500000'));
      expect(normalizeMoneyPropValue(8500000), equals('8500000'));
      expect(normalizeMoneyPropValue(8500000.0), equals('8500000'));
      expect(normalizeMoneyPropValue('000'), equals('0'));
      expect(normalizeMoneyPropValue('0'), equals('0'));
      expect(normalizeMoneyPropValue(''), equals(''));
      expect(normalizeMoneyPropValue(null), equals(''));
      // Negative value handling
      expect(normalizeMoneyPropValue('-500000', allowNegative: true), equals('-500000'));
      expect(normalizeMoneyPropValue('-500000', allowNegative: false), equals('500000'));
    });

    test('normalizeMoneyPropValue matches JS Math.round on negative halves (allowNegative)', () {
      // JS Math.round(-500000.5) === -500000 (ties toward +Infinity); Dart .round() gives -500001.
      expect(normalizeMoneyPropValue(-1.5, allowNegative: true), equals('-1'));
      expect(normalizeMoneyPropValue(-500000.5, allowNegative: true), equals('-500000'));
      expect(normalizeMoneyPropValue('-500000.5', allowNegative: true), equals('-500000'));
      // Positive halves unchanged.
      expect(normalizeMoneyPropValue(220000.5), equals('220001'));
    });

    test('formatMoneyInputDisplay formats strings and Postgres values with thousand dots', () {
      expect(formatMoneyInputDisplay('8500000'), equals('8.500.000'));
      expect(formatMoneyInputDisplay('8500000.00'), equals('8.500.000'));
      expect(formatMoneyInputDisplay(1000000), equals('1.000.000'));
      expect(formatMoneyInputDisplay('0'), equals('0'));
      expect(formatMoneyInputDisplay(''), equals(''));
      expect(formatMoneyInputDisplay('-', allowNegative: true), equals('-'));
      expect(formatMoneyInputDisplay('-1500000', allowNegative: true), equals('-1.500.000'));
    });

    test('toNumericInputValue, normalizeDecimalNumericInputValue, and formatMoneyDraftForDisplay aliases match behavior', () {
      expect(toNumericInputValue('8500000.00'), equals('8500000'));
      expect(normalizeDecimalNumericInputValue('8500000.00'), equals('8500000'));
      expect(formatMoneyDraftForDisplay('8500000.00'), equals('8.500.000'));

      expect(toNumericInputValue(1250000), equals('1250000'));
      expect(normalizeDecimalNumericInputValue('220000.5'), equals('220001'));
      expect(formatMoneyDraftForDisplay(1250000), equals('1.250.000'));
      expect(formatMoneyDraftForDisplay('-', allowNegative: true), equals('-'));
    });

    test('parseMoneyUserEdit recalculates caret index and clean display text', () {
      // Typing "8500000" at end
      final edit1 = parseMoneyUserEdit('8500000', 7);
      expect(edit1.rawValue, equals('8500000'));
      expect(edit1.displayValue, equals('8.500.000'));
      expect(edit1.nextCaretIndex, equals(9));

      // Transient minus
      final editMinus = parseMoneyUserEdit('-', 1, allowNegative: true);
      expect(editMinus.isTransientMinus, isTrue);
      expect(editMinus.displayValue, equals('-'));
      expect(editMinus.nextCaretIndex, equals(1));

      // Empty input
      final editEmpty = parseMoneyUserEdit('', 0);
      expect(editEmpty.rawValue, equals(''));
      expect(editEmpty.displayValue, equals(''));
      expect(editEmpty.nextCaretIndex, equals(0));

      // All zeros -> compact to "0"
      final editZeros = parseMoneyUserEdit('000', 3);
      expect(editZeros.rawValue, equals('0'));
      expect(editZeros.displayValue, equals('0'));
      expect(editZeros.nextCaretIndex, equals(1));
    });

    test('handleMoneySeparatorKey skips separator dots on Backspace and Delete', () {
      // Backspace on "8.500.000" where caret is after first dot (index 2: "8.|500.000")
      // Should delete '8' (at index 0)
      final bsResult = handleMoneySeparatorKey('8.500.000', 2, 2, 'Backspace');
      expect(bsResult.handled, isTrue);
      expect(bsResult.rawValue, equals('500000'));
      expect(bsResult.displayValue, equals('500.000'));

      // Delete on "8.500.000" where caret is before first dot (index 1: "8|.500.000")
      // Should delete '5' (the digit after dot)
      final delResult = handleMoneySeparatorKey('8.500.000', 1, 1, 'Delete');
      expect(delResult.handled, isTrue);
      expect(delResult.rawValue, equals('800000'));
      expect(delResult.displayValue, equals('800.000'));

      // Regular character position is not handled
      final unhandled = handleMoneySeparatorKey('8.500.000', 3, 3, 'Backspace');
      expect(unhandled.handled, isFalse);
    });
  });

  group('Date Range Utilities (date_range.dart)', () {
    test('toDateOnlyStr normalizes various date representations to YYYY-MM-DD', () {
      expect(toDateOnlyStr(DateTime(2026, 11, 14)), equals('2026-11-14'));
      expect(toDateOnlyStr('2026-11-14'), equals('2026-11-14'));
      expect(toDateOnlyStr('2026-11-14T08:30:00.000Z'), equals('2026-11-14'));
      expect(toDateOnlyStr('invalid'), equals(''));
      expect(toDateOnlyStr(null), equals(''));
    });

    test('formatDateVi converts YYYY-MM-DD to DD/MM/YYYY', () {
      expect(formatDateVi('2026-11-14'), equals('14/11/2026'));
      expect(formatDateVi(''), equals(''));
    });

    test('addDaysStr and diffDaysStr handle UTC days calculations', () {
      expect(addDaysStr('2026-02-28', 1), equals('2026-03-01'));
      expect(addDaysStr('2026-11-14', -4), equals('2026-11-10'));
      expect(diffDaysStr('2026-01-01', '2026-01-10'), equals(9));
      expect(diffDaysStr('2026-01-10', '2026-01-01'), equals(-9));
      expect(diffDaysStr('invalid', '2026-01-10'), isNull);
    });

    test('addMonthsClampedStr clamps to month end', () {
      expect(addMonthsClampedStr('2026-01-31', 1), equals('2026-02-28')); // Non-leap year
      expect(addMonthsClampedStr('2024-01-31', 1), equals('2024-02-29')); // Leap year
      expect(addMonthsClampedStr('2026-03-31', 1), equals('2026-04-30'));
      expect(addMonthsClampedStr('2026-05-15', 2), equals('2026-07-15'));
    });

    test('maxDateStr and minDateStr find boundary dates', () {
      expect(maxDateStr(['2026-01-01', '2026-05-20', '2026-03-15']), equals('2026-05-20'));
      expect(minDateStr(['2026-01-01', '2026-05-20', '2026-03-15']), equals('2026-01-01'));
    });

    test('extractApartmentBusyIntervals extracts blocking contracts and HELD reservations', () {
      final contracts = [
        {
          'id': 'c1',
          'status': 'ACTIVE',
          'start_date': '2026-01-01',
          'end_date': '2026-06-30',
          'contract_number': 'HD-001',
        },
        {
          'id': 'c2',
          'status': 'TERMINATED', // Non-blocking
          'start_date': '2025-01-01',
          'end_date': '2025-12-31',
        },
      ];
      final reservations = [
        {
          'id': 'r1',
          'status': 'HELD',
          'hold_from': '2026-07-01',
          'hold_until': '2026-07-10',
          'prospect_name': 'Nguyễn Văn A',
        },
        {
          'id': 'r2',
          'status': 'CANCELLED', // Non-blocking
          'hold_from': '2026-08-01',
          'hold_until': '2026-08-10',
        },
      ];

      final intervals = extractApartmentBusyIntervals(
        contracts: contracts,
        reservations: reservations,
      );

      expect(intervals.length, equals(2));
      expect(intervals[0].id, equals('c1'));
      expect(intervals[0].kind, equals('contract'));
      expect(intervals[0].from, equals('2026-01-01'));
      expect(intervals[0].to, equals('2026-06-30'));
      expect(intervals[0].label, equals('HĐ HD-001'));

      expect(intervals[1].id, equals('r1'));
      expect(intervals[1].kind, equals('reservation'));
      expect(intervals[1].from, equals('2026-07-01'));
      expect(intervals[1].to, equals('2026-07-10'));
      expect(intervals[1].label, equals('Giữ chỗ (Nguyễn Văn A)'));
    });

    test('findFirstAvailableStartDate finds open window considering minSpanDays', () {
      final busy = [
        const BusyInterval(
          id: 'c1',
          kind: 'contract',
          status: 'ACTIVE',
          from: '2026-01-01',
          to: '2026-01-10',
          label: 'HĐ 1',
        ),
        const BusyInterval(
          id: 'r1',
          kind: 'reservation',
          status: 'HELD',
          from: '2026-01-12',
          to: '2026-01-20',
          label: 'Giữ chỗ 1',
        ),
      ];

      // Starting at 2026-01-05: busy until 10. Day 11 is free.
      // If minSpanDays = 1 -> '2026-01-11'
      expect(findFirstAvailableStartDate('2026-01-05', busy, minSpanDays: 1), equals('2026-01-11'));
      // If minSpanDays = 2 -> Day 11 to 12 overlaps with reservation starting on 12! So it pushes to '2026-01-21'
      expect(findFirstAvailableStartDate('2026-01-05', busy, minSpanDays: 2), equals('2026-01-21'));
    });

    test('findOverlappingBusyIntervals and formatBusyOverlapError', () {
      final busy = [
        const BusyInterval(
          id: 'c1',
          kind: 'contract',
          status: 'ACTIVE',
          from: '2026-02-01',
          to: '2026-02-28',
          label: 'HĐ 1',
        ),
      ];

      final overlaps = findOverlappingBusyIntervals('2026-02-15', '2026-03-15', busy);
      expect(overlaps.length, equals(1));
      final errorMsg = formatBusyOverlapError(overlaps);
      expect(errorMsg, contains('trùng với hợp đồng thuê (01/02/2026 → 28/02/2026)'));
    });

    test('getDateOrderError validates chronological order', () {
      // strictAfter: true (end > start)
      expect(getDateOrderError('2026-01-10', '2026-01-10', strictAfter: true), contains('phải sau'));
      expect(getDateOrderError('2026-01-11', '2026-01-10', strictAfter: true), contains('phải sau'));
      expect(getDateOrderError('2026-01-09', '2026-01-10', strictAfter: true), isEmpty);

      // strictAfter: false (end >= start)
      expect(getDateOrderError('2026-01-10', '2026-01-10', strictAfter: false), isEmpty);
      expect(getDateOrderError('2026-01-11', '2026-01-10', strictAfter: false), contains('không được nhỏ hơn'));
    });

    test('syncFilterDateRange keeps toDate synced if fromDate moves past it', () {
      final synced = syncFilterDateRange('2026-05-10', '2026-05-01');
      expect(synced.fromDate, equals('2026-05-10'));
      expect(synced.toDate, equals('2026-05-10'));

      final unchanged = syncFilterDateRange('2026-05-01', '2026-05-10');
      expect(unchanged.fromDate, equals('2026-05-01'));
      expect(unchanged.toDate, equals('2026-05-10'));
    });
  });

  group('Base64 File & Image Compression (base64_file.dart)', () {
    test('encodeBytesToDataUrl encodes bytes to base64 data URI and validates size', () {
      final bytes = Uint8List.fromList([1, 2, 3, 4]);
      final uri = encodeBytesToDataUrl(bytes, mimeType: 'image/jpeg');
      expect(uri, startsWith('data:image/jpeg;base64,'));

      // Reject oversized image (> 5MB)
      final largeBytes = Uint8List(5 * 1024 * 1024 + 1);
      expect(
        () => encodeBytesToDataUrl(largeBytes, mimeType: 'image/jpeg'),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('compressImageBytesToDataUrl resizes image > 1280px to <= 1280px', () async {
      // Create a test image with dimensions 2000 x 1000 (> 1280px)
      final original = img.Image(width: 2000, height: 1000);
      img.fill(original, color: img.ColorRgb8(255, 0, 0));
      final pngBytes = Uint8List.fromList(img.encodePng(original));

      final dataUri = await compressImageBytesToDataUrl(pngBytes, maxDimension: 1280, jpegQuality: 78);
      expect(dataUri, startsWith('data:image/jpeg;base64,'));

      // Verify the compressed image has max dimension <= 1280
      final base64Part = dataUri.split(',').last;
      final decodedBytes = base64Decode(base64Part);
      final resized = img.decodeImage(decodedBytes)!;
      expect(resized.width <= 1280, isTrue);
      expect(resized.height <= 1280, isTrue);
      expect(resized.width, equals(1280));
      expect(resized.height, equals(640)); // Preserved aspect ratio
    });
  });

  group('Idempotency (idempotency.dart)', () {
    test('createIdempotencyKey produces a valid UUID v4', () {
      final key = createIdempotencyKey();
      expect(key, matches(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', caseSensitive: false)));
    });

    test('withIdempotency adds Idempotency-Key header', () {
      final opts = withIdempotency({'headers': {'Content-Type': 'application/json'}});
      final headers = opts['headers'] as Map<String, dynamic>;
      expect(headers['Content-Type'], equals('application/json'));
      expect(headers['Idempotency-Key'], isNotEmpty);
    });

    test('canCollectAdditionalDeposit verifies reservation and contract status', () {
      // Valid condition: HELD, contract is ACTIVE, deposit_amount > amount_held > 0
      final valid = {
        'status': 'HELD',
        'contract_status': 'ACTIVE',
        'deposit_amount': 5000000,
        'amount_held': 2000000,
      };
      expect(canCollectAdditionalDeposit(valid), isTrue);

      // Already fully held
      final fullyHeld = {
        'status': 'HELD',
        'contract_status': 'ACTIVE',
        'deposit_amount': 5000000,
        'amount_held': 5000000,
      };
      expect(canCollectAdditionalDeposit(fullyHeld), isFalse);

      // Wrong status
      final cancelled = {
        'status': 'CANCELLED',
        'contract_status': 'ACTIVE',
        'deposit_amount': 5000000,
        'amount_held': 2000000,
      };
      expect(canCollectAdditionalDeposit(cancelled), isFalse);

      // Wrong contract status (e.g. TERMINATED)
      final terminated = {
        'status': 'HELD',
        'contract_status': 'TERMINATED',
        'deposit_amount': 5000000,
        'amount_held': 2000000,
      };
      expect(canCollectAdditionalDeposit(terminated), isFalse);
    });
  });

  group('Zalo Rich Text & Templates (zalo_format.dart)', () {
    test('kZaloQuickTemplates has 5 standard management templates', () {
      expect(kZaloQuickTemplates.length, equals(5));
      final keys = kZaloQuickTemplates.map((t) => t.key).toList();
      expect(keys, containsAll([
        'UTILITY_INTERRUPTION',
        'MAINTENANCE_NOTICE',
        'HOUSE_RULES',
        'SECURITY_ALERT',
        'GENERAL_ANNOUNCEMENT',
      ]));
    });

    test('parseZaloBoldSegments and stripZaloBoldMarkers parse **bold** markers', () {
      const text = 'Xin chào **Quý Cư dân**, vui lòng **đóng phí** đúng hạn.';
      final segments = parseZaloBoldSegments(text);
      expect(segments.length, equals(5));
      expect(segments[0].text, equals('Xin chào '));
      expect(segments[0].bold, isFalse);
      expect(segments[1].text, equals('Quý Cư dân'));
      expect(segments[1].bold, isTrue);
      expect(segments[2].text, equals(', vui lòng '));
      expect(segments[2].bold, isFalse);
      expect(segments[3].text, equals('đóng phí'));
      expect(segments[3].bold, isTrue);
      expect(segments[4].text, equals(' đúng hạn.'));
      expect(segments[4].bold, isFalse);

      final stripped = stripZaloBoldMarkers(text);
      expect(stripped, equals('Xin chào Quý Cư dân, vui lòng đóng phí đúng hạn.'));
    });

    test('zaloTextToHtml converts bold markers to <b> and newlines to <br>', () {
      const text = 'Dòng 1 **đậm**\nDòng 2';
      final html = zaloTextToHtml(text);
      expect(html, equals('Dòng 1 <b>đậm</b><br>Dòng 2'));
    });

    test('isValidZaloGroupUrl validates zalo.me URLs', () {
      expect(isValidZaloGroupUrl('https://zalo.me/g/abcdef123'), isTrue);
      expect(isValidZaloGroupUrl('https://chat.zalo.me/g/xyz'), isTrue);
      expect(isValidZaloGroupUrl(''), isTrue); // Empty or null is treated as valid (optional)
      expect(isValidZaloGroupUrl(null), isTrue);
      expect(isValidZaloGroupUrl('https://facebook.com/group'), isFalse);
      expect(isValidZaloGroupUrl('https://zalo.me/../etc'), isFalse);
    });

    test('buildZaloPreviewText formats timestamp in Asia/Ho_Chi_Minh as HH:mm dd/MM/yyyy', () {
      // UTC 17:30 -> 00:30 next day in UTC+7; React Intl vi-VN order is time-first.
      final text = buildZaloPreviewText(scheduledOrSentAt: '2026-11-17T17:30:00Z');
      expect(text, contains('🕒 Thời điểm ghi nhận: **00:30 18/11/2026**'));
      expect(text, isNot(contains('17/11/2026 17:30')));
    });

    test('buildRoomMaintenanceZaloText formats next appointment in Asia/Ho_Chi_Minh', () {
      final text = buildRoomMaintenanceZaloText({
        'next_appointment_at': '2026-11-17T17:30:00Z',
      });
      expect(text, contains('📅 Lịch hẹn xử lý tiếp theo: **00:30 18/11/2026**'));
    });

    test('buildRoomMaintenanceZaloText NEVER leaks internal_note to residents', () {
      final detail = {
        'building_code': 'TH01',
        'apartment_code': 'P302',
        'tracking_code': 'SR-2026-001',
        'category': 'ELECTRICAL',
        'title': 'Sửa bóng đèn phòng ngủ',
        'status': 'IN_PROGRESS',
        'assigned_to_name': 'KTV Minh',
        'internal_note': 'Cư dân này hay phàn nàn, cần tính phí cẩn thận! MẬT',
      };

      final text = buildRoomMaintenanceZaloText(detail);
      expect(text, contains('TH01'));
      expect(text, contains('P302'));
      expect(text, contains('#SR-2026-001'));
      expect(text, contains('KTV Minh'));
      // ABSOLUTE REQUIREMENT: internal_note must NOT be in output!
      expect(text, isNot(contains('Cư dân này hay phàn nàn')));
      expect(text, isNot(contains('internal_note')));
      expect(text, isNot(contains('MẬT')));
    });

    test('computeSlaBadgeMeta handles COMPLETED, OVERDUE, DUE_SOON, and ON_TRACK', () {
      final now = DateTime(2026, 11, 14, 12, 0);

      // RESOLVED -> COMPLETED
      final completed = computeSlaBadgeMeta(status: 'RESOLVED', now: now);
      expect(completed.state, equals('COMPLETED'));
      expect(completed.variant, equals('emerald'));

      // CANCELLED -> COMPLETED (slate)
      final cancelled = computeSlaBadgeMeta(status: 'CANCELLED', now: now);
      expect(cancelled.state, equals('COMPLETED'));
      expect(cancelled.variant, equals('slate'));

      // Past slaDueAt -> OVERDUE
      final overdue = computeSlaBadgeMeta(
        status: 'IN_PROGRESS',
        slaDueAt: now.subtract(const Duration(minutes: 90)),
        now: now,
      );
      expect(overdue.state, equals('OVERDUE'));
      expect(overdue.variant, equals('red'));
      expect(overdue.label, contains('Quá hạn SLA'));

      // Due in 30 minutes -> DUE_SOON
      final dueSoon = computeSlaBadgeMeta(
        status: 'ASSIGNED',
        slaDueAt: now.add(const Duration(minutes: 30)),
        now: now,
      );
      expect(dueSoon.state, equals('DUE_SOON'));
      expect(dueSoon.variant, equals('amber'));
      expect(dueSoon.label, contains('Sắp hết hạn SLA'));

      // Due in 5 hours -> ON_TRACK
      final onTrack = computeSlaBadgeMeta(
        status: 'NEW',
        slaDueAt: now.add(const Duration(hours: 5)),
        now: now,
      );
      expect(onTrack.state, equals('ON_TRACK'));
      expect(onTrack.variant, equals('emerald'));
    });
  });

  group('File Exporter (file_exporter.dart)', () {
    test('buildUtf8BomCsvBytes includes UTF-8 BOM and properly escapes CSV cells', () {
      final headers = [
        CsvHeader(label: 'Mã phòng', key: 'code'),
        CsvHeader(label: 'Giá thuê, VND', key: 'rent'),
        CsvHeader(label: 'Ghi chú', key: 'note'),
      ];
      final rows = [
        {'code': 'P101', 'rent': 8500000, 'note': 'Phòng có ban công'},
        {'code': 'P102', 'rent': 9000000, 'note': 'Có dấu "ngoặc kép", phẩy'},
      ];

      final bytes = buildUtf8BomCsvBytes(headers: headers, rows: rows);

      // UTF-8 BOM check: 0xEF, 0xBB, 0xBF
      expect(bytes.length, greaterThan(3));
      expect(bytes[0], equals(0xEF));
      expect(bytes[1], equals(0xBB));
      expect(bytes[2], equals(0xBF));

      final csvContent = utf8.decode(bytes.sublist(3));
      expect(csvContent, contains('Mã phòng,"Giá thuê, VND",Ghi chú'));
      expect(csvContent, contains('P101,8500000,Phòng có ban công'));
      expect(csvContent, contains('P102,9000000,"Có dấu ""ngoặc kép"", phẩy"'));
    });
  });
}
