import crypto from 'node:crypto';
import express from 'express';
import { pool, adminPool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import {
  getUserRoleCodes,
  getOwnerBuildingIds,
  getManagerBuildingIds,
  ownerBuildingFilter,
  managerBuildingFilter,
  logAccessDenied,
} from '../services/ownerScope.js';
import { normalizeVnPhone } from '../services/residentAccount.js';
import { buildOwnerPreview, checkLookupRateLimit } from '../utils/piiMask.js';

const router = express.Router();
const ownerLookupBuckets = new Map();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FALLBACK_VIETQR_BANKS = [
  { id: 43, code: 'VCB', bin: '970436', shortName: 'Vietcombank', name: 'Ngân hàng TMCP Ngoại Thương Việt Nam', logo: 'https://cdn.vietqr.io/img/VCB.png' },
  { id: 17, code: 'ICB', bin: '970415', shortName: 'VietinBank', name: 'Ngân hàng TMCP Công thương Việt Nam', logo: 'https://cdn.vietqr.io/img/ICB.png' },
  { id: 4, code: 'BIDV', bin: '970418', shortName: 'BIDV', name: 'Ngân hàng TMCP Đầu tư và Phát triển Việt Nam', logo: 'https://cdn.vietqr.io/img/BIDV.png' },
  { id: 42, code: 'VBA', bin: '970405', shortName: 'Agribank', name: 'Ngân hàng Nông nghiệp và Phát triển Nông thôn Việt Nam', logo: 'https://cdn.vietqr.io/img/VBA.png' },
  { id: 38, code: 'TCB', bin: '970407', shortName: 'Techcombank', name: 'Ngân hàng TMCP Kỹ thương Việt Nam', logo: 'https://cdn.vietqr.io/img/TCB.png' },
  { id: 21, code: 'MB', bin: '970422', shortName: 'MBBank', name: 'Ngân hàng TMCP Quân đội', logo: 'https://cdn.vietqr.io/img/MB.png' },
  { id: 2, code: 'ACB', bin: '970416', shortName: 'ACB', name: 'Ngân hàng TMCP Á Châu', logo: 'https://cdn.vietqr.io/img/ACB.png' },
  { id: 47, code: 'VPB', bin: '970432', shortName: 'VPBank', name: 'Ngân hàng TMCP Việt Nam Thịnh Vượng', logo: 'https://cdn.vietqr.io/img/VPB.png' },
  { id: 39, code: 'TPB', bin: '970423', shortName: 'TPBank', name: 'Ngân hàng TMCP Tiên Phong', logo: 'https://cdn.vietqr.io/img/TPB.png' },
  { id: 36, code: 'STB', bin: '970403', shortName: 'Sacombank', name: 'Ngân hàng TMCP Sài Gòn Thương Tín', logo: 'https://cdn.vietqr.io/img/STB.png' },
  { id: 12, code: 'HDB', bin: '970437', shortName: 'HDBank', name: 'Ngân hàng TMCP Phát triển TP. Hồ Chí Minh', logo: 'https://cdn.vietqr.io/img/HDB.png' },
  { id: 45, code: 'VIB', bin: '970441', shortName: 'VIB', name: 'Ngân hàng TMCP Quốc tế Việt Nam', logo: 'https://cdn.vietqr.io/img/VIB.png' },
  { id: 35, code: 'SHB', bin: '970443', shortName: 'SHB', name: 'Ngân hàng TMCP Sài Gòn - Hà Nội', logo: 'https://cdn.vietqr.io/img/SHB.png' },
  { id: 10, code: 'EIB', bin: '970431', shortName: 'Eximbank', name: 'Ngân hàng TMCP Xuất Nhập khẩu Việt Nam', logo: 'https://cdn.vietqr.io/img/EIB.png' },
  { id: 22, code: 'MSB', bin: '970426', shortName: 'MSB', name: 'Ngân hàng TMCP Hàng Hải Việt Nam', logo: 'https://cdn.vietqr.io/img/MSB.png' },
  { id: 26, code: 'OCB', bin: '970448', shortName: 'OCB', name: 'Ngân hàng TMCP Phương Đông', logo: 'https://cdn.vietqr.io/img/OCB.png' },
  { id: 20, code: 'LPB', bin: '970449', shortName: 'LPBank', name: 'Ngân hàng TMCP Lộc Phát Việt Nam', logo: 'https://cdn.vietqr.io/img/LPB.png' },
  { id: 33, code: 'SEAB', bin: '970440', shortName: 'SeABank', name: 'Ngân hàng TMCP Đông Nam Á', logo: 'https://cdn.vietqr.io/img/SEAB.png' },
  { id: 23, code: 'NAB', bin: '970428', shortName: 'NamABank', name: 'Ngân hàng TMCP Nam Á', logo: 'https://cdn.vietqr.io/img/NAB.png' },
  { id: 1, code: 'ABB', bin: '970425', shortName: 'ABBANK', name: 'Ngân hàng TMCP An Bình', logo: 'https://cdn.vietqr.io/img/ABB.png' },
  { id: 3, code: 'BAB', bin: '970409', shortName: 'BacABank', name: 'Ngân hàng TMCP Bắc Á', logo: 'https://cdn.vietqr.io/img/BAB.png' },
  { id: 5, code: 'BVB', bin: '970438', shortName: 'BaoVietBank', name: 'Ngân hàng TMCP Bảo Việt', logo: 'https://cdn.vietqr.io/img/BVB.png' },
  { id: 44, code: 'VCCB', bin: '970454', shortName: 'BVBank', name: 'Ngân hàng TMCP Bản Việt', logo: 'https://cdn.vietqr.io/img/VCCB.png' },
  { id: 31, code: 'SCB', bin: '970429', shortName: 'SCB', name: 'Ngân hàng TMCP Sài Gòn', logo: 'https://cdn.vietqr.io/img/SCB.png' },
  { id: 30, code: 'PVCB', bin: '970412', shortName: 'PVcomBank', name: 'Ngân hàng TMCP Đại Chúng Việt Nam', logo: 'https://cdn.vietqr.io/img/PVCB.png' },
  { id: 24, code: 'NCB', bin: '970419', shortName: 'NCB', name: 'Ngân hàng TMCP Quốc Dân', logo: 'https://cdn.vietqr.io/img/NCB.png' },
  { id: 19, code: 'KLB', bin: '970452', shortName: 'KienLongBank', name: 'Ngân hàng TMCP Kiên Long', logo: 'https://cdn.vietqr.io/img/KLB.png' },
  { id: 29, code: 'PGB', bin: '970430', shortName: 'PGBank', name: 'Ngân hàng TMCP Thịnh vượng và Phát triển', logo: 'https://cdn.vietqr.io/img/PGB.png' },
  { id: 46, code: 'VIETBANK', bin: '970433', shortName: 'VietBank', name: 'Ngân hàng TMCP Việt Nam Thương Tín', logo: 'https://cdn.vietqr.io/img/VIETBANK.png' },
  { id: 41, code: 'VAB', bin: '970427', shortName: 'VietABank', name: 'Ngân hàng TMCP Việt Á', logo: 'https://cdn.vietqr.io/img/VAB.png' },
  { id: 34, code: 'SGB', bin: '970400', shortName: 'SaigonBank', name: 'Ngân hàng TMCP Sài Gòn Công Thương', logo: 'https://cdn.vietqr.io/img/SGB.png' },
  { id: 25, code: 'OCEANBANK', bin: '970414', shortName: 'MBV', name: 'Ngân hàng TNHH MTV Việt Nam Hiện Đại', logo: 'https://cdn.vietqr.io/img/OCEANBANK.png' },
  { id: 9, code: 'COOPBANK', bin: '970446', shortName: 'CoopBank', name: 'Ngân hàng Hợp tác xã Việt Nam', logo: 'https://cdn.vietqr.io/img/COOPBANK.png' },
  { id: 53, code: 'CAKE', bin: '546034', shortName: 'CAKE', name: 'TMCP Việt Nam Thịnh Vượng - Ngân hàng số CAKE by VPBank', logo: 'https://cdn.vietqr.io/img/CAKE.png' },
  { id: 54, code: 'UBANK', bin: '546035', shortName: 'Ubank', name: 'TMCP Việt Nam Thịnh Vượng - Ngân hàng số Ubank by VPBank', logo: 'https://cdn.vietqr.io/img/UBANK.png' },
  { id: 58, code: 'TIMO', bin: '963388', shortName: 'Timo', name: 'Ngân hàng số Timo by Ban Viet Bank', logo: 'https://cdn.vietqr.io/img/TIMO.png' },
  { id: 49, code: 'WVN', bin: '970457', shortName: 'Woori', name: 'Ngân hàng TNHH MTV Woori Việt Nam', logo: 'https://cdn.vietqr.io/img/WVN.png' },
  { id: 37, code: 'SHBVN', bin: '970424', shortName: 'ShinhanBank', name: 'Ngân hàng TNHH MTV Shinhan Việt Nam', logo: 'https://cdn.vietqr.io/img/SHBVN.png' },
  { id: 14, code: 'HSBC', bin: '458761', shortName: 'HSBC', name: 'Ngân hàng TNHH MTV HSBC (Việt Nam)', logo: 'https://cdn.vietqr.io/img/HSBC.png' },
  { id: 32, code: 'SCVN', bin: '970410', shortName: 'StandardChartered', name: 'Ngân hàng TNHH MTV Standard Chartered Bank Việt Nam', logo: 'https://cdn.vietqr.io/img/SCVN.png' },
  { id: 40, code: 'UOB', bin: '970458', shortName: 'UnitedOverseas', name: 'Ngân hàng United Overseas - Chi nhánh TP. Hồ Chí Minh', logo: 'https://cdn.vietqr.io/img/UOB.png' },
  { id: 28, code: 'PBVN', bin: '970439', shortName: 'PublicBank', name: 'Ngân hàng TNHH MTV Public Việt Nam', logo: 'https://cdn.vietqr.io/img/PBVN.png' },
  { id: 7, code: 'CIMB', bin: '422589', shortName: 'CIMB', name: 'Ngân hàng TNHH MTV CIMB Việt Nam', logo: 'https://cdn.vietqr.io/img/CIMB.png' },
];

let vietQrBankCache = {
  items: null,
  expiresAt: 0,
};

async function fetchVietQrBanks() {
  const now = Date.now();
  if (vietQrBankCache.items && vietQrBankCache.expiresAt > now) {
    return { data: vietQrBankCache.items, cached: true };
  }

  const headers = { Accept: 'application/json' };
  if (process.env.VIETQR_CLIENT_ID) headers['x-client-id'] = process.env.VIETQR_CLIENT_ID;
  if (process.env.VIETQR_API_KEY) headers['x-api-key'] = process.env.VIETQR_API_KEY;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const resp = await fetch('https://api.vietqr.io/v2/banks', {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (resp.ok) {
      const json = await resp.json();
      if (json?.code === '00' && Array.isArray(json.data) && json.data.length > 0) {
        const normalized = json.data.map((b) => ({
          id: b.id,
          code: b.code || '',
          bin: b.bin || '',
          shortName: b.shortName || b.short_name || b.code || '',
          name: b.name || '',
          logo: b.logo || '',
          swift_code: b.swift_code || '',
          transferSupported: Number(b.transferSupported ?? b.isTransfer ?? 1),
        }));
        vietQrBankCache = {
          items: normalized,
          expiresAt: now + 12 * 60 * 60 * 1000,
        };
        return { data: normalized, cached: false };
      }
    }
  } catch (err) {
    console.warn('[VietQR Banks Warning]: Falling back to built-in bank catalog:', err.message);
  }

  return { data: vietQrBankCache.items || FALLBACK_VIETQR_BANKS, fallback: true };
}

async function attachOwnerPreviews(rows, orgId) {
  const ownerIds = Array.from(new Set((rows || []).map((r) => r.owner_id).filter(Boolean)));
  if (ownerIds.length === 0) {
    return (rows || []).map((r) => ({ ...r, owner_preview: null }));
  }
  const ownRes = await adminPool.query(
    'SELECT id, full_name, email, phone FROM owner WHERE org_id = $1 AND id = ANY($2::uuid[])',
    [orgId, ownerIds]
  );
  const byId = Object.fromEntries(ownRes.rows.map((o) => [o.id, buildOwnerPreview(o)]));
  return (rows || []).map((r) => ({
    ...r,
    owner_preview: r.owner_id ? byId[r.owner_id] || null : null,
  }));
}

/**
 * Helper kiểm tra quyền truy cập tòa nhà theo PRD v2.0 (v0.2) Mục 6.2 & AC-019.1:
 * - SYS_ADMIN: CRUD toàn bộ tòa trong tổ chức
 * - OWNER: R trên các tòa mình sở hữu (owner.person_id)
 * - MANAGER: RU trên tòa được gán (user_role.building_id) và CRU trên khu/tầng/căn hộ trong tòa đó
 * - RESIDENT: R trên tòa có hợp đồng / giữ chỗ của mình
 */
async function checkBuildingAccess(req, buildingId, requiredAction = 'read') {
  if (!buildingId || !UUID_RE.test(String(buildingId))) {
    return { allowed: false, status: 404, message: 'Không tìm thấy tòa nhà.' };
  }
  const userId = req.user.sub;
  const orgId = req.user.org_id;
  const userRoleCodes = getUserRoleCodes(req);

  // Kiểm tra sự tồn tại của tòa trong tổ chức (qua adminPool để phân biệt chuẩn 404 vs 403 AC-019.1)
  const bExist = await adminPool.query(
    'SELECT * FROM building WHERE id = $1 AND org_id = $2',
    [buildingId, orgId]
  );
  if (bExist.rows.length === 0) {
    return { allowed: false, status: 404, message: 'Không tìm thấy tòa nhà.' };
  }
  const buildingRow = bExist.rows[0];

  if (userRoleCodes.includes('SYS_ADMIN')) {
    return { allowed: true, status: 200, building: buildingRow, message: 'OK' };
  }

  if (userRoleCodes.includes('OWNER')) {
    if (requiredAction !== 'read') {
      await logAccessDenied(req, 'building', buildingId, `OWNER attempted ${requiredAction} on building`);
      return {
        allowed: false,
        status: 403,
        message: 'Chủ đầu tư (OWNER) có quyền Xem (R), không được Tạo/Sửa/Xóa tòa nhà.',
      };
    }
    const ownedIds = await getOwnerBuildingIds(userId, orgId);
    if (!ownedIds.includes(buildingId)) {
      await logAccessDenied(req, 'building', buildingId, 'OWNER accessed building owned by another owner');
      return {
        allowed: false,
        status: 403,
        message: 'Bạn không sở hữu tòa nhà này.',
      };
    }
    return { allowed: true, status: 200, building: buildingRow, message: 'OK' };
  }

  if (userRoleCodes.includes('MANAGER')) {
    if (requiredAction === 'delete') {
      await logAccessDenied(req, 'building', buildingId, 'MANAGER attempted delete action');
      return {
        allowed: false,
        status: 403,
        message: 'Quy tắc RBAC: Quản lý (MANAGER) chỉ có quyền CRU (Tạo, Xem, Sửa), không được Xóa.',
      };
    }

    const mgrIds = await getManagerBuildingIds(userId, orgId);
    if (!mgrIds.includes(buildingId)) {
      await logAccessDenied(req, 'building', buildingId, 'MANAGER accessed unassigned building (AC-019.1)');
      return {
        allowed: false,
        status: 403,
        message: 'Bạn không có quyền quản lý tòa nhà này.',
      };
    }
    return { allowed: true, status: 200, building: buildingRow, message: 'OK' };
  }

  if (userRoleCodes.includes('RESIDENT')) {
    if (requiredAction !== 'read') {
      await logAccessDenied(req, 'building', buildingId, `RESIDENT attempted ${requiredAction} on building`);
      return { allowed: false, status: 403, message: 'Cư dân chỉ có quyền xem thông tin căn hộ của mình.' };
    }
    const b = await pool.query(
      `SELECT b.* FROM building b
       WHERE b.id = $1 AND (
         EXISTS (
           SELECT 1 FROM contract c
           JOIN tenant t ON t.id = c.primary_tenant_id
           WHERE c.building_id = b.id AND t.person_id = $2
         )
         OR EXISTS (
           SELECT 1 FROM contract c
           JOIN contract_occupant co ON co.contract_id = c.id
           JOIN tenant t_occ ON t_occ.id = co.tenant_id
           WHERE c.building_id = b.id AND t_occ.person_id = $2
         )
         OR EXISTS (
           SELECT 1 FROM reservation rsv
           JOIN person p ON p.phone = rsv.phone
           WHERE rsv.building_id = b.id AND p.id = $2
         )
       )`,
      [buildingId, req.user.person_id]
    );
    if (b.rows.length === 0) {
      await logAccessDenied(req, 'building', buildingId, 'RESIDENT accessed building without contract/reservation');
      return { allowed: false, status: 403, message: 'Bạn không có quyền xem tòa nhà này.' };
    }
    return { allowed: true, status: 200, building: buildingRow, message: 'OK' };
  }

  await logAccessDenied(req, 'building', buildingId, 'Unrecognized role');
  return { allowed: false, status: 403, message: 'Bạn không có quyền truy cập.' };
}

/**
 * GET /api/v1/buildings/check-code?code=TN-A
 * Kiểm tra mã tòa có sẵn hay đã trùng (FR-007 / NV-03)
 */
router.get('/check-code', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']), async (req, res) => {
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
    const result = await adminPool.query(
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
 * - SYS_ADMIN: Xem toàn bộ tòa nhà trong tổ chức (CRUD)
 * - OWNER: Xem các tòa nhà thuộc sở hữu (R)
 * - MANAGER: Xem danh sách tòa nhà được phân công quản lý (RU)
 * - RESIDENT: Xem tòa nhà của căn hộ mình đang thuê (R)
 */
router.get('/', authenticateToken, async (req, res) => {
  try {
    const orgId = req.user.org_id;
    const userRoleCodes = getUserRoleCodes(req);
    const isSysAdmin = userRoleCodes.includes('SYS_ADMIN');
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

    if (isSysAdmin) {
      // SYS_ADMIN: Toàn bộ tòa thuộc org
    } else if (isOwner) {
      const { sql: ownerSql } = await ownerBuildingFilter('b.id', req.user.sub, orgId, params);
      sql += ownerSql;
    } else if (isManager) {
      const { sql: mgrSql } = await managerBuildingFilter('b.id', req.user.sub, orgId, params);
      sql += mgrSql;
    } else if (isResident) {
      params.push(req.user.person_id);
      const pIdx = params.length;
      sql += ` AND b.id IN (
        SELECT c.building_id FROM contract c
        JOIN tenant t ON t.id = c.primary_tenant_id
        WHERE t.person_id = $${pIdx}
        UNION
        SELECT c.building_id FROM contract c
        JOIN contract_occupant co ON co.contract_id = c.id
        JOIN tenant t_occ ON t_occ.id = co.tenant_id
        WHERE t_occ.person_id = $${pIdx}
      )`;
    } else {
      return res.json({ data: [] });
    }

    sql += ` ORDER BY b.code ASC, b.created_at ASC`;
    const result = await pool.query(sql, params);
    const enriched = await attachOwnerPreviews(result.rows, orgId);

    res.json({ data: enriched });
  } catch (err) {
    console.error('[Buildings Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Không thể lấy danh sách tòa nhà.' });
  }
});

/**
 * POST /api/v1/buildings (FR-007 / US-008 / NV-03 — TẠO TÒA NHÀ MỚI)
 * Quyền theo PRD v2.0 Mục 6.2 & FR-007:
 * - SYS_ADMIN (CRUD): Tạo tòa nhà mới cấp tổ chức.
 * - MANAGER (CRU): Khởi tạo tòa nhà mới và tự động nhận quyền quản lý (user_role) trên tòa vừa tạo.
 * - OWNER (R): Chỉ có quyền Xem.
 */
router.post('/', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
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

    // Dùng adminPool kiểm tra trùng mã toàn tổ chức (không lộ thông tin tòa khác cho MANAGER)
    const checkDup = await adminPool.query('SELECT id FROM building WHERE org_id = $1 AND code = $2', [orgId, cleanCode]);
    if (checkDup.rows.length > 0) {
      return res.status(409).json({
        code: 'BUILDING_CODE_EXISTS',
        message: `Mã tòa "${cleanCode}" đã tồn tại trong tổ chức.`,
      });
    }

    if (owner_id) {
      const ownerOk = await adminPool.query('SELECT 1 FROM owner WHERE id = $1 AND org_id = $2', [owner_id, orgId]);
      if (ownerOk.rows.length === 0) {
        return res.status(400).json({ code: 'INVALID_OWNER', message: 'Chủ sở hữu không tồn tại trong tổ chức.' });
      }
    }

    const newBuildingId = crypto.randomUUID();
    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      // Chèn tòa nhà trước (trigger AFTER INSERT tự động gán user_role MANAGER cho người tạo nếu là MANAGER),
      // sau đó SELECT lại bản ghi để tuân thủ đầy đủ rls_building_select.
      await client.query(
        `INSERT INTO building (id, org_id, owner_id, name, code, address, timezone, lease_terms, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')`,
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

      const selRes = await client.query('SELECT * FROM building WHERE id = $1', [newBuildingId]);
      const newBuilding = selRes.rows[0];

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'CREATE', 'building', $2, NULL, $3)`,
        [req.user.sub, newBuilding.id, JSON.stringify(newBuilding)]
      );

      await client.query('COMMIT');

      res.status(201).json({
        message: `Đã tạo tòa nhà ${newBuilding.name} (${newBuilding.code}) thành công.`,
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
 * GET /api/v1/buildings/lookup-owner?identifier=...
 * Cơ chế bảo mật Know-Before-You-Link (PRD FR-007 & FR-070 & NFR-007):
 * - KHÔNG công khai danh sách Chủ đầu tư.
 * - Chỉ khớp chính xác 100% Email hoặc SĐT 10 chữ số (không tìm kiếm gần đúng / wildcard).
 * - Có Rate Limit chống dò quét và chỉ trả về thông tin Chủ đầu tư đã che một phần (masked PII).
 */
router.get('/lookup-owner', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const raw = String(req.query.identifier || '').trim();
  if (!raw) {
    return res.status(400).json({
      code: 'MISSING_IDENTIFIER',
      message: 'Vui lòng nhập Email hoặc Số điện thoại của Chủ đầu tư để kiểm tra.',
    });
  }

  const rl = checkLookupRateLimit(ownerLookupBuckets, String(req.user.sub), 20, 5 * 60 * 1000);
  if (!rl.allowed) {
    return res.status(429).json({
      code: 'TOO_MANY_REQUESTS',
      message: `Bạn đã tra cứu quá nhiều lần. Vui lòng thử lại sau ${rl.retryAfterSec} giây.`,
    });
  }

  const isEmail = raw.includes('@');
  let cleanEmail = null;
  let cleanPhone = null;

  if (isEmail) {
    cleanEmail = raw.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(422).json({
        code: 'INVALID_EMAIL_FORMAT',
        message: 'Định dạng Email không hợp lệ (ví dụ hợp lệ: chudautu@congty.vn).',
      });
    }
  } else {
    cleanPhone = normalizeVnPhone(raw);
    if (!/^0[0-9]{9}$/.test(cleanPhone)) {
      return res.status(422).json({
        code: 'INVALID_PHONE_FORMAT',
        message: 'Số điện thoại không đúng định dạng 10 chữ số Việt Nam (ví dụ: 0912345678).',
      });
    }
  }

  try {
    const orgId = req.user.org_id;
    const ownerRes = isEmail
      ? await adminPool.query(
          'SELECT id, full_name, email, phone FROM owner WHERE org_id = $1 AND LOWER(email) = $2 LIMIT 1',
          [orgId, cleanEmail]
        )
      : await adminPool.query(
          'SELECT id, full_name, email, phone FROM owner WHERE org_id = $1 AND phone = $2 LIMIT 1',
          [orgId, cleanPhone]
        );

    if (ownerRes.rows.length === 0) {
      return res.json({
        found: false,
        owner: null,
        message:
          'Không tìm thấy hồ sơ Chủ đầu tư khớp với Email/SĐT này trong hệ thống. Vui lòng kiểm tra lại hoặc để trống để Quản trị hệ thống gán sau.',
      });
    }

    return res.json({
      found: true,
      owner: buildOwnerPreview(ownerRes.rows[0]),
      message: 'Đã tìm thấy hồ sơ Chủ đầu tư hợp lệ.',
    });
  } catch (err) {
    console.error('[Lookup Owner Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi tra cứu Chủ đầu tư.' });
  }
});

/**
 * GET /api/v1/buildings/owners — Chỉ SYS_ADMIN (quản trị cấp tổ chức) hoặc chính OWNER đó xem bản ghi của mình.
 * Tuyệt đối KHÔNG công khai danh sách Chủ đầu tư cho MANAGER.
 * Đặt TRƯỚC router.get('/:id') để không bị nuốt bởi pattern /:id
 */
router.get('/owners', authenticateToken, requireRole(['SYS_ADMIN', 'OWNER']), async (req, res) => {
  try {
    const roleCodes = getUserRoleCodes(req);
    const orgId = req.user.org_id;

    if (roleCodes.includes('SYS_ADMIN')) {
      const result = await pool.query(
        'SELECT id, full_name, email FROM owner WHERE org_id = $1 ORDER BY full_name ASC',
        [orgId]
      );
      return res.json({ data: result.rows });
    }

    const result = await pool.query(
      'SELECT id, full_name, email FROM owner WHERE org_id = $1 AND person_id = $2 ORDER BY full_name ASC',
      [orgId, req.user.person_id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[List Owners Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách chủ sở hữu.' });
  }
});

/**
 * GET /api/v1/buildings/banks
 * Danh mục ngân hàng Việt Nam từ VietQR.io (dùng cho dropdown chọn ngân hàng khi tạo/sửa tòa nhà)
 */
router.get('/banks', authenticateToken, async (_req, res) => {
  try {
    const result = await fetchVietQrBanks();
    res.json({ data: result.data, cached: Boolean(result.cached), fallback: Boolean(result.fallback) });
  } catch (err) {
    console.error('[VietQR Banks Error]:', err);
    res.json({ data: FALLBACK_VIETQR_BANKS, fallback: true });
  }
});

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const check = await checkBuildingAccess(req, id, 'read');
    if (!check.allowed) {
      return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
    }

    const zones = await pool.query(
      'SELECT id, code, name FROM zone WHERE building_id = $1 ORDER BY code ASC',
      [id]
    );
    const [withOwner] = await attachOwnerPreviews([check.building], req.user.org_id);

    res.json({ data: { ...withOwner, zones: zones.rows } });
  } catch (err) {
    console.error('[Building Detail Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải thông tin tòa nhà.' });
  }
});

/**
 * DELETE /api/v1/buildings/:id
 * Quyền theo PRD 6.2: Chỉ SYS_ADMIN có quyền D (xóa tòa nhà trống). MANAGER chỉ có CRU, OWNER chỉ có R.
 */
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const roleCodes = getUserRoleCodes(req);

    if (!roleCodes.includes('SYS_ADMIN')) {
      const checkRead = await checkBuildingAccess(req, id, 'update');
      if (!checkRead.allowed) {
        return res.status(checkRead.status).json({ code: 'FORBIDDEN', message: checkRead.message });
      }
      await logAccessDenied(req, 'building', id, 'MANAGER attempted to delete building (CRU only)');
      return res.status(403).json({
        code: 'DELETE_PROHIBITED',
        message: 'Thao tác xóa không được phép. Quyền của Quản lý là CRU (Tạo, Xem, Sửa), không được Xóa tòa nhà.',
      });
    }

    const access = await checkBuildingAccess(req, id, 'delete');
    if (!access.allowed) {
      return res.status(access.status).json({ code: 'FORBIDDEN', message: access.message });
    }

    const depRes = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM apartment WHERE building_id = $1) AS apt_cnt,
         (SELECT COUNT(*)::int FROM floor WHERE building_id = $1) AS floor_cnt,
         (SELECT COUNT(*)::int FROM zone WHERE building_id = $1) AS zone_cnt,
         (SELECT COUNT(*)::int FROM contract WHERE building_id = $1) AS contract_cnt`,
      [id]
    );
    const { apt_cnt, floor_cnt, zone_cnt, contract_cnt } = depRes.rows[0] || {};
    if (apt_cnt > 0 || floor_cnt > 0 || zone_cnt > 0 || contract_cnt > 0) {
      return res.status(400).json({
        code: 'BUILDING_NOT_EMPTY',
        message: 'Không thể xóa tòa nhà đang chứa phân khu, tầng, căn hộ hoặc hợp đồng.',
      });
    }

    const delRes = await pool.query('DELETE FROM building WHERE id = $1 RETURNING *', [id]);
    if (delRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
    }

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before)
       VALUES ($1, 'DELETE', 'building', $2, $3)`,
      [req.user.sub, id, JSON.stringify(delRes.rows[0])]
    );

    return res.json({ message: 'Đã xóa tòa nhà trống thành công.', data: delRes.rows[0] });
  } catch (err) {
    console.error('[Delete Building Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi xóa tòa nhà.' });
  }
});

/**
 * PATCH /api/v1/buildings/:id/status
 * Đổi trạng thái tòa nhà: ACTIVE <-> INACTIVE (State Machine NV-03)
 * Quyền: SYS_ADMIN hoặc MANAGER của tòa đó
 */
router.patch('/:id/status', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const check = await checkBuildingAccess(req, id, 'update');
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

    if (status === 'INACTIVE') {
      const activeContractsRes = await client.query(
        `SELECT COUNT(*) FROM contract WHERE building_id = $1 AND status = 'ACTIVE'`,
        [id]
      );
      const activeCount = parseInt(activeContractsRes.rows[0].count, 10);
      if (activeCount > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'ACTIVE_CONTRACTS_EXIST',
          message: `Không thể tạm dừng hoạt động tòa nhà này vì đang có ${activeCount} hợp đồng đang có hiệu lực. Vui lòng thanh lý hết hợp đồng trước.`,
        });
      }

      const heldRes = await client.query(
        `SELECT COUNT(*) FROM reservation WHERE building_id = $1 AND status = 'HELD'`,
        [id]
      );
      const heldCount = parseInt(heldRes.rows[0].count, 10);
      if (heldCount > 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'RESERVED_APARTMENTS_EXIST',
          message: `Không thể tạm dừng hoạt động tòa nhà này vì đang có ${heldCount} căn đang được giữ chỗ.`,
        });
      }
    }

    const updateRes = await client.query(
      `UPDATE building SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );

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
 * PATCH /api/v1/buildings/:id — sửa thông tin tòa:
 * - SYS_ADMIN: sửa mọi trường vận hành + owner_id
 * - MANAGER (được gán tòa): sửa thông tin vận hành (name, address, timezone, lease_terms, payment_account), KHÔNG được đổi owner_id
 */
router.patch('/:id', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { name, address, owner_id, timezone, lease_terms, payment_account } = req.body;
  const roleCodes = getUserRoleCodes(req);
  const isSysAdmin = roleCodes.includes('SYS_ADMIN');

  const check = await checkBuildingAccess(req, id, 'update');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }

  if (name !== undefined && (!name || name.trim().length < 2 || name.trim().length > 100)) {
    return res.status(422).json({ code: 'VALIDATION_ERROR', message: 'Tên tòa nhà phải từ 2 đến 100 ký tự.' });
  }

  try {
    // MANAGER chỉ được gắn owner_id nếu tòa nhà hiện đang chưa có chủ sở hữu (owner_id IS NULL);
    // nếu tòa nhà đã có chủ sở hữu, chỉ SYS_ADMIN mới được thay đổi / chuyển nhượng (FR-070).
    if (!isSysAdmin && owner_id !== undefined && owner_id !== check.building.owner_id) {
      if (check.building.owner_id !== null || !owner_id) {
        await logAccessDenied(req, 'building', id, 'MANAGER attempted to change existing building owner_id');
        return res.status(403).json({
          code: 'FORBIDDEN_OWNER_CHANGE',
          message: 'Chỉ Quản trị hệ thống (SYS_ADMIN) mới có quyền thay đổi Chủ sở hữu (owner_id) của tòa nhà đã gắn chủ đầu tư.',
        });
      }
    }

    if (owner_id !== undefined && owner_id !== null) {
      const ownerOk = await adminPool.query('SELECT 1 FROM owner WHERE id = $1 AND org_id = $2', [owner_id, req.user.org_id]);
      if (ownerOk.rows.length === 0) {
        return res.status(400).json({ code: 'INVALID_OWNER', message: 'Chủ sở hữu không tồn tại trong tổ chức.' });
      }
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const beforeRes = await client.query('SELECT * FROM building WHERE id = $1', [id]);
      if (beforeRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tòa nhà.' });
      }
      const before = beforeRes.rows[0];

      const oldTerms = before.lease_terms || {};
      const nextTerms = lease_terms === undefined && payment_account === undefined
        ? undefined
        : {
            ...oldTerms,
            ...(lease_terms || {}),
            ...(payment_account !== undefined ? { payment_account } : {}),
          };

      const canUpdateOwner =
        owner_id !== undefined && (isSysAdmin || (before.owner_id === null && Boolean(owner_id)));

      const updated = await client.query(
        `UPDATE building
         SET name = COALESCE($1, name),
             address = COALESCE($2, address),
             owner_id = CASE WHEN $3 THEN $4 ELSE owner_id END,
             timezone = COALESCE($5, timezone),
             lease_terms = COALESCE($6, lease_terms)
         WHERE id = $7
         RETURNING id, org_id, owner_id, name, code, address, timezone, lease_terms, status, created_at`,
        [
          name?.trim() || null,
          address?.trim() || null,
          canUpdateOwner,
          owner_id ?? null,
          timezone || null,
          nextTerms ? JSON.stringify(nextTerms) : null,
          id,
        ]
      );

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'UPDATE', 'building', $2, $3, $4)`,
        [req.user.sub, id, JSON.stringify(before), JSON.stringify(updated.rows[0])]
      );

      await client.query('COMMIT');
      res.json({ message: 'Cập nhật tòa nhà thành công.', data: updated.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      await release();
    }
  } catch (err) {
    console.error('[Update Building Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi cập nhật tòa nhà.' });
  }
});

/**
 * PATCH /api/v1/buildings/:id/floors/:floor_id — sửa tầng (B3): level, name.
 */
router.patch('/:id/floors/:floor_id', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id, floor_id } = req.params;
  const { level, name } = req.body;

  const check = await checkBuildingAccess(req, id, 'update');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }

  let lvl;
  if (level !== undefined) {
    lvl = parseInt(level, 10);
    if (isNaN(lvl)) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Số tầng phải là số nguyên (INTEGER).' });
    }
    const dup = await pool.query(
      'SELECT id FROM floor WHERE building_id = $1 AND level = $2 AND id <> $3',
      [id, lvl, floor_id]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ code: 'FLOOR_EXISTS', message: `Tầng ${lvl} đã tồn tại trong tòa nhà này.` });
    }
  }

  try {
    const before = await pool.query('SELECT * FROM floor WHERE id = $1 AND building_id = $2', [floor_id, id]);
    if (before.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tầng trong tòa này.' });
    }

    const result = await pool.query(
      `UPDATE floor SET level = COALESCE($1, level), name = COALESCE($2, name)
       WHERE id = $3 RETURNING *`,
      [lvl ?? null, name?.trim() || null, floor_id]
    );

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
       VALUES ($1, 'UPDATE', 'floor', $2, $3, $4)`,
      [req.user.sub, floor_id, JSON.stringify(before.rows[0]), JSON.stringify(result.rows[0])]
    );

    res.json({ message: 'Cập nhật tầng thành công.', data: result.rows[0] });
  } catch (err) {
    console.error('[Update Floor Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi cập nhật tầng.' });
  }
});

/**
 * GET /api/v1/buildings/:id/floor-map
 * Lấy sơ đồ tầng và căn hộ (FR-010)
 */
router.get('/:id/floor-map', authenticateToken, async (req, res) => {
  const { id } = req.params;

  const check = await checkBuildingAccess(req, id, 'read');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }

  try {
    const floorsRes = await pool.query(
      'SELECT * FROM floor WHERE building_id = $1 ORDER BY level DESC',
      [id]
    );

    const apartmentsRes = await pool.query(
      `SELECT a.*, z.code AS zone_code, z.name AS zone_name
       FROM apartment a
       LEFT JOIN zone z ON z.id = a.zone_id
       WHERE a.building_id = $1
       ORDER BY a.code ASC`,
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

  const check = await checkBuildingAccess(req, id, 'read');
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
 * Quyền: SYS_ADMIN hoặc MANAGER của tòa nhà đó
 */
router.post('/:id/floors', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { level, name } = req.body;

  const check = await checkBuildingAccess(req, id, 'create');
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

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'floor', $2, $3)`,
      [req.user.sub, result.rows[0].id, JSON.stringify(result.rows[0])]
    );

    res.status(201).json({ message: 'Tạo tầng thành công.', data: result.rows[0] });
  } catch (err) {
    console.error('[Create Floor Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo tầng.' });
  }
});

/**
 * DELETE /api/v1/buildings/:id/floors/:floor_id
 * Quyền theo PRD 6.2: Chỉ SYS_ADMIN có quyền D (xóa tầng rỗng). MANAGER chỉ có CRU, OWNER chỉ có R.
 */
router.delete('/:id/floors/:floor_id', authenticateToken, async (req, res) => {
  try {
    const { id, floor_id } = req.params;
    const roleCodes = getUserRoleCodes(req);

    if (!roleCodes.includes('SYS_ADMIN')) {
      const checkRead = await checkBuildingAccess(req, id, 'update');
      if (!checkRead.allowed) {
        return res.status(checkRead.status).json({ code: 'FORBIDDEN', message: checkRead.message });
      }

      const aptCountRes = await pool.query('SELECT COUNT(*) FROM apartment WHERE floor_id = $1', [floor_id]);
      const count = parseInt(aptCountRes.rows[0]?.count || 0, 10);
      if (count > 0) {
        return res.status(400).json({
          code: 'FLOOR_HAS_APARTMENTS',
          message: `Không thể xóa tầng này vì đang chứa ${count} căn hộ. Vui lòng chuyển hoặc xóa căn hộ trước.`,
        });
      }

      await logAccessDenied(req, 'floor', floor_id, 'MANAGER attempted to delete floor (CRU only)');
      return res.status(403).json({
        code: 'DELETE_PROHIBITED',
        message: 'Thao tác xóa không được phép. Quyền của Quản lý là CRU (Tạo, Xem, Sửa), không được Xóa tầng.',
      });
    }

    const access = await checkBuildingAccess(req, id, 'delete');
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

    const delRes = await pool.query(
      'DELETE FROM floor WHERE id = $1 AND building_id = $2 RETURNING *',
      [floor_id, id]
    );
    if (delRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy tầng trong tòa này.' });
    }

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before)
       VALUES ($1, 'DELETE', 'floor', $2, $3)`,
      [req.user.sub, floor_id, JSON.stringify(delRes.rows[0])]
    );

    return res.json({ message: 'Đã xóa tầng trống thành công.', data: delRes.rows[0] });
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
  const check = await checkBuildingAccess(req, id, 'read');
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
 * POST /api/v1/buildings/:id/zones — SYS_ADMIN / MANAGER khởi tạo khu (NV-03, FR-007)
 */
router.post('/:id/zones', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id } = req.params;
  const { code, name } = req.body;
  const check = await checkBuildingAccess(req, id, 'create');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }
  if (!code || !String(code).trim()) {
    return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Mã khu (code) là bắt buộc.' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO zone (org_id, building_id, code, name)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [check.building.org_id, id, String(code).trim().toUpperCase(), name || null]
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
 * PATCH /api/v1/buildings/:id/zones/:zone_id — đổi tên khu
 */
router.patch('/:id/zones/:zone_id', authenticateToken, requireRole(['SYS_ADMIN', 'MANAGER']), async (req, res) => {
  const { id, zone_id } = req.params;
  const { name } = req.body;
  const check = await checkBuildingAccess(req, id, 'update');
  if (!check.allowed) {
    return res.status(check.status).json({ code: 'ACCESS_DENIED', message: check.message });
  }
  try {
    const before = await pool.query('SELECT * FROM zone WHERE id = $1 AND building_id = $2', [zone_id, id]);
    if (before.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy khu trong tòa này.' });
    }
    const result = await pool.query(
      `UPDATE zone SET name = COALESCE($1, name), updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [name ?? null, zone_id]
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

/**
 * DELETE /api/v1/buildings/:id/zones/:zone_id
 * Quyền theo PRD 6.2: Chỉ SYS_ADMIN có quyền D (xóa khu rỗng). MANAGER chỉ có CRU, OWNER chỉ có R.
 */
router.delete('/:id/zones/:zone_id', authenticateToken, async (req, res) => {
  try {
    const { id, zone_id } = req.params;
    const roleCodes = getUserRoleCodes(req);

    if (!roleCodes.includes('SYS_ADMIN')) {
      const checkRead = await checkBuildingAccess(req, id, 'update');
      if (!checkRead.allowed) {
        return res.status(checkRead.status).json({ code: 'FORBIDDEN', message: checkRead.message });
      }

      const aptCountRes = await pool.query('SELECT COUNT(*) FROM apartment WHERE zone_id = $1', [zone_id]);
      const count = parseInt(aptCountRes.rows[0]?.count || 0, 10);
      if (count > 0) {
        return res.status(400).json({
          code: 'ZONE_HAS_APARTMENTS',
          message: `Không thể xóa phân khu này vì đang chứa ${count} căn hộ. Vui lòng gỡ phân khu khỏi các căn hộ trước.`,
        });
      }

      await logAccessDenied(req, 'zone', zone_id, 'MANAGER attempted to delete zone (CRU only)');
      return res.status(403).json({
        code: 'DELETE_PROHIBITED',
        message: 'Thao tác xóa không được phép. Quyền của Quản lý là CRU (Tạo, Xem, Sửa), không được Xóa phân khu.',
      });
    }

    const access = await checkBuildingAccess(req, id, 'delete');
    if (!access.allowed) {
      return res.status(access.status).json({ code: 'FORBIDDEN', message: access.message });
    }

    const aptCountRes = await pool.query('SELECT COUNT(*) FROM apartment WHERE zone_id = $1', [zone_id]);
    const count = parseInt(aptCountRes.rows[0]?.count || 0, 10);
    if (count > 0) {
      return res.status(400).json({
        code: 'ZONE_HAS_APARTMENTS',
        message: `Không thể xóa phân khu này vì đang chứa ${count} căn hộ. Vui lòng gỡ phân khu khỏi các căn hộ trước.`,
      });
    }

    const delRes = await pool.query(
      'DELETE FROM zone WHERE id = $1 AND building_id = $2 RETURNING *',
      [zone_id, id]
    );
    if (delRes.rows.length === 0) {
      return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy phân khu trong tòa này.' });
    }

    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, before)
       VALUES ($1, 'DELETE', 'zone', $2, $3)`,
      [req.user.sub, zone_id, JSON.stringify(delRes.rows[0])]
    );

    return res.json({ message: 'Đã xóa phân khu trống thành công.', data: delRes.rows[0] });
  } catch (err) {
    console.error('[Delete Zone Error]:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi máy chủ khi xóa phân khu.' });
  }
});

export default router;
