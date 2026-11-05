import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { saveBase64Image } from '../services/imageUpload.js';
import { isTransitionAllowed, APARTMENT_TRANSITIONS, syncApartmentStatus } from '../services/apartmentStatus.js';
import { buildApartmentDrafts, findDuplicateCodes } from '../services/apartmentBulk.js';
import {
  getUserRoleCodes,
  getOwnerBuildingIds,
  getManagerBuildingIds,
  ownerBuildingFilter,
  managerBuildingFilter,
  logAccessDenied,
} from '../services/ownerScope.js';

const router = express.Router();

/**
 * GET /api/v1/apartments
 * - SYS_ADMIN: Xem toàn bộ căn hộ trong tổ chức (CRUD)
 * - OWNER: Xem căn hộ thuộc các tòa mình sở hữu (R)
 * - MANAGER: Xem căn hộ thuộc tòa được phân công quản lý (CRU)
 * - RESIDENT: Xem căn hộ của chính mình (R)
 * - AC-019.1: Truy cập building_id ngoài phạm vi trả 403 + ghi audit_log
 */
router.get('/', authenticateToken, async (req, res) => {
  const { building_id, status } = req.query;
  const orgId = req.user.org_id;
  const userRoleCodes = getUserRoleCodes(req);
  const isSysAdmin = userRoleCodes.includes('SYS_ADMIN');
  const isOwner = userRoleCodes.includes('OWNER');
  const isManager = userRoleCodes.includes('MANAGER');
  const isResident = userRoleCodes.includes('RESIDENT');

  try {
    // Kiểm tra quyền trên building_id truyền trực tiếp qua URL query (AC-019.1)
    if (building_id) {
      if (isOwner && !isSysAdmin) {
        const ownedIds = await getOwnerBuildingIds(req.user.sub, orgId);
        if (!ownedIds.includes(building_id)) {
          await logAccessDenied(req, 'building', building_id, 'OWNER queried apartments of unowned building');
          return res.status(403).json({
            code: 'ACCESS_DENIED',
            message: 'Bạn không sở hữu tòa nhà này.',
          });
        }
      } else if (isManager && !isSysAdmin) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
        if (!mgrIds.includes(building_id)) {
          await logAccessDenied(req, 'building', building_id, 'MANAGER queried apartments of unassigned building (AC-019.1)');
          return res.status(403).json({
            code: 'ACCESS_DENIED',
            message: 'Bạn không có quyền quản lý tòa nhà này.',
          });
        }
      }
    }

    let sql = `
      SELECT a.*,
             b.name as building_name, b.code as building_code,
             f.name as floor_name,
             z.name as zone_name, z.code as zone_code,
             (SELECT COUNT(*)::int FROM contract c
              WHERE c.apartment_id = a.id
                AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'PENDING_APPROVAL', 'DRAFT')
                AND c.end_date >= CURRENT_DATE) AS active_contracts_count,
             (SELECT COUNT(*)::int FROM reservation r
              WHERE r.apartment_id = a.id
                AND r.status = 'HELD'
                AND r.hold_until >= CURRENT_DATE) AS held_reservations_count
      FROM apartment a
      JOIN building b ON b.id = a.building_id
      LEFT JOIN floor f ON f.id = a.floor_id
      LEFT JOIN zone z ON z.id = a.zone_id
      WHERE b.org_id = $1
    `;
    const params = [orgId];

    if (isSysAdmin) {
      // SYS_ADMIN: Toàn bộ căn hộ thuộc org
    } else if (isOwner) {
      const { sql: ownerSql } = await ownerBuildingFilter('a.building_id', req.user.sub, orgId, params);
      sql += ownerSql;
    } else if (isManager) {
      const { sql: mgrSql } = await managerBuildingFilter('a.building_id', req.user.sub, orgId, params);
      sql += mgrSql;
    } else if (isResident) {
      params.push(req.user.person_id);
      const pIdx = params.length;
      sql += ` AND a.id IN (
        SELECT c.apartment_id FROM contract c
        JOIN tenant t ON t.id = c.primary_tenant_id
        WHERE t.person_id = $${pIdx}
        UNION
        SELECT c.apartment_id FROM contract c
        JOIN contract_occupant co ON co.contract_id = c.id
        JOIN tenant t_occ ON t_occ.id = co.tenant_id
        WHERE t_occ.person_id = $${pIdx}
      )`;
    } else {
      return res.json({ data: [] });
    }

    if (building_id) {
      params.push(building_id);
      sql += ` AND a.building_id = $${params.length}`;
    }

    if (status) {
      params.push(status);
      sql += ` AND a.status = ANY(string_to_array($${params.length}, ','))`;
    }

    sql += ` ORDER BY b.code ASC, a.code ASC`;

    const result = await pool.query(sql, params);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Apartments Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi lấy danh sách căn hộ.' });
  }
});

/**
 * GET /api/v1/apartments/:id
 * Chi tiết căn hộ kèm hợp đồng hiện tại, giữ chỗ, đồng hồ điện/nước và lịch sử yêu cầu kỹ thuật
 */
router.get('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id || ''))) {
    return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
  }
  const orgId = req.user.org_id;
  const roleCodes = getUserRoleCodes(req);
  const isSysAdmin = roleCodes.includes('SYS_ADMIN');
  const isOwner = roleCodes.includes('OWNER');
  const isManager = roleCodes.includes('MANAGER');
  const isResident = roleCodes.includes('RESIDENT');

  try {
    const existRes = await adminPool.query(
      `SELECT a.id, a.building_id
       FROM apartment a
       JOIN building b ON b.id = a.building_id
       WHERE a.id = $1 AND b.org_id = $2`,
      [id, orgId]
    );
    if (existRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }
    const { building_id: buildingId } = existRes.rows[0];

    if (!isSysAdmin) {
      if (isOwner) {
        const ownedIds = await getOwnerBuildingIds(req.user.sub, orgId);
        if (!ownedIds.includes(buildingId)) {
          await logAccessDenied(req, 'apartment', id, 'OWNER viewed apartment of unowned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không sở hữu tòa nhà của căn hộ này.' });
        }
      } else if (isManager) {
        const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
        if (!mgrIds.includes(buildingId)) {
          await logAccessDenied(req, 'apartment', id, 'MANAGER viewed apartment of unassigned building');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà của căn hộ này.' });
        }
      } else if (isResident) {
        const resCheck = await adminPool.query(
          `SELECT 1 FROM contract c
           JOIN tenant t ON t.id = c.primary_tenant_id
           WHERE c.apartment_id = $1 AND t.person_id = $2
           UNION ALL
           SELECT 1 FROM contract c
           JOIN contract_occupant co ON co.contract_id = c.id
           JOIN tenant t_occ ON t_occ.id = co.tenant_id
           WHERE c.apartment_id = $1 AND t_occ.person_id = $2
           LIMIT 1`,
          [id, req.user.person_id]
        );
        if (resCheck.rows.length === 0) {
          await logAccessDenied(req, 'apartment', id, 'RESIDENT viewed another apartment');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem căn hộ này.' });
        }
      }
    }

    const aptRes = await pool.query(
      `SELECT a.*,
              building_has_active_owner(a.building_id) AS building_has_active_owner,
              b.name AS building_name, b.code AS building_code, b.address AS building_address,
              f.name AS floor_name, f.level AS floor_level,
              z.name AS zone_name, z.code AS zone_code
       FROM apartment a
       JOIN building b ON b.id = a.building_id
       LEFT JOIN floor f ON f.id = a.floor_id
       LEFT JOIN zone z ON z.id = a.zone_id
       WHERE a.id = $1`,
      [id]
    );
    if (aptRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }
    const apartment = aptRes.rows[0];

    const [contractsRes, reservationsRes, metersRes, requestsRes, zonesRes] = await Promise.all([
      pool.query(
        `SELECT c.*, p.full_name AS tenant_name, p.phone AS tenant_phone
         FROM contract c
         LEFT JOIN tenant t ON t.id = c.primary_tenant_id
         LEFT JOIN person p ON p.id = t.person_id
         WHERE c.apartment_id = $1
         ORDER BY c.start_date ASC, c.created_at DESC
         LIMIT 50`,
        [id]
      ),
      pool.query(
        `SELECT r.*, COALESCE(r.hold_from, r.created_at::date) AS hold_from
         FROM reservation r
         WHERE r.apartment_id = $1
         ORDER BY COALESCE(r.hold_from, r.created_at::date) ASC, r.hold_until ASC, r.created_at DESC
         LIMIT 50`,
        [id]
      ),
      pool.query(
        `SELECT m.*,
                (SELECT mr.current_reading FROM meter_reading mr WHERE mr.meter_id = m.id ORDER BY mr.period DESC, mr.current_reading DESC, mr.recorded_at DESC LIMIT 1) AS latest_reading,
                (SELECT mr.period FROM meter_reading mr WHERE mr.meter_id = m.id ORDER BY mr.period DESC, mr.current_reading DESC, mr.recorded_at DESC LIMIT 1) AS latest_period
         FROM meter m
         WHERE m.apartment_id = $1
         ORDER BY m.meter_type ASC`,
        [id]
      ),
      pool.query(
        `SELECT id, tracking_code, title, category, priority, status, created_at, rating
         FROM service_request
         WHERE apartment_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [id]
      ),
      pool.query(
        `SELECT z.*, (SELECT COUNT(*) FROM apartment a WHERE a.zone_id = z.id) AS apartment_count
         FROM zone z WHERE z.building_id = $1 ORDER BY z.code ASC`,
        [apartment.building_id]
      ),
    ]);

    res.json({
      data: {
        ...apartment,
        allowed_transitions: APARTMENT_TRANSITIONS[apartment.status] || [],
        contracts: contractsRes.rows,
        reservations: reservationsRes.rows,
        meters: metersRes.rows,
        service_requests: requestsRes.rows,
        zones: zonesRes.rows,
      },
    });
  } catch (err) {
    console.error('[Apartment Detail Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải chi tiết căn hộ.' });
  }
});

/**
 * POST /api/v1/apartments
 * Quyền theo PRD 6.2: SYS_ADMIN (CRUD toàn org) hoặc MANAGER (CRU trên tòa được gán). OWNER chỉ có R.
 */
router.post('/', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { building_id, floor_id, zone_id, code, area_m2, type, bedrooms, base_rent, amenities, note } = req.body;
  const roleCodes = getUserRoleCodes(req);
  const isSysAdmin = roleCodes.includes('SYS_ADMIN');

  if (!building_id || !code) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Tòa nhà và mã phòng là bắt buộc.' });
  }

  if (base_rent !== undefined && base_rent < 0) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Giá thuê không được âm.' });
  }

  try {
    const bCheck = await adminPool.query('SELECT id FROM building WHERE id = $1 AND org_id = $2', [building_id, req.user.org_id]);
    if (bCheck.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
    }

    if (!isSysAdmin) {
      const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
      if (!mgrIds.includes(building_id)) {
        await logAccessDenied(req, 'building', building_id, 'MANAGER attempted to create apartment in unassigned building');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền quản lý tòa nhà này để tạo căn hộ.',
        });
      }
    }

    if (floor_id) {
      const floorCheck = await pool.query(
        `SELECT 1 FROM floor WHERE id = $1 AND building_id = $2`,
        [floor_id, building_id]
      );
      if (floorCheck.rows.length === 0) {
        return res.status(400).json({
          code: 'FLOOR_MISMATCH',
          message: 'Tầng không thuộc tòa nhà này.',
        });
      }
    }

    if (zone_id) {
      const zoneCheck = await pool.query(
        `SELECT 1 FROM zone WHERE id = $1 AND building_id = $2`,
        [zone_id, building_id]
      );
      if (zoneCheck.rows.length === 0) {
        return res.status(400).json({
          code: 'ZONE_MISMATCH',
          message: 'Khu không thuộc tòa nhà này.',
        });
      }
    }

    const result = await pool.query(
      `INSERT INTO apartment (building_id, zone_id, floor_id, code, area_m2, type, bedrooms, base_rent, status, amenities, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AVAILABLE', $9, $10)
       RETURNING *`,
      [
        building_id,
        zone_id || null,
        floor_id || null,
        code.trim().toUpperCase(),
        area_m2 || 0,
        type || '1PN',
        bedrooms || 1,
        base_rent || 0,
        JSON.stringify(amenities || {}),
        note || '',
      ]
    );

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'apartment', $2, $3)`,
      [req.user.sub, result.rows[0].id, JSON.stringify(result.rows[0])]
    );

    res.status(201).json({ message: 'Tạo căn hộ thành công.', data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      let suggestion = '';
      try {
        const cleanInput = String(code || '').trim().toUpperCase();
        const inputMatch = cleanInput.match(/^(.*?)(\d+)$/);
        const allCodesRes = await pool.query(
          `SELECT code FROM apartment WHERE building_id = $1`,
          [building_id]
        );
        const targetPrefix = inputMatch ? inputMatch[1] : null;
        let maxNum = -1;
        let bestPadLen = inputMatch ? inputMatch[2].length : 0;
        let bestPrefix = targetPrefix ?? '';

        for (const r of allCodesRes.rows) {
          const m = String(r.code || '').match(/^(.*?)(\d+)$/);
          if (!m) continue;
          if (targetPrefix !== null && m[1] !== targetPrefix) continue;
          const numVal = parseInt(m[2], 10);
          if (numVal > maxNum) {
            maxNum = numVal;
            bestPrefix = m[1];
            bestPadLen = Math.max(bestPadLen, m[2].length);
          }
        }
        if (maxNum >= 0) {
          const nextDigits = String(maxNum + 1).padStart(bestPadLen, '0');
          suggestion = ` Gợi ý mã kế tiếp: ${bestPrefix}${nextDigits}.`;
        }
      } catch {
        // gợi ý là phụ
      }
      return res.status(409).json({ code: 'DUPLICATE_CODE', message: `Mã căn "${code}" đã tồn tại trong tòa nhà này.${suggestion}` });
    }
    console.error('[Create Apartment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo căn hộ.' });
  }
});

/**
 * POST /api/v1/apartments/bulk
 * FR-009: Tạo hàng loạt căn hộ theo mẫu tầng trên 1..n tầng (dry_run xem trước hoặc commit all-or-nothing kèm audit).
 */
router.post('/bulk', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const body = req.body || {};
  const {
    building_id: buildingId,
    floor_ids: rawFloorIds,
    zone_id: zoneId,
    code_prefix: rawPrefix,
    units,
    amenities,
    note,
    dry_run: dryRun,
  } = body;

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const fail = (status, code, message, extra = {}) =>
    res.status(status).json({ code, message, ...extra });

  if (!uuidRe.test(String(buildingId || ''))) {
    return fail(422, 'VALIDATION_ERROR', 'Tòa nhà không hợp lệ.');
  }

  try {
    const orgId = req.user.org_id;
    const isSysAdmin = getUserRoleCodes(req).includes('SYS_ADMIN');

    const bCheck = await adminPool.query(
      'SELECT id, code FROM building WHERE id = $1 AND org_id = $2',
      [buildingId, orgId]
    );
    if (bCheck.rows.length === 0) {
      return fail(404, 'NOT_FOUND', 'Không tìm thấy tòa nhà.');
    }

    if (!isSysAdmin) {
      const mgrIds = await getManagerBuildingIds(req.user.sub, orgId);
      if (!mgrIds.includes(buildingId)) {
        await logAccessDenied(req, 'building', buildingId, 'MANAGER attempted bulk apartment creation in unassigned building');
        return fail(403, 'ACCESS_DENIED', 'Bạn không có quyền quản lý tòa nhà này để tạo căn hộ.');
      }
    }

    // Shape validation (after RBAC building check per Review Focus #3 & AC-019.1)
    const floorIds = Array.isArray(rawFloorIds)
      ? [...new Set(rawFloorIds.map((id) => String(id || '').trim()))].filter(Boolean)
      : [];
    if (floorIds.length === 0 || floorIds.length > 50 || floorIds.some((id) => !uuidRe.test(id))) {
      return fail(422, 'VALIDATION_ERROR', 'Chọn từ 1 đến 50 tầng hợp lệ.');
    }
    if (zoneId !== undefined && zoneId !== null && String(zoneId).trim() !== '' && !uuidRe.test(String(zoneId).trim())) {
      return fail(422, 'VALIDATION_ERROR', 'Khu không hợp lệ.');
    }
    if (!Array.isArray(units) || units.length === 0 || units.length > 50) {
      return fail(422, 'VALIDATION_ERROR', 'Mẫu tầng phải có từ 1 đến 50 loại căn.');
    }
    if (units.length * floorIds.length > 500) {
      return fail(422, 'VALIDATION_ERROR', 'Một lần chỉ được tạo tối đa 500 căn hộ.');
    }

    const cleanPrefix = String(rawPrefix || '').trim().toUpperCase();
    if (cleanPrefix && !/^[A-Z0-9-]+$/.test(cleanPrefix)) {
      return fail(422, 'VALIDATION_ERROR', 'Tiền tố mã căn chỉ được chứa chữ cái, số và dấu gạch ngang.');
    }
    if (amenities !== undefined && amenities !== null && (typeof amenities !== 'object' || Array.isArray(amenities))) {
      return fail(422, 'VALIDATION_ERROR', 'Tiện ích phải là một đối tượng JSON.');
    }
    if (note !== undefined && typeof note !== 'string') {
      return fail(422, 'VALIDATION_ERROR', 'Ghi chú phải là chuỗi.');
    }

    const cleanUnits = [];
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i] || {};
      const suffix = unit.suffix === undefined || unit.suffix === null
        ? ''
        : String(unit.suffix).trim().toUpperCase();
      if (suffix && !/^[A-Z0-9-]{1,10}$/.test(suffix)) {
        return fail(422, 'VALIDATION_ERROR', `Hậu tố căn thứ ${i + 1} không hợp lệ.`);
      }
      const bedrooms = Number(unit.bedrooms ?? 1);
      const area = Number(unit.area_m2 ?? 0);
      const rent = Number(unit.base_rent ?? 0);
      if (!Number.isInteger(bedrooms) || bedrooms < 0 || bedrooms > 20) {
        return fail(422, 'VALIDATION_ERROR', `Số phòng ngủ của căn thứ ${i + 1} phải là số nguyên từ 0 đến 20.`);
      }
      if (!Number.isFinite(area) || area < 0 || area > 9999.99) {
        return fail(422, 'VALIDATION_ERROR', `Diện tích của căn thứ ${i + 1} không hợp lệ.`);
      }
      if (!Number.isInteger(rent) || rent < 0) {
        return fail(422, 'VALIDATION_ERROR', `Giá thuê của căn thứ ${i + 1} phải là số nguyên VND không âm.`);
      }
      cleanUnits.push({
        suffix,
        type: String(unit.type || '1PN').trim() || '1PN',
        bedrooms,
        area_m2: area,
        base_rent: rent,
      });
    }

    const cleanZoneId = zoneId ? String(zoneId).trim() : null;
    let zoneCode = '';
    if (cleanZoneId) {
      const zoneCheck = await pool.query(
        'SELECT code FROM zone WHERE id = $1 AND building_id = $2',
        [cleanZoneId, buildingId]
      );
      if (zoneCheck.rows.length === 0) {
        return fail(422, 'ZONE_MISMATCH', 'Khu không thuộc tòa nhà này.');
      }
      zoneCode = zoneCheck.rows[0].code || '';
    }

    const effectivePrefix = cleanPrefix || String(zoneCode || '').trim().toUpperCase();

    const floorsRes = await pool.query(
      'SELECT id, level, name FROM floor WHERE building_id = $1 AND id = ANY($2::uuid[]) ORDER BY level ASC',
      [buildingId, floorIds]
    );
    if (floorsRes.rows.length !== floorIds.length) {
      return fail(422, 'FLOOR_MISMATCH', 'Có tầng không thuộc tòa nhà này.');
    }

    const drafts = buildApartmentDrafts({
      codePrefix: effectivePrefix,
      units: cleanUnits,
      floors: floorsRes.rows,
      zoneId: cleanZoneId,
      amenities: amenities || {},
      note: note || '',
    });

    const payloadDuplicates = findDuplicateCodes(drafts);
    if (payloadDuplicates.length > 0) {
      return fail(422, 'DUPLICATE_CODE_IN_PAYLOAD', 'Mẫu tầng sinh ra mã căn trùng nhau.', {
        conflicts: payloadDuplicates.map((code) => ({ code })),
      });
    }

    const existing = await pool.query(
      'SELECT code FROM apartment WHERE building_id = $1 AND code = ANY($2::text[])',
      [buildingId, drafts.map((d) => d.code)]
    );
    const existingCodes = new Set(existing.rows.map((r) => r.code));
    const conflicts = drafts
      .filter((d) => existingCodes.has(d.code))
      .map((d) => ({ code: d.code, floor_id: d.floor_id, floor_name: d.floor_name }));

    if (dryRun) {
      return res.json({
        data: drafts,
        conflicts,
        total: drafts.length,
        valid: conflicts.length === 0,
      });
    }

    if (conflicts.length > 0) {
      return fail(409, 'DUPLICATE_CODE', 'Một số mã căn đã tồn tại trong tòa nhà này.', { conflicts });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const created = [];
      for (const draft of drafts) {
        const inserted = await client.query(
          `INSERT INTO apartment
             (building_id, zone_id, floor_id, code, area_m2, type, bedrooms, base_rent, status, amenities, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AVAILABLE', $9, $10)
           RETURNING *`,
          [
            buildingId,
            draft.zone_id,
            draft.floor_id,
            draft.code,
            draft.area_m2,
            draft.type,
            draft.bedrooms,
            draft.base_rent,
            JSON.stringify(draft.amenities || {}),
            draft.note || '',
          ]
        );
        const row = inserted.rows[0];
        created.push(row);
        await client.query(
          `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
           VALUES ($1, 'CREATE', 'apartment', $2, $3)`,
          [req.user.sub, row.id, JSON.stringify(row)]
        );
      }
      await client.query('COMMIT');
      return res.status(201).json({
        message: `Đã tạo ${created.length} căn hộ từ mẫu tầng.`,
        created_count: created.length,
        data: created,
      });
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      if (txErr.code === '23505') {
        return fail(409, 'DUPLICATE_CODE', 'Mã căn vừa bị tạo bởi thao tác khác. Vui lòng xem trước lại.');
      }
      throw txErr;
    } finally {
      await release();
    }
  } catch (err) {
    console.error('[Bulk Create Apartments Error]:', err);
    return res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo căn hộ hàng loạt.' });
  }
});

/**
 * PATCH /api/v1/apartments/:id
 * Quyền: SYS_ADMIN hoặc MANAGER của tòa nhà đó (CRU).
 */
router.patch('/:id', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { status, base_rent, area_m2, type, bedrooms, amenities, note, zone_id } = req.body;
  const roleCodes = getUserRoleCodes(req);
  const isSysAdmin = roleCodes.includes('SYS_ADMIN');

  try {
    const aptExist = await adminPool.query(
      `SELECT a.* FROM apartment a
       JOIN building b ON b.id = a.building_id
       WHERE a.id = $1 AND b.org_id = $2`,
      [id, req.user.org_id]
    );
    if (aptExist.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }

    const before = aptExist.rows[0];

    if (!isSysAdmin) {
      const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
      if (!mgrIds.includes(before.building_id)) {
        await logAccessDenied(req, 'apartment', id, 'MANAGER attempted to update apartment in unassigned building');
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          message: 'Bạn không có quyền quản lý căn hộ này.',
        });
      }
    }

    if (status && ['OCCUPIED', 'RESERVED'].includes(status)) {
      return res.status(409).json({
        code: 'DIRECT_STATUS_CHANGE_PROHIBITED',
        message: 'Không thể tự ý chuyển sang trạng thái Đang thuê hoặc Đã đặt cọc. Trạng thái này được cập nhật tự động qua Hợp đồng và Giữ chỗ.',
      });
    }

    if (status && !isTransitionAllowed(before.status, status)) {
      return res.status(409).json({
        code: 'INVALID_STATUS_TRANSITION',
        message: `Không thể chuyển căn hộ từ ${before.status} sang ${status}. Các chuyển đổi hợp lệ từ ${before.status}: ${(APARTMENT_TRANSITIONS[before.status] || []).join(', ') || 'không có (phải qua luồng hợp đồng)'}.`,
      });
    }

    const currentActiveContract = await pool.query(
      `SELECT 1 FROM contract
       WHERE apartment_id = $1
         AND status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
         AND start_date <= CURRENT_DATE
         AND COALESCE(terminated_at, end_date) > CURRENT_DATE
       LIMIT 1`,
      [id]
    );
    const hasCurrentActiveContract = currentActiveContract.rows.length > 0;

    if (status && hasCurrentActiveContract) {
      return res.status(409).json({
        code: 'INVALID_STATUS_TRANSITION',
        message: 'Căn đang có hợp đồng hiệu lực hiện tại, phải chấm dứt hợp đồng trước.',
      });
    }

    const anyOpenContract = await pool.query(
      `SELECT 1 FROM contract WHERE apartment_id = $1 AND status IN ('ACTIVE', 'RENEWAL_PENDING') LIMIT 1`,
      [id]
    );
    const hasAnyOpenContract = anyOpenContract.rows.length > 0;

    if (
      area_m2 !== undefined &&
      hasAnyOpenContract &&
      Number(area_m2) !== Number(before.area_m2) &&
      req.body.confirm_recalculate_fees !== true
    ) {
      return res.status(409).json({
        code: 'AREA_CHANGE_REQUIRES_CONFIRM',
        message: 'Đang có hợp đồng ACTIVE trên căn này. Sửa diện tích ảnh hưởng phí dịch vụ — gửi kèm confirm_recalculate_fees: true để xác nhận tính lại.',
      });
    }

    const hasZoneUpdate = zone_id !== undefined;
    const nextZoneId = zone_id ? zone_id : null;

    if (nextZoneId) {
      const zoneCheck = await pool.query(
        `SELECT 1 FROM zone WHERE id = $1 AND building_id = $2`,
        [nextZoneId, before.building_id]
      );
      if (zoneCheck.rows.length === 0) {
        return res.status(400).json({ code: 'ZONE_MISMATCH', message: 'Khu không thuộc tòa nhà này.' });
      }
    }

    const result = await pool.query(
      `UPDATE apartment
       SET status = COALESCE($1, status),
           base_rent = COALESCE($2, base_rent),
           area_m2 = COALESCE($3, area_m2),
           amenities = COALESCE($4, amenities),
           note = COALESCE($5, note),
           zone_id = CASE WHEN $6::boolean THEN $7::uuid ELSE zone_id END,
           type = COALESCE($8, type),
           bedrooms = COALESCE($9, bedrooms),
           updated_at = NOW()
       WHERE id = $10
       RETURNING *`,
      [
        status || null,
        base_rent !== undefined ? base_rent : null,
        area_m2 !== undefined ? area_m2 : null,
        amenities ? JSON.stringify(amenities) : null,
        note !== undefined ? note : null,
        hasZoneUpdate,
        nextZoneId,
        type !== undefined && String(type).trim() ? String(type).trim() : null,
        bedrooms !== undefined && bedrooms !== null && bedrooms !== '' ? Number(bedrooms) : null,
        id,
      ]
    );

    let updatedRow = result.rows[0];
    // Điểm 6: Nếu căn rời MAINTENANCE -> AVAILABLE mà đã có HĐ tương lai / giữ chỗ HELD, tự động đồng bộ về RESERVED/OCCUPIED
    if (before.status === 'MAINTENANCE' && status === 'AVAILABLE') {
      const syncedStatus = await syncApartmentStatus(pool, id, { leaveMaintenance: true });
      if (syncedStatus && syncedStatus !== updatedRow.status) {
        const refreshed = await pool.query('SELECT * FROM apartment WHERE id = $1', [id]);
        if (refreshed.rows[0]) updatedRow = refreshed.rows[0];
      }
    }

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE', 'apartment', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(before), JSON.stringify(updatedRow)]
    );

    res.json({ message: 'Cập nhật căn hộ thành công.', data: updatedRow });
  } catch (err) {
    console.error('[Update Apartment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi cập nhật căn hộ.' });
  }
});

/**
 * DELETE /api/v1/apartments/:id
 * Quyền theo PRD 6.2: Chỉ SYS_ADMIN được xóa căn hộ chưa phát sinh hợp đồng / giữ chỗ.
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const roleCodes = getUserRoleCodes(req);

  if (!roleCodes.includes('SYS_ADMIN')) {
    await logAccessDenied(req, 'apartment', id, 'Non-SYS_ADMIN attempted to delete apartment');
    return res.status(403).json({
      code: 'DELETE_PROHIBITED',
      message: 'Thao tác xóa không được phép. Quyền của Quản lý là CRU (Tạo, Xem, Sửa), không được Xóa căn hộ.',
    });
  }

  try {
    const hasHistory = await pool.query(
      `SELECT 1 FROM contract WHERE apartment_id = $1
       UNION ALL
       SELECT 1 FROM reservation WHERE apartment_id = $1
       LIMIT 1`,
      [id]
    );
    if (hasHistory.rows.length > 0) {
      return res.status(409).json({
        code: 'APARTMENT_HAS_HISTORY',
        message: 'Không thể xóa căn hộ đã từng phát sinh hợp đồng hoặc giữ chỗ. Vui lòng chuyển sang trạng thái INACTIVE.',
      });
    }

    const delRes = await pool.query('DELETE FROM apartment WHERE id = $1 RETURNING *', [id]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before)
       VALUES ($1, 'DELETE', 'apartment', $2, $3)`,
      [req.user.sub, id, JSON.stringify(delRes.rows[0])]
    );

    return res.json({ message: 'Đã xóa căn hộ thành công.', data: delRes.rows[0] });
  } catch (err) {
    console.error('[Delete Apartment Error]:', err);
    return res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi xóa căn hộ.' });
  }
});

/**
 * PATCH /api/v1/apartments/:id/handover
 * Bàn giao & nghiệm thu phòng (B8 / PRD 6.2, 7.5, FR-024, R-12):
 * Ghi nhận biên bản kiểm tra bàn giao kèm ảnh (attachment + audit_log HANDOVER) và giải phóng MAINTENANCE -> AVAILABLE (trừ khi keep_maintenance = true).
 */
router.patch('/:id/handover', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { note, checklist, evidence, keep_maintenance } = req.body || {};
  const roleCodes = getUserRoleCodes(req);
  const isSysAdmin = roleCodes.includes('SYS_ADMIN');

  const { client, release } = await getUserClient(req);
  try {
    const aptExist = await client.query(
      `SELECT a.* FROM apartment a
       JOIN building b ON b.id = a.building_id
       WHERE a.id = $1 AND b.org_id = $2`,
      [id, req.user.org_id]
    );
    if (aptExist.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
    }
    const before = aptExist.rows[0];

    if (!isSysAdmin) {
      const mgrIds = await getManagerBuildingIds(req.user.sub, req.user.org_id);
      if (!mgrIds.includes(before.building_id)) {
        await logAccessDenied(req, 'apartment', id, 'MANAGER attempted handover in unassigned building');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền quản lý căn hộ này.' });
      }
    }

    if (before.status !== 'MAINTENANCE') {
      return res.status(409).json({
        code: 'INVALID_STATUS',
        message: `Chỉ căn hộ đang bảo trì (MAINTENANCE) mới cần bàn giao. Căn hiện ở trạng thái ${before.status}.`,
      });
    }

    const activeContract = await client.query(
      `SELECT 1 FROM contract
       WHERE apartment_id = $1
         AND status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
         AND start_date <= CURRENT_DATE
         AND COALESCE(terminated_at, end_date) > CURRENT_DATE
       LIMIT 1`,
      [id]
    );
    if (activeContract.rows.length > 0) {
      return res.status(409).json({
        code: 'ACTIVE_CONTRACT_EXISTS',
        message: 'Căn đang có hợp đồng hiệu lực hiện tại, phải chấm dứt hợp đồng trước khi bàn giao.',
      });
    }

    const warnings = [];
    const heldDeposit = await client.query(
      `SELECT 1 FROM deposit WHERE contract_id IN (
         SELECT id FROM contract WHERE apartment_id = $1
       ) AND status = 'HELD' LIMIT 1`,
      [id]
    );
    if (heldDeposit.rows.length > 0) {
      warnings.push('Còn cọc đang giữ chưa tất toán. Hãy hoàn tất tất toán theo FR-024.');
    }

    await client.query('BEGIN');

    const evidenceList = [];
    if (Array.isArray(evidence)) {
      for (const rawItem of evidence) {
        const item = typeof rawItem === 'string' ? rawItem.trim() : '';
        if (!item) continue;
        if (item.startsWith('data:')) {
          const saved = await saveBase64Image({
            imageBase64: item,
            folder: 'handovers',
            entityId: id,
            entity: 'apartment',
            ownerId: id,
            req,
            query: client.query.bind(client),
            allowPdf: true,
          });
          if (saved.error) {
            await client.query('ROLLBACK');
            return res.status(422).json({ code: saved.error.code, message: saved.error.message });
          }
          evidenceList.push(`/api/v1/attachments/${saved.attachment.id}/view`);
        } else if (item.startsWith('/api/v1/attachments/')) {
          evidenceList.push(item);
        } else {
          await client.query(
            `INSERT INTO attachment (owner_entity, owner_id, storage_path, uploaded_by)
             SELECT 'apartment', $1::uuid, $2::text, $3::uuid
             WHERE NOT EXISTS (
               SELECT 1 FROM attachment
               WHERE owner_entity = 'apartment' AND owner_id = $1 AND storage_path = $2
             )`,
            [id, item, req.user.sub]
          );
          evidenceList.push(item);
        }
      }
    }

    if (!keep_maintenance) {
      await syncApartmentStatus(client, id, { leaveMaintenance: true });
    }
    const result = await client.query(`SELECT * FROM apartment WHERE id = $1`, [id]);
    const updatedApt = result.rows[0];
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'HANDOVER', 'apartment', $2, $3, $4)`,
      [
        req.user.sub,
        id,
        JSON.stringify(before),
        JSON.stringify({
          ...updatedApt,
          inspection_note: note || null,
          checklist: Array.isArray(checklist) ? checklist : [],
          evidence: evidenceList,
        }),
      ]
    );

    await client.query('COMMIT');

    res.json({
      message: keep_maintenance
        ? 'Đã ghi nhận biên bản kiểm tra bàn giao phòng kèm hình ảnh.'
        : 'Bàn giao và nghiệm thu phòng thành công. Căn hộ sẵn sàng kinh doanh.',
      data: updatedApt,
      evidence: evidenceList,
      warnings,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[Handover Apartment Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi bàn giao căn hộ.' });
  } finally {
    await release();
  }
});

export default router;
