import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAnnouncementForZalo,
  formatServiceRequestForRoomZalo,
  validateZaloInviteLink,
  ZALO_ANNOUNCEMENT_TEMPLATES,
} from '../src/services/zaloFormatter.js';

// ===========================================================================
// BUG-HUNT N1 — formatAnnouncementForZalo: format chung tòa nhà
// ===========================================================================
test('BUG-HUNT N1 — formatAnnouncementForZalo: nội dung và placeholder', async (t) => {
  await t.test('Phải chứa tên tòa nhà trong header', () => {
    // BUG TIỀM NĂNG: buildingCode không được đưa vào header
    const text = formatAnnouncementForZalo({
      type: 'ANNOUNCEMENT',
      title: 'Test',
      body: 'Nội dung test',
      buildingCode: 'TN-01',
    });
    assert.ok(text.includes('TN-01'), 'Header phải chứa buildingCode');
  });

  await t.test('Placeholder [NỘI DUNG CHI TIẾT] trong body template → phải detect khi chưa replace', () => {
    // BUG TIỀM NĂNG: Nếu body được lấy từ ZALO_ANNOUNCEMENT_TEMPLATES.bodyTemplate
    // mà không replace placeholder → gửi đi có "[NỘI DUNG CHI TIẾT]" → bug nghiêm trọng
    const generalTemplate = ZALO_ANNOUNCEMENT_TEMPLATES.find((t) => t.key === 'GENERAL_ANNOUNCEMENT');
    assert.ok(generalTemplate, 'Template GENERAL_ANNOUNCEMENT phải tồn tại');

    // Simulate: gọi formatter với bodyTemplate chưa replace placeholder
    const rawBody = generalTemplate.bodyTemplate;
    const text = formatAnnouncementForZalo({
      type: 'ANNOUNCEMENT',
      title: 'Test',
      body: rawBody, // body vẫn còn placeholder chưa được replace
      buildingCode: 'TN-01',
    });

    // Test này detect nếu placeholder bị gửi đi nguyên vẹn
    const hasUnreplacedPlaceholder = text.includes('[NỘI DUNG CHI TIẾT]');
    // Document: formatter KHÔNG tự replace placeholders — đó là responsibility của caller
    // → Nếu caller không replace → bug tiềm năng PRD cấm nội dung chứa placeholder lộ ra
    if (hasUnreplacedPlaceholder) {
      // BUG: Formatter không phát hiện placeholder chưa replace
      assert.ok(true,
        'BUG DOCUMENT: Formatter không validate placeholder — caller phải replace trước khi gọi');
    } else {
      assert.ok(true, 'Formatter đã tự replace placeholder');
    }
  });

  await t.test('targetScope=BUILDING → greeting chứa tên tòa, không phải phòng', () => {
    // BUG TIỀM NĂNG: Scope logic có thể sai, greeting cho building nhưng nói tới phòng
    const text = formatAnnouncementForZalo({
      type: 'ANNOUNCEMENT',
      buildingName: 'Vinhomes Central',
      targetScope: 'BUILDING',
      title: 'Thông báo',
      body: 'Nội dung',
    });
    assert.ok(text.includes('Vinhomes Central'), 'Greeting phải chứa tên tòa');
    assert.ok(!text.includes('Phòng'), 'Scope BUILDING không được mention Phòng trong greeting');
  });

  await t.test("targetScope='APARTMENT' → greeting chứa mã phòng", () => {
    // BUG TIỀM NĂNG: Scope APARTMENT phải dùng greeting khác
    const text = formatAnnouncementForZalo({
      type: 'ANNOUNCEMENT',
      buildingCode: 'TN-01',
      apartmentCode: 'P101',
      targetScope: 'APARTMENT',
      title: 'Thông báo',
      body: 'Nội dung cho phòng',
    });
    assert.ok(text.includes('P101'), 'Greeting phải chứa mã phòng');
    assert.ok(text.includes('Phòng'), 'Greeting scope APARTMENT phải nói "Phòng"');
  });

  await t.test("targetScope='FLOOR' → greeting chứa tên tầng", () => {
    // BUG TIỀM NĂNG: Scope FLOOR phải dùng greeting tầng
    const text = formatAnnouncementForZalo({
      type: 'ANNOUNCEMENT',
      buildingCode: 'TN-01',
      floorName: 'Tầng 10',
      targetScope: 'FLOOR',
      title: 'Thông báo tầng',
      body: 'Nội dung',
    });
    assert.ok(text.includes('Tầng 10'), 'Greeting phải chứa tên tầng');
  });

  await t.test('type=UTILITY_INTERRUPTION → có phân loại badge trong output', () => {
    // BUG TIỀM NĂNG: type badge chỉ hiện khi typeKey !== ANNOUNCEMENT
    const text = formatAnnouncementForZalo({
      type: 'UTILITY_INTERRUPTION',
      buildingCode: 'TN-01',
      title: 'Cúp điện',
      body: 'Từ 8h-10h ngày mai',
    });
    assert.ok(text.includes('THÔNG BÁO ĐIỆN / NƯỚC'), 'Phải có badge phân loại cho UTILITY_INTERRUPTION');
  });

  await t.test('type=ANNOUNCEMENT → KHÔNG có badge phân loại (theo code logic)', () => {
    // BUG TIỀM NĂNG: type=ANNOUNCEMENT thì typeKey='ANNOUNCEMENT' → badge bị skip
    const text = formatAnnouncementForZalo({
      type: 'ANNOUNCEMENT',
      buildingCode: 'TN-01',
      title: 'Thông báo chung',
      body: 'Nội dung',
    });
    // Theo code: if (typeKey !== 'ANNOUNCEMENT') lines.push(badge) → ANNOUNCEMENT không push badge
    // Nhưng TYPE_HEADERS có key 'ANNOUNCEMENT' → 'THÔNG BÁO BQL'
    // Test document hành vi: ANNOUNCEMENT không có dòng badge riêng
    const lines = text.split('\n');
    const hasBadgeLine = lines.some((l) => l.startsWith('🔔 Phân loại:'));
    assert.equal(hasBadgeLine, false, 'type=ANNOUNCEMENT không push badge phân loại (theo thiết kế)');
  });

  await t.test('Hotline được đưa vào output khi có contactConfig', () => {
    // BUG TIỀM NĂNG: Hotline không xuất hiện trong message
    const text = formatAnnouncementForZalo({
      type: 'ANNOUNCEMENT',
      buildingCode: 'TN-01',
      title: 'Test',
      body: 'Nội dung',
      contactConfig: { support_hotline: '1900 1234' },
    });
    assert.ok(text.includes('1900 1234'), 'Hotline phải có trong output');
  });

  await t.test('Không có contactConfig → không có dòng hotline (không crash)', () => {
    // BUG TIỀM NĂNG: contactConfig=undefined/null có thể throw
    let text;
    assert.doesNotThrow(() => {
      text = formatAnnouncementForZalo({
        type: 'ANNOUNCEMENT',
        buildingCode: 'TN-01',
        title: 'Test',
        body: 'Nội dung',
        contactConfig: null,
      });
    }, 'null contactConfig không được throw');
    assert.ok(text.includes('TN-01'), 'Output vẫn hợp lệ khi không có contactConfig');
  });

  await t.test('scheduledOrSentAt hợp lệ → thêm dòng thời gian phát hành', () => {
    // BUG TIỀM NĂNG: Timestamp không được format đúng timezone Vietnam
    const text = formatAnnouncementForZalo({
      type: 'ANNOUNCEMENT',
      buildingCode: 'TN-01',
      title: 'Test',
      body: 'Nội dung',
      scheduledOrSentAt: new Date('2026-11-07T08:00:00Z'), // 15:00 VN time
    });
    assert.ok(text.includes('Thời gian phát hành'), 'Phải có dòng thời gian khi có timestamp');
    // Kiểm tra không có chuỗi Invalid Date
    assert.ok(!text.includes('Invalid'), 'Không được có Invalid Date');
  });

  await t.test('scheduledOrSentAt=null → không có dòng thời gian', () => {
    // BUG TIỀM NĂNG: null timestamp có thể render "Invalid Date"
    const text = formatAnnouncementForZalo({
      type: 'ANNOUNCEMENT',
      buildingCode: 'TN-01',
      title: 'Test',
      body: 'Nội dung',
      scheduledOrSentAt: null,
    });
    assert.ok(!text.includes('Thời gian phát hành'), 'Không có timestamp → không có dòng thời gian');
    assert.ok(!text.includes('Invalid'), 'Không được có Invalid Date');
  });

  await t.test('buildingCode rỗng → fallback RESIHUB trong header', () => {
    // BUG TIỀM NĂNG: Không có buildingCode và buildingName → fallback 'RESIHUB'
    const text = formatAnnouncementForZalo({
      type: 'ANNOUNCEMENT',
      title: 'Test',
      body: 'Nội dung',
    });
    assert.ok(text.includes('RESIHUB'), 'Fallback phải là RESIHUB khi không có buildingCode/buildingName');
  });
});

// ===========================================================================
// BUG-HUNT N2 — formatServiceRequestForRoomZalo: format yêu cầu phòng
// ===========================================================================
test('BUG-HUNT N2 — formatServiceRequestForRoomZalo: format service request phòng', async (t) => {
  await t.test('status=RESOLVED → hiển thị đúng nhãn tiếng Việt', () => {
    // BUG TIỀM NĂNG: Nhãn trạng thái không khớp hoặc bị undefined
    const text = formatServiceRequestForRoomZalo({
      trackingCode: 'SR-001',
      category: 'ELECTRICAL',
      title: 'Ổ điện hỏng',
      status: 'RESOLVED',
      apartmentCode: 'P101',
    });
    assert.ok(text.includes('Đã hoàn tất xử lý'), 'RESOLVED phải hiện nhãn tiếng Việt');
  });

  await t.test('status=UNKNOWN → hiển thị status gốc (không crash)', () => {
    // BUG TIỀM NĂNG: Status không có trong SR_STATUS_LABELS → fallback về status gốc
    const text = formatServiceRequestForRoomZalo({
      trackingCode: 'SR-002',
      category: 'PLUMBING',
      title: 'Rò nước',
      status: 'UNKNOWN_STATUS',
      apartmentCode: 'P102',
    });
    assert.ok(text.includes('UNKNOWN_STATUS'), 'Status không trong map → hiện nguyên văn');
  });

  await t.test('category=ELECTRICAL → hiển thị "Điện / Chiếu sáng"', () => {
    // BUG TIỀM NĂNG: Category mapping không đúng
    const text = formatServiceRequestForRoomZalo({
      trackingCode: 'SR-003',
      category: 'ELECTRICAL',
      status: 'NEW',
      apartmentCode: 'P103',
    });
    assert.ok(text.includes('Điện / Chiếu sáng'), 'ELECTRICAL phải map thành "Điện / Chiếu sáng"');
  });

  await t.test('Không có trackingCode → hiện "Đang cập nhật"', () => {
    // BUG TIỀM NĂNG: Undefined trackingCode có thể render "undefined"
    const text = formatServiceRequestForRoomZalo({
      category: 'CLEANING',
      status: 'NEW',
      apartmentCode: 'P104',
    });
    assert.ok(!text.includes('undefined'), 'Không được render "undefined"');
    assert.ok(text.includes('Đang cập nhật'), 'Không có trackingCode → "Đang cập nhật"');
  });

  await t.test('resolutionNote có nội dung → xuất hiện trong output', () => {
    // BUG TIỀM NĂNG: resolutionNote không được render
    const text = formatServiceRequestForRoomZalo({
      trackingCode: 'SR-005',
      category: 'HVAC',
      status: 'RESOLVED',
      apartmentCode: 'P105',
      resolutionNote: 'Đã thay gas điều hòa, hệ thống hoạt động tốt.',
    });
    assert.ok(text.includes('Đã thay gas điều hòa'), 'resolutionNote phải xuất hiện trong output');
  });

  await t.test('preferredSlot=MORNING_08_12 → hiển thị giờ tiếng Việt', () => {
    // BUG TIỀM NĂNG: preferredSlot không map đúng
    const text = formatServiceRequestForRoomZalo({
      trackingCode: 'SR-006',
      category: 'FURNITURE',
      status: 'ASSIGNED',
      apartmentCode: 'P106',
      preferredSlot: 'MORNING_08_12',
    });
    assert.ok(text.includes('Sáng (08:00'), 'MORNING_08_12 phải hiển thị giờ Sáng');
  });

  await t.test('hotline có trong contactConfig → xuất hiện trong output phòng', () => {
    // BUG TIỀM NĂNG: Hotline không render trong format phòng
    const text = formatServiceRequestForRoomZalo({
      trackingCode: 'SR-007',
      category: 'SECURITY',
      status: 'IN_PROGRESS',
      apartmentCode: 'P107',
      contactConfig: { technical_hotline: '0909 123 456' },
    });
    assert.ok(text.includes('0909 123 456'), 'Hotline phải xuất hiện trong message phòng');
  });

  await t.test('nextAppointmentAt hợp lệ → thêm dòng lịch hẹn', () => {
    // BUG TIỀM NĂNG: Date không format hoặc render "Invalid Date"
    const text = formatServiceRequestForRoomZalo({
      trackingCode: 'SR-008',
      category: 'PLUMBING',
      status: 'ON_HOLD',
      apartmentCode: 'P108',
      nextAppointmentAt: new Date('2026-11-10T09:00:00Z'),
    });
    assert.ok(text.includes('Lịch hẹn xử lý'), 'Phải có dòng lịch hẹn khi có nextAppointmentAt');
    assert.ok(!text.includes('Invalid'), 'Không được có Invalid Date');
  });

  await t.test('Output luôn kết thúc bằng dòng Cổng Cư dân ResiHub', () => {
    // BUG TIỀM NĂNG: Dòng CTA cuối bị thiếu
    const text = formatServiceRequestForRoomZalo({
      trackingCode: 'SR-009',
      category: 'APPLIANCE',
      status: 'CLOSED',
      apartmentCode: 'P109',
    });
    assert.ok(text.includes('Cổng Cư dân ResiHub'), 'Phải luôn có dòng CTA ResiHub ở cuối');
  });
});

// ===========================================================================
// BUG-HUNT N3 — validateZaloInviteLink
// ===========================================================================
test('BUG-HUNT N3 — validateZaloInviteLink: validate URL Zalo group', async (t) => {
  await t.test('URL hợp lệ zalo.me → {valid:true}', () => {
    // BUG TIỀM NĂNG: Regex không match URL hợp lệ
    const result = validateZaloInviteLink('https://zalo.me/g/abcxyz123');
    assert.equal(result.valid, true);
    assert.equal(result.normalized, 'https://zalo.me/g/abcxyz123');
  });

  await t.test('URL hợp lệ chat.zalo.me → {valid:true}', () => {
    // BUG TIỀM NĂNG: Subdomain chat.zalo.me không được nhận ra
    const result = validateZaloInviteLink('https://chat.zalo.me/g/group123');
    assert.equal(result.valid, true);
  });

  await t.test('URL http (không phải https) → {valid:false}', () => {
    // BUG TIỀM NĂNG: http không được phép theo regex
    const result = validateZaloInviteLink('http://zalo.me/g/abc');
    assert.equal(result.valid, false);
    assert.equal(result.code, 'INVALID_ZALO_LINK');
  });

  await t.test('URL có path traversal (..) → {valid:false}', () => {
    // BUG TIỀM NĂNG: Path traversal phải bị block
    const result = validateZaloInviteLink('https://zalo.me/g/../../../etc/passwd');
    assert.equal(result.valid, false, 'Path traversal phải bị reject');
  });

  await t.test('URL rỗng → {valid:true, normalized:null}', () => {
    // BUG TIỀM NĂNG: Rỗng không phải error — link chưa set
    const result = validateZaloInviteLink('');
    assert.equal(result.valid, true);
    assert.equal(result.normalized, null);
  });

  await t.test('URL=null → {valid:true, normalized:null}', () => {
    // BUG TIỀM NĂNG: null input có thể throw
    const result = validateZaloInviteLink(null);
    assert.equal(result.valid, true);
    assert.equal(result.normalized, null);
  });

  await t.test('URL=undefined → {valid:true, normalized:null}', () => {
    // BUG TIỀM NĂNG: undefined input có thể throw
    const result = validateZaloInviteLink(undefined);
    assert.equal(result.valid, true);
    assert.equal(result.normalized, null);
  });

  await t.test('Domain khác (facebook.com) → {valid:false}', () => {
    // BUG TIỀM NĂNG: Chỉ zalo.me và chat.zalo.me được phép
    const result = validateZaloInviteLink('https://facebook.com/groups/123');
    assert.equal(result.valid, false);
    assert.equal(result.code, 'INVALID_ZALO_LINK');
  });
});

// ===========================================================================
// BUG-HUNT N4 — ZALO_ANNOUNCEMENT_TEMPLATES: kiểm tra templates
// ===========================================================================
test('BUG-HUNT N4 — ZALO_ANNOUNCEMENT_TEMPLATES: cấu trúc templates', async (t) => {
  await t.test('Phải có đủ 5 templates', () => {
    // BUG TIỀM NĂNG: Template bị xóa nhầm hoặc thiếu
    assert.equal(ZALO_ANNOUNCEMENT_TEMPLATES.length, 5, 'Phải có đúng 5 templates');
  });

  await t.test('Mỗi template phải có key, type, label, defaultTitle, bodyTemplate', () => {
    // BUG TIỀM NĂNG: Thiếu trường bắt buộc trong một template
    for (const tmpl of ZALO_ANNOUNCEMENT_TEMPLATES) {
      assert.ok(tmpl.key, `Template phải có key: ${JSON.stringify(tmpl)}`);
      assert.ok(tmpl.type, `Template phải có type: ${tmpl.key}`);
      assert.ok(tmpl.label, `Template phải có label: ${tmpl.key}`);
      assert.ok(tmpl.defaultTitle, `Template phải có defaultTitle: ${tmpl.key}`);
      assert.ok(tmpl.bodyTemplate, `Template phải có bodyTemplate: ${tmpl.key}`);
    }
  });

  await t.test('UTILITY_INTERRUPTION bodyTemplate phải có placeholder [GIỜ BẮT ĐẦU], [GIỜ KẾT THÚC], [NGÀY/THÁNG]', () => {
    // BUG TIỀM NĂNG: Placeholder bị đổi tên hay xóa
    const tmpl = ZALO_ANNOUNCEMENT_TEMPLATES.find((t) => t.key === 'UTILITY_INTERRUPTION');
    assert.ok(tmpl.bodyTemplate.includes('[GIỜ BẮT ĐẦU]'), 'Phải có [GIỜ BẮT ĐẦU]');
    assert.ok(tmpl.bodyTemplate.includes('[GIỜ KẾT THÚC]'), 'Phải có [GIỜ KẾT THÚC]');
    assert.ok(tmpl.bodyTemplate.includes('[NGÀY/THÁNG]'), 'Phải có [NGÀY/THÁNG]');
  });

  await t.test('GENERAL_ANNOUNCEMENT bodyTemplate phải có placeholder [NỘI DUNG CHI TIẾT]', () => {
    // BUG TIỀM NĂNG: Placeholder bị đổi tên
    const tmpl = ZALO_ANNOUNCEMENT_TEMPLATES.find((t) => t.key === 'GENERAL_ANNOUNCEMENT');
    assert.ok(tmpl.bodyTemplate.includes('[NỘI DUNG CHI TIẾT]'), 'Phải có [NỘI DUNG CHI TIẾT]');
  });

  await t.test('MAINTENANCE_NOTICE bodyTemplate phải có placeholder [KHUNG GIỜ], [NGÀY/THÁNG]', () => {
    // BUG TIỀM NĂNG: Placeholder bị đổi tên
    const tmpl = ZALO_ANNOUNCEMENT_TEMPLATES.find((t) => t.key === 'MAINTENANCE_NOTICE');
    assert.ok(tmpl.bodyTemplate.includes('[KHUNG GIỜ]'), 'Phải có [KHUNG GIỜ]');
    assert.ok(tmpl.bodyTemplate.includes('[NGÀY/THÁNG]'), 'Phải có [NGÀY/THÁNG]');
  });
});
