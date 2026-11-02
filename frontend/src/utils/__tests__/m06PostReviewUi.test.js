import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canActorApproveReservationRow } from '../depositUiHelpers.js';

const readSrc = (relPath) =>
  fs.readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), 'utf8');

test('M06 Post-Review UI (3.4) — ApartmentDetailPage wires allowSelfApproval & enforces UNC on BANK_TRANSFER cancel-settle', () => {
  const src = readSrc('../../pages/admin/apartments/ApartmentDetailPage.jsx');
  assert.match(src, /usersService\s*\.getSettings\s*\(/, 'Must load org settings for allow_self_approval');
  assert.match(
    src,
    /canActorApproveReservationRow\s*\(\s*\{[\s\S]*?allowSelfApproval[\s\S]*?\}\s*\)/,
    'Must pass allowSelfApproval into canActorApproveReservationRow'
  );
  assert.match(
    src,
    /Hoàn tiền giữ chỗ qua chuyển khoản bắt buộc đính kèm ít nhất 01 ảnh chứng từ UNC/,
    'Must validate UNC evidence client-side when refund_method === BANK_TRANSFER and refAmt > 0'
  );

  // Confirm helper honors allowSelfApproval = true for creator Manager on ownerless building
  assert.equal(
    canActorApproveReservationRow({
      isOwner: false,
      isManager: true,
      isSysAdmin: false,
      currentUserId: 'mgr-1',
      createdBy: 'mgr-1',
      buildingHasActiveOwner: false,
      allowSelfApproval: true,
    }),
    true
  );
});

test('M06 Post-Review UI (3.2 & 3.6.1) — DepositsPage checks final_invoice_issued precondition & renders Chờ thu cọc hint', () => {
  const src = readSrc('../../pages/admin/deposits/DepositsPage.jsx');
  assert.match(
    src,
    /settlementPreconditions\.final_invoice_issued\s*!==\s*false/,
    'isPreconditionsReady must check final_invoice_issued !== false'
  );
  assert.match(
    src,
    /unbilled_meter_types/,
    'Settlement modal must surface unbilled_meter_types warning'
  );
  assert.match(
    src,
    /Chờ thu cọc/,
    'Status column must render "Chờ thu cọc" sub-badge when HELD deposit has amount_held === 0'
  );
});

test('M06 Post-Review UI (3.3) — ContractDetailPage supports new_deposit_amount & surplus_deposit_amount reminder on transfer-room', () => {
  const src = readSrc('../../pages/admin/contracts/ContractDetailPage.jsx');
  assert.match(src, /new_deposit_amount/, 'Transfer room form/payload must support new_deposit_amount');
  assert.match(
    src,
    /surplus_deposit_amount/,
    'Transfer room handler must surface surplus_deposit_amount reminder when old deposit has surplus'
  );
});
