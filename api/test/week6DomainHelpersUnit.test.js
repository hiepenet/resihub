import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SERVICE_REQUEST_OPEN_STATUSES,
  PREFERRED_SLOT_CODES,
  buildServiceRequestTrackingPrefix,
  computeServiceRequestSlaDeadlines,
  isWithinDuplicateWindow,
  validateServiceRequestTransition,
} from '../src/services/serviceRequestRules.js';

import {
  ZALO_ANNOUNCEMENT_TEMPLATES,
  validateZaloInviteLink,
  formatAnnouncementForZalo,
  formatServiceRequestForRoomZalo,
} from '../src/services/zaloFormatter.js';

test('Task 1: exported constants match M11 & M13 contracts', () => {
  assert.deepEqual(SERVICE_REQUEST_OPEN_STATUSES, [
    'NEW',
    'ASSIGNED',
    'IN_PROGRESS',
    'ON_HOLD',
    'REOPENED',
  ]);
  assert.deepEqual(PREFERRED_SLOT_CODES, [
    'MORNING_08_12',
    'AFTERNOON_13_17',
    'EVENING_18_21',
    'ANYTIME',
  ]);
  assert.equal(Array.isArray(ZALO_ANNOUNCEMENT_TEMPLATES), true);
  const templateTypes = ZALO_ANNOUNCEMENT_TEMPLATES.map((t) => t.type);
  for (const expectedType of [
    'UTILITY_INTERRUPTION',
    'MAINTENANCE_NOTICE',
    'HOUSE_RULES',
    'SECURITY_ALERT',
    'ANNOUNCEMENT',
  ]) {
    assert.ok(
      templateTypes.includes(expectedType) ||
        ZALO_ANNOUNCEMENT_TEMPLATES.some((t) => t.key === 'GENERAL_ANNOUNCEMENT'),
      `Expected template coverage for ${expectedType}`
    );
  }
});

test('Review Focus #4: buildServiceRequestTrackingPrefix uses Asia/Ho_Chi_Minh date across UTC midnight', () => {
  // 2026-10-31T17:05:00Z is 2026-11-01 00:05:00 ICT (+07:00)
  const prefix = buildServiceRequestTrackingPrefix(new Date('2026-10-31T17:05:00.000Z'));
  assert.equal(prefix, 'SR-20261101-');
});

test('computeServiceRequestSlaDeadlines computes 2h response and 4h urgent vs 24h normal resolve deadlines', () => {
  const createdAt = new Date('2026-11-01T01:00:00.000Z');

  const normalSla = computeServiceRequestSlaDeadlines({
    createdAt,
    priority: 'NORMAL',
    slaConfig: { response_hours: 2, urgent_resolve_hours: 4, normal_resolve_hours: 24 },
  });
  assert.equal(normalSla.responseHours, 2);
  assert.equal(normalSla.resolveHours, 24);
  assert.equal(normalSla.slaResponseDueAt.toISOString(), '2026-11-01T03:00:00.000Z');
  assert.equal(normalSla.slaDueAt.toISOString(), '2026-11-02T01:00:00.000Z');

  const highSla = computeServiceRequestSlaDeadlines({
    createdAt,
    priority: 'HIGH',
    slaConfig: {},
  });
  assert.equal(highSla.responseHours, 2);
  assert.equal(highSla.resolveHours, 24);

  const urgentSla = computeServiceRequestSlaDeadlines({
    createdAt,
    priority: 'URGENT',
    slaConfig: { response_hours: 2, urgent_resolve_hours: 4, normal_resolve_hours: 24 },
  });
  assert.equal(urgentSla.responseHours, 2);
  assert.equal(urgentSla.resolveHours, 4);
  assert.equal(urgentSla.slaResponseDueAt.toISOString(), '2026-11-01T03:00:00.000Z');
  assert.equal(urgentSla.slaDueAt.toISOString(), '2026-11-01T05:00:00.000Z');
});

test('Review Focus #2: isWithinDuplicateWindow enforces 24h boundary and open status filter', () => {
  const now = new Date('2026-11-02T10:00:00.000Z');
  const ago23h59m = new Date(now.getTime() - (23 * 60 + 59) * 60 * 1000);
  const ago24h01m = new Date(now.getTime() - (24 * 60 + 1) * 60 * 1000);
  const ago1h = new Date(now.getTime() - 60 * 60 * 1000);

  assert.equal(
    isWithinDuplicateWindow({ existingCreatedAt: ago23h59m, existingStatus: 'NEW', now }),
    true
  );
  assert.equal(
    isWithinDuplicateWindow({ existingCreatedAt: ago23h59m, existingStatus: 'ON_HOLD', now }),
    true
  );
  assert.equal(
    isWithinDuplicateWindow({ existingCreatedAt: ago24h01m, existingStatus: 'NEW', now }),
    false
  );
  for (const closedLike of ['RESOLVED', 'CLOSED', 'CANCELLED']) {
    assert.equal(
      isWithinDuplicateWindow({ existingCreatedAt: ago1h, existingStatus: closedLike, now }),
      false
    );
  }
});

test('Review Focus #3: validateServiceRequestTransition enforces MANAGER & RESIDENT state machines, holdReason and reopen window', () => {
  // MANAGER transitions
  for (const toStatus of ['ASSIGNED', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED']) {
    const res = validateServiceRequestTransition({
      fromStatus: 'NEW',
      toStatus,
      actorRole: 'MANAGER',
    });
    assert.equal(res.valid, true, `MANAGER NEW -> ${toStatus} should be valid`);
  }

  const missingHoldReason = validateServiceRequestTransition({
    fromStatus: 'NEW',
    toStatus: 'ON_HOLD',
    actorRole: 'MANAGER',
    holdReason: '   ',
  });
  assert.equal(missingHoldReason.valid, false);
  assert.equal(missingHoldReason.code, 'HOLD_REASON_REQUIRED');

  const validHold = validateServiceRequestTransition({
    fromStatus: 'NEW',
    toStatus: 'ON_HOLD',
    actorRole: 'MANAGER',
    holdReason: 'Cư dân đi công tác hẹn thứ 7',
  });
  assert.equal(validHold.valid, true);

  assert.equal(
    validateServiceRequestTransition({
      fromStatus: 'REOPENED',
      toStatus: 'IN_PROGRESS',
      actorRole: 'MANAGER',
    }).valid,
    true
  );
  assert.equal(
    validateServiceRequestTransition({
      fromStatus: 'REOPENED',
      toStatus: 'RESOLVED',
      actorRole: 'MANAGER',
    }).valid,
    true
  );

  const closedToInProgress = validateServiceRequestTransition({
    fromStatus: 'CLOSED',
    toStatus: 'IN_PROGRESS',
    actorRole: 'MANAGER',
  });
  assert.equal(closedToInProgress.valid, false);
  assert.equal(closedToInProgress.code, 'INVALID_STATUS_TRANSITION');

  // RESIDENT transitions
  assert.equal(
    validateServiceRequestTransition({
      fromStatus: 'NEW',
      toStatus: 'CANCELLED',
      actorRole: 'RESIDENT',
    }).valid,
    true
  );

  const assignedCancel = validateServiceRequestTransition({
    fromStatus: 'ASSIGNED',
    toStatus: 'CANCELLED',
    actorRole: 'RESIDENT',
  });
  assert.equal(assignedCancel.valid, false);
  assert.equal(assignedCancel.code, 'INVALID_STATUS_TRANSITION');

  const resolvedAt = new Date('2026-11-01T10:00:00.000Z');
  const within3Days = new Date('2026-11-04T09:59:00.000Z');
  const after3Days = new Date('2026-11-04T10:01:00.000Z');

  const validReopen = validateServiceRequestTransition({
    fromStatus: 'RESOLVED',
    toStatus: 'REOPENED',
    actorRole: 'RESIDENT',
    reopenReason: 'Vẫn còn rỉ nước mạnh',
    resolvedAt,
    reopenWindowDays: 3,
    now: within3Days,
  });
  assert.equal(validReopen.valid, true);

  const shortReopenReason = validateServiceRequestTransition({
    fromStatus: 'RESOLVED',
    toStatus: 'REOPENED',
    actorRole: 'RESIDENT',
    reopenReason: 'Lỗi',
    resolvedAt,
    reopenWindowDays: 3,
    now: within3Days,
  });
  assert.equal(shortReopenReason.valid, false);
  assert.equal(shortReopenReason.code, 'REOPEN_REASON_REQUIRED');

  const expiredReopen = validateServiceRequestTransition({
    fromStatus: 'RESOLVED',
    toStatus: 'REOPENED',
    actorRole: 'RESIDENT',
    reopenReason: 'Vẫn còn rỉ nước mạnh',
    resolvedAt,
    reopenWindowDays: 3,
    now: after3Days,
  });
  assert.equal(expiredReopen.valid, false);
  assert.equal(expiredReopen.code, 'REOPEN_WINDOW_EXPIRED');
});

test('Review Focus #5: validateZaloInviteLink accepts empty/valid zalo.me HTTPS URLs and rejects unsafe/non-Zalo links', () => {
  assert.deepEqual(validateZaloInviteLink(null), { valid: true, normalized: null });
  assert.deepEqual(validateZaloInviteLink('   '), { valid: true, normalized: null });
  assert.deepEqual(validateZaloInviteLink('https://zalo.me/g/resihubvopa'), {
    valid: true,
    normalized: 'https://zalo.me/g/resihubvopa',
  });
  assert.deepEqual(validateZaloInviteLink('https://chat.zalo.me/join/abc_123'), {
    valid: true,
    normalized: 'https://chat.zalo.me/join/abc_123',
  });

  for (const bad of [
    'javascript:alert(1)',
    'http://zalo.me/g/abc',
    'https://evil.example.com/zalo.me',
  ]) {
    const res = validateZaloInviteLink(bad);
    assert.equal(res.valid, false, `Should reject ${bad}`);
    assert.equal(res.code, 'INVALID_ZALO_LINK');
  }
});

test('formatAnnouncementForZalo & formatServiceRequestForRoomZalo generate clean mobile-ready Vietnamese messages', () => {
  const bldgMsg = formatAnnouncementForZalo({
    type: 'UTILITY_INTERRUPTION',
    title: 'Tạm ngừng cấp nước định kỳ',
    body: 'Tòa nhà vệ sinh bể nước ngầm từ 09:00 đến 11:30.',
    targetScope: 'BUILDING',
    buildingCode: 'VOP-A',
    buildingName: 'ResiHub Ocean Park A',
    contactConfig: { support_hotline: '0901234567' },
  });
  assert.match(bldgMsg, /\[THÔNG BÁO BQL TÒA VOP-A\]/);
  assert.match(bldgMsg, /Tạm ngừng cấp nước định kỳ/);
  assert.match(bldgMsg, /0901234567/);

  const roomMsg = formatAnnouncementForZalo({
    type: 'ANNOUNCEMENT',
    title: 'Nhắc kiểm tra ban công',
    body: 'Nhờ anh/chị thu gọn đồ ngoài ban công trước bão.',
    targetScope: 'APARTMENT',
    buildingCode: 'VOP-A',
    apartmentCode: 'A101',
    contactConfig: { support_hotline: '0901234567' },
  });
  assert.match(roomMsg, /Phòng A101/);

  const srMsg = formatServiceRequestForRoomZalo({
    trackingCode: 'SR-20261103-0001',
    category: 'PLUMBING',
    title: 'Rò nước bồn rửa',
    status: 'ON_HOLD',
    apartmentCode: 'A101',
    buildingCode: 'VOP-A',
    preferredSlot: 'MORNING_08_12',
    nextAppointmentAt: '2026-11-04T02:00:00.000Z',
    resolutionNote: 'Đã khóa van tạm, hẹn sáng mai thay gioăng',
    assigneeName: 'Kỹ thuật Hùng',
    contactConfig: { support_hotline: '0901234567' },
  });
  assert.match(srMsg, /SR-20261103-0001/);
  assert.match(srMsg, /A101/);
  assert.match(srMsg, /Đã khóa van tạm/);
});
