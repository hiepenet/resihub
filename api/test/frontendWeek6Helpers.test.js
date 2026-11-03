import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Frontend Week 6 Helpers: zaloFormat.js', async (t) => {
  const mod = await import('../../frontend/src/utils/zaloFormat.js');

  await t.test('1. ZALO_QUICK_TEMPLATES provides >= 5 standard operational templates', () => {
    assert.equal(Array.isArray(mod.ZALO_QUICK_TEMPLATES), true);
    assert.ok(mod.ZALO_QUICK_TEMPLATES.length >= 5);
    assert.ok(mod.ZALO_QUICK_TEMPLATES.some((tpl) => tpl.key === 'UTILITY_INTERRUPTION'));
    assert.ok(mod.ZALO_QUICK_TEMPLATES.some((tpl) => tpl.key === 'MAINTENANCE_NOTICE'));
  });

  await t.test('2. buildZaloPreviewText formats building vs apartment headers and greetings', () => {
    const bldgText = mod.buildZaloPreviewText({
      type: 'UTILITY_INTERRUPTION',
      title: 'Cắt nước rửa bể ngầm',
      body: 'Từ 09:00 đến 11:30 sáng thứ Bảy.',
      targetScope: 'BUILDING',
      buildingCode: 'VOP-A',
      buildingName: 'Vinhomes Ocean Park A',
      hotline: '0909123456',
    });
    assert.ok(bldgText.includes('[THÔNG BÁO BQL TÒA VOP-A]'));
    assert.ok(bldgText.includes('Kính gửi Quý Cư dân'));
    assert.ok(bldgText.includes('Cắt nước rửa bể ngầm'));
    assert.ok(bldgText.includes('0909123456'));

    const aptText = mod.buildZaloPreviewText({
      type: 'MAINTENANCE_NOTICE',
      title: 'Kiểm tra van nước tổng',
      body: 'Kỹ thuật ghé lúc 14:30.',
      targetScope: 'APARTMENT',
      buildingCode: 'VOP-A',
      apartmentCode: 'A-302',
    });
    assert.ok(aptText.includes('Phòng A-302'));
    assert.ok(aptText.includes('Kiểm tra van nước tổng'));
  });

  await t.test('3. buildRoomMaintenanceZaloText formats service request update without internal_note', () => {
    const msg = mod.buildRoomMaintenanceZaloText({
      tracking_code: 'SR-20261104-8899',
      apartment_code: 'A-201',
      building_code: 'VOP-A',
      category: 'PLUMBING',
      title: 'Rỉ vòi xịt',
      status: 'ON_HOLD',
      hold_reason: 'Chờ vật tư phao đồng',
      internal_note: 'Bí mật chi phí 350k',
    });
    assert.ok(msg.includes('SR-20261104-8899'));
    assert.ok(msg.includes('A-201'));
    assert.ok(msg.includes('Chờ vật tư phao đồng'));
    assert.equal(msg.includes('Bí mật chi phí 350k'), false);
  });

  await t.test('4. isValidZaloGroupUrl enforces https://zalo.me/ or https://chat.zalo.me/', () => {
    assert.equal(mod.isValidZaloGroupUrl(''), true);
    assert.equal(mod.isValidZaloGroupUrl(null), true);
    assert.equal(mod.isValidZaloGroupUrl('https://zalo.me/g/vopa_building'), true);
    assert.equal(mod.isValidZaloGroupUrl('https://chat.zalo.me/join/abc123'), true);
    assert.equal(mod.isValidZaloGroupUrl('javascript:alert(1)'), false);
    assert.equal(mod.isValidZaloGroupUrl('http://zalo.me/g/insecure'), false);
    assert.equal(mod.isValidZaloGroupUrl('https://evil.example/zalo.me'), false);
  });

  await t.test('5. computeSlaBadgeMeta distinguishes OVERDUE, DUE_SOON, ON_TRACK, and COMPLETED', () => {
    const now = new Date('2026-11-04T10:00:00+07:00');

    const overdue = mod.computeSlaBadgeMeta({
      status: 'IN_PROGRESS',
      slaDueAt: '2026-11-04T09:00:00+07:00',
      now,
    });
    assert.equal(overdue.state, 'OVERDUE');
    assert.equal(overdue.variant, 'red');

    const dueSoon = mod.computeSlaBadgeMeta({
      status: 'NEW',
      slaDueAt: '2026-11-04T10:45:00+07:00',
      now,
    });
    assert.equal(dueSoon.state, 'DUE_SOON');
    assert.equal(dueSoon.variant, 'amber');

    const onTrack = mod.computeSlaBadgeMeta({
      status: 'ASSIGNED',
      slaDueAt: '2026-11-04T18:00:00+07:00',
      now,
    });
    assert.equal(onTrack.state, 'ON_TRACK');

    const resolvedLateCheck = mod.computeSlaBadgeMeta({
      status: 'RESOLVED',
      slaDueAt: '2026-11-03T09:00:00+07:00',
      now,
    });
    assert.equal(resolvedLateCheck.state, 'COMPLETED');
  });
});

