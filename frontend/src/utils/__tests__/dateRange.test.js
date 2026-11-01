import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toDateOnlyStr,
  addDaysStr,
  addMonthsClampedStr,
  maxDateStr,
  extractApartmentBusyIntervals,
  findFirstAvailableStartDate,
  findOverlappingBusyIntervals,
  getDateOrderError,
  syncFilterDateRange,
} from '../dateRange.js';

test('toDateOnlyStr and addDaysStr / addMonthsClampedStr compute exact calendar dates', () => {
  assert.equal(toDateOnlyStr('2026-10-31'), '2026-10-31');
  assert.equal(toDateOnlyStr('2026-02-31'), '');
  // Full ISO timestamp serialized from local midnight (e.g. 2026-11-30T17:00:00.000Z in UTC+7)
  // must resolve back to local calendar date 2026-12-01, never slicing the UTC date prefix.
  const localMidnightIso = new Date(2026, 11, 1, 0, 0, 0).toISOString();
  assert.equal(toDateOnlyStr(localMidnightIso), '2026-12-01');
  assert.equal(addDaysStr('2026-12-01', 1), '2026-12-02');
  assert.equal(addDaysStr('2026-10-31', 1), '2026-11-01');
  assert.equal(addMonthsClampedStr('2026-12-02', 12), '2027-12-02');
  assert.equal(addMonthsClampedStr('2026-01-31', 1), '2026-02-28');
  assert.equal(maxDateStr('', '2026-10-31', '2026-12-02', null), '2026-12-02');
});

test('findFirstAvailableStartDate jumps outside occupied contract range (31/10 inside 01/10 -> 01/12 yields 02/12)', () => {
  const intervals = extractApartmentBusyIntervals({
    contracts: [
      {
        id: 'c1',
        status: 'ACTIVE',
        start_date: '2026-10-01',
        end_date: '2026-12-01',
        tenant_name: 'Nguyen Van A',
      },
    ],
    reservations: [],
  });

  const nextStart = findFirstAvailableStartDate('2026-10-31', intervals);
  assert.equal(nextStart, '2026-12-02');
});

test('findFirstAvailableStartDate chains across consecutive contracts and reservations and respects terminated_at', () => {
  const intervals = extractApartmentBusyIntervals({
    contracts: [
      {
        id: 'c1',
        status: 'TERMINATION_PENDING',
        start_date: '2026-10-01',
        end_date: '2027-04-01',
        terminated_at: '2026-12-01',
      },
    ],
    reservations: [
      {
        id: 'r1',
        status: 'HELD',
        hold_from: '2026-12-02',
        hold_until: '2026-12-15',
        prospect_name: 'Tran Thi B',
      },
    ],
  });

  assert.equal(findFirstAvailableStartDate('2026-10-31', intervals), '2026-12-16');

  // When converting r1 itself into a contract, excludeReservationId lets start_date be 2026-12-02
  const intervalsExcludingR1 = extractApartmentBusyIntervals(
    {
      contracts: [
        {
          id: 'c1',
          status: 'TERMINATION_PENDING',
          start_date: '2026-10-01',
          end_date: '2027-04-01',
          terminated_at: '2026-12-01',
        },
      ],
      reservations: [
        {
          id: 'r1',
          status: 'HELD',
          hold_from: '2026-12-02',
          hold_until: '2026-12-15',
        },
      ],
    },
    { excludeReservationId: 'r1' }
  );
  assert.equal(findFirstAvailableStartDate('2026-10-31', intervalsExcludingR1), '2026-12-02');
});

test('findFirstAvailableStartDate with minSpanDays=2 skips 1-day gap that cannot fit a reservation', () => {
  const intervals = extractApartmentBusyIntervals({
    contracts: [
      {
        id: 'c_future',
        status: 'ACTIVE',
        start_date: '2026-11-01',
        end_date: '2026-12-01',
      },
    ],
    reservations: [],
  });

  // Today 2026-10-31 has only 1 free day before 2026-11-01; reservation needs hold_until >= hold_from + 1
  assert.equal(findFirstAvailableStartDate('2026-10-31', intervals, { minSpanDays: 2 }), '2026-12-02');
});

test('findOverlappingBusyIntervals detects conflicts for both point inside busy range and spanning busy range', () => {
  const intervals = extractApartmentBusyIntervals({
    contracts: [
      {
        id: 'c1',
        status: 'ACTIVE',
        start_date: '2026-10-01',
        end_date: '2026-12-01',
      },
    ],
    reservations: [
      {
        id: 'r1',
        status: 'HELD',
        hold_from: '2026-12-10',
        hold_until: '2026-12-20',
      },
    ],
  });

  // Choosing start_date inside 01/10 -> 01/12 conflicts
  assert.equal(findOverlappingBusyIntervals('2026-11-15', '2027-11-15', intervals).length, 2);
  // Choosing 2026-12-02 -> 2026-12-09 is completely outside both intervals
  assert.equal(findOverlappingBusyIntervals('2026-12-02', '2026-12-09', intervals).length, 0);
  // Choosing 2026-12-02 -> 2026-12-15 overlaps reservation r1
  const hits = findOverlappingBusyIntervals('2026-12-02', '2026-12-15', intervals);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'r1');
});

test('getDateOrderError and syncFilterDateRange enforce before/after rules per context', () => {
  // Strict mode (contracts / reservations): end_date must be > start_date
  assert.notEqual(getDateOrderError('2026-12-02', '2026-12-02', { strictAfter: true }), '');
  assert.notEqual(getDateOrderError('2026-12-05', '2026-12-02', { strictAfter: true }), '');
  assert.equal(getDateOrderError('2026-12-02', '2026-12-03', { strictAfter: true }), '');

  // Inclusive mode (service cancellation / amendments): end_date >= start_date
  assert.equal(getDateOrderError('2026-12-02', '2026-12-02', { strictAfter: false }), '');
  assert.notEqual(getDateOrderError('2026-12-05', '2026-12-02', { strictAfter: false }), '');

  // Instant filter auto-sync (AuditLogsPage)
  assert.deepEqual(syncFilterDateRange('2026-11-10', '2026-11-05'), {
    fromDate: '2026-11-10',
    toDate: '2026-11-10',
  });
  assert.deepEqual(syncFilterDateRange('2026-11-01', '2026-11-05'), {
    fromDate: '2026-11-01',
    toDate: '2026-11-05',
  });
  assert.deepEqual(syncFilterDateRange('2026-11-10', ''), {
    fromDate: '2026-11-10',
    toDate: '',
  });
});

