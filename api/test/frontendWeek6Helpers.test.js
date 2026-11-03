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

  await t.test('6. Bold markers highlight important fields & Rich Text helpers convert safely for Zalo PC/Web', async () => {
    const bldgText = mod.buildZaloPreviewText({
      type: 'UTILITY_INTERRUPTION',
      title: 'Cắt điện bảo trì trạm biến áp',
      body: 'Áp dụng từ **08:00** đến **10:30** ngày **05/11**.',
      targetScope: 'BUILDING',
      buildingCode: 'VOP-A',
      buildingName: 'Vinhomes Ocean Park A',
      hotline: '0909123456',
      scheduledOrSentAt: '2026-11-04T01:30:00.000Z',
    });
    assert.ok(bldgText.includes('**[THÔNG BÁO BQL TÒA VOP-A]**'));
    assert.ok(bldgText.includes('**THÔNG BÁO ĐIỆN / NƯỚC**'));
    assert.ok(bldgText.includes('**Cắt điện bảo trì trạm biến áp**'));
    assert.ok(bldgText.includes('**0909123456**'));

    const srText = mod.buildRoomMaintenanceZaloText({
      tracking_code: 'SR-20261104-8899',
      apartment_code: 'A-201',
      building_code: 'VOP-A',
      category: 'PLUMBING',
      title: 'Rỉ vòi xịt',
      status: 'RESOLVED',
      resolution_note: 'Đã thay mới dây cấp inox',
      internal_note: 'Giá vốn vật tư 80k',
    });
    assert.ok(srText.includes('**[BQL TÒA VOP-A — CẬP NHẬT SỬA CHỮA PHÒNG A-201]**'));
    assert.ok(srText.includes('**#SR-20261104-8899**'));
    assert.ok(srText.includes('**Đã hoàn tất xử lý (chờ nghiệm thu)**'));
    assert.ok(srText.includes('**Đã thay mới dây cấp inox**'));
    assert.equal(srText.includes('Giá vốn vật tư 80k'), false);

    assert.equal(typeof mod.parseZaloBoldSegments, 'function');
    assert.equal(typeof mod.stripZaloBoldMarkers, 'function');
    assert.equal(typeof mod.zaloTextToHtml, 'function');
    assert.equal(typeof mod.copyZaloMessageToClipboard, 'function');

    const segments = mod.parseZaloBoldSegments('Xin chào **Phòng A101** lúc **09:00**!');
    assert.deepEqual(segments, [
      { text: 'Xin chào ', bold: false },
      { text: 'Phòng A101', bold: true },
      { text: ' lúc ', bold: false },
      { text: '09:00', bold: true },
      { text: '!', bold: false },
    ]);

    // Unclosed ** or single * must not swallow characters
    assert.equal(
      mod.stripZaloBoldMarkers('**[THÔNG BÁO]** Phép tính 5 * 3 và **chưa đóng'),
      '[THÔNG BÁO] Phép tính 5 * 3 và **chưa đóng'
    );

    // HTML output converts **...** to <b>...</b>, \n to <br>, and escapes XSS payloads
    const html = mod.zaloTextToHtml('**[BQL <script>alert(1)</script>]**\nLiên hệ: **0909 & "113"**');
    assert.equal(
      html,
      '<b>[BQL &lt;script&gt;alert(1)&lt;/script&gt;]</b><br>Liên hệ: <b>0909 &amp; &quot;113&quot;</b>'
    );

    // Rich clipboard write populates both text/html and stripped text/plain
    const origNavigator = globalThis.navigator;
    const origClipboardItem = globalThis.ClipboardItem;
    let capturedItems = null;
    try {
      globalThis.ClipboardItem = class MockClipboardItem {
        constructor(data) {
          this.data = data;
        }
      };
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          clipboard: {
            write: async (items) => {
              capturedItems = items;
            },
          },
        },
      });

      const copied = await mod.copyZaloMessageToClipboard('**[THÔNG BÁO]**\nHotline: **0909123456**');
      assert.equal(copied, true);
      assert.equal(Array.isArray(capturedItems), true);
      const htmlBlobText = await capturedItems[0].data['text/html'].text();
      const plainBlobText = await capturedItems[0].data['text/plain'].text();
      assert.equal(htmlBlobText, '<b>[THÔNG BÁO]</b><br>Hotline: <b>0909123456</b>');
      assert.equal(plainBlobText, '[THÔNG BÁO]\nHotline: 0909123456');
    } finally {
      globalThis.ClipboardItem = origClipboardItem;
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: origNavigator,
      });
    }
  });
});

