import express from 'express';
import { pool, adminPool } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import {
  scopedBuildingFilter,
  checkBuildingAccess,
} from '../services/ownerScope.js';
import { roundVND } from '../services/pricing.js';

export const serviceCatalogRouter = express.Router();
export const serviceSubscriptionsRouter = express.Router();
const router = express.Router();

const VALID_CATEGORIES = ['ELECTRICITY', 'WATER', 'INTERNET', 'PARKING', 'CLEANING', 'MANAGEMENT', 'UTILITY', 'OTHER'];
const VALID_BILLING_TYPES = ['FIXED', 'METERED', 'QUANTITY'];

function computeProrata(unitPrice, quantity, targetDateStr, mode = 'subscribe') {
  const dt = targetDateStr ? new Date(targetDateStr) : new Date();
  const year = dt.getFullYear();
  const month = dt.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const day = dt.getDate();
  const activeDays = mode === 'cancel' ? day : Math.max(1, daysInMonth - day + 1);
  return roundVND((Number(unitPrice || 0) * Number(quantity || 1) * activeDays) / daysInMonth);
}

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
 * POST /api/v1/service-catalog
 */
serviceCatalogRouter.post(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
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

    try {
      const ins = await pool.query(
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
      res.status(201).json({ message: 'Tạo dịch vụ thành công.', data: ins.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ code: 'DUPLICATE_CODE', message: 'Mã dịch vụ đã tồn tại trong tổ chức.' });
      }
      console.error('[Create ServiceCatalog Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo dịch vụ.' });
    }
  }
);

/**
 * PATCH /api/v1/service-catalog/:id
 */
serviceCatalogRouter.patch(
  '/:id',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;
    const { name, category, billing_type, unit, unit_price, description, is_active } = req.body;

    try {
      const cur = await pool.query('SELECT * FROM service_catalog WHERE id = $1 AND org_id = $2', [id, req.user.org_id]);
      if (cur.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy dịch vụ.' });
      }
      const b = cur.rows[0];

      const up = await pool.query(
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
      res.json({ message: 'Cập nhật dịch vụ thành công.', data: up.rows[0] });
    } catch (err) {
      console.error('[Update ServiceCatalog Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật dịch vụ.' });
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
 * BQL gán trực tiếp dịch vụ cho căn hộ / hợp đồng (FR-027)
 */
serviceSubscriptionsRouter.post(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  async (req, res) => {
    const { contract_id, apartment_id, service_id, quantity = 1, start_date, note } = req.body;
    const orgId = req.user.org_id;

    if (!service_id || (!contract_id && !apartment_id)) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Vui lòng chọn dịch vụ và căn hộ/hợp đồng.',
      });
    }

    try {
      const svcRes = await pool.query(
        'SELECT * FROM service_catalog WHERE id = $1 AND org_id = $2 AND is_active = TRUE',
        [service_id, orgId]
      );
      if (svcRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy dịch vụ đang hoạt động.' });
      }
      const svc = svcRes.rows[0];

      let targetBuildingId = null;
      let targetApartmentId = apartment_id || null;
      let targetContractId = contract_id || null;

      if (targetContractId) {
        const cRes = await adminPool.query(
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
        const aRes = await adminPool.query(
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

      const effDate = start_date || new Date().toISOString().slice(0, 10);
      const prorata = computeProrata(svc.unit_price, quantity, effDate, 'subscribe');

      const ins = await pool.query(
        `INSERT INTO service_subscription (
           org_id, building_id, apartment_id, contract_id, service_id,
           quantity, unit_price, start_date, prorata_amount, status, note, requested_by, approved_by
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE', $10, $11, $11)
         RETURNING *`,
        [
          orgId,
          targetBuildingId,
          targetApartmentId,
          targetContractId,
          service_id,
          Math.max(1, Number(quantity) || 1),
          svc.unit_price,
          effDate,
          prorata,
          note?.trim() || null,
          req.user.sub,
        ]
      );

      res.status(201).json({ message: 'Đăng ký dịch vụ thành công.', data: ins.rows[0] });
    } catch (err) {
      console.error('[Create Subscription Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi đăng ký dịch vụ.' });
    }
  }
);

/**
 * PATCH /api/v1/service-subscriptions/:id
 * Duyệt / từ chối đăng ký hoặc xác nhận hủy dịch vụ (FR-028, FR-029)
 */
serviceSubscriptionsRouter.patch(
  '/:id',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;
    const { status, quantity, note, end_date } = req.body;
    const orgId = req.user.org_id;

    try {
      const curRes = await adminPool.query(
        `SELECT ss.*, sc.name AS service_name
         FROM service_subscription ss
         JOIN service_catalog sc ON sc.id = ss.service_id
         WHERE ss.id = $1 AND ss.org_id = $2`,
        [id, orgId]
      );
      if (curRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đăng ký dịch vụ.' });
      }
      const sub = curRes.rows[0];
      const ok = await checkBuildingAccess(req, sub.building_id, 'service_subscription', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }

      const nextStatus = status || sub.status;
      const nextQty = quantity !== undefined ? Math.max(1, Number(quantity)) : sub.quantity;
      const nextEnd = end_date !== undefined ? end_date : (nextStatus === 'CANCELLED' ? new Date().toISOString().slice(0, 10) : sub.end_date);
      const nextProrata = nextStatus === 'CANCELLED'
        ? computeProrata(sub.unit_price, nextQty, nextEnd, 'cancel')
        : sub.prorata_amount;

      const up = await pool.query(
        `UPDATE service_subscription
         SET status = $1,
             quantity = $2,
             end_date = $3,
             prorata_amount = $4,
             note = COALESCE($5, note),
             approved_by = $6,
             updated_at = NOW()
         WHERE id = $7
         RETURNING *`,
        [nextStatus, nextQty, nextEnd, nextProrata, note, req.user.sub, id]
      );

      if (sub.requested_by && nextStatus !== sub.status) {
        const msgMap = {
          ACTIVE: `Đăng ký dịch vụ "${sub.service_name}" đã được phê duyệt.`,
          REJECTED: `Đăng ký dịch vụ "${sub.service_name}" bị từ chối.`,
          CANCELLED: `Dịch vụ "${sub.service_name}" đã được xác nhận hủy.`,
        };
        if (msgMap[nextStatus]) {
          await adminPool.query(
            `INSERT INTO notification (org_id, user_id, title, content, type, payload)
             VALUES ($1, $2, 'Cập nhật dịch vụ tiện ích', $3, 'SERVICE_UPDATE', $4)`,
            [orgId, sub.requested_by, msgMap[nextStatus], JSON.stringify({ subscription_id: id, status: nextStatus })]
          );
        }
      }

      res.json({ message: 'Cập nhật đăng ký dịch vụ thành công.', data: up.rows[0] });
    } catch (err) {
      console.error('[Update Subscription Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật đăng ký dịch vụ.' });
    }
  }
);

router.use('/catalog', serviceCatalogRouter);
router.use('/subscriptions', serviceSubscriptionsRouter);

export default router;

