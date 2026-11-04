import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import {
  scopedBuildingFilter,
  checkBuildingAccess,
  logAccessDenied,
  getAccessibleBuildingIds,
} from '../services/ownerScope.js';
import { roundVND } from '../services/pricing.js';
import { validateAndNormalizeSubscriptionMeta } from '../services/serviceSubscriptionMeta.js';
import {
  resolveServiceUnitPrice,
  computeSubscriptionPeriodCharge,
  normalizeSubscriptionStatusInput,
  todayVietnamYmd,
  addDaysYmd,
  toDateOnlyYmd,
} from '../services/serviceBilling.js';
import { syncSubscriptionTerminationInvoicesInTx } from '../services/invoiceLifecycle.js';
import { notifyUser } from '../services/notificationService.js';

export const serviceCatalogRouter = express.Router();
export const serviceSubscriptionsRouter = express.Router();
const router = express.Router();

const VALID_CATEGORIES = ['ELECTRICITY', 'WATER', 'INTERNET', 'PARKING', 'CLEANING', 'MANAGEMENT', 'UTILITY', 'OTHER'];
const VALID_BILLING_TYPES = ['FIXED', 'METERED', 'QUANTITY'];

/**
 * GET /api/v1/service-catalog (hoặc /api/v1/services/catalog)
 */
serviceCatalogRouter.get('/', authenticateToken, async (req, res) => {
  const { active_only } = req.query;
  try {
    const params = [req.user.org_id];
    let sql = `
      SELECT sc.*,
             (SELECT COUNT(*)::int FROM service_subscription ss WHERE ss.service_id = sc.id AND ss.status = 'ACTIVE') AS active_subscriptions_count
      FROM service_catalog sc
      WHERE sc.org_id = $1
    `;
    if (active_only === 'true') {
      sql += ` AND sc.is_active = TRUE`;
    }
    sql += ` ORDER BY sc.is_active DESC, sc.category ASC, sc.name ASC`;
    const result = await pool.query(sql, params);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[ServiceCatalog List Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh mục dịch vụ.' });
  }
});

/**
 * POST /api/v1/service-catalog (PRD 6.2 - MANAGER only)
 */
serviceCatalogRouter.post(
  '/',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { code, name, category = 'UTILITY', billing_type = 'FIXED', unit = 'tháng', unit_price = 0, description, building_id } = req.body;
    const orgId = req.user.org_id;

    if (!code?.trim() || !name?.trim()) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mã dịch vụ và tên dịch vụ là bắt buộc.' });
    }
    if (!VALID_CATEGORIES.includes(category) || !VALID_BILLING_TYPES.includes(billing_type)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Phân loại hoặc hình thức tính phí không hợp lệ.' });
    }
    if (Number(unit_price) < 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Đơn giá không được âm.' });
    }

    if (building_id) {
      const ok = await checkBuildingAccess(req, building_id, 'service_catalog');
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }
    }

    const { client, release } = await getUserClient(req);
    try {
      const ins = await client.query(
        `INSERT INTO service_catalog (org_id, building_id, code, name, category, billing_type, unit, unit_price, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          orgId,
          building_id || null,
          code.trim().toUpperCase(),
          name.trim(),
          category,
          billing_type,
          unit.trim(),
          Math.round(Number(unit_price)),
          description?.trim() || null,
        ]
      );
      const row = ins.rows[0];

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'CREATE_SERVICE_CATALOG', 'service_catalog', $2, $3)`,
        [req.user.sub, row.id, JSON.stringify(row)]
      );

      res.status(201).json({ message: 'Tạo dịch vụ thành công.', data: row });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ code: 'DUPLICATE_CODE', message: 'Mã dịch vụ đã tồn tại trong tổ chức.' });
      }
      console.error('[Create ServiceCatalog Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo dịch vụ.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/service-catalog/:id (PRD 6.2 - MANAGER only, FR-070 multi-building guard)
 */
serviceCatalogRouter.patch(
  '/:id',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { name, category, billing_type, unit, unit_price, description, is_active } = req.body;

    const { client, release } = await getUserClient(req);
    try {
      // 1. Resource scope check (distinguish 404 vs 403 per AC-019.1)
      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('service_catalog', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy dịch vụ.' });
      }
      const scope = scopeRes.rows[0];

      // 2. Building access & FR-070 org-default guard
      if (scope.building_id) {
        const ok = await checkBuildingAccess(req, scope.building_id, 'service_catalog', id);
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
        }
      } else {
        // FR-070: Org-default catalog row (building_id IS NULL)
        const accessibleIds = await getAccessibleBuildingIds(req);
        if (accessibleIds !== null) {
          const curCat = await client.query('SELECT code FROM service_catalog WHERE id = $1', [id]);
          const catCode = curCat.rows[0]?.code;
          const sharedCheck = await adminPool.query(
            `SELECT ss.id, ss.building_id
             FROM service_subscription ss
             JOIN building b ON b.id = ss.building_id
             WHERE ss.service_id = $1
               AND b.org_id = $2
               AND ss.status IN ('ACTIVE', 'PENDING_APPROVAL', 'CANCELLATION_PENDING')
               AND NOT (ss.building_id = ANY($3::uuid[]))
               AND NOT EXISTS (
                 SELECT 1 FROM service_catalog sc_ov
                 WHERE sc_ov.org_id = ss.org_id
                   AND sc_ov.building_id = ss.building_id
                   AND UPPER(sc_ov.code) = UPPER($4)
                   AND sc_ov.is_active = TRUE
               )
             LIMIT 1`,
            [id, req.user.org_id, accessibleIds, catCode]
          );
          if (sharedCheck.rows.length > 0) {
            await logAccessDenied(
              req,
              'service_catalog',
              id,
              'Cannot modify org-default service catalog shared across unassigned buildings'
            );
            return res.status(403).json({
              code: 'ORG_DEFAULT_SHARED_ACROSS_BUILDINGS',
              message: 'Không thể chỉnh sửa dịch vụ mặc định tổ chức khi đang được áp dụng tại tòa nhà khác ngoài phạm vi quản lý. Vui lòng tạo cấu hình riêng cho tòa nhà của bạn.',
            });
          }
        }
      }

      const cur = await client.query('SELECT * FROM service_catalog WHERE id = $1', [id]);
      if (cur.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy dịch vụ.' });
      }
      const b = cur.rows[0];

      const up = await client.query(
        `UPDATE service_catalog
         SET name = $1,
             category = $2,
             billing_type = $3,
             unit = $4,
             unit_price = $5,
             description = $6,
             is_active = $7,
             updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [
          name?.trim() || b.name,
          category || b.category,
          billing_type || b.billing_type,
          unit?.trim() || b.unit,
          unit_price !== undefined ? Math.round(Number(unit_price)) : b.unit_price,
          description !== undefined ? description : b.description,
          is_active !== undefined ? Boolean(is_active) : b.is_active,
          id,
        ]
      );
      const updatedRow = up.rows[0];

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'UPDATE_SERVICE_CATALOG', 'service_catalog', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(b), JSON.stringify(updatedRow)]
      );

      res.json({ message: 'Cập nhật dịch vụ thành công.', data: updatedRow });
    } catch (err) {
      console.error('[Update ServiceCatalog Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật dịch vụ.' });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/service-subscriptions (hoặc /api/v1/services/subscriptions)
 */
serviceSubscriptionsRouter.get(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id, status } = req.query;
    const orgId = req.user.org_id;

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'service_subscription');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem đăng ký dịch vụ của tòa nhà này.' });
        }
      }

      const params = [orgId];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'ss.building_id', params);

      let sql = `
        SELECT ss.*,
               sc.code AS service_code,
               sc.name AS service_name,
               sc.category AS service_category,
               sc.billing_type,
               sc.unit,
               a.code AS apartment_code,
               b.name AS building_name,
               b.code AS building_code,
               p.full_name AS tenant_name,
               p.phone AS tenant_phone
        FROM service_subscription ss
        JOIN service_catalog sc ON sc.id = ss.service_id
        JOIN apartment a ON a.id = ss.apartment_id
        JOIN building b ON b.id = ss.building_id
        LEFT JOIN contract c ON c.id = ss.contract_id
        LEFT JOIN tenant t ON t.id = c.primary_tenant_id
        LEFT JOIN person p ON p.id = t.person_id
        WHERE ss.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND ss.building_id = $${params.length}`;
      }
      if (status) {
        params.push(status);
        sql += ` AND ss.status = ANY(string_to_array($${params.length}, ','))`;
      }

      sql += ` ORDER BY
        CASE ss.status WHEN 'PENDING_APPROVAL' THEN 1 WHEN 'CANCELLATION_PENDING' THEN 2 WHEN 'ACTIVE' THEN 3 ELSE 4 END ASC,
        ss.created_at DESC`;

      const result = await pool.query(sql, params);
      res.json({ data: result.rows });
    } catch (err) {
      console.error('[ServiceSubscriptions List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách đăng ký dịch vụ.' });
    }
  }
);

/**
 * POST /api/v1/service-subscriptions
 * BQL gán trực tiếp dịch vụ cho căn hộ / hợp đồng (FR-027, FR-065, PRD 6.2 - MANAGER only)
 */
serviceSubscriptionsRouter.post(
  '/',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { contract_id, apartment_id, service_id, quantity = 1, start_date, note, vehicle_plates, is_price_locked, unit_price } = req.body;
    const orgId = req.user.org_id;

    if (!service_id || (!contract_id && !apartment_id)) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Vui lòng chọn dịch vụ và căn hộ/hợp đồng.',
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      const svcRes = await client.query(
        'SELECT * FROM service_catalog WHERE id = $1 AND org_id = $2 AND is_active = TRUE',
        [service_id, orgId]
      );
      if (svcRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy dịch vụ đang hoạt động.' });
      }
      const svc = svcRes.rows[0];
      const meta = validateAndNormalizeSubscriptionMeta({
        category: svc.category,
        billingType: svc.billing_type,
        quantity,
        vehiclePlates: vehicle_plates,
        note,
      });

      let targetBuildingId = null;
      let targetApartmentId = apartment_id || null;
      let targetContractId = contract_id || null;

      if (targetContractId) {
        const cRes = await client.query(
          `SELECT c.id, c.apartment_id, c.building_id
           FROM contract c JOIN building b ON b.id = c.building_id
           WHERE c.id = $1 AND b.org_id = $2`,
          [targetContractId, orgId]
        );
        if (cRes.rows.length === 0) {
          return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy hợp đồng.' });
        }
        targetApartmentId = cRes.rows[0].apartment_id;
        targetBuildingId = cRes.rows[0].building_id;
      } else {
        const aRes = await client.query(
          `SELECT a.id, a.building_id,
                  (SELECT id FROM contract WHERE apartment_id = a.id AND status = 'ACTIVE' LIMIT 1) AS active_contract_id
           FROM apartment a JOIN building b ON b.id = a.building_id
           WHERE a.id = $1 AND b.org_id = $2`,
          [targetApartmentId, orgId]
        );
        if (aRes.rows.length === 0) {
          return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
        }
        targetBuildingId = aRes.rows[0].building_id;
        targetContractId = aRes.rows[0].active_contract_id;
      }

      const ok = await checkBuildingAccess(req, targetBuildingId, 'service_subscription');
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }

      const effDate = start_date || todayVietnamYmd();
      const isPriceLocked = Boolean(is_price_locked) === true;

      // 3-tier FR-065 pricing resolution
      let contractServicePrices = [];
      if (targetContractId) {
        const cspRes = await client.query(
          'SELECT * FROM contract_service_price WHERE contract_id = $1',
          [targetContractId]
        );
        contractServicePrices = cspRes.rows;
      }
      const catRes = await client.query(
        'SELECT * FROM service_catalog WHERE org_id = $1 AND is_active = TRUE',
        [orgId]
      );
      const priceResult = resolveServiceUnitPrice({
        subscription: {
          service_code: svc.code,
          service_category: svc.category,
          unit_price: unit_price !== undefined ? Number(unit_price) : svc.unit_price,
          is_price_locked: isPriceLocked,
        },
        contractBuildingId: targetBuildingId,
        periodEndYmd: effDate,
        contractServicePrices,
        catalogItems: catRes.rows,
      });

      const finalUnitPrice = (unit_price !== undefined && isPriceLocked)
        ? Math.round(Number(unit_price))
        : priceResult.unitPrice;

      const effStartYmd = toDateOnlyYmd(effDate) || todayVietnamYmd();
      const prorata = computeSubscriptionPeriodCharge({
        subscription: {
          service_code: svc.code,
          service_category: svc.category,
          service_name: svc.name,
          billing_type: svc.billing_type,
          quantity: meta.quantity,
          unit_price: finalUnitPrice,
          is_price_locked: isPriceLocked,
          start_date: effStartYmd,
          status: 'ACTIVE',
        },
        periodYm: effStartYmd.slice(0, 7),
        contractBuildingId: targetBuildingId,
        contractServicePrices,
        catalogItems: catRes.rows,
      }).amount;

      const ins = await client.query(
        `INSERT INTO service_subscription (
           org_id, building_id, apartment_id, contract_id, service_id,
           quantity, unit_price, is_price_locked, start_date, prorata_amount, status, note, vehicle_plates, requested_by, approved_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'ACTIVE', $11, $12, $13, $13)
         RETURNING *`,
        [
          orgId,
          targetBuildingId,
          targetApartmentId,
          targetContractId,
          service_id,
          meta.quantity,
          finalUnitPrice,
          isPriceLocked,
          effDate,
          prorata,
          meta.note,
          meta.vehiclePlates,
          req.user.sub,
        ]
      );
      const newSub = ins.rows[0];

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'CREATE_SERVICE_SUBSCRIPTION', 'service_subscription', $2, $3)`,
        [req.user.sub, newSub.id, JSON.stringify(newSub)]
      );

      res.status(201).json({ message: 'Đăng ký dịch vụ thành công.', data: newSub });
    } catch (err) {
      if (err.httpStatus) {
        return res.status(err.httpStatus).json({ code: err.code, message: err.message });
      }
      console.error('[Create Subscription Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi đăng ký dịch vụ.' });
    } finally {
      await release();
    }
  }
);

/**
 * PATCH /api/v1/service-subscriptions/:id
 * Duyệt / từ chối đăng ký hoặc xác nhận hủy dịch vụ (FR-028, FR-029, PRD 6.2 - MANAGER only)
 */
serviceSubscriptionsRouter.patch(
  '/:id',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { status, quantity, note, end_date, vehicle_plates, zero_usage } = req.body;
    const orgId = req.user.org_id;

    const { client, release } = await getUserClient(req);
    try {
      // 1. Resource scope check
      const scopeRes = await client.query(
        `SELECT * FROM fn_get_finance_resource_scope('service_subscription', $1)`,
        [id]
      );
      if (scopeRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đăng ký dịch vụ.' });
      }
      const scope = scopeRes.rows[0];

      const ok = await checkBuildingAccess(req, scope.building_id, 'service_subscription', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }

      await client.query('BEGIN');

      const curRes = await client.query(
        `SELECT ss.*, sc.name AS service_name, sc.code AS service_code, sc.category AS service_category, sc.billing_type
         FROM service_subscription ss
         JOIN service_catalog sc ON sc.id = ss.service_id
         WHERE ss.id = $1 AND ss.org_id = $2
         FOR UPDATE OF ss`,
        [id, orgId]
      );
      if (curRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đăng ký dịch vụ.' });
      }
      const sub = curRes.rows[0];

      // Block mutating already TERMINATED or REJECTED subscriptions (409 INVALID_STATUS)
      if (sub.status === 'TERMINATED' || sub.status === 'REJECTED') {
        await client.query('ROLLBACK');
        return res.status(409).json({
          code: 'INVALID_STATUS',
          message: 'Không thể chỉnh sửa đăng ký dịch vụ đã kết thúc hoặc bị từ chối.',
        });
      }

      let nextQty = sub.quantity;
      let nextPlates = sub.vehicle_plates || [];
      let cleanNote = null;

      if (quantity !== undefined || vehicle_plates !== undefined) {
        const meta = validateAndNormalizeSubscriptionMeta({
          category: sub.service_category,
          billingType: sub.billing_type,
          quantity: quantity !== undefined ? quantity : sub.quantity,
          vehiclePlates: vehicle_plates !== undefined ? vehicle_plates : sub.vehicle_plates,
          note,
        });
        nextQty = meta.quantity;
        nextPlates = meta.vehiclePlates;
        cleanNote = note !== undefined ? meta.note : null;
      } else if (note !== undefined && note !== null) {
        const noteMeta = validateAndNormalizeSubscriptionMeta({
          category: 'OTHER',
          billingType: 'FIXED',
          quantity: 1,
          note,
        });
        cleanNote = noteMeta.note;
      }

      const normalizedStatusInput = status ? normalizeSubscriptionStatusInput(status) : null;
      let nextStatus = sub.status;
      let nextEnd = sub.end_date;
      let nextProrata = sub.prorata_amount;

      if (normalizedStatusInput) {
        if (sub.status === 'CANCELLATION_PENDING' && normalizedStatusInput === 'ACTIVE') {
          // Reject-cancel: revert to ACTIVE
          nextStatus = 'ACTIVE';
          nextEnd = null;
        } else if (normalizedStatusInput === 'TERMINATED') {
          nextStatus = 'TERMINATED';
          const subStartYmd = toDateOnlyYmd(sub.start_date);
          const reqEndYmd = end_date ? toDateOnlyYmd(end_date) : null;
          const todayVnYmd = todayVietnamYmd();
          const targetEnd = reqEndYmd || toDateOnlyYmd(sub.end_date) || todayVnYmd;

          if (Boolean(zero_usage) === true || (targetEnd && targetEnd < subStartYmd)) {
            // 0 VND pre-start cancellation or zero_usage
            nextEnd = addDaysYmd(subStartYmd, -1);
            nextProrata = 0;
          } else {
            nextEnd = targetEnd;
            const termCspRes = sub.contract_id
              ? await client.query('SELECT * FROM contract_service_price WHERE contract_id = $1', [sub.contract_id])
              : { rows: [] };
            const termCatRes = await client.query('SELECT * FROM service_catalog WHERE org_id = $1 AND is_active = TRUE', [orgId]);
            nextProrata = computeSubscriptionPeriodCharge({
              subscription: {
                ...sub,
                quantity: nextQty,
                end_date: nextEnd,
                status: 'TERMINATED',
                is_price_locked: sub.is_price_locked,
              },
              periodYm: nextEnd.slice(0, 7),
              contractBuildingId: sub.building_id,
              contractServicePrices: termCspRes.rows,
              catalogItems: termCatRes.rows,
            }).amount;
          }
        } else {
          nextStatus = normalizedStatusInput;
        }
      } else if (end_date !== undefined) {
        nextEnd = toDateOnlyYmd(end_date);
      }

      const up = await client.query(
        `UPDATE service_subscription
         SET status = $1,
             quantity = $2,
             end_date = $3,
             prorata_amount = $4,
             note = COALESCE($5, note),
             vehicle_plates = $6,
             is_price_locked = CASE WHEN $1 = 'TERMINATED' THEN TRUE ELSE is_price_locked END,
             approved_by = $7,
             updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [nextStatus, nextQty, nextEnd, nextProrata, cleanNote, nextPlates, req.user.sub, id]
      );
      const updatedSub = up.rows[0];

      // Synchronize invoices on newly TERMINATED subscription across 3 scenarios
      let invoiceSyncResult = null;
      if (nextStatus === 'TERMINATED' && sub.status !== 'TERMINATED') {
        const cRes = await client.query('SELECT * FROM contract WHERE id = $1', [sub.contract_id]);
        const contract = cRes.rows[0] || null;
        invoiceSyncResult = await syncSubscriptionTerminationInvoicesInTx(client, {
          subscription: updatedSub,
          contract,
          actorId: req.user.sub,
          reason: cleanNote || 'Chấm dứt gói đăng ký dịch vụ',
        });
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'UPDATE_SERVICE_SUBSCRIPTION', 'service_subscription', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(sub), JSON.stringify(updatedSub)]
      );

      await client.query('COMMIT');

      if (sub.requested_by && nextStatus !== sub.status) {
        const msgMap = {
          ACTIVE: `Đăng ký dịch vụ "${sub.service_name}" đã được phê duyệt.`,
          REJECTED: `Đăng ký dịch vụ "${sub.service_name}" bị từ chối.`,
          TERMINATED: `Dịch vụ "${sub.service_name}" đã được xác nhận hủy.`,
        };
        if (msgMap[nextStatus]) {
          const notifType = nextStatus === 'TERMINATED' ? 'SERVICE_TERMINATED' : 'SERVICE_UPDATE';
          try {
            await notifyUser(orgId, sub.requested_by, {
              title: 'Cập nhật dịch vụ tiện ích',
              content: msgMap[nextStatus],
              type: notifType,
              payload: {
                subscription_id: id,
                contract_id: updatedSub.contract_id,
                building_id: updatedSub.building_id,
                apartment_id: updatedSub.apartment_id,
                status: nextStatus,
              },
            });
          } catch (notifErr) {
            console.error('[Services] Failed to emit subscription notification:', notifErr.message);
          }
        }
      }

      res.json({
        message: 'Cập nhật đăng ký dịch vụ thành công.',
        data: updatedSub,
        invoice_sync: invoiceSyncResult,
      });
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {}
      if (err.httpStatus) {
        return res.status(err.httpStatus).json({ code: err.code, message: err.message });
      }
      console.error('[Update Subscription Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật đăng ký dịch vụ.' });
    } finally {
      await release();
    }
  }
);

router.use('/catalog', serviceCatalogRouter);
router.use('/subscriptions', serviceSubscriptionsRouter);

export default router;
