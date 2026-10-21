import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * Helper kiểm tra quyền truy cập tòa nhà theo vai trò:
 * - OWNER: Xem toàn bộ tòa trong tổ chức (R)
 * - MANAGER: CRU trên các tòa do mình quản lý (user_role.building_id)
 * - RESIDENT: Xem tòa có căn hộ của mình (R)
 */
async function checkBuildingAccess(userId, userRoleCodes, orgId, buildingId, requiredAction = 'read') {
  if (userRoleCodes.includes('OWNER')) {
    if (requiredAction !== 'read') {
      return { allowed: false, status: 403, message: 'Chủ đầu tư (OWNER) có quyền Xem (R), không được Tạo/Sửa/Xóa tòa nhà.' };
    }
    const b = await pool.query('SELECT * FROM building WHERE id = $1 AND org_id = $2', [buildingId, orgId]);
    return {
      allowed: b.rows.length > 0,
      status: b.rows.length > 0 ? 200 : 404,
      building: b.rows[0],
      message: b.rows.length > 0 ? 'OK' : 'Không tìm thấy tòa nhà.',
    };
  }

  if (userRoleCodes.includes('MANAGER')) {
    if (requiredAction === 'delete') {
      return { allowed: false, status: 403, message: 'Quy tắc RBAC: Quản lý (MANAGER) chỉ có quyền CRU (Tạo, Xem, Sửa), không được Xóa.' };
    }

    // Kiểm tra tòa nhà có thuộc quyền quản lý của Manager này không
    const b = await pool.query(
      `SELECT b.* FROM building b
       JOIN user_role ur ON ur.building_id = b.id
       WHERE b.id = $1 AND ur.user_id = $2 AND b.org_id = $3`,
      [buildingId, userId, orgId]
    );

    if (b.rows.length === 0) {
      return { allowed: false, status: 403, message: 'Bạn không có quyền quản lý tòa nhà này.' };
    }
    return { allowed: true, status: 200, building: b.rows[0], message: 'OK' };
  }

  if (userRoleCodes.includes('RESIDENT')) {
    if (requiredAction !== 'read') {
      return { allowed: false, status: 403, message: 'Cư dân chỉ có quyền xem thông tin căn hộ của mình.' };
    }
    const b = await pool.query(
      `SELECT b.* FROM building b
       JOIN contract c ON c.building_id = b.id
       JOIN tenant t ON t.id = c.primary_tenant_id
       WHERE b.id = $1 AND t.person_id = (SELECT person_id FROM app_user WHERE id = $2)`,
      [buildingId, userId]
    );
    if (b.rows.length === 0) {
      return { allowed: false, status: 403, message: 'Bạn không có quyền xem tòa nhà này.' };
    }
    return { allowed: true, status: 200, building: b.rows[0], message: 'OK' };
  }

  return { allowed: false, status: 403, message: 'Bạn không có quyền truy cập.' };
}

/**
 * GET /api/v1/buildings/check-code?code=TN-A
 * Kiểm tra mã tòa có sẵn hay đã trùng (FR-007 / NV-03)
 */
router.get('/check-code', authenticateToken, async (req, res) => {
  const { code } = req.query;
  const orgId = req.user.org_id;

  if (!code || !code.trim()) {
    return res.status(400).json({ code: 'MISSING_CODE', message: 'Thiếu mã tòa cần kiểm tra.' });
  }

  const cleanCode = code.trim().toUpperCase();

  if (!/^[A-Z0-9-]+$/.test(cleanCode)) {
    return res.json({
      available: false,
      code: cleanCode,
      message: 'Mã tòa chỉ được chứa chữ cái, số và dấu gạch ngang (-).',
    });
  }

  try {
    const result = await pool.query(
      'SELECT id FROM building WHERE org_id = $1 AND code = $2',
      [orgId, cleanCode]
    );

    return res.json({
      available: result.rows.length === 0,
      code: cleanCode,
      message: result.rows.length === 0 ? 'Mã tòa hợp lệ và chưa được dùng.' : 'Mã tòa đã tồn tại trong tổ chức.',
    });
  } catch (err) {
    console.error('[Check Code Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi kiểm tra mã tòa.' });
  }
});

/**
 * GET /api/v1/buildings
 * - OWNER: Xem toàn bộ tòa nhà thuộc sở hữu trong tổ chức (R)
 * - MANAGER: Xem danh sách tòa nhà do mình quản lý (CRU)
 * - RESIDENT: Xem tòa nhà của căn hộ mình đang ở (R)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    const isOwner = userRoleCodes.includes('OWNER');
    const isManager = userRoleCodes.includes('MANAGER');
    const isResident = userRoleCodes.includes('RESIDENT');

    let sql = `
      SELECT b.*, 
        (SELECT COUNT(*) FROM apartment a WHERE a.building_id = b.id) as total_apartments,
        (SELECT COUNT(*) FROM apartment a WHERE a.building_id = b.id AND a.status = 'AVAILABLE') as available_apartments,
        (SELECT COUNT(*) FROM apartment a WHERE a.building_id = b.id AND a.status = 'OCCUPIED') as occupied_apartments,
        (SELECT COUNT(*) FROM floor f WHERE f.building_id = b.id) as total_floors
      FROM building b
      WHERE b.org_id = $1
    `;
    const params = [orgId];

    if (isManager && !isOwner) {
      // Manager: Chỉ xem các tòa do mình quản lý
      params.push(req.user.sub);
      sql += ` AND b.id IN (
        SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL
      )`;
    } else if (isResident && !isOwner && !isManager) {
      // Resident: Chỉ xem tòa của căn hộ mình đang thuê
      params.push(req.user.person_id);
      sql += ` AND b.id IN (
        SELECT c.building_id FROM contract c
        JOIN tenant t ON t.id = c.primary_tenant_id
        WHERE t.person_id = $${params.length}
      )`;
    }

    sql += ` ORDER BY b.created_at DESC`;
    const result = await pool.query(sql, params);

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Buildings Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Không thể lấy danh sách tòa nhà.' });
  }
});

/**
 * POST /api/v1/buildings (NV-03 — TẠO TÒA NHÀ MỚI)
 * Quyền: Chỉ MANAGER có quyền tạo tòa nhà (CRU). OWNER có quyền R (bị chặn).
 * Sau khi tạo, tòa nhà mới tự động được gán quyền quản lý cho Manager.
 */
router.post('/', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { name, code, address, owner_id, timezone, lease_terms, payment_account } = req.body;

  if (!name || name.trim().length < 2 || name.trim().length > 100) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: 'Tên tòa nhà phải từ 2 đến 100 ký tự.',
    });
  }

  const cleanCode = (code || '').trim().toUpperCase();
  if (!cleanCode || cleanCode.length < 2 || cleanCode.length > 20) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: 'Mã tòa nhà phải từ 2 đến 20 ký tự.',
    });
  }

  if (!/^[A-Z0-9-]+$/.test(cleanCode)) {
    return res.status(422).json({
      code: 'VALIDATION_ERROR',
      message: 'Mã tòa chỉ được chứa chữ cái in hoa (A-Z), chữ số (0-9) và dấu gạch ngang (-).',
    });
  }

  try {
    const orgId = req.user.org_id;

    // Rule: Mã tòa unique trong org
    const checkDup = await pool.query('SELECT id FROM building WHERE org_id = $1 AND code = $2', [orgId, cleanCode]);
    if (checkDup.rows.length > 0) {
      return res.status(409).json({
        code: 'BUILDING_CODE_EXISTS',
        message: `Mã tòa "${cleanCode}" đã tồn tại trong tổ chức.`,
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const newBuildingId = (await client.query('SELECT gen_random_uuid() as id')).rows[0].id;

      // Tự động gán quyền quản lý tòa nhà mới cho Manager tạo tòa này trước để RLS cho phép RETURNING
      const roleRes = await client.query("SELECT id FROM role WHERE code = 'MANAGER' AND org_id = $1", [orgId]);
      if (roleRes.rows.length > 0) {
        await client.query(
          `INSERT INTO user_role (user_id, role_id, building_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, role_id, building_id) DO NOTHING`,
          [req.user.sub, roleRes.rows[0].id, newBuildingId]
        );
      }

      const result = await client.query(
        `INSERT INTO building (id, org_id, owner_id, name, code, address, timezone, lease_terms, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')
         RETURNING *`,
        [
          newBuildingId,
          orgId,
          owner_id || null,
          name.trim(),
          cleanCode,
          address?.trim() || '',
          timezone || 'Asia/Ho_Chi_Minh',
          JSON.stringify({
            ...(lease_terms || {}),
            payment_account: payment_account || {},
          }),
        ]
      );

      const newBuilding = result.rows[0];

      // Ghi audit log
      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'CREATE', 'building', $2, NULL, $3)`,
        [req.user.sub, newBuilding.id, JSON.stringify(newBuilding)]
      );

      await client.query('COMMIT');

      res.status(201).json({
        message: `Đã tạo tòa nhà ${newBuilding.name} (${newBuilding.code}) và gán quản lý thành công.`,
        data: newBuilding,
      });
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      await release();
    }
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        code: 'BUILDING_CODE_EXISTS',
        message: `Mã tòa "${cleanCode}" đã tồn tại trong tổ chức.`,
      });
    }
    console.error('[Create Building Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tạo tòa nhà.' });
  }
});

/**
 * GET /api/v1/buildings/:id
 */
router.get('/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userRoleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
  
  const check = await checkBuildingAccess(req.user.sub, userRoleCodes, req.user.org_id, id, 'read');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }

  // Kèm phân khu (B1) để UI tạo căn hộ chọn khu
  const zones = await pool.query(
    'SELECT id, code, name, status FROM zone WHERE building_id = $1 ORDER BY code ASC',
    [id]
  );

  res.json({ data: { ...check.building, zones: zones.rows } });
});

/**
 * PATCH /api/v1/buildings/:id/status
 * Đổi trạng thái tòa nhà: ACTIVE <-> INACTIVE (State Machine NV-03)
 * Quyền: Chỉ MANAGER có quyền cập nhật trạng thái tòa mình quản lý (CRU)
 */
router.patch('/:id/status', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const userRoleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));

  const check = await checkBuildingAccess(req.user.sub, userRoleCodes, req.user.org_id, id, 'update');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }

  if (!['ACTIVE', 'INACTIVE'].includes(status)) {
    return res.status(400).json({ code: 'INVALID_STATUS', message: 'Trạng thái chỉ có thể là ACTIVE hoặc INACTIVE.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');
    const before = check.building;

    // Kiểm tra ràng buộc hợp đồng hiệu lực khi Deactivate
    if (status === 'INACTIVE') {
      const activeContractsRes = await client.query(
        `SELECT COUNT(*) FROM contract WHERE building_id = $1 AND status = 'ACTIVE'`,
        [id]
      );
      const activeCount = parseInt(activeContractsRes.rows[0].count, 10);
      if (activeCount > 0) {
        return res.status(400).json({
          code: 'ACTIVE_CONTRACTS_EXIST',
          message: `Không thể tạm dừng hoạt động tòa nhà này vì đang có ${activeCount} hợp đồng đang có hiệu lực. Vui lòng thanh lý hết hợp đồng trước.`,
        });
      }
    }

    const updateRes = await client.query(
      `UPDATE building SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE', 'building', $2, $3, $4)`,
      [req.user.sub, id, JSON.stringify(before), JSON.stringify(updateRes.rows[0])]
    );

    await client.query('COMMIT');
    res.json({
      message: `Đã chuyển trạng thái tòa nhà sang ${status === 'ACTIVE' ? 'Đang hoạt động' : 'Tạm ngừng'}.`,
      data: updateRes.rows[0],
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[Update Status Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi cập nhật trạng thái tòa nhà.' });
  } finally {
    await release();
  }
});

/**
 * GET /api/v1/buildings/:id/floor-map
 * Lấy sơ đồ tầng và căn hộ (FR-010)
 */
router.get('/:id/floor-map', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userRoleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));

  const check = await checkBuildingAccess(req.user.sub, userRoleCodes, req.user.org_id, id, 'read');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }

  try {
    const floorsRes = await pool.query(
      'SELECT * FROM floor WHERE building_id = $1 ORDER BY level DESC',
      [id]
    );

    const apartmentsRes = await pool.query(
      'SELECT * FROM apartment WHERE building_id = $1 ORDER BY code ASC',
      [id]
    );

    const floorMap = floorsRes.rows.map((floor) => {
      return {
        ...floor,
        apartments: apartmentsRes.rows.filter((apt) => apt.floor_id === floor.id),
      };
    });

    res.json({ data: floorMap });
  } catch (err) {
    console.error('[Floor Map Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải sơ đồ tầng.' });
  }
});

/**
 * GET /api/v1/buildings/:id/floors
 * Lấy danh sách tầng của tòa nhà
 */
router.get('/:id/floors', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const userRoleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));

  const check = await checkBuildingAccess(req.user.sub, userRoleCodes, req.user.org_id, id, 'read');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }

  try {
    const result = await pool.query(
      `SELECT f.*, 
        (SELECT COUNT(*) FROM apartment a WHERE a.floor_id = f.id) as apartment_count
       FROM floor f
       WHERE f.building_id = $1
       ORDER BY f.level ASC`,
      [id]
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Get Floors Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách tầng.' });
  }
});

/**
 * POST /api/v1/buildings/:id/floors (NV-04)
 * Quyền: Chỉ MANAGER được thêm tầng cho tòa nhà mình quản lý (CRU)
 */
router.post('/:id/floors', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { level, name } = req.body;
  const userRoleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));

  const check = await checkBuildingAccess(req.user.sub, userRoleCodes, req.user.org_id, id, 'create');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }

  if (level === undefined || level === null || level === '') {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Số tầng (level) là bắt buộc.' });
  }

  const lvl = parseInt(level, 10);
  if (isNaN(lvl)) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Số tầng phải là số nguyên (INTEGER).' });
  }

  let floorName = name?.trim();
  if (!floorName) {
    if (lvl < 0) floorName = `Tầng hầm B${Math.abs(lvl)}`;
    else if (lvl === 0) floorName = `Tầng Trệt`;
    else floorName = `Tầng ${lvl}`;
  }

  try {
    const checkDup = await pool.query(
      'SELECT id FROM floor WHERE building_id = $1 AND level = $2',
      [id, lvl]
    );
    if (checkDup.rows.length > 0) {
      return res.status(409).json({
        code: 'FLOOR_EXISTS',
        message: `Tầng ${lvl} đã tồn tại trong tòa nhà này.`,
      });
    }

    const result = await pool.query(
      `INSERT INTO floor (building_id, level, name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, lvl, floorName]
    );

    res.status(201).json({ message: 'Tạo tầng thành công.', data: result.rows[0] });
  } catch (err) {
    console.error('[Create Floor Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo tầng.' });
  }
});

/**
 * DELETE /api/v1/buildings/:id/floors/:floor_id
 * Quyền: Bị chặn (Manager có quyền CRU - không xóa; Owner có quyền R)
 * Nếu tầng đang có căn hộ, trả về lỗi 400 FLOOR_HAS_APARTMENTS.
 * Nếu không có căn hộ, trả về lỗi 403 DELETE_PROHIBITED (chỉ có quyền CRU).
 */
router.delete('/:id/floors/:floor_id', authenticateToken, async (req, res) => {
  try {
    const { id, floor_id } = req.params;
    const roleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
    const access = await checkBuildingAccess(req.user.sub, roleCodes, req.user.org_id, id, 'update');
    if (!access.allowed) {
      return res.status(access.status).json({ code: 'FORBIDDEN', message: access.message });
    }

    const aptCountRes = await pool.query('SELECT COUNT(*) FROM apartment WHERE floor_id = $1', [floor_id]);
    const count = parseInt(aptCountRes.rows[0]?.count || 0, 10);
    if (count > 0) {
      return res.status(400).json({
        code: 'FLOOR_HAS_APARTMENTS',
        message: `Không thể xóa tầng này vì đang chứa ${count} căn hộ. Vui lòng chuyển hoặc xóa căn hộ trước.`,
      });
    }

    return res.status(403).json({
      code: 'DELETE_PROHIBITED',
      message: 'Thao tác xóa không được phép. Quyền của Quản lý là CRU (Tạo, Xem, Sửa), không được Xóa tầng.',
    });
  } catch (err) {
    console.error('Lỗi kiểm tra xóa tầng:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi kiểm tra xóa tầng.' });
  }
});

// ============================================================================
// KHU / BLOCK (B1, FR-007) — cây Tòa · Khu · Tầng · Căn hộ
// ============================================================================

/**
 * GET /api/v1/buildings/:id/zones
 */
router.get('/:id/zones', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const roleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
  const check = await checkBuildingAccess(req.user.sub, roleCodes, req.user.org_id, id, 'read');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }
  try {
    const result = await pool.query(
      `SELECT z.*, (SELECT COUNT(*) FROM apartment a WHERE a.zone_id = z.id) AS apartment_count
       FROM zone z WHERE z.building_id = $1 ORDER BY z.code ASC`,
      [id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Get Zones Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách khu.' });
  }
});

/**
 * POST /api/v1/buildings/:id/zones — MANAGER khởi tạo khu (NV-03, FR-007)
 */
router.post('/:id/zones', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { code, name } = req.body;
  const roleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
  const check = await checkBuildingAccess(req.user.sub, roleCodes, req.user.org_id, id, 'create');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }
  if (!code || !String(code).trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mã khu (code) là bắt buộc.' });
  }
  try {
    const bRes = await pool.query('SELECT org_id FROM building WHERE id = $1', [id]);
    if (bRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
    }
    const result = await pool.query(
      `INSERT INTO zone (org_id, building_id, code, name)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [bRes.rows[0].org_id, id, String(code).trim().toUpperCase(), name || null]
    );
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'zone', $2, $3)`,
      [req.user.sub, result.rows[0].id, JSON.stringify(result.rows[0])]
    );
    res.status(201).json({ message: 'Tạo khu thành công.', data: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        code: 'ZONE_EXISTS',
        message: `Khu ${String(code).trim().toUpperCase()} đã tồn tại trong tòa này.`,
      });
    }
    console.error('[Create Zone Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo khu.' });
  }
});

/**
 * PATCH /api/v1/buildings/:id/zones/:zone_id — đổi tên / bật tắt khu
 */
router.patch('/:id/zones/:zone_id', authenticateToken, requireRole(['MANAGER']), async (req, res) => {
  const { id, zone_id } = req.params;
  const { name, status } = req.body;
  const roleCodes = (req.user.roles || []).map((r) => (typeof r === 'string' ? r : r.code));
  const check = await checkBuildingAccess(req.user.sub, roleCodes, req.user.org_id, id, 'update');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }
  if (status && !['ACTIVE', 'INACTIVE'].includes(status)) {
    return res.status(400).json({ code: 'INVALID_ZONE_STATUS', message: 'Trạng thái khu chỉ nhận ACTIVE hoặc INACTIVE.' });
  }
  try {
    const before = await pool.query('SELECT * FROM zone WHERE id = $1 AND building_id = $2', [zone_id, id]);
    if (before.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy khu trong tòa này.' });
    }
    const result = await pool.query(
      `UPDATE zone SET name = COALESCE($1, name), status = COALESCE($2, status), updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [name ?? null, status ?? null, zone_id]
    );
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE', 'zone', $2, $3, $4)`,
      [req.user.sub, zone_id, JSON.stringify(before.rows[0]), JSON.stringify(result.rows[0])]
    );
    res.json({ message: 'Cập nhật khu thành công.', data: result.rows[0] });
  } catch (err) {
    console.error('[Update Zone Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật khu.' });
  }
});

export default router;
