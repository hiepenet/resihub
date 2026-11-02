import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import { saveBase64Image } from '../services/imageUpload.js';
import {
  isPositiveSafeIntegerVnd,
  getTodayVnDateStr,
  validateDeduction,
  computeRefund,
  resolvePostSettlementStatus,
  validateRefundBankInfo,
  normalizeOpenInvoiceSnapshot,
  isSettlementSnapshotStale,
} from '../services/depositSettlement.js';
import {
  getUserRoleCodes,
  getOwnerBuildingIds,
  getManagerBuildingIds,
  logAccessDenied,
} from '../services/ownerScope.js';
import { checkFourEyesOrWarn } from '../services/pricing.js';

const router = express.Router();

async function getOperatorReadBuildingIds(userId, orgId, roleCodes) {
  const ids = new Set();
  if (roleCodes.includes('OWNER')) {
    (await getOwnerBuildingIds(userId, orgId)).forEach((id) => ids.add(id));
  }
  if (roleCodes.includes('MANAGER')) {
    (await getManagerBuildingIds(userId, orgId)).forEach((id) => ids.add(id));
  }
  return Array.from(ids);
}

async function getDepositWriteBuildingIds(userId, orgId, roleCodes) {
  const ids = new Set();
  if (roleCodes.includes('MANAGER')) {
    (await getManagerBuildingIds(userId, orgId)).forEach((id) => ids.add(id));
  }
  return Array.from(ids);
}

async function getDepositAccessMeta(client, depositId) {
  const res = await client.query('SELECT * FROM fn_get_deposit_access_meta($1)', [depositId]);
  return res.rows[0] || null;
}

async function verifyDepositReadAccess(req, meta, depositId, contextLabel) {
  const roleCodes = getUserRoleCodes(req);
  if (roleCodes.includes('SYS_ADMIN')) {
    return true;
  }
  if (roleCodes.some((r) => ['OWNER', 'MANAGER'].includes(r))) {
    const allowedIds = await getOperatorReadBuildingIds(req.user.sub, req.user.org_id, roleCodes);
    if (!allowedIds.includes(meta.building_id)) {
      await logAccessDenied(req, 'deposit', depositId, `Operator accessed ${contextLabel} outside building scope`);
      return false;
    }
    return true;
  }
  if (roleCodes.includes('RESIDENT')) {
    if (!meta.is_contract_resident) {
      await logAccessDenied(req, 'deposit', depositId, `RESIDENT accessed another resident ${contextLabel}`);
      return false;
    }
    return true;
  }
  return false;
}

async function canActAsDepositApprover(req, meta, depositId, actionLabel) {
  const roleCodes = getUserRoleCodes(req);
  if (roleCodes.includes('OWNER')) {
    const ownerIds = await getOwnerBuildingIds(req.user.sub, req.user.org_id);
    if (ownerIds.includes(meta.building_id)) return { ok: true };
  }
  if (roleCodes.includes('MANAGER')) {
    const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
    if (mgrIds.includes(meta.building_id)) return { ok: true };
  }
  if (roleCodes.includes('SYS_ADMIN')) {
    if (!meta.building_has_active_owner) return { ok: true };
    await logAccessDenied(
      req,
      'deposit',
      depositId,
      `SYS_ADMIN attempted ${actionLabel} on building with active OWNER`
    );
    return {
      ok: false,
      code: 'SYS_ADMIN_READ_ONLY_ON_OWNED_BUILDING',
      message: 'Tòa nhà đã có Chủ sở hữu (OWNER) hoạt động; Quản trị hệ thống chỉ có quyền Xem (R) theo PRD Mục 6.2.',
    };
  }
  await logAccessDenied(req, 'deposit', depositId, `Unauthorized ${actionLabel} outside building scope`);
  return {
    ok: false,
    code: 'ACCESS_DENIED',
    message: 'Bạn không có quyền phê duyệt hồ sơ cọc của tòa nhà này.',
  };
}

/**
 * Tổng hợp tự động công nợ hóa đơn đang mở của hợp đồng (R-06):
 * - serviceDebt: công nợ dịch vụ / điện / nước / phạt chậm (KHÔNG gồm RENT) -> được đối trừ tự động vào tiền cọc.
 * - rentDebt: công nợ tiền thuê phòng (RENT) -> TUYỆT ĐỐI KHÔNG đối trừ vào tiền cọc.
 */
async function calculateContractOpenDebts(client, contractId) {
  const invRes = await client.query(
    `SELECT i.id,
            i.invoice_code,
            i.period,
            i.total_amount,
            i.paid_amount,
            i.status,
            COALESCE(SUM(il.amount) FILTER (WHERE il.item_type = 'RENT'), 0)::bigint AS rent_gross,
            COALESCE(SUM(il.amount) FILTER (WHERE il.item_type <> 'RENT'), 0)::bigint AS non_rent_gross
     FROM invoice i
     LEFT JOIN invoice_line il ON il.invoice_id = i.id
     WHERE i.contract_id = $1
       AND i.status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
     GROUP BY i.id
     ORDER BY i.period ASC, i.created_at ASC`,
    [contractId]
  );

  let serviceDebt = 0;
  let rentDebt = 0;
  const openInvoices = [];

  for (const row of invRes.rows) {
    const total = Math.max(0, Number(row.total_amount || 0));
    const paid = Math.max(0, Number(row.paid_amount || 0));
    const remaining = Math.max(0, total - paid);
    if (remaining <= 0) continue;

    const rentGross = Math.max(0, Number(row.rent_gross || 0));
    const nonRentGross = Math.max(0, Number(row.non_rent_gross || 0));

    let invRentUnpaid = 0;
    let invServiceUnpaid = 0;

    if (rentGross === 0 && nonRentGross === 0) {
      invServiceUnpaid = remaining;
    } else if (nonRentGross === 0) {
      invRentUnpaid = remaining;
      invServiceUnpaid = 0;
    } else if (rentGross === 0) {
      invServiceUnpaid = remaining;
      invRentUnpaid = 0;
    } else {
      const paidToRent = Math.min(paid, rentGross);
      invRentUnpaid = Math.max(0, Math.min(remaining, rentGross - paidToRent));
      invServiceUnpaid = Math.max(0, remaining - invRentUnpaid);
    }

    serviceDebt += invServiceUnpaid;
    rentDebt += invRentUnpaid;
    openInvoices.push({
      id: row.id,
      invoice_code: row.invoice_code,
      period: row.period,
      total_amount: total,
      paid_amount: paid,
      remaining,
      rent_unpaid: invRentUnpaid,
      service_unpaid: invServiceUnpaid,
    });
  }

  return {
    serviceDebt: Math.round(serviceDebt),
    rentDebt: Math.round(rentDebt),
    openInvoices,
  };
}

/**
 * Kiểm tra điều kiện tiên quyết trước khi lập hồ sơ tất toán cọc (R-06 / FR-024 / R-12):
 * 1) Hợp đồng đã kết thúc (TERMINATED / EXPIRED)
 * 2) Nếu hợp đồng đã nhận phòng và căn hộ có đồng hồ điện/nước khởi tạo trước/trong ngày kết thúc -> phải có chỉ số kỳ cuối
 * 3) Không còn hóa đơn DRAFT chưa phát hành/chưa hủy trên hợp đồng
 * 4) Nếu hợp đồng đã nhận phòng (movedIn === true) -> bắt buộc có biên bản kiểm tra bàn giao phòng kèm hình ảnh (HANDOVER hoặc inspection_evidence)
 */
async function checkSettlementPreconditions(
  client,
  contractRow,
  { latestPhotoHandoverAt = null, existingSettlement = null, incomingInspectionEvidence = null } = {}
) {
  const contractEnded = ['TERMINATED', 'EXPIRED'].includes(contractRow.contract_status);

  const startStr = getTodayVnDateStr(contractRow.start_date);
  const endRefStr = getTodayVnDateStr(contractRow.terminated_at) || getTodayVnDateStr(contractRow.end_date);
  const endPeriod = endRefStr ? endRefStr.slice(0, 7) : null;
  const movedIn = Boolean(startStr && endRefStr && endRefStr >= startStr);

  let missingMeterTypes = [];
  if (movedIn && endRefStr && endPeriod && contractRow.apartment_id) {
    const meterRes = await client.query(
      `SELECT m.meter_type
       FROM meter m
       WHERE m.apartment_id = $1
         AND m.created_at::date <= $2::date
         AND NOT EXISTS (
           SELECT 1 FROM meter_reading mr
           WHERE mr.meter_id = m.id
             AND mr.period >= $3
         )`,
      [contractRow.apartment_id, endRefStr, endPeriod]
    );
    missingMeterTypes = meterRes.rows.map((r) => r.meter_type);
  }
  const finalMetersRecorded = missingMeterTypes.length === 0;

  const draftInvRes = await client.query(
    `SELECT COUNT(*)::int AS cnt
     FROM invoice
     WHERE contract_id = $1 AND status = 'DRAFT'`,
    [contractRow.contract_id]
  );
  const draftInvoiceCount = draftInvRes.rows[0]?.cnt || 0;
  const noDraftInvoices = draftInvoiceCount === 0;

  const effectiveInspectionEvidence =
    incomingInspectionEvidence !== null && incomingInspectionEvidence !== undefined
      ? incomingInspectionEvidence
      : existingSettlement?.inspection_evidence;
  const hasInlineInspectionEvidence =
    Array.isArray(effectiveInspectionEvidence) &&
    effectiveInspectionEvidence.some((item) => typeof item === 'string' && item.trim().length > 0);
  const apartmentInspected = !movedIn || Boolean(latestPhotoHandoverAt) || hasInlineInspectionEvidence;
  const handoverRecordedAt = latestPhotoHandoverAt
    ? new Date(latestPhotoHandoverAt).toISOString()
    : null;

  return {
    ready: contractEnded && finalMetersRecorded && noDraftInvoices && apartmentInspected,
    contract_ended: contractEnded,
    final_meters_recorded: finalMetersRecorded,
    missing_meter_types: missingMeterTypes,
    no_draft_invoices: noDraftInvoices,
    draft_invoice_count: draftInvoiceCount,
    apartment_inspected: apartmentInspected,
    handover_recorded_at: handoverRecordedAt,
  };
}

function escapeHtml(val) {
  return String(val ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const VALID_COLLECT_METHODS = [
  'BANK_TRANSFER',
  'CASH',
  'CARD',
  'EWALLET',
  'E_WALLET',
  'QR_CODE',
  'OTHER',
];

async function normalizeAndPersistEvidence(
  client,
  { entity = 'deposit', ownerId, folder = 'deposits', evidence = [], req }
) {
  if (!ownerId || !Array.isArray(evidence) || evidence.length === 0) return [];
  const normalized = [];
  for (const rawItem of evidence) {
    const item = typeof rawItem === 'string' ? rawItem.trim() : '';
    if (!item) continue;
    if (item.startsWith('data:')) {
      const saved = await saveBase64Image({
        imageBase64: item,
        folder,
        entityId: ownerId,
        entity,
        ownerId,
        req,
        query: client.query.bind(client),
        allowPdf: true,
      });
      if (saved.error) {
        const err = new Error(saved.error.message);
        err.status = 422;
        err.code = saved.error.code;
        throw err;
      }
      normalized.push(`/api/v1/attachments/${saved.attachment.id}/view`);
    } else if (item.startsWith('/api/v1/attachments/')) {
      normalized.push(item);
    } else {
      await client.query(
        `INSERT INTO attachment (owner_entity, owner_id, storage_path, uploaded_by)
         SELECT $1::text, $2::uuid, $3::text, $4::uuid
         WHERE NOT EXISTS (
           SELECT 1 FROM attachment
           WHERE owner_entity = $1 AND owner_id = $2 AND storage_path = $3
         )`,
        [entity, ownerId, item, req?.user?.sub || null]
      );
      normalized.push(item);
    }
  }
  return normalized;
}

/**
 * GET /api/v1/deposits
 */
router.get(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']),
  async (req, res) => {
    const { client, release } = await getUserClient(req);
    try {
      const orgId = req.user.org_id;
      const userRoles = getUserRoleCodes(req);
      const isSysAdmin = userRoles.includes('SYS_ADMIN');
      const isOperator = userRoles.some((r) => ['OWNER', 'MANAGER'].includes(r));
      const isResident = userRoles.includes('RESIDENT');

      let sql = `SELECT d.*, 
          c.deposit_amount,
          c.rent_amount, 
          c.start_date, 
          c.end_date, 
          c.status as contract_status,
          c.terminated_at,
          c.building_id,
          building_has_active_owner(c.building_id) AS building_has_active_owner,
          a.code as apartment_code, 
          b.name as building_name, 
          b.code as building_code,
          COALESCE(p.full_name, 'Khách thuê') as tenant_name
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN apartment a ON a.id = c.apartment_id
         JOIN building b ON b.id = c.building_id
         LEFT JOIN tenant t ON t.id = c.primary_tenant_id
         LEFT JOIN person p ON p.id = t.person_id
         WHERE b.org_id = $1`;
      const params = [orgId];

      if (isSysAdmin) {
        // SYS_ADMIN: R toàn bộ sổ cọc trong org
      } else if (isOperator) {
        const bIds = await getOperatorReadBuildingIds(req.user.sub, orgId, userRoles);
        if (bIds.length === 0) {
          sql += ' AND 1 = 0';
        } else {
          params.push(bIds);
          sql += ` AND c.building_id = ANY($${params.length}::uuid[])`;
        }
      } else if (isResident) {
        sql += ` AND c.id IN (SELECT contract_id FROM get_resident_contract_ids())`;
      }

      sql += ` ORDER BY d.created_at DESC`;
      const result = await client.query(sql, params);

      res.json({ data: result.rows });
    } catch (err) {
      console.error('[Deposits Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách cọc.' });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/deposits/:id/transactions
 * Lịch sử biến động sổ cọc (thu cọc, khấu trừ, hoàn cọc)
 */
router.get(
  '/:id/transactions',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']),
  async (req, res) => {
    const { id } = req.params;
    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const allowed = await verifyDepositReadAccess(req, meta, id, 'deposit transactions');
      if (!allowed) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem sổ cọc này.' });
      }

      const txns = await client.query(
        `SELECT dt.*,
                p_created.full_name AS created_by_name,
                p_approved.full_name AS approved_by_name
         FROM deposit_transaction dt
         LEFT JOIN app_user au_c ON au_c.id = dt.created_by
         LEFT JOIN person p_created ON p_created.id = au_c.person_id
         LEFT JOIN app_user au_a ON au_a.id = dt.approved_by
         LEFT JOIN person p_approved ON p_approved.id = au_a.person_id
         WHERE dt.deposit_id = $1
         ORDER BY dt.created_at DESC`,
        [id]
      );
      res.json({ data: txns.rows });
    } catch (err) {
      console.error('[Deposit Transactions List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải lịch sử giao dịch cọc.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/deposits/:id/transactions
 * Thu bổ sung cọc
 */
router.post(
  '/:id/transactions',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { type, amount, description, method, evidence } = req.body;

    if (type === 'deduct' || type === 'refund') {
      return res.status(409).json({
        code: 'MUST_USE_SETTLEMENT',
        message: 'Khấu trừ/hoàn cọc chỉ thực hiện qua hồ sơ tất toán có phê duyệt (FR-024).',
      });
    }

    if (type === 'transfer') {
      return res.status(409).json({
        code: 'TRANSFER_INTERNAL_ONLY',
        message: 'Bút toán kết chuyển cọc (transfer) chỉ do hệ thống tự động thực hiện khi kích hoạt hợp đồng / gia hạn / chuyển phòng.',
      });
    }

    if (type !== 'collect') {
      return res.status(400).json({
        code: 'INVALID_TRANSACTION_TYPE',
        message: 'Loại giao dịch không hợp lệ. Chỉ chấp nhận collect.',
      });
    }

    if (!isPositiveSafeIntegerVnd(amount)) {
      return res.status(400).json({
        code: 'INVALID_AMOUNT',
        message: 'Số tiền thu cọc phải là số nguyên dương VND.',
      });
    }

    if (!method || !String(method).trim()) {
      return res.status(400).json({
        code: 'METHOD_REQUIRED',
        message: 'Phương thức thanh toán là bắt buộc khi thu tiền cọc (vd: BANK_TRANSFER, CASH).',
      });
    }

    const normalizedMethod = String(method).trim();
    if (!VALID_COLLECT_METHODS.includes(normalizedMethod)) {
      return res.status(400).json({
        code: 'INVALID_METHOD',
        message: `Phương thức thu cọc không hợp lệ. Chỉ chấp nhận: ${VALID_COLLECT_METHODS.join(', ')}.`,
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const roleCodes = getUserRoleCodes(req);
      const writeIds = await getDepositWriteBuildingIds(req.user.sub, req.user.org_id, roleCodes);
      if (!writeIds.includes(meta.building_id)) {
        await logAccessDenied(req, 'deposit', id, 'Operator attempted deposit transaction on unassigned building');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý sổ cọc của tòa nhà này.' });
      }

      await client.query('BEGIN');

      const depositRes = await client.query(
        `SELECT d.*, c.status AS contract_status, c.deposit_amount AS contract_deposit_amount
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         WHERE d.id = $1
         FOR UPDATE OF d`,
        [id]
      );
      if (depositRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const currentDeposit = depositRes.rows[0];
      if (
        currentDeposit.status !== 'HELD' ||
        !['ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING'].includes(currentDeposit.contract_status)
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'DEPOSIT_NOT_COLLECTIBLE',
          message: `Chỉ cho phép thu bổ sung tiền cọc khi sổ cọc đang HELD và hợp đồng đang hiệu lực (hiện tại: cọc ${currentDeposit.status}, hợp đồng ${currentDeposit.contract_status}).`,
        });
      }

      const txnAmount = BigInt(String(amount).trim());
      const newAmount = BigInt(currentDeposit.amount_held ?? 0) + txnAmount;
      const contractCap = BigInt(currentDeposit.contract_deposit_amount ?? 0);
      if (newAmount > contractCap) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          code: 'DEPOSIT_EXCEEDS_CONTRACT_AMOUNT',
          message: `Tổng tiền cọc thu vào (${newAmount.toString()} ₫) vượt mức tiền cọc quy định trong hợp đồng (${contractCap.toString()} ₫).`,
        });
      }

      const rawEvidence = Array.isArray(evidence) ? evidence : [];
      const evidenceList = await normalizeAndPersistEvidence(client, {
        entity: 'deposit',
        ownerId: id,
        folder: 'deposits',
        evidence: rawEvidence,
        req,
      });

      const txnRes = await client.query(
        `INSERT INTO deposit_transaction (
           deposit_id, type, amount, description, method, evidence, status, approved_by, approved_at, created_by
         )
         VALUES ($1, 'collect', $2, $3, $4, $5, 'APPROVED', $6, NOW(), $6)
         RETURNING *`,
        [
          id,
          txnAmount.toString(),
          description || 'Thu bổ sung cọc',
          normalizedMethod,
          evidenceList,
          req.user.sub,
        ]
      );

      await client.query(
        `UPDATE deposit SET amount_held = $1, status = $2, updated_at = NOW() WHERE id = $3`,
        [newAmount.toString(), currentDeposit.status, id]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'CREATE', 'deposit_transaction', $2, $3)`,
        [req.user.sub, txnRes.rows[0].id, JSON.stringify(txnRes.rows[0])]
      );

      await client.query('COMMIT');
      res.status(201).json({ message: 'Ghi nhận giao dịch cọc thành công.', data: txnRes.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err?.status) {
        return res.status(err.status).json({ code: err.code || 'VALIDATION_ERROR', message: err.message });
      }
      console.error('[Deposit Transaction Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi ghi nhận giao dịch cọc.' });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/deposits/:id/settlement
 */
router.get(
  '/:id/settlement',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']),
  async (req, res) => {
    const { id } = req.params;
    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const allowed = await verifyDepositReadAccess(req, meta, id, 'settlement');
      if (!allowed) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem hồ sơ tất toán này.' });
      }

      const q = await client.query(
        `SELECT d.id, d.contract_id, d.amount_held, d.status, d.settlement, d.refund_due_date,
                c.deposit_amount, c.status as contract_status, c.building_id, c.apartment_id,
                c.start_date, c.end_date, c.terminated_at,
                a.code as apartment_code, b.name as building_name,
                COALESCE(p.full_name, 'Khách thuê') as tenant_name
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN apartment a ON a.id = c.apartment_id
         JOIN building b ON b.id = c.building_id
         LEFT JOIN tenant t ON t.id = c.primary_tenant_id
         LEFT JOIN person p ON p.id = t.person_id
         WHERE d.id = $1`,
        [id]
      );
      if (q.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const row = q.rows[0];
      const debts = await calculateContractOpenDebts(client, row.contract_id);
      const preconditions = await checkSettlementPreconditions(client, row, {
        latestPhotoHandoverAt: meta.latest_photo_handover_at,
        existingSettlement: row.settlement,
      });

      const saved = row.settlement || null;
      const isAccountingCommitted =
        Boolean(saved?.accounting_committed_at) ||
        ['PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL', 'RETURNED'].includes(row.status);
      const effectiveServiceDebt = isAccountingCommitted && saved
        ? Number(saved.outstanding_debt || 0)
        : debts.serviceDebt;
      const effectiveRentDebt = isAccountingCommitted && saved?.rent_debt !== undefined
        ? Number(saved.rent_debt || 0)
        : debts.rentDebt;
      const snapshotStale =
        ['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'].includes(row.status) && !isAccountingCommitted
          ? isSettlementSnapshotStale(saved, {
              serviceDebt: debts.serviceDebt,
              rentDebt: debts.rentDebt,
              heldAmount: row.amount_held,
              openInvoices: debts.openInvoices,
            })
          : false;

      res.json({
        data: {
          deposit_id: row.id,
          contract_id: row.contract_id,
          deposit_amount: row.deposit_amount,
          amount_held: row.amount_held,
          status: row.status,
          contract_status: row.contract_status,
          terminated_at: row.terminated_at,
          settlement: row.settlement,
          refund_due_date: row.refund_due_date,
          apartment_code: row.apartment_code,
          building_name: row.building_name,
          building_has_active_owner: Boolean(meta.building_has_active_owner),
          tenant_name: row.tenant_name,
          calculated_service_debt: effectiveServiceDebt,
          calculated_rent_debt: effectiveRentDebt,
          open_invoices: debts.openInvoices || [],
          snapshot_stale: snapshotStale,
          preconditions,
        },
      });
    } catch (err) {
      console.error('[Get Settlement Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải hồ sơ tất toán.' });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/deposits/:id/settlement/pdf
 * Xuất biên bản tất toán tiền cọc định dạng HTML chuẩn A4 có thể in/lưu PDF (R-24)
 */
router.get(
  '/:id/settlement/pdf',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'RESIDENT']),
  async (req, res) => {
    const { id } = req.params;
    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).send('<h1>404 Không tìm thấy sổ cọc</h1>');
      }
      const allowed = await verifyDepositReadAccess(req, meta, id, 'settlement PDF');
      if (!allowed) {
        return res.status(403).send('<h1>403 Bạn không có quyền truy cập biên bản tất toán này</h1>');
      }

      const q = await client.query(
        `SELECT d.*,
                c.deposit_amount, c.rent_amount, c.start_date, c.end_date, c.terminated_at,
                c.status AS contract_status, c.building_id,
                a.code AS apartment_code,
                b.name AS building_name, b.address AS building_address, b.org_id,
                o.name AS org_name,
                p.full_name AS tenant_name, p.phone AS tenant_phone, p.id_number AS tenant_id_number
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN apartment a ON a.id = c.apartment_id
         JOIN building b ON b.id = c.building_id
         JOIN organization o ON o.id = b.org_id
         LEFT JOIN tenant t ON t.id = c.primary_tenant_id
         LEFT JOIN person p ON p.id = t.person_id
         WHERE d.id = $1 AND b.org_id = $2`,
        [id, req.user.org_id]
      );
      if (q.rows.length === 0) {
        return res.status(404).send('<h1>404 Không tìm thấy sổ cọc</h1>');
      }
      const row = q.rows[0];
      const settlement = row.settlement || {};
      const items = Array.isArray(settlement.items) ? settlement.items : [];
      const fmtMoney = (v) => `${Number(v || 0).toLocaleString('vi-VN')} ₫`;
      const fmtDate = (d) => {
        if (!d) return '—';
        const dt = new Date(d);
        if (isNaN(dt.getTime())) return String(d);
        return `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}/${dt.getFullYear()}`;
      };

      const isAccountingCommitted =
        Boolean(settlement.accounting_committed_at) ||
        ['PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL', 'RETURNED'].includes(row.status);
      const heldForCalc = isAccountingCommitted
        ? Number(settlement.deposit_held_before_settlement ?? row.deposit_amount ?? 0)
        : Number(row.amount_held || 0);
      const serviceDebt = Number(settlement.outstanding_debt || 0);
      const rentDebt = Number(settlement.rent_debt || 0);
      const sumItems = items.reduce((s, it) => s + Number(it.amount || 0), 0);
      const refundAmount = Number(settlement.refund_amount ?? Math.max(0, heldForCalc - serviceDebt - sumItems));
      const shortfall = Number(settlement.shortfall ?? Math.max(0, serviceDebt + sumItems - heldForCalc));

      const categoryLabel = {
        DAMAGE: 'Hư hỏng tài sản',
        CLEANING: 'Phí vệ sinh bàn giao',
        UTILITY_DEBT: 'Công nợ tiện ích',
        OTHER: 'Khác',
      };

      const itemRowsHtml = items.length > 0
        ? items
            .map(
              (it, idx) => `
          <tr>
            <td style="text-align:center;">${idx + 1}</td>
            <td>${escapeHtml(categoryLabel[it.category] || it.category)}</td>
            <td>${escapeHtml(it.description)}</td>
            <td style="text-align:right; font-weight:600;">${fmtMoney(it.amount)}</td>
          </tr>`
            )
            .join('')
        : `<tr><td colspan="4" style="text-align:center; color:#64748b; font-style:italic;">Không phát sinh khấu trừ hư hỏng / vệ sinh bàn giao.</td></tr>`;

      const displayTenantName = escapeHtml(row.tenant_name || 'Khách thuê');
      const displayTenantPhone = escapeHtml(row.tenant_phone || '—');
      const displayTenantIdNumber = escapeHtml(row.tenant_id_number || '—');

      const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <title>Biên bản tất toán tiền cọc - ${escapeHtml(row.apartment_code)}</title>
  <style>
    @page { size: A4; margin: 18mm 15mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Times New Roman', serif; font-size: 12.5pt; line-height: 1.5; color: #0f172a; margin: 0; background: #f1f5f9; }
    .toolbar { position: sticky; top: 0; background: #0f172a; color: #fff; padding: 10px 24px; display: flex; justify-content: space-between; align-items: center; z-index: 999; }
    .btn-print { background: #4f46e5; color: #fff; border: none; padding: 8px 16px; border-radius: 8px; font-weight: 600; cursor: pointer; }
    .sheet { max-width: 210mm; min-height: 297mm; margin: 20px auto; background: #fff; padding: 18mm; box-shadow: 0 4px 20px rgba(0,0,0,0.08); }
    .header { text-align: center; margin-bottom: 20px; }
    .title { font-size: 16pt; font-weight: bold; text-transform: uppercase; margin: 12px 0 4px; }
    h3 { font-size: 12.5pt; text-transform: uppercase; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px; margin-top: 18px; }
    table { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 12pt; }
    th, td { border: 1px solid #334155; padding: 6px 10px; }
    th { background: #f8fafc; text-align: left; }
    .summary-row td { font-weight: bold; }
    .signatures { display: flex; justify-content: space-between; margin-top: 36px; page-break-inside: avoid; }
    .sig-box { width: 45%; text-align: center; }
    .sig-space { height: 80px; }
    @media print {
      body { background: #fff; }
      .toolbar { display: none !important; }
      .sheet { box-shadow: none; margin: 0; padding: 0; max-width: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <div>Biên bản tất toán tiền cọc — Căn <strong>${escapeHtml(row.apartment_code)}</strong> (${escapeHtml(row.building_name)})</div>
    <button class="btn-print" onclick="window.print()">In / Lưu PDF (Ctrl + P)</button>
  </div>
  <div class="sheet">
    <div class="header">
      <div style="font-weight:bold;">CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</div>
      <div style="font-weight:bold;">Độc lập – Tự do – Hạnh phúc</div>
      <div class="title">BIÊN BẢN TẤT TOÁN &amp; ĐỐI CHIẾU TIỀN ĐẶT CỌC</div>
      <div style="font-size:11pt; color:#475569;">Mã sổ cọc: ${escapeHtml(row.id.slice(0, 8).toUpperCase())} — Trạng thái: ${escapeHtml(row.status)}</div>
    </div>

    <h3>I. Thông tin hợp đồng &amp; các bên</h3>
    <p><strong>Đơn vị quản lý:</strong> ${escapeHtml(row.org_name)} — Tòa nhà: <strong>${escapeHtml(row.building_name)}</strong> (${escapeHtml(row.building_address)})</p>
    <p><strong>Căn hộ:</strong> ${escapeHtml(row.apartment_code)} | <strong>Thời hạn HĐ:</strong> ${fmtDate(row.start_date)} – ${fmtDate(row.end_date)} | <strong>Ngày kết thúc thực tế:</strong> ${fmtDate(row.terminated_at || row.end_date)}</p>
    <p><strong>Khách thuê đại diện:</strong> ${displayTenantName} | <strong>SĐT:</strong> ${displayTenantPhone} | <strong>CCCD/HC:</strong> ${displayTenantIdNumber}</p>

    <h3>II. Chi tiết khấu trừ biên bản bàn giao</h3>
    <table>
      <thead>
        <tr>
          <th style="width:45px; text-align:center;">STT</th>
          <th style="width:170px;">Danh mục</th>
          <th>Nội dung / Hiện trạng nghiệm thu</th>
          <th style="width:140px; text-align:right;">Số tiền</th>
        </tr>
      </thead>
      <tbody>
        ${itemRowsHtml}
      </tbody>
    </table>

    <h3>III. Tổng hợp đối trừ &amp; kết quả tất toán</h3>
    <table>
      <tbody>
        <tr>
          <td>1. Tiền đặt cọc bảo lưu thực tế</td>
          <td style="width:160px; text-align:right; font-weight:bold;">${fmtMoney(heldForCalc)}</td>
        </tr>
        <tr>
          <td>2. Tổng khấu trừ hư hỏng / vệ sinh bàn giao</td>
          <td style="text-align:right;">${fmtMoney(sumItems)}</td>
        </tr>
        <tr>
          <td>3. Công nợ dịch vụ / điện / nước tồn đọng (đối trừ vào cọc)</td>
          <td style="text-align:right;">${fmtMoney(serviceDebt)}</td>
        </tr>
        <tr>
          <td>4. Công nợ tiền thuê phòng tồn đọng <em>(KHÔNG trừ vào tiền cọc — thanh toán riêng)</em></td>
          <td style="text-align:right;">${fmtMoney(rentDebt)}</td>
        </tr>
        <tr class="summary-row" style="background:#ecfdf5;">
          <td>5. SỐ TIỀN HOÀN TRẢ CHO KHÁCH THUÊ (1 − 2 − 3)</td>
          <td style="text-align:right; color:#047857;">${fmtMoney(refundAmount)}</td>
        </tr>
        ${
          shortfall > 0
            ? `<tr class="summary-row" style="background:#fff1f2;">
          <td>6. Công nợ vượt cọc cần thu thêm sau trả phòng</td>
          <td style="text-align:right; color:#be123c;">${fmtMoney(shortfall)}</td>
        </tr>`
            : ''
        }
      </tbody>
    </table>

    <p><strong>Phương thức hoàn trả:</strong> ${escapeHtml(settlement.refund_method || 'BANK_TRANSFER')} ${
      settlement.bank_info?.bank_name
        ? `— Ngân hàng: ${escapeHtml(settlement.bank_info.bank_name)} | STK: ${escapeHtml(settlement.bank_info.account_number || settlement.bank_info.account_no || '')} | Chủ TK: ${escapeHtml(settlement.bank_info.account_holder || '')}`
        : ''
    }</p>
    <p><strong>Hạn hoàn cọc theo quy định:</strong> ${fmtDate(row.refund_due_date)}</p>

    <div class="signatures">
      <div class="sig-box">
        <strong>ĐẠI DIỆN BAN QUẢN LÝ</strong><br />
        <em>(Ký và ghi rõ họ tên)</em>
        <div class="sig-space"></div>
      </div>
      <div class="sig-box">
        <strong>KHÁCH THUÊ XÁC NHẬN</strong><br />
        <em>(Ký và ghi rõ họ tên)</em>
        <div class="sig-space"></div>
        <div><strong>${displayTenantName}</strong></div>
      </div>
    </div>
  </div>
</body>
</html>`;

      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(html);
    } catch (err) {
      console.error('[Settlement PDF Error]:', err);
      res.status(500).send('<h1>500 Lỗi máy chủ khi xuất biên bản tất toán</h1>');
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/deposits/:id/settlement
 */
router.post(
  '/:id/settlement',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { items = [], refund_method = 'BANK_TRANSFER', bank_info = {}, inspection_evidence } = req.body;

    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const roleCodes = getUserRoleCodes(req);
      const writeIds = await getDepositWriteBuildingIds(req.user.sub, req.user.org_id, roleCodes);
      if (!writeIds.includes(meta.building_id)) {
        await logAccessDenied(req, 'deposit', id, 'Operator attempted settlement submit on unassigned building');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền lập tất toán cho tòa nhà này.' });
      }

      await client.query('BEGIN');

      const depRes = await client.query(
        `SELECT d.*, c.status as contract_status, c.building_id, c.apartment_id,
                c.primary_tenant_id, c.start_date, c.end_date, c.terminated_at,
                a.code AS apartment_code
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN apartment a ON a.id = c.apartment_id
         WHERE d.id = $1 FOR UPDATE OF d`,
        [id]
      );

      if (depRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const dep = depRes.rows[0];

      if (!['HELD', 'SETTLEMENT_DRAFT'].includes(dep.status)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'DEPOSIT_NOT_HELD',
          message: 'Chỉ có thể lập hồ sơ tất toán cho khoản cọc đang giữ (HELD) hoặc bản nháp tất toán (SETTLEMENT_DRAFT).',
        });
      }

      const preconditions = await checkSettlementPreconditions(client, dep, {
        latestPhotoHandoverAt: meta.latest_photo_handover_at,
        existingSettlement: dep.settlement,
        incomingInspectionEvidence: inspection_evidence !== undefined ? inspection_evidence : null,
      });
      if (!preconditions.contract_ended) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'CONTRACT_NOT_TERMINATED_OR_EXPIRED',
          message: 'Hợp đồng phải ở trạng thái TERMINATED hoặc EXPIRED mới được mở hồ sơ tất toán.',
        });
      }
      if (!preconditions.final_meters_recorded) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'MISSING_FINAL_METER_READING',
          message: `Chưa ghi đủ chỉ số công tơ kỳ cuối (${preconditions.missing_meter_types.join(', ')}) cho căn hộ trước khi lập tất toán cọc.`,
          missing_meter_types: preconditions.missing_meter_types,
        });
      }
      if (!preconditions.no_draft_invoices) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'UNPUBLISHED_INVOICE',
          message: 'Hợp đồng đang còn hóa đơn bản nháp (DRAFT) chưa phát hành hoặc chưa hủy. Vui lòng xử lý dứt điểm trước khi tất toán cọc.',
        });
      }

      if (!Array.isArray(items)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ code: 'INVALID_ITEMS', message: 'Danh sách khoản trừ không hợp lệ.' });
      }

      for (const item of items) {
        const v = validateDeduction(item);
        if (!v.ok) {
          await client.query('ROLLBACK');
          return res.status(422).json({ code: v.code, message: v.message });
        }
      }

      if (!preconditions.apartment_inspected) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'MISSING_APARTMENT_INSPECTION',
          message: 'Chưa có biên bản kiểm tra bàn giao phòng kèm hình ảnh sau khi hợp đồng kết thúc (FR-024, R-12).',
          preconditions,
        });
      }

      const preAmountItems = items.map((item) => ({
        ...item,
        amount: Number(String(item.amount).trim()),
      }));
      const { serviceDebt, rentDebt, openInvoices } = await calculateContractOpenDebts(client, dep.contract_id);

      const { refund, shortfall } = computeRefund({
        depositAmount: dep.amount_held,
        outstandingDebt: serviceDebt,
        items: preAmountItems,
      });

      const vBank = validateRefundBankInfo({
        refundAmount: refund,
        refundMethod: refund_method,
        bankInfo: bank_info,
      });
      if (!vBank.ok) {
        await client.query('ROLLBACK');
        return res.status(422).json({ code: vBank.code, message: vBank.message });
      }

      const normalizedItems = [];
      for (const item of items) {
        const normEv = await normalizeAndPersistEvidence(client, {
          entity: 'deposit',
          ownerId: id,
          folder: 'deposits',
          evidence: Array.isArray(item.evidence) ? item.evidence : [],
          req,
        });
        normalizedItems.push({
          ...item,
          amount: Number(String(item.amount).trim()),
          description: String(item.description).trim(),
          evidence: normEv,
        });
      }

      const prevSettlement = dep.settlement || {};
      const rawInspectionEvidence =
        inspection_evidence !== undefined
          ? Array.isArray(inspection_evidence)
            ? inspection_evidence
            : []
          : Array.isArray(prevSettlement.inspection_evidence)
            ? prevSettlement.inspection_evidence
            : [];
      const normalizedInspectionEvidence = await normalizeAndPersistEvidence(client, {
        entity: 'deposit',
        ownerId: id,
        folder: 'handovers',
        evidence: rawInspectionEvidence,
        req,
      });

      const settlementPayload = {
        items: normalizedItems,
        inspection_evidence: normalizedInspectionEvidence,
        outstanding_debt: serviceDebt,
        service_debt: serviceDebt,
        rent_debt: rentDebt,
        deposit_held_before_settlement: Number(dep.amount_held),
        refund_amount: Number(refund),
        shortfall: Number(shortfall),
        refund_method,
        bank_info: vBank.normalizedBankInfo,
        open_invoice_snapshot: normalizeOpenInvoiceSnapshot(openInvoices),
        created_by: req.user.sub,
        created_at: new Date().toISOString(),
        approved_by: null,
        approved_at: null,
        accounting_committed_at: null,
        dispute_thread: Array.isArray(prevSettlement.dispute_thread) ? prevSettlement.dispute_thread : [],
      };

      await client.query(
        `UPDATE deposit SET settlement = $1, status = 'PENDING_APPROVAL', updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(settlementPayload), id]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'SETTLEMENT_SUBMIT', 'deposit', $2, $3)`,
        [req.user.sub, id, JSON.stringify(settlementPayload)]
      );

      await client.query(
        `SELECT fn_notify_deposit_event($1, 'RESIDENT', 'SETTLEMENT_STATEMENT_READY', $2, $3, $4::jsonb, NULL)`,
        [
          id,
          'Bảng kê tất toán tiền cọc đã được lập',
          `Ban Quản Lý đã lập bảng kê tất toán tiền cọc cho căn ${dep.apartment_code}. Vui lòng kiểm tra chi tiết bảng kê và gửi phản hồi nếu có thắc mắc trước khi chi hoàn cọc.`,
          JSON.stringify({ deposit_id: id, contract_id: dep.contract_id, settlement: settlementPayload }),
        ]
      );

      const approverAudience = meta.building_has_active_owner ? 'BUILDING_OWNERS' : 'BUILDING_MANAGERS';
      await client.query(
        `SELECT fn_notify_deposit_event($1, $2, 'SETTLEMENT_PENDING_APPROVAL', $3, $4, $5::jsonb, NULL)`,
        [
          id,
          approverAudience,
          `Chờ phê duyệt hoàn cọc — Căn ${dep.apartment_code}`,
          `Ban Quản Lý đã trình hồ sơ tất toán tiền cọc căn ${dep.apartment_code} (hoàn trả dự kiến: ${Number(refund).toLocaleString('vi-VN')} ₫). Vui lòng xem xét và phê duyệt.`,
          JSON.stringify({
            deposit_id: id,
            contract_id: dep.contract_id,
            refund_amount: Number(refund),
            link: '/admin/deposits',
          }),
        ]
      );

      await client.query('COMMIT');

      res.status(200).json({
        message: 'Đã gửi hồ sơ tất toán cọc, chờ phê duyệt hoàn cọc.',
        data: { settlement: settlementPayload, status: 'PENDING_APPROVAL' },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err?.status) {
        return res.status(err.status).json({ code: err.code || 'VALIDATION_ERROR', message: err.message });
      }
      console.error('[Settlement Submit Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lập hồ sơ tất toán.' });
    } finally {
      await release();
    }
  }
);

async function commitSettlementAccounting(client, { depositId, settlement, heldBefore, serviceDebt, actorId }) {
  const items = Array.isArray(settlement.items) ? settlement.items : [];
  const sumItems = items.reduce((s, it) => s + Math.max(0, Number(it.amount || 0)), 0);
  const effectiveApprovedBy = settlement.approved_by || actorId;
  const effectiveApprovedAt = settlement.approved_at || new Date().toISOString();
  const effectiveCreatedBy = settlement.created_by || actorId;

  let remainingDepositToDeduct = heldBefore;
  for (const item of items) {
    const itemAmt = Math.max(0, Math.round(Number(item.amount || 0)));
    const appliedDeduct = Math.min(remainingDepositToDeduct, itemAmt);
    remainingDepositToDeduct -= appliedDeduct;
    if (appliedDeduct <= 0) continue;
    await client.query(
      `INSERT INTO deposit_transaction (
         deposit_id, type, amount, category, description, evidence, status, method, approved_by, approved_at, created_by
       )
       VALUES ($1, 'deduct', $2, $3, $4, $5, 'APPROVED', $6, $7, $8::timestamptz, $9)`,
      [
        depositId,
        appliedDeduct,
        item.category,
        item.description,
        item.evidence || [],
        item.method || 'OTHER',
        effectiveApprovedBy,
        effectiveApprovedAt,
        effectiveCreatedBy,
      ]
    );
  }

  const coveredServiceDebt = Math.min(serviceDebt, remainingDepositToDeduct);
  if (coveredServiceDebt > 0) {
    await client.query(
      `INSERT INTO deposit_transaction (
         deposit_id, type, amount, category, description, evidence, status, method, approved_by, approved_at, created_by
       )
       VALUES ($1, 'deduct', $2, 'UTILITY_DEBT', $3, $4, 'APPROVED', 'TRANSFER', $5, $6::timestamptz, $7)`,
      [
        depositId,
        Math.round(coveredServiceDebt),
        'Đối trừ tự động công nợ dịch vụ/điện nước từ tiền đặt cọc (R-06)',
        [],
        effectiveApprovedBy,
        effectiveApprovedAt,
        effectiveCreatedBy,
      ]
    );
  }

  const uncoveredItemsShortfall = Math.max(0, sumItems - heldBefore);
  await client.query('SELECT fn_apply_deposit_settlement_accounting($1, $2, $3)', [
    depositId,
    Math.round(coveredServiceDebt),
    Math.round(uncoveredItemsShortfall),
  ]);

  return {
    coveredServiceDebt: Math.round(coveredServiceDebt),
    uncoveredItemsShortfall: Math.round(uncoveredItemsShortfall),
  };
}

/**
 * POST /api/v1/deposits/:id/settlement/approve
 */
router.post(
  '/:id/settlement/approve',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const approverAccess = await canActAsDepositApprover(req, meta, id, 'settlement approve');
      if (!approverAccess.ok) {
        return res.status(403).json({ code: approverAccess.code, message: approverAccess.message });
      }

      await client.query('BEGIN');

      const depRes = await client.query(
        `SELECT d.*, c.primary_tenant_id, c.building_id, a.code AS apartment_code
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN apartment a ON a.id = c.apartment_id
         WHERE d.id = $1 FOR UPDATE OF d`,
        [id]
      );

      if (depRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const dep = depRes.rows[0];

      if (dep.status === 'DISPUTED') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'SETTLEMENT_DISPUTED',
          message: 'Hồ sơ tất toán đang trong tình trạng tranh chấp, không thể phê duyệt (FR-024).',
        });
      }

      if (dep.status !== 'PENDING_APPROVAL') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'NOT_PENDING_APPROVAL',
          message: 'Chỉ có thể phê duyệt hồ sơ tất toán đang chờ duyệt (PENDING_APPROVAL).',
        });
      }

      const settlement = dep.settlement;
      if (!settlement) {
        await client.query('ROLLBACK');
        return res.status(400).json({ code: 'NO_SETTLEMENT_DATA', message: 'Không có dữ liệu tất toán.' });
      }

      if (settlement.created_by && String(settlement.created_by) === String(req.user.sub)) {
        const fourEyes = await checkFourEyesOrWarn({
          orgId: req.user.org_id,
          actorId: req.user.sub,
          creatorId: settlement.created_by,
          entity: 'deposit',
          entityId: id,
          actionContext: 'SETTLEMENT_APPROVE',
        });
        if (!fourEyes.allowed) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            code: 'SELF_APPROVAL',
            message: 'Nguyên tắc Four-eyes: Người tạo hồ sơ tất toán không được tự duyệt.',
          });
        }
      }

      const heldBefore = Math.max(0, Number(dep.amount_held || 0));
      const items = Array.isArray(settlement.items) ? settlement.items : [];
      const sumItems = items.reduce((s, it) => s + Math.max(0, Number(it.amount || 0)), 0);

      await client.query(
        `SELECT id FROM invoice
         WHERE contract_id = $1
           AND status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
         FOR UPDATE`,
        [dep.contract_id]
      );

      const liveDebts = await calculateContractOpenDebts(client, dep.contract_id);
      if (
        isSettlementSnapshotStale(settlement, {
          serviceDebt: liveDebts.serviceDebt,
          rentDebt: liveDebts.rentDebt,
          heldAmount: heldBefore,
          openInvoices: liveDebts.openInvoices,
        })
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'SETTLEMENT_SNAPSHOT_STALE',
          message:
            'Công nợ hóa đơn hoặc số dư tiền cọc đã biến động kể từ khi trình duyệt. Vui lòng từ chối hồ sơ để Quản lý lập lại bảng kê theo số liệu mới nhất.',
        });
      }

      const serviceDebt = liveDebts.serviceDebt;
      const rentDebt = liveDebts.rentDebt;

      const { refund: recomputedRefund, shortfall: recomputedShortfall } = computeRefund({
        depositAmount: heldBefore,
        outstandingDebt: serviceDebt,
        items,
      });
      const refundAmount = Number(recomputedRefund);
      const shortfallAmount = Number(recomputedShortfall);
      const nowIso = new Date().toISOString();

      if (refundAmount === 0) {
        const { coveredServiceDebt } = await commitSettlementAccounting(client, {
          depositId: id,
          settlement: { ...settlement, approved_by: req.user.sub, approved_at: nowIso },
          heldBefore,
          serviceDebt,
          actorId: req.user.sub,
        });

        const finalStatus = resolvePostSettlementStatus({
          refundAmount: 0,
          outstandingDebt: serviceDebt,
          items,
          shortfall: shortfallAmount,
        });

        const finalizedSettlement = {
          ...settlement,
          outstanding_debt: serviceDebt,
          service_debt: serviceDebt,
          rent_debt: rentDebt,
          deposit_held_before_settlement: heldBefore,
          covered_service_debt: coveredServiceDebt,
          refund_amount: 0,
          shortfall: shortfallAmount,
          approved_by: req.user.sub,
          approved_at: nowIso,
          accounting_committed_at: nowIso,
        };

        await client.query(
          `UPDATE deposit SET amount_held = 0, status = $1, settlement = $2, updated_at = NOW() WHERE id = $3`,
          [finalStatus, JSON.stringify(finalizedSettlement), id]
        );

        await client.query(
          `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
           VALUES ($1, 'SETTLEMENT_APPROVE', 'deposit', $2, $3)`,
          [req.user.sub, id, JSON.stringify({ ...finalizedSettlement, final_status: finalStatus })]
        );

        await client.query(
          `SELECT fn_notify_deposit_event($1, 'RESIDENT', 'SETTLEMENT_APPROVED', $2, $3, $4::jsonb, NULL)`,
          [
            id,
            'Hồ sơ tất toán cọc đã được phê duyệt',
            'Hồ sơ tất toán tiền cọc của hợp đồng thuê căn hộ đã được phê duyệt.',
            JSON.stringify({ deposit_id: id, settlement: finalizedSettlement, status: finalStatus }),
          ]
        );

        await client.query('COMMIT');
        return res.json({
          message: 'Phê duyệt hồ sơ tất toán thành công.',
          data: { id, status: finalStatus, amount_held: '0', settlement: finalizedSettlement },
        });
      }

      const coveredServiceDebtPreview = Math.min(serviceDebt, Math.max(0, heldBefore - sumItems));
      const approvedPendingSettlement = {
        ...settlement,
        outstanding_debt: serviceDebt,
        service_debt: serviceDebt,
        rent_debt: rentDebt,
        deposit_held_before_settlement: heldBefore,
        covered_service_debt: Math.round(coveredServiceDebtPreview),
        refund_amount: refundAmount,
        shortfall: shortfallAmount,
        approved_by: req.user.sub,
        approved_at: nowIso,
        accounting_committed_at: null,
      };

      await client.query(
        `UPDATE deposit
         SET amount_held = $1, status = 'APPROVED_PENDING_PAYOUT', settlement = $2, updated_at = NOW()
         WHERE id = $3`,
        [heldBefore, JSON.stringify(approvedPendingSettlement), id]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'SETTLEMENT_APPROVE', 'deposit', $2, $3)`,
        [req.user.sub, id, JSON.stringify({ ...approvedPendingSettlement, final_status: 'APPROVED_PENDING_PAYOUT' })]
      );

      await client.query(
        `SELECT fn_notify_deposit_event($1, 'RESIDENT', 'SETTLEMENT_APPROVED', $2, $3, $4::jsonb, NULL)`,
        [
          id,
          'Hồ sơ tất toán cọc đã được phê duyệt — Chờ chi hoàn',
          `Bảng kê tất toán tiền cọc căn ${dep.apartment_code} đã được phê duyệt (số tiền hoàn trả: ${refundAmount.toLocaleString('vi-VN')} ₫). Ban Quản Lý sẽ thực hiện chi hoàn trong thời hạn quy định.`,
          JSON.stringify({ deposit_id: id, settlement: approvedPendingSettlement, status: 'APPROVED_PENDING_PAYOUT' }),
        ]
      );

      await client.query(
        `SELECT fn_notify_deposit_event($1, 'BUILDING_MANAGERS', 'SETTLEMENT_READY_FOR_PAYOUT', $2, $3, $4::jsonb, NULL)`,
        [
          id,
          `Sẵn sàng chi hoàn cọc — Căn ${dep.apartment_code}`,
          `Hồ sơ tất toán cọc căn ${dep.apartment_code} đã được phê duyệt. Vui lòng thực hiện chuyển khoản/chi tiền (${refundAmount.toLocaleString('vi-VN')} ₫) và tải lên chứng từ UNC.`,
          JSON.stringify({
            deposit_id: id,
            contract_id: dep.contract_id,
            refund_amount: refundAmount,
            link: '/admin/deposits',
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Đã phê duyệt bảng kê tất toán cọc. Hồ sơ chuyển sang chờ Ban Quản Lý thực hiện chi hoàn (APPROVED_PENDING_PAYOUT).',
        data: { id, status: 'APPROVED_PENDING_PAYOUT', amount_held: String(heldBefore), settlement: approvedPendingSettlement },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Settlement Approve Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi phê duyệt hồ sơ tất toán.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/deposits/:id/settlement/reject
 */
router.post(
  '/:id/settlement/reject',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do từ chối hồ sơ tất toán.' });
    }

    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const approverAccess = await canActAsDepositApprover(req, meta, id, 'settlement reject');
      if (!approverAccess.ok) {
        return res.status(403).json({ code: approverAccess.code, message: approverAccess.message });
      }

      await client.query('BEGIN');

      const depRes = await client.query('SELECT * FROM deposit WHERE id = $1 FOR UPDATE', [id]);
      if (depRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const dep = depRes.rows[0];
      if (!['PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT'].includes(dep.status) || dep.settlement?.accounting_committed_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({ code: 'NOT_PENDING_APPROVAL', message: 'Chỉ có thể từ chối hồ sơ đang chờ duyệt hoặc chưa thực hiện chi tiền.' });
      }

      if (dep.settlement?.created_by && String(dep.settlement.created_by) === String(req.user.sub)) {
        const fourEyes = await checkFourEyesOrWarn({
          orgId: req.user.org_id,
          actorId: req.user.sub,
          creatorId: dep.settlement.created_by,
          entity: 'deposit',
          entityId: id,
          actionContext: 'SETTLEMENT_REJECT',
        });
        if (!fourEyes.allowed) {
          await client.query('ROLLBACK');
          return res.status(403).json({
            code: 'SELF_APPROVAL',
            message: 'Nguyên tắc Four-eyes: Người tạo hồ sơ tất toán không được tự phê duyệt/từ chối.',
          });
        }
      }

      const updatedSettlement = {
        ...(dep.settlement || {}),
        approved_by: null,
        approved_at: null,
        rejected_by: req.user.sub,
        rejected_at: new Date().toISOString(),
        rejection_reason: reason.trim(),
      };

      await client.query(
        `UPDATE deposit SET status = 'SETTLEMENT_DRAFT', settlement = $1, updated_at = NOW() WHERE id = $2`,
        [JSON.stringify(updatedSettlement), id]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'SETTLEMENT_REJECT', 'deposit', $2, $3)`,
        [req.user.sub, id, JSON.stringify(updatedSettlement)]
      );

      if (dep.settlement?.created_by) {
        await client.query(
          `SELECT fn_notify_deposit_event($1, 'SPECIFIC_USER', 'SETTLEMENT_REJECTED', $2, $3, $4::jsonb, $5::uuid)`,
          [
            id,
            'Hồ sơ tất toán tiền cọc bị từ chối',
            `Hồ sơ tất toán cọc cần được rà soát và lập lại: "${reason.trim()}"`,
            JSON.stringify({ deposit_id: id, status: 'SETTLEMENT_DRAFT', reason: reason.trim() }),
            dep.settlement.created_by,
          ]
        );
      }

      await client.query('COMMIT');
      res.json({ message: 'Đã từ chối hồ sơ tất toán, chuyển về trạng thái nháp.', data: { id, status: 'SETTLEMENT_DRAFT' } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Settlement Reject Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi từ chối hồ sơ tất toán.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/deposits/:id/dispute
 */
router.post(
  '/:id/dispute',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER', 'RESIDENT']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ code: 'REASON_REQUIRED', message: 'Vui lòng cung cấp lý do tranh chấp / khiếu nại.' });
    }

    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const roleCodes = getUserRoleCodes(req);
      let authorized = false;
      if (roleCodes.includes('RESIDENT') && meta.is_contract_resident) {
        authorized = true;
      } else if (roleCodes.includes('MANAGER')) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
        if (mgrIds.includes(meta.building_id)) {
          authorized = true;
        }
      }
      if (!authorized) {
        await logAccessDenied(req, 'deposit', id, 'Unauthorized dispute submission attempt');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền gửi khiếu nại cho sổ cọc này.',
        });
      }

      await client.query('BEGIN');
      const rpcRes = await client.query('SELECT * FROM fn_submit_deposit_dispute($1, $2)', [
        id,
        String(reason).trim(),
      ]);
      await client.query('COMMIT');

      const updated = rpcRes.rows[0];
      res.json({
        message: 'Đã ghi nhận khiếu nại và chuyển hồ sơ cọc sang trạng thái tranh chấp (DISPUTED).',
        data: { id: updated.id, status: updated.status, settlement: updated.settlement },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const msg = String(err?.message || '');
      if (msg.includes('DISPUTE_WINDOW_EXPIRED')) {
        return res.status(409).json({
          code: 'DISPUTE_WINDOW_EXPIRED',
          message: 'Đã quá thời hạn 7 ngày kể từ khi tất toán để gửi khiếu nại bảng kê tiền cọc (FR-024).',
        });
      }
      if (msg.includes('DISPUTE_ALREADY_FINALIZED')) {
        return res.status(409).json({
          code: 'DISPUTE_ALREADY_FINALIZED',
          message: 'Hồ sơ tất toán này đã hoàn tất chu kỳ giải quyết khiếu nại cuối cùng, không thể mở lại tranh chấp.',
        });
      }
      if (msg.includes('DISPUTE_NOT_ALLOWED')) {
        return res.status(409).json({
          code: 'INVALID_STATUS_FOR_DISPUTE',
          message: 'Chỉ có thể gửi khiếu nại cho hồ sơ đang chờ duyệt hoặc trong 7 ngày sau tất toán.',
        });
      }
      if (msg.includes('ACCESS_DENIED')) {
        await logAccessDenied(req, 'deposit', id, 'fn_submit_deposit_dispute rejected caller');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền gửi khiếu nại cho sổ cọc này.' });
      }
      console.error('[Settlement Dispute Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi ghi nhận tranh chấp cọc.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/deposits/:id/resolve-dispute
 */
router.post(
  '/:id/resolve-dispute',
  authenticateToken,
  requireRole(['OWNER', 'MANAGER', 'SYS_ADMIN']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { resolution } = req.body;
    const trimmedReason = String(req.body?.reason ?? req.body?.notes ?? '').trim();

    if (!['ADJUST', 'CONFIRM'].includes(resolution)) {
      return res.status(400).json({
        code: 'INVALID_RESOLUTION',
        message: 'Phương án giải quyết không hợp lệ. Chỉ chấp nhận ADJUST (mở lại sửa bảng kê) hoặc CONFIRM (xác nhận giữ nguyên).',
      });
    }
    if (!trimmedReason) {
      return res.status(400).json({
        code: 'REASON_REQUIRED',
        message: 'Vui lòng nhập nội dung phản hồi / biên bản giải quyết khiếu nại.',
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const approverAccess = await canActAsDepositApprover(req, meta, id, 'resolve dispute');
      if (!approverAccess.ok) {
        return res.status(403).json({ code: approverAccess.code, message: approverAccess.message });
      }

      await client.query('BEGIN');

      const depRes = await client.query('SELECT * FROM deposit WHERE id = $1 FOR UPDATE', [id]);
      if (depRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const dep = depRes.rows[0];
      if (dep.status !== 'DISPUTED') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'NOT_DISPUTED',
          message: `Chỉ có thể giải quyết tranh chấp khi sổ cọc đang ở trạng thái DISPUTED (hiện tại: ${dep.status}).`,
        });
      }

      const prevSettlement = dep.settlement || {};
      const prevStatus = prevSettlement.previous_status_before_dispute || null;
      const isAccountingCommitted =
        Boolean(prevSettlement.accounting_committed_at) ||
        ['PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL', 'RETURNED'].includes(prevStatus);

      if (resolution === 'ADJUST' && isAccountingCommitted) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'ALREADY_PAID_OUT',
          message: 'Sổ cọc đã thực hiện hạch toán đối trừ / chi trả, không thể mở lại bản nháp để sửa sổ cái bất biến.',
        });
      }

      if (resolution === 'CONFIRM' && (Boolean(prevSettlement.approved_at) || isAccountingCommitted)) {
        if (prevSettlement.created_by && String(prevSettlement.created_by) === String(req.user.sub)) {
          const fourEyes = await checkFourEyesOrWarn({
            orgId: req.user.org_id,
            actorId: req.user.sub,
            creatorId: prevSettlement.created_by,
            entity: 'deposit',
            entityId: id,
            actionContext: 'RESOLVE_DISPUTE_CONFIRM',
          });
          if (!fourEyes.allowed) {
            await client.query('ROLLBACK');
            return res.status(403).json({
              code: 'SELF_APPROVAL',
              message: 'Nguyên tắc Four-eyes: Người lập bảng kê tất toán không được tự đóng khiếu nại giữ nguyên kết quả đã duyệt.',
            });
          }
        }
      }

      const roleCodes = getUserRoleCodes(req);
      const actorRole = roleCodes.includes('OWNER')
        ? 'OWNER'
        : roleCodes.includes('SYS_ADMIN')
          ? 'SYS_ADMIN'
          : 'MANAGER';
      const prevThread = Array.isArray(prevSettlement.dispute_thread) ? prevSettlement.dispute_thread : [];

      let nextStatus = 'SETTLEMENT_DRAFT';
      const extraPatch = {};
      if (resolution === 'ADJUST') {
        extraPatch.approved_by = null;
        extraPatch.approved_at = null;
      } else if (isAccountingCommitted) {
        nextStatus = ['PARTIALLY_REFUNDED', 'REFUNDED', 'DEDUCTED_FULL', 'RETURNED'].includes(prevStatus)
          ? prevStatus
          : resolvePostSettlementStatus({
              refundAmount: prevSettlement.refund_amount,
              outstandingDebt: prevSettlement.outstanding_debt,
              items: prevSettlement.items || [],
              shortfall: prevSettlement.shortfall,
            });
        extraPatch.post_settlement_dispute_closed = true;
      } else if (prevStatus === 'APPROVED_PENDING_PAYOUT' || Boolean(prevSettlement.approved_at)) {
        nextStatus = 'APPROVED_PENDING_PAYOUT';
      } else {
        nextStatus = 'PENDING_APPROVAL';
      }

      const updatedSettlement = {
        ...prevSettlement,
        ...extraPatch,
        dispute_resolved_by: req.user.sub,
        dispute_resolved_at: new Date().toISOString(),
        dispute_resolution: resolution,
        dispute_resolution_reason: trimmedReason,
        dispute_thread: [
          ...prevThread,
          {
            type: 'RESOLUTION',
            resolution,
            at: new Date().toISOString(),
            by: req.user.sub,
            role: actorRole,
            message: trimmedReason,
          },
        ],
      };

      await client.query(
        `UPDATE deposit SET status = $1, settlement = $2, updated_at = NOW() WHERE id = $3`,
        [nextStatus, JSON.stringify(updatedSettlement), id]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'SETTLEMENT_RESOLVE_DISPUTE', 'deposit', $2, $3)`,
        [req.user.sub, id, JSON.stringify({ resolution, next_status: nextStatus, reason: trimmedReason })]
      );

      await client.query(
        `SELECT fn_notify_deposit_event($1, 'RESIDENT', 'DISPUTE_RESOLVED', $2, $3, $4::jsonb, NULL)`,
        [
          id,
          'Phản hồi giải quyết khiếu nại tất toán cọc',
          `Khiếu nại tất toán cọc đã được xử lý (${resolution === 'ADJUST' ? 'Mở lại điều chỉnh bảng kê' : 'Xác nhận giữ nguyên kết quả'}): "${trimmedReason}"`,
          JSON.stringify({ deposit_id: id, status: nextStatus, resolution }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message:
          resolution === 'ADJUST'
            ? 'Đã mở lại hồ sơ tất toán (SETTLEMENT_DRAFT) để điều chỉnh bảng kê và trình duyệt lại.'
            : `Đã xác nhận kết quả giải quyết khiếu nại, chuyển trạng thái sang ${nextStatus}.`,
        data: { id, status: nextStatus, settlement: updatedSettlement },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Resolve Dispute Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi giải quyết khiếu nại tất toán cọc.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/deposits/:id/payout
 * Thực thi chi hoàn tiền cọc (hoặc phát hành lại lệnh chi khi RETURNED) kèm chứng từ UNC (FR-024, R-12)
 */
router.post(
  '/:id/payout',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { evidence, reference_code, method, note } = req.body || {};

    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const roleCodes = getUserRoleCodes(req);
      const writeIds = await getDepositWriteBuildingIds(req.user.sub, req.user.org_id, roleCodes);
      if (!writeIds.includes(meta.building_id)) {
        await logAccessDenied(req, 'deposit', id, 'MANAGER attempted payout on unassigned building');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền chi hoàn cọc trên tòa nhà này.' });
      }

      await client.query('BEGIN');

      const depRes = await client.query(
        `SELECT d.*, c.primary_tenant_id, c.building_id, a.code AS apartment_code
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN apartment a ON a.id = c.apartment_id
         WHERE d.id = $1 FOR UPDATE OF d`,
        [id]
      );
      if (depRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const dep = depRes.rows[0];
      if (dep.status === 'DISPUTED') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'SETTLEMENT_DISPUTED',
          message: 'Hồ sơ tất toán đang có khiếu nại/tranh chấp mở, tạm khóa chi tiền cho đến khi được giải quyết (FR-024).',
        });
      }

      if (!['APPROVED_PENDING_PAYOUT', 'RETURNED'].includes(dep.status) || BigInt(dep.amount_held || 0) <= 0n) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS_FOR_PAYOUT',
          message: `Chỉ có thể chi hoàn cho sổ cọc ở trạng thái APPROVED_PENDING_PAYOUT hoặc RETURNED có số dư cần chi > 0 (hiện tại: ${dep.status}).`,
        });
      }

      const settlement = dep.settlement || {};
      const refundMethod = method || settlement.refund_method || 'BANK_TRANSFER';
      if (!['BANK_TRANSFER', 'CASH'].includes(refundMethod)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'INVALID_METHOD',
          message: 'Phương thức chi hoàn không hợp lệ (chỉ chấp nhận BANK_TRANSFER hoặc CASH).',
        });
      }

      const rawEvidence = Array.isArray(evidence)
        ? evidence.filter((item) => typeof item === 'string' && item.trim().length > 0)
        : [];
      if (refundMethod === 'BANK_TRANSFER' && rawEvidence.length < 1) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          code: 'PAYOUT_EVIDENCE_REQUIRED',
          message: 'Chi hoàn cọc qua chuyển khoản bắt buộc đính kèm chứng từ UNC / sao kê ngân hàng (FR-024, R-12).',
        });
      }

      const isAlreadyCommitted = Boolean(settlement.accounting_committed_at);
      const wasReturned = dep.status === 'RETURNED';
      const targetRefundAmount = isAlreadyCommitted
        ? Math.round(Number(dep.amount_held || 0))
        : Math.round(Number(settlement.refund_amount || 0));

      const vBank = validateRefundBankInfo({
        refundAmount: targetRefundAmount,
        refundMethod,
        bankInfo: settlement.bank_info || {},
      });
      if (!vBank.ok) {
        await client.query('ROLLBACK');
        return res.status(422).json({ code: vBank.code, message: vBank.message });
      }

      const nowIso = new Date().toISOString();
      let coveredServiceDebt = Number(settlement.covered_service_debt || 0);
      let committedAtIso = settlement.accounting_committed_at || nowIso;

      if (!isAlreadyCommitted) {
        const heldBefore = Math.max(0, Number(dep.amount_held || 0));
        await client.query(
          `SELECT id FROM invoice
           WHERE contract_id = $1
             AND status IN ('ISSUED', 'PARTIALLY_PAID', 'OVERDUE')
           FOR UPDATE`,
          [dep.contract_id]
        );
        const liveDebts = await calculateContractOpenDebts(client, dep.contract_id);
        if (
          isSettlementSnapshotStale(settlement, {
            serviceDebt: liveDebts.serviceDebt,
            rentDebt: liveDebts.rentDebt,
            heldAmount: heldBefore,
            openInvoices: liveDebts.openInvoices,
          })
        ) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            code: 'SETTLEMENT_SNAPSHOT_STALE',
            message:
              'Công nợ hóa đơn hoặc số dư tiền cọc đã biến động trước thời điểm chi hoàn. Vui lòng từ chối hồ sơ để lập lại bảng kê theo số liệu mới nhất.',
          });
        }

        const accResult = await commitSettlementAccounting(client, {
          depositId: id,
          settlement,
          heldBefore,
          serviceDebt: liveDebts.serviceDebt,
          actorId: req.user.sub,
        });
        coveredServiceDebt = accResult.coveredServiceDebt;
        committedAtIso = nowIso;
      }

      const normalizedEvidence = await normalizeAndPersistEvidence(client, {
        entity: 'deposit',
        ownerId: id,
        folder: 'deposits',
        evidence: rawEvidence,
        req,
      });

      const trimmedRef = reference_code ? String(reference_code).trim() : null;
      const trimmedNote = note ? String(note).trim() : null;
      const refundDescription = wasReturned
        ? `Phát hành lại lệnh chi hoàn tiền cọc${trimmedNote ? ` — ${trimmedNote}` : ''}`
        : `Chi hoàn tiền cọc sau tất toán${trimmedNote ? ` — ${trimmedNote}` : ''}`;

      await client.query(
        `INSERT INTO deposit_transaction (
           deposit_id, type, amount, description, evidence, reference_code, status, method, approved_by, approved_at, created_by
         )
         VALUES ($1, 'refund', $2, $3, $4, $5, 'APPROVED', $6, $7, $8::timestamptz, $9)`,
        [
          id,
          targetRefundAmount,
          refundDescription,
          normalizedEvidence,
          trimmedRef,
          refundMethod,
          settlement.approved_by || req.user.sub,
          settlement.approved_at || nowIso,
          req.user.sub,
        ]
      );

      const finalStatus = resolvePostSettlementStatus({
        refundAmount: targetRefundAmount,
        outstandingDebt: Number(settlement.outstanding_debt || 0),
        items: Array.isArray(settlement.items) ? settlement.items : [],
        shortfall: Number(settlement.shortfall || 0),
      });

      const prevReissues = Array.isArray(settlement.reissue_history) ? settlement.reissue_history : [];
      const updatedSettlement = {
        ...settlement,
        refund_method: refundMethod,
        bank_info: vBank.normalizedBankInfo,
        covered_service_debt: coveredServiceDebt,
        accounting_committed_at: committedAtIso,
        payout_at: nowIso,
        payout_by: req.user.sub,
        payout_evidence: normalizedEvidence,
        payout_reference_code: trimmedRef,
        ...(trimmedNote ? { payout_note: trimmedNote } : {}),
        ...(wasReturned
          ? {
              reissued_at: nowIso,
              reissued_by: req.user.sub,
              reissue_history: [
                ...prevReissues,
                {
                  at: nowIso,
                  by: req.user.sub,
                  amount: targetRefundAmount,
                  reference_code: trimmedRef,
                  evidence: normalizedEvidence,
                },
              ],
            }
          : {}),
      };

      await client.query(
        `UPDATE deposit SET amount_held = 0, status = $1, settlement = $2, updated_at = NOW() WHERE id = $3`,
        [finalStatus, JSON.stringify(updatedSettlement), id]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, $2, 'deposit', $3, $4)`,
        [
          req.user.sub,
          wasReturned ? 'DEPOSIT_PAYOUT_REISSUE' : 'DEPOSIT_PAYOUT',
          id,
          JSON.stringify({
            status: finalStatus,
            amount: targetRefundAmount,
            reference_code: trimmedRef,
            evidence: normalizedEvidence,
          }),
        ]
      );

      const notifType = wasReturned ? 'DEPOSIT_PAYOUT_REISSUED' : 'DEPOSIT_PAYOUT_COMPLETED';
      await client.query(
        `SELECT fn_notify_deposit_event($1, 'RESIDENT', $2, $3, $4, $5::jsonb, NULL)`,
        [
          id,
          notifType,
          wasReturned ? 'Đã phát hành lại lệnh chi hoàn tiền cọc' : 'Đã chi hoàn tiền đặt cọc',
          `Ban Quản Lý đã thực hiện chi hoàn ${targetRefundAmount.toLocaleString('vi-VN')} ₫ cho căn ${dep.apartment_code}${trimmedRef ? ` (mã giao dịch: ${trimmedRef})` : ''}.`,
          JSON.stringify({
            deposit_id: id,
            contract_id: dep.contract_id,
            status: finalStatus,
            amount: targetRefundAmount,
            reference_code: trimmedRef,
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message: wasReturned
          ? 'Đã phát hành lại lệnh chi hoàn tiền cọc thành công.'
          : 'Đã ghi nhận chi hoàn tiền cọc và lưu chứng từ UNC thành công.',
        data: { id, status: finalStatus, amount_held: '0', settlement: updatedSettlement },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err?.status) {
        return res.status(err.status).json({ code: err.code || 'VALIDATION_ERROR', message: err.message });
      }
      console.error('[Deposit Payout Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi thực hiện chi hoàn tiền cọc.' });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/deposits/:id/payout-returned
 * Ghi nhận giao dịch chuyển khoản hoàn cọc bị ngân hàng trả lại (RETURNED) — bất biến sổ cái (FR-024)
 */
router.post(
  '/:id/payout-returned',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { reason, reference_code } = req.body || {};
    const trimmedReason = String(reason || '').trim();
    if (!trimmedReason) {
      return res.status(400).json({
        code: 'REASON_REQUIRED',
        message: 'Vui lòng cung cấp lý do ngân hàng trả lại giao dịch hoàn cọc.',
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }
      const roleCodes = getUserRoleCodes(req);
      const writeIds = await getDepositWriteBuildingIds(req.user.sub, req.user.org_id, roleCodes);
      if (!writeIds.includes(meta.building_id)) {
        await logAccessDenied(req, 'deposit', id, 'MANAGER attempted payout-returned on unassigned building');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền thao tác trên tòa nhà này.' });
      }

      await client.query('BEGIN');

      const depRes = await client.query(
        `SELECT d.*, a.code AS apartment_code
         FROM deposit d
         JOIN contract c ON c.id = d.contract_id
         JOIN apartment a ON a.id = c.apartment_id
         WHERE d.id = $1 FOR UPDATE OF d`,
        [id]
      );
      if (depRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const dep = depRes.rows[0];
      const refundAmt = Math.round(Number(dep.settlement?.refund_amount || 0));
      if (
        !['REFUNDED', 'PARTIALLY_REFUNDED'].includes(dep.status) ||
        BigInt(dep.amount_held || 0) !== 0n ||
        refundAmt <= 0
      ) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_DEPOSIT_STATUS_FOR_RETURN',
          message:
            'Chỉ có thể ghi nhận ngân hàng hoàn trả (RETURNED) đối với sổ cọc đã chi hoàn (REFUNDED / PARTIALLY_REFUNDED) có số tiền hoàn > 0.',
        });
      }

      const trimmedRef = reference_code ? String(reference_code).trim() : null;
      const nowIso = new Date().toISOString();

      await client.query(
        `INSERT INTO deposit_transaction (
           deposit_id, type, amount, description, reference_code, status, method, approved_by, approved_at, created_by
         )
         VALUES ($1, 'refund_reversal', $2, $3, $4, 'APPROVED', $5, $6, NOW(), $6)`,
        [
          id,
          refundAmt,
          `Ngân hàng trả lại giao dịch hoàn cọc: ${trimmedReason}`,
          trimmedRef,
          dep.settlement?.refund_method || 'BANK_TRANSFER',
          req.user.sub,
        ]
      );

      const prevReturns = Array.isArray(dep.settlement?.return_history) ? dep.settlement.return_history : [];
      const updatedSettlement = {
        ...(dep.settlement || {}),
        returned_at: nowIso,
        returned_by: req.user.sub,
        return_reason: trimmedReason,
        return_reference_code: trimmedRef,
        return_history: [
          ...prevReturns,
          {
            at: nowIso,
            by: req.user.sub,
            amount: refundAmt,
            reason: trimmedReason,
            reference_code: trimmedRef,
          },
        ],
      };

      await client.query(
        `UPDATE deposit SET amount_held = $1, status = 'RETURNED', settlement = $2, updated_at = NOW() WHERE id = $3`,
        [refundAmt, JSON.stringify(updatedSettlement), id]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'DEPOSIT_PAYOUT_RETURNED', 'deposit', $2, $3)`,
        [
          req.user.sub,
          id,
          JSON.stringify({ status: 'RETURNED', amount_restored: refundAmt, reason: trimmedReason, reference_code: trimmedRef }),
        ]
      );

      await client.query(
        `SELECT fn_notify_deposit_event($1, 'RESIDENT', 'DEPOSIT_PAYOUT_RETURNED', $2, $3, $4::jsonb, NULL)`,
        [
          id,
          'Giao dịch hoàn tiền đặt cọc bị ngân hàng trả lại',
          `Giao dịch chuyển khoản hoàn tiền cọc căn ${dep.apartment_code} (${refundAmt.toLocaleString('vi-VN')} ₫) bị ngân hàng trả lại với lý do: "${trimmedReason}". Vui lòng kiểm tra và cập nhật lại thông tin tài khoản thụ hưởng.`,
          JSON.stringify({
            deposit_id: id,
            contract_id: dep.contract_id,
            status: 'RETURNED',
            reason: trimmedReason,
            refund_amount: refundAmt,
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Đã ghi nhận giao dịch hoàn cọc bị trả lại (RETURNED) và khôi phục số dư chờ phát hành lại lệnh chi.',
        data: { id, status: 'RETURNED', amount_held: String(refundAmt), settlement: updatedSettlement },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[Deposit Payout Returned Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi ghi nhận giao dịch hoàn cọc bị trả lại.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/deposits/:id/bank-info
 * Cập nhật thông tin tài khoản ngân hàng nhận hoàn cọc khi ở trạng thái APPROVED_PENDING_PAYOUT hoặc RETURNED
 */
router.patch(
  '/:id/bank-info',
  authenticateToken,
  requireRole(['MANAGER', 'RESIDENT']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { bank_name, bank_code, bank_bin, account_number, account_holder } = req.body || {};

    const { client, release } = await getUserClient(req);
    try {
      const meta = await getDepositAccessMeta(client, id);
      if (!meta) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy sổ cọc.' });
      }

      const roleCodes = getUserRoleCodes(req);
      let isBuildingManager = false;
      let isPrimaryResident = false;

      if (roleCodes.includes('MANAGER')) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
        if (mgrIds.includes(meta.building_id)) {
          isBuildingManager = true;
        }
      }
      if (roleCodes.includes('RESIDENT') && meta.is_primary_resident) {
        isPrimaryResident = true;
      }

      if (!isBuildingManager && !isPrimaryResident) {
        await logAccessDenied(req, 'deposit', id, 'Unauthorized bank-info update attempt');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Chỉ Quản lý tòa nhà hoặc cư dân đứng tên chính trên hợp đồng mới được cập nhật tài khoản nhận hoàn cọc.',
        });
      }

      const vBank = validateRefundBankInfo({
        refundAmount: 1,
        refundMethod: 'BANK_TRANSFER',
        bankInfo: { bank_name, bank_code, bank_bin, account_number, account_holder },
      });
      if (!vBank.ok) {
        return res.status(422).json({ code: vBank.code, message: vBank.message });
      }

      await client.query('BEGIN');
      const rpcRes = await client.query('SELECT * FROM fn_update_deposit_refund_bank_info($1, $2::jsonb)', [
        id,
        JSON.stringify(vBank.normalizedBankInfo),
      ]);
      const updated = rpcRes.rows[0];

      if (isPrimaryResident && !isBuildingManager) {
        await client.query(
          `SELECT fn_notify_deposit_event($1, 'BUILDING_MANAGERS', 'DEPOSIT_BANK_INFO_UPDATED', $2, $3, $4::jsonb, NULL)`,
          [
            id,
            'Cư dân đã cập nhật tài khoản nhận hoàn cọc',
            `Cư dân đã cập nhật thông tin tài khoản thụ hưởng mới (${vBank.normalizedBankInfo.bank_name} — ${vBank.normalizedBankInfo.account_number}). Vui lòng kiểm tra và thực hiện phát hành lệnh chi hoàn cọc.`,
            JSON.stringify({
              deposit_id: id,
              contract_id: meta.contract_id,
              bank_info: vBank.normalizedBankInfo,
              link: '/admin/deposits',
            }),
          ]
        );
      }

      await client.query('COMMIT');
      res.json({
        message: 'Đã cập nhật thông tin tài khoản nhận hoàn cọc thành công.',
        data: {
          id: updated.id,
          status: updated.status,
          amount_held: updated.amount_held,
          settlement: updated.settlement,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const msg = String(err?.message || '');
      if (msg.includes('INVALID_STATUS_FOR_BANK_UPDATE')) {
        return res.status(409).json({
          code: 'INVALID_STATUS_FOR_BANK_UPDATE',
          message:
            'Chỉ có thể cập nhật tài khoản ngân hàng khi sổ cọc ở trạng thái APPROVED_PENDING_PAYOUT hoặc RETURNED có số tiền hoàn > 0.',
        });
      }
      if (msg.includes('ACCESS_DENIED')) {
        await logAccessDenied(req, 'deposit', id, 'fn_update_deposit_refund_bank_info rejected caller');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền cập nhật tài khoản nhận hoàn cọc cho sổ cọc này.',
        });
      }
      console.error('[Deposit Bank Info Update Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật tài khoản ngân hàng nhận hoàn cọc.' });
    } finally {
      await release();
    }
  }
);

export default router;
