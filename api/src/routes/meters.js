import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { saveBase64Image } from '../services/imageUpload.js';
import {
  scopedBuildingFilter,
  checkBuildingAccess,
} from '../services/ownerScope.js';

const router = express.Router();

const PERIOD_RE = /^\d{4}-\d{2}$/;

/**
 * GET /api/v1/meters
 * Danh sách đồng hồ điện / nước theo tòa nhà & căn hộ, kèm chỉ số kỳ đang chọn hoặc kỳ mới nhất (M08)
 */
router.get(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'STAFF', 'ACCOUNTANT']),
  async (req, res) => {
    const { building_id, meter_type, period, search } = req.query;
    const orgId = req.user.org_id;
    const targetPeriod = period && PERIOD_RE.test(period) ? period : new Date().toISOString().slice(0, 7);

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'meter');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem đồng hồ tòa nhà này.' });
        }
      }

      const params = [orgId, targetPeriod];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'm.building_id', params);

      let sql = `
        SELECT m.*,
               a.code AS apartment_code,
               a.status AS apartment_status,
               b.name AS building_name,
               b.code AS building_code,
               f.name AS floor_name,
               mr_cur.id AS period_reading_id,
               mr_cur.period AS current_period,
               mr_cur.previous_reading AS period_previous_reading,
               mr_cur.current_reading AS period_current_reading,
               mr_cur.consumption AS period_consumption,
               mr_cur.is_abnormal AS period_is_abnormal,
               mr_cur.abnormal_note AS period_abnormal_note,
               mr_cur.image_url AS period_image_url,
               mr_prev.current_reading AS last_known_reading,
               mr_prev.consumption AS last_known_consumption,
               mr_prev.period AS last_known_period
        FROM meter m
        JOIN apartment a ON a.id = m.apartment_id
        JOIN building b ON b.id = m.building_id
        LEFT JOIN floor f ON f.id = a.floor_id
        LEFT JOIN meter_reading mr_cur
          ON mr_cur.meter_id = m.id AND mr_cur.period = $2
        LEFT JOIN LATERAL (
          SELECT current_reading, consumption, period
          FROM meter_reading
          WHERE meter_id = m.id AND period < $2
          ORDER BY period DESC
          LIMIT 1
        ) mr_prev ON TRUE
        WHERE m.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND m.building_id = $${params.length}`;
      }
      if (meter_type) {
        params.push(meter_type);
        sql += ` AND m.meter_type = $${params.length}`;
      }
      if (search && search.trim()) {
        params.push(`%${search.trim()}%`);
        const idx = params.length;
        sql += ` AND (m.meter_code ILIKE $${idx} OR a.code ILIKE $${idx})`;
      }

      sql += ` ORDER BY b.code ASC, a.code ASC, m.meter_type ASC`;

      const result = await pool.query(sql, params);
      res.json({ data: result.rows, period: targetPeriod });
    } catch (err) {
      console.error('[Meters List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách đồng hồ điện/nước.' });
    }
  }
);

/**
 * POST /api/v1/meters
 * Khởi tạo đồng hồ điện/nước cho căn hộ (FR-030)
 */
router.post(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER', 'STAFF']),
  async (req, res) => {
    const { apartment_id, meter_type, meter_code, unit_price, initial_reading = 0 } = req.body;
    const orgId = req.user.org_id;

    if (!apartment_id || !['ELECTRICITY', 'WATER'].includes(meter_type)) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Căn hộ và loại đồng hồ (ELECTRICITY / WATER) là bắt buộc.',
      });
    }

    try {
      const aptRes = await adminPool.query(
        `SELECT a.id, a.code, a.building_id, b.code AS building_code
         FROM apartment a
         JOIN building b ON b.id = a.building_id
         WHERE a.id = $1 AND b.org_id = $2`,
        [apartment_id, orgId]
      );
      if (aptRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
      }
      const apt = aptRes.rows[0];
      const ok = await checkBuildingAccess(req, apt.building_id, 'meter');
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }

      const defaultCode = `${meter_type === 'ELECTRICITY' ? 'EL' : 'WT'}-${apt.building_code}-${apt.code}`;
      const defaultUnit = meter_type === 'ELECTRICITY' ? 'kWh' : 'm³';
      const defaultPrice = meter_type === 'ELECTRICITY' ? 3800 : 22000;

      const ins = await pool.query(
        `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          orgId,
          apt.building_id,
          apartment_id,
          meter_type,
          meter_code?.trim() || defaultCode,
          defaultUnit,
          unit_price !== undefined ? Number(unit_price) : defaultPrice,
          Number(initial_reading) || 0,
        ]
      );

      res.status(201).json({ message: 'Tạo đồng hồ thành công.', data: ins.rows[0] });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({
          code: 'DUPLICATE_METER',
          message: 'Căn hộ đã có đồng hồ loại này hoặc mã đồng hồ bị trùng.',
        });
      }
      console.error('[Create Meter Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo đồng hồ.' });
    }
  }
);

/**
 * GET /api/v1/meters/readings
 * Lịch sử ghi chỉ số lọc theo tòa, kỳ, loại, bất thường (>30%)
 */
router.get(
  '/readings',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'STAFF', 'ACCOUNTANT']),
  async (req, res) => {
    const { building_id, period, meter_type, abnormal_only } = req.query;
    const orgId = req.user.org_id;

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'meter_reading');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền truy cập tòa nhà này.' });
        }
      }

      const params = [orgId];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'mr.building_id', params);

      let sql = `
        SELECT mr.*,
               m.meter_type,
               m.meter_code,
               m.unit,
               m.unit_price,
               a.code AS apartment_code,
               b.name AS building_name,
               b.code AS building_code,
               p.full_name AS recorded_by_name
        FROM meter_reading mr
        JOIN meter m ON m.id = mr.meter_id
        JOIN apartment a ON a.id = mr.apartment_id
        JOIN building b ON b.id = mr.building_id
        LEFT JOIN app_user au ON au.id = mr.recorded_by
        LEFT JOIN person p ON p.id = au.person_id
        WHERE mr.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND mr.building_id = $${params.length}`;
      }
      if (period) {
        params.push(period);
        sql += ` AND mr.period = $${params.length}`;
      }
      if (meter_type) {
        params.push(meter_type);
        sql += ` AND m.meter_type = $${params.length}`;
      }
      if (abnormal_only === 'true') {
        sql += ` AND mr.is_abnormal = TRUE`;
      }

      sql += ` ORDER BY mr.period DESC, b.code ASC, a.code ASC`;
      const result = await pool.query(sql, params);
      res.json({ data: result.rows });
    } catch (err) {
      console.error('[Meter Readings List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách chỉ số.' });
    }
  }
);

/**
 * Helper ghi nhận 1 chỉ số đồng hồ + tự động cảnh báo bất thường > 30% (FR-031)
 */
async function upsertSingleReading(client, req, meterId, { period, current_reading, abnormal_note, image_base64, image_url }) {
  if (!period || !PERIOD_RE.test(period)) {
    throw Object.assign(new Error('Kỳ chốt chỉ số phải theo định dạng YYYY-MM.'), { status: 400, code: 'INVALID_PERIOD' });
  }

  const meterRes = await adminPool.query(
    'SELECT * FROM meter WHERE id = $1 AND org_id = $2',
    [meterId, req.user.org_id]
  );
  if (meterRes.rows.length === 0) {
    throw Object.assign(new Error('Không tìm thấy đồng hồ.'), { status: 404, code: 'NOT_FOUND' });
  }
  const meter = meterRes.rows[0];
  const ok = await checkBuildingAccess(req, meter.building_id, 'meter_reading', meterId);
  if (!ok) {
    throw Object.assign(new Error('Bạn không có quyền ghi chỉ số tòa nhà này.'), { status: 403, code: 'ACCESS_DENIED' });
  }

  const prevRes = await client.query(
    `SELECT current_reading, consumption
     FROM meter_reading
     WHERE meter_id = $1 AND period < $2
     ORDER BY period DESC
     LIMIT 1`,
    [meterId, period]
  );

  const previousReading = prevRes.rows.length > 0
    ? Number(prevRes.rows[0].current_reading)
    : Number(meter.initial_reading || 0);
  const currentVal = Number(current_reading);

  if (Number.isNaN(currentVal) || currentVal < previousReading) {
    throw Object.assign(
      new Error(`Chỉ số mới (${currentVal}) không được nhỏ hơn chỉ số kỳ trước (${previousReading}).`),
      { status: 400, code: 'INVALID_READING' }
    );
  }

  const consumption = Number((currentVal - previousReading).toFixed(2));
  let isAbnormal = false;
  let computedNote = abnormal_note?.trim() || null;

  if (prevRes.rows.length > 0 && Number(prevRes.rows[0].consumption) > 0) {
    const prevCons = Number(prevRes.rows[0].consumption);
    const diffRatio = Math.abs(consumption - prevCons) / prevCons;
    if (diffRatio > 0.3) {
      isAbnormal = true;
      const pct = Math.round(diffRatio * 100);
      if (!computedNote) {
        computedNote = `Sản lượng biến động ${consumption > prevCons ? '+' : '-'}${pct}% so với kỳ trước (${prevCons} ${meter.unit})`;
      }
    }
  }

  const upserted = await client.query(
    `INSERT INTO meter_reading (
       org_id, building_id, meter_id, apartment_id, period,
       previous_reading, current_reading, consumption, is_abnormal, abnormal_note, image_url, recorded_by, recorded_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
     ON CONFLICT (meter_id, period) DO UPDATE
       SET previous_reading = EXCLUDED.previous_reading,
           current_reading = EXCLUDED.current_reading,
           consumption = EXCLUDED.consumption,
           is_abnormal = EXCLUDED.is_abnormal,
           abnormal_note = COALESCE(EXCLUDED.abnormal_note, meter_reading.abnormal_note),
           image_url = COALESCE(EXCLUDED.image_url, meter_reading.image_url),
           recorded_by = EXCLUDED.recorded_by,
           recorded_at = NOW()
     RETURNING *`,
    [
      meter.org_id,
      meter.building_id,
      meter.id,
      meter.apartment_id,
      period,
      previousReading,
      currentVal,
      consumption,
      isAbnormal,
      computedNote,
      image_url || null,
      req.user.sub,
    ]
  );

  let row = upserted.rows[0];
  if (image_base64 && typeof image_base64 === 'string' && image_base64.startsWith('data:image/')) {
    const uploaded = await saveBase64Image({
      imageBase64: image_base64,
      folder: 'meters',
      entityId: row.id,
      entity: 'meter_reading',
      ownerId: row.id,
      req,
      query: (t, p) => client.query(t, p),
    });
    if (!uploaded.error && uploaded.attachment) {
      const viewUrl = `/api/v1/attachments/${uploaded.attachment.id}/view`;
      const imgUpdate = await client.query(
        'UPDATE meter_reading SET image_url = $1 WHERE id = $2 RETURNING *',
        [viewUrl, row.id]
      );
      row = imgUpdate.rows[0];
    }
  }

  return row;
}

/**
 * POST /api/v1/meters/readings/batch
 * Ghi chỉ số nhanh hàng loạt theo kỳ
 */
router.post(
  '/readings/batch',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER', 'STAFF']),
  async (req, res) => {
    const { period, readings } = req.body;
    if (!Array.isArray(readings) || readings.length === 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Danh sách chỉ số trống.' });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const saved = [];
      for (const item of readings) {
        if (item.current_reading === undefined || item.current_reading === '' || item.current_reading === null) continue;
        const row = await upsertSingleReading(client, req, item.meter_id, {
          period: item.period || period,
          current_reading: item.current_reading,
          abnormal_note: item.abnormal_note,
          image_base64: item.image_base64,
        });
        saved.push(row);
      }
      await client.query('COMMIT');
      const abnormalCount = saved.filter((r) => r.is_abnormal).length;
      res.status(201).json({
        message: `Đã lưu ${saved.length} chỉ số${abnormalCount > 0 ? ` (${abnormalCount} chỉ số bất thường >30%)` : ''}.`,
        data: saved,
        abnormal_count: abnormalCount,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Batch Meter Reading Error]:', err);
      res.status(err.status || 500).json({
        code: err.code || 'DB_ERROR',
        message: err.message || 'Lỗi khi ghi chỉ số hàng loạt.',
      });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/meters/:id/readings
 * Lịch sử chỉ số của 1 đồng hồ
 */
router.get(
  '/:id/readings',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER', 'STAFF', 'ACCOUNTANT']),
  async (req, res) => {
    const { id } = req.params;
    try {
      const mRes = await adminPool.query(
        'SELECT id, building_id FROM meter WHERE id = $1 AND org_id = $2',
        [id, req.user.org_id]
      );
      if (mRes.rows.length === 0) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đồng hồ.' });
      }
      const ok = await checkBuildingAccess(req, mRes.rows[0].building_id, 'meter', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền truy cập đồng hồ này.' });
      }

      const rows = await pool.query(
        `SELECT mr.*, p.full_name AS recorded_by_name
         FROM meter_reading mr
         LEFT JOIN app_user au ON au.id = mr.recorded_by
         LEFT JOIN person p ON p.id = au.person_id
         WHERE mr.meter_id = $1
         ORDER BY mr.period DESC`,
        [id]
      );
      res.json({ data: rows.rows });
    } catch (err) {
      console.error('[Single Meter Readings Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải lịch sử đồng hồ.' });
    }
  }
);

/**
 * POST /api/v1/meters/:id/readings
 * Ghi chỉ số cho 1 đồng hồ kèm ảnh chụp đồng hồ (FR-030, FR-031)
 */
router.post(
  '/:id/readings',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'MANAGER', 'STAFF']),
  async (req, res) => {
    const { id } = req.params;
    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const row = await upsertSingleReading(client, req, id, req.body);
      await client.query('COMMIT');
      res.status(201).json({
        message: row.is_abnormal
          ? 'Đã ghi chỉ số (Cảnh báo: sản lượng biến động >30% so với kỳ trước).'
          : 'Ghi chỉ số đồng hồ thành công.',
        data: row,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Create Meter Reading Error]:', err);
      res.status(err.status || 500).json({
        code: err.code || 'DB_ERROR',
        message: err.message || 'Lỗi khi ghi chỉ số đồng hồ.',
      });
    } finally {
      await release();
    }
  }
);

export default router;

