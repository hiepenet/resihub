import test from 'node:test';
import assert from 'node:assert/strict';
import {
  postValidateTicketTriage,
  CLOSED_TICKET_CATEGORIES,
  CLOSED_TICKET_PRIORITIES,
} from '../src/services/aiRules.js';

// ===========================================================================
// BUG-HUNT T1 — Closed taxonomy (AI không được tự tạo nhãn mới)
// ===========================================================================
test('BUG-HUNT T1 — Closed taxonomy: category và priority validation', async (t) => {
  await t.test("rawModelJson.category='MECHANICAL' (không trong danh mục) → category=null", () => {
    // BUG TIỀM NĂNG: 'MECHANICAL' không có trong CLOSED_TICKET_CATEGORIES → phải null
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'MECHANICAL', priority: 'NORMAL', confidence: 0.9 },
      description: 'máy lạnh hỏng',
    });
    assert.equal(result.category, null, 'MECHANICAL không trong taxonomy → null');
  });

  await t.test("rawModelJson.category='ELECTRICAL' (hợp lệ) → category='ELECTRICAL'", () => {
    // BUG TIỀM NĂNG: Danh mục hợp lệ phải pass qua
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'ELECTRICAL', priority: 'NORMAL', confidence: 0.9 },
      description: 'ổ điện bị hỏng',
    });
    assert.equal(result.category, 'ELECTRICAL');
    assert.equal(result.triageStatus, 'SUGGESTED');
  });

  await t.test("rawModelJson.category='electrical' (lowercase) → phải uppercase trước compare", () => {
    // BUG TIỀM NĂNG: Code có dùng toUpperCase() không? lowercase input phải được normalize
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'electrical', priority: 'NORMAL', confidence: 0.9 },
      description: 'ổ điện hỏng',
    });
    assert.equal(result.category, 'ELECTRICAL', 'lowercase phải được uppercase và match');
  });

  await t.test("rawModelJson.priority='CRITICAL' (không trong danh mục) → priority=null, triageStatus=NEEDS_MANUAL_REVIEW", () => {
    // BUG TIỀM NĂNG: 'CRITICAL' không phải URGENT/HIGH/NORMAL/LOW → null
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'ELECTRICAL', priority: 'CRITICAL', confidence: 0.9 },
      description: 'bóng đèn hỏng',
    });
    assert.equal(result.priority, null, 'CRITICAL không trong taxonomy → null, không có safety hazard');
    assert.equal(result.triageStatus, 'NEEDS_MANUAL_REVIEW');
  });

  await t.test("rawModelJson.priority='NORMAL' → 'NORMAL' (hợp lệ)", () => {
    // BUG TIỀM NĂNG: Danh mục hợp lệ
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'PLUMBING', priority: 'NORMAL', confidence: 0.9 },
      description: 'rò nước nhẹ',
    });
    assert.equal(result.priority, 'NORMAL');
  });

  await t.test("rawModelJson.priority='EXTREME' (không trong danh mục) → null", () => {
    // BUG TIỀM NĂNG: 'EXTREME' không trong ['LOW','NORMAL','HIGH','URGENT'] → null
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'CLEANING', priority: 'EXTREME', confidence: 0.9 },
      description: 'cần dọn vệ sinh',
    });
    assert.equal(result.priority, null, 'EXTREME không trong taxonomy → null');
  });

  await t.test('Kiểm tra CLOSED_TICKET_CATEGORIES chứa đúng danh mục', () => {
    // BUG TIỀM NĂNG: Danh mục bị thiếu hay thêm sai
    const expected = ['ELECTRICAL', 'PLUMBING', 'HVAC', 'FURNITURE', 'APPLIANCE', 'CLEANING', 'SECURITY', 'OTHER'];
    assert.deepEqual(
      [...CLOSED_TICKET_CATEGORIES].sort(),
      [...expected].sort(),
      'CLOSED_TICKET_CATEGORIES phải khớp danh mục chuẩn',
    );
  });

  await t.test('Kiểm tra CLOSED_TICKET_PRIORITIES chứa đúng mức độ ưu tiên', () => {
    // BUG TIỀM NĂNG: Danh mục bị thiếu hay thêm sai
    const expected = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
    assert.deepEqual(
      [...CLOSED_TICKET_PRIORITIES].sort(),
      [...expected].sort(),
      'CLOSED_TICKET_PRIORITIES phải khớp danh mục chuẩn',
    );
  });
});

// ===========================================================================
// BUG-HUNT T2 — Confidence threshold
// ===========================================================================
test('BUG-HUNT T2 — Confidence threshold: boundary SUGGESTED vs NEEDS_MANUAL_REVIEW', async (t) => {
  await t.test('confidence=0.7 (đúng bằng threshold) → SUGGESTED (dùng < không <=)', () => {
    // BUG TIỀM NĂNG: Code dùng confidence < confidenceThreshold
    // → 0.7 < 0.7 = FALSE → không trigger NEEDS_MANUAL_REVIEW → SUGGESTED
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'ELECTRICAL', priority: 'NORMAL', confidence: 0.7 },
      description: 'ổ điện bị hỏng',
      confidenceThreshold: 0.7,
    });
    assert.equal(result.triageStatus, 'SUGGESTED',
      'confidence === threshold phải SUGGESTED (không phải NEEDS_MANUAL_REVIEW)');
    assert.equal(result.needsHumanReview, false);
  });

  await t.test('confidence=0.69 → NEEDS_MANUAL_REVIEW', () => {
    // BUG TIỀM NĂNG: 0.69 < 0.7 → phải trigger manual review
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'ELECTRICAL', priority: 'NORMAL', confidence: 0.69 },
      description: 'ổ điện bị hỏng',
      confidenceThreshold: 0.7,
    });
    assert.equal(result.triageStatus, 'NEEDS_MANUAL_REVIEW');
    assert.equal(result.needsHumanReview, true);
  });

  await t.test('confidence=0.71 → SUGGESTED (vượt threshold 0.01)', () => {
    // BUG TIỀM NĂNG: Chỉ cao hơn threshold một chút vẫn phải SUGGESTED
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'PLUMBING', priority: 'HIGH', confidence: 0.71 },
      description: 'ống nước bị rò',
      confidenceThreshold: 0.7,
    });
    assert.equal(result.triageStatus, 'SUGGESTED');
  });

  await t.test('confidence=0 → NEEDS_MANUAL_REVIEW', () => {
    // BUG TIỀM NĂNG: confidence=0 phải luôn manual review
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'CLEANING', priority: 'LOW', confidence: 0 },
      description: 'cần dọn vệ sinh',
      confidenceThreshold: 0.7,
    });
    assert.equal(result.triageStatus, 'NEEDS_MANUAL_REVIEW');
    assert.equal(result.needsHumanReview, true);
  });
});

// ===========================================================================
// BUG-HUNT T3 — Safety hazard escalation (critical bugs)
// ===========================================================================
test('BUG-HUNT T3 — Safety hazard: SAFETY_HAZARD_RE keyword escalation', async (t) => {
  // Helper: tạo input với description và confidence thấp
  function hazardInput(description, priority = 'NORMAL') {
    return {
      rawModelJson: { category: 'ELECTRICAL', priority, confidence: 0.9 },
      description,
      confidenceThreshold: 0.7,
    };
  }

  await t.test("'rò điện' → priority='URGENT', SAFETY_HAZARD_ESCALATED trong warnings", () => {
    // BUG TIỀM NĂNG: regex không match 'rò điện'
    const result = postValidateTicketTriage(hazardInput('rò điện tại cầu thang'));
    assert.equal(result.priority, 'URGENT', 'rò điện phải escalate lên URGENT');
    assert.ok(result.warnings.includes('SAFETY_HAZARD_ESCALATED'));
  });

  await t.test("'giật điện' → priority='URGENT'", () => {
    // BUG TIỀM NĂNG: 'giật điện' phải match SAFETY_HAZARD_RE
    const result = postValidateTicketTriage(hazardInput('bị giật điện khi cắm sạc'));
    assert.equal(result.priority, 'URGENT');
  });

  await t.test("'bốc khói' → priority='URGENT'", () => {
    // BUG TIỀM NĂNG: 'bốc khói' phải match
    const result = postValidateTicketTriage(hazardInput('tủ điện bốc khói'));
    assert.equal(result.priority, 'URGENT');
  });

  await t.test("'cháy nổ' → priority='URGENT'", () => {
    // BUG TIỀM NĂNG: 'cháy nổ' phải match
    const result = postValidateTicketTriage(hazardInput('nguy cơ cháy nổ'));
    assert.equal(result.priority, 'URGENT');
  });

  await t.test("'ngập nước' → priority='URGENT'", () => {
    // BUG TIỀM NĂNG: 'ngập nước' phải match
    const result = postValidateTicketTriage(hazardInput('tầng hầm bị ngập nước'));
    assert.equal(result.priority, 'URGENT');
  });

  await t.test("'rò gas' → priority='URGENT'", () => {
    // BUG TIỀM NĂNG: 'rò gas' phải match (regex: rò\\s*gas)
    const result = postValidateTicketTriage(hazardInput('phát hiện rò gas bếp'));
    assert.equal(result.priority, 'URGENT');
  });

  await t.test("'mùi gas' → priority='URGENT'", () => {
    // BUG TIỀM NĂNG: 'mùi gas' phải match
    const result = postValidateTicketTriage(hazardInput('có mùi gas trong căn hộ'));
    assert.equal(result.priority, 'URGENT');
  });

  await t.test("'mắc kẹt thang máy' → priority='URGENT' (regex chính xác)", () => {
    // BUG TIỀM NĂNG: regex là 'mắc\\s*kẹt\\s*thang\\s*máy' - phải match
    const result = postValidateTicketTriage(hazardInput('cư dân bị mắc kẹt thang máy'));
    assert.equal(result.priority, 'URGENT');
  });

  await t.test("'kẹt thang' → priority='URGENT' [FIXED: regex mở rộng]", () => {
    // FIX BP-008: Regex giờ bao gồm 'kẹt\\s*thang' → 'kẹt thang không mở được' sẽ match
    const result = postValidateTicketTriage(hazardInput('kẹt thang không mở được'));
    assert.equal(result.priority, 'URGENT',
      "FIXED: 'kẹt thang' giờ được nhận diện là SAFETY_HAZARD và escalate URGENT");
  });

  await t.test("BUG: 'rò điện' với confidence rất thấp (0.1) → vẫn phải URGENT", () => {
    // BUG TIỀM NĂNG: Khi confidence thấp → vào nhánh NEEDS_MANUAL_REVIEW nhưng priority vẫn phải URGENT
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'ELECTRICAL', priority: 'LOW', confidence: 0.1 },
      description: 'rò điện phát hiện tại cầu thang',
      confidenceThreshold: 0.7,
    });
    assert.equal(result.priority, 'URGENT',
      'Safety hazard phải URGENT dù confidence rất thấp');
    assert.ok(result.warnings.includes('SAFETY_HAZARD_ESCALATED'));
  });

  await t.test("Safety hazard + confidence thấp → triageStatus='NEEDS_MANUAL_REVIEW' nhưng priority='URGENT'", () => {
    // BUG TIỀM NĂNG: Khi vào nhánh NEEDS_MANUAL_REVIEW → safePriority = hasSafetyHazard ? 'URGENT' : null
    // Phải có CÙNG LÚC: triageStatus='NEEDS_MANUAL_REVIEW' VÀ priority='URGENT'
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'ELECTRICAL', priority: 'NORMAL', confidence: 0.1 },
      description: 'có mùi gas rất nặng',
      confidenceThreshold: 0.7,
    });
    assert.equal(result.triageStatus, 'NEEDS_MANUAL_REVIEW',
      'Confidence thấp → phải NEEDS_MANUAL_REVIEW');
    assert.equal(result.priority, 'URGENT',
      'Nhưng safety hazard phải override priority thành URGENT');
    assert.equal(result.needsHumanReview, true);
  });
});

// ===========================================================================
// BUG-HUNT T4 — Suggested assignee validation
// ===========================================================================
test('BUG-HUNT T4 — suggestedAssigneeId: validation trong allowedAssigneeIds', async (t) => {
  await t.test("allowedAssigneeIds=['staff-1','staff-2'], suggestion='staff-1' → 'staff-1'", () => {
    // BUG TIỀM NĂNG: ID hợp lệ trong list phải được pass through
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'PLUMBING', priority: 'NORMAL', confidence: 0.9, suggested_assignee_id: 'staff-1' },
      description: 'rò nước nhẹ',
      allowedAssigneeIds: ['staff-1', 'staff-2'],
      confidenceThreshold: 0.7,
    });
    assert.equal(result.suggestedAssigneeId, 'staff-1');
  });

  await t.test("allowedAssigneeIds=['staff-1'], suggestion='staff-3' (không trong list) → null", () => {
    // BUG TIỀM NĂNG: ID không trong allowedSet phải bị null
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'PLUMBING', priority: 'LOW', confidence: 0.9, suggested_assignee_id: 'staff-3' },
      description: 'rò nước nhẹ',
      allowedAssigneeIds: ['staff-1'],
      confidenceThreshold: 0.7,
    });
    assert.equal(result.suggestedAssigneeId, null, 'ID không trong list → null');
  });

  await t.test("allowedAssigneeIds=[], suggestion='staff-1' → null", () => {
    // BUG TIỀM NĂNG: Danh sách rỗng → Set rỗng → không match → null
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'CLEANING', priority: 'LOW', confidence: 0.9, suggested_assignee_id: 'staff-1' },
      description: 'cần dọn vệ sinh',
      allowedAssigneeIds: [],
      confidenceThreshold: 0.7,
    });
    assert.equal(result.suggestedAssigneeId, null, 'List rỗng → null');
  });

  await t.test('allowedAssigneeIds=null → null, không throw', () => {
    // BUG TIỀM NĂNG: null input có thể gây TypeError khi map/Set
    let result;
    assert.doesNotThrow(() => {
      result = postValidateTicketTriage({
        rawModelJson: { category: 'CLEANING', priority: 'LOW', confidence: 0.9, suggested_assignee_id: 'staff-1' },
        description: 'dọn vệ sinh',
        allowedAssigneeIds: null,
        confidenceThreshold: 0.7,
      });
    }, 'null allowedAssigneeIds không được throw');
    assert.equal(result.suggestedAssigneeId, null);
  });

  await t.test('suggestion=null → suggestedAssigneeId=null', () => {
    // BUG TIỀM NĂNG: null suggestion có thể gây lỗi
    const result = postValidateTicketTriage({
      rawModelJson: { category: 'FURNITURE', priority: 'NORMAL', confidence: 0.9, suggested_assignee_id: null },
      description: 'ghế bị hỏng',
      allowedAssigneeIds: ['staff-1'],
      confidenceThreshold: 0.7,
    });
    assert.equal(result.suggestedAssigneeId, null);
  });
});

// ===========================================================================
// BUG-HUNT T5 — Trùng lặp yêu cầu (PRD AC-04.2) — cần integration test
// ===========================================================================
test('BUG-HUNT T5 — Trùng lặp yêu cầu: TODO cần integration test', async (t) => {
  await t.test('TODO: Hai yêu cầu cùng căn, cùng loại, trong 24h → cần warn', () => {
    // BUG TIỀM NĂNG: Logic này cần DB query để detect duplicates
    // postValidateTicketTriage() không có duplicate check — cần check ở tầng API/controller
    // Cần integration test riêng với DB mock
    assert.ok(true, 'TODO: Viết integration test cho AC-04.2 duplicate detection (cần DB)');
  });
});
