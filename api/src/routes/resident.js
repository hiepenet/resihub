import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';

const router = express.Router();

/**
 * GET /api/v1/resident/overview
 * Cung cấp toàn bộ dữ liệu cổng cư dân theo vai trò RESIDENT:
 * - Thông tin cá nhân
 * - Hợp đồng đang thuê (nếu có)
 * - Đặt cọc giữ chỗ (nếu có - NV-06)
 * - Hồ sơ đăng ký thuê đang chờ duyệt (nếu có - FR-012)
 * - Danh sách căn hộ trống khả dụng (AVAILABLE) để khám phá
 */
router.get('/overview', authenticateToken, async (req, res) => {
  try {
    const personId = req.user.person_id;
    const orgId = req.user.org_id;

    // 1. Lấy thông tin person
    const personRes = await pool.query(
      'SELECT id, full_name, phone, email, dob, id_number FROM person WHERE id = $1',
      [personId]
    );
    const user = personRes.rows[0] || {
      full_name: req.user.name || 'Cư dân',
      phone: req.user.phone || '',
      email: req.user.email || '',
    };

    const userPhone = user.phone || '';
    const cleanPhone = userPhone.startsWith('+84') ? '0' + userPhone.slice(3) : userPhone;

    // 2. Kiểm tra hợp đồng đang thuê (status = ACTIVE)
    const contractRes = await pool.query(
      `SELECT 
         c.id as contract_id,
         c.start_date,
         c.end_date,
         c.rent_amount,
         c.billing_cycle,
         c.billing_day,
         c.payment_due_days,
         c.deposit_amount,
         c.status as contract_status,
         c.note as contract_note,
         c.created_at as contract_created_at,
         a.id as apartment_id,
         a.code as apartment_code,
         a.area_m2,
         a.bedrooms,
         a.type as apartment_type,
         a.amenities,
         b.id as building_id,
         b.name as building_name,
         b.address as building_address,
         f.name as floor_name,
         d.amount_held as deposit_held_amount,
         d.status as deposit_status
       FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       LEFT JOIN floor f ON f.id = a.floor_id
       LEFT JOIN deposit d ON d.contract_id = c.id
       WHERE t.person_id = $1 AND c.status = 'ACTIVE'
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [personId]
    );

    const contract = contractRes.rows[0] || null;
    const hasContract = !!contract;

    // 3. Kiểm tra đặt cọc giữ chỗ (reservation status = HELD)
    let reservation = null;
    if (cleanPhone) {
      const reservationRes = await pool.query(
        `SELECT 
           r.id as reservation_id,
           r.hold_amount,
           r.hold_until,
           r.status as reservation_status,
           r.note as reservation_note,
           r.created_at as reservation_created_at,
           a.id as apartment_id,
           a.code as apartment_code,
           a.area_m2,
           a.base_rent,
           b.id as building_id,
           b.name as building_name,
           b.address as building_address,
           pm.full_name as manager_name,
           pm.phone as manager_phone
         FROM reservation r
         JOIN apartment a ON a.id = r.apartment_id
         JOIN building b ON b.id = r.building_id
         LEFT JOIN user_role ur ON ur.building_id = b.id
         LEFT JOIN app_user au ON au.id = ur.user_id
         LEFT JOIN person pm ON pm.id = au.person_id
         WHERE (r.phone = $1 OR r.phone = $2) AND r.status = 'HELD'
         ORDER BY r.created_at DESC
         LIMIT 1`,
        [cleanPhone, userPhone]
      );
      reservation = reservationRes.rows[0] || null;
    }

    // 4. Kiểm tra hồ sơ cư dân tự khai đang chờ duyệt (FR-012)
    const pendingAppRes = await pool.query(
      `SELECT t.id, t.status, t.created_at
       FROM tenant t
       WHERE t.person_id = $1 AND t.status = 'PENDING'
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [personId]
    );
    const pendingApplication = pendingAppRes.rows[0] || null;

    // 5. Danh sách căn hộ trống khả dụng (AVAILABLE) để khách khám phá
    const availableAptsRes = await pool.query(
      `SELECT 
         a.id, a.code, a.area_m2, a.type, a.bedrooms, a.base_rent, a.amenities,
         b.id as building_id, b.name as building_name, b.address as building_address,
         f.name as floor_name
       FROM apartment a
       JOIN building b ON b.id = a.building_id
       LEFT JOIN floor f ON f.id = a.floor_id
       WHERE a.status = 'AVAILABLE' AND b.status = 'ACTIVE'
       ORDER BY b.name ASC, a.code ASC
       LIMIT 8`
    );

    // 6. Thông tin liên hệ BQL tòa nhà
    const targetBuildingId = contract?.building_id || reservation?.building_id || null;
    let managerContactRes;
    if (targetBuildingId) {
      managerContactRes = await pool.query(
        `SELECT p.full_name, p.phone, p.email, b.name as building_name
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
         JOIN app_user au ON au.id = ur.user_id
         JOIN person p ON p.id = au.person_id
         JOIN building b ON b.id = ur.building_id
         WHERE r.code = 'MANAGER' AND ur.building_id = $1
         LIMIT 1`,
        [targetBuildingId]
      );
    }
    if (!managerContactRes || managerContactRes.rows.length === 0) {
      managerContactRes = await pool.query(
        `SELECT p.full_name, p.phone, p.email, b.name as building_name
         FROM user_role ur
         JOIN role r ON r.id = ur.role_id
         JOIN app_user au ON au.id = ur.user_id
         JOIN person p ON p.id = au.person_id
         LEFT JOIN building b ON b.id = ur.building_id
         WHERE r.code = 'MANAGER'
         LIMIT 1`
      );
    }
    const managerContact = managerContactRes.rows[0] || {
      full_name: 'Ban Quản Lý ResiHub',
      phone: '0901234567',
      email: 'manager@resihub.vn',
    };

    res.json({
      data: {
        user,
        has_contract: hasContract,
        contract,
        reservation,
        pending_application: pendingApplication,
        available_apartments: availableAptsRes.rows,
        manager_contact: managerContact,
      },
    });
  } catch (err) {
    console.error('Lỗi lấy dữ liệu cổng cư dân:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi tải dữ liệu cổng cư dân.' });
  }
});

/**
 * POST /api/v1/resident/rental-application (FR-012)
 * Cư dân tự khai hồ sơ thuê phòng gửi Ban Quản Lý duyệt
 */
router.post('/rental-application', authenticateToken, async (req, res) => {
  const { full_name, id_number, dob, desired_apartment_id, note } = req.body;
  const personId = req.user.person_id;
  const orgId = req.user.org_id;

  if (!full_name?.trim()) {
    return res.status(400).json({ code: 'INVALID_INPUT', message: 'Vui lòng nhập họ và tên.' });
  }

  const { client, release } = await getUserClient(req);
  try {
    await client.query('BEGIN');

    // Cập nhật thông tin person
    await client.query(
      `UPDATE person
       SET full_name = $1,
           id_number = COALESCE($2, id_number),
           dob = COALESCE($3::date, dob),
           updated_at = NOW()
       WHERE id = $4`,
      [full_name.trim(), id_number?.trim() || null, dob || null, personId]
    );

    // Tạo hồ sơ tenant ở trạng thái PENDING
    let tenantRes = await client.query(
      'SELECT id FROM tenant WHERE person_id = $1 AND status = \'PENDING\'',
      [personId]
    );

    let tenantId;
    if (tenantRes.rows.length === 0) {
      const newTenant = await client.query(
        `INSERT INTO tenant (person_id, org_id, type, status)
         VALUES ($1, $2, 'primary', 'PENDING')
         RETURNING id`,
        [personId, orgId]
      );
      tenantId = newTenant.rows[0].id;
    } else {
      tenantId = tenantRes.rows[0].id;
    }

    // Ghi audit log
    await client.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'tenant_application', $2, $3)`,
      [
        req.user.sub,
        tenantId,
        JSON.stringify({ full_name, id_number, desired_apartment_id, note }),
      ]
    );

    await client.query('COMMIT');

    res.status(201).json({
      message: 'Hồ sơ nhận nhà đã được gửi thành công. Ban Quản Lý sẽ liên hệ và duyệt hồ sơ trong thời gian sớm nhất!',
      data: { tenant_id: tenantId },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Lỗi nộp hồ sơ thuê nhà:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi nộp hồ sơ thuê nhà.' });
  } finally {
    await release();
  }
});

/**
 * POST /api/v1/resident/service-requests (FR-042)
 * Cư dân gửi yêu cầu sửa chữa / báo hỏng thiết bị
 */
router.post('/service-requests', authenticateToken, async (req, res) => {
  const { title, description, urgency, apartment_id } = req.body;

  if (!title?.trim() || !description?.trim()) {
    return res.status(400).json({ code: 'INVALID_INPUT', message: 'Vui lòng cung cấp tiêu đề và mô tả sự cố.' });
  }

  try {
    // Ghi audit log hoặc phiếu yêu cầu
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'service_request', gen_random_uuid(), $2)`,
      [
        req.user.sub,
        JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          urgency: urgency || 'NORMAL',
          apartment_id,
          created_at: new Date().toISOString(),
        }),
      ]
    );

    res.status(201).json({
      message: 'Đã tiếp nhận yêu cầu báo hỏng. Kỹ thuật viên tòa nhà sẽ liên hệ hỗ trợ bạn sớm nhất.',
    });
  } catch (err) {
    console.error('Lỗi gửi yêu cầu hỗ trợ:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi ghi nhận yêu cầu hỗ trợ.' });
  }
});

/**
 * GET /api/v1/resident/contract-requests (FR-019)
 * Danh sách đề nghị gia hạn / chấm dứt của cư dân
 */
router.get('/contract-requests', authenticateToken, async (req, res) => {
  try {
    const personId = req.user.person_id;
    const userId = req.user.sub;

    const query = `
      SELECT cr.id, cr.type, cr.desired_date, cr.note, cr.status, cr.created_at, cr.updated_at,
             c.id as contract_id,
             a.code as apartment_code,
             b.name as building_name
      FROM contract_request cr
      JOIN contract c ON c.id = cr.contract_id
      JOIN apartment a ON a.id = c.apartment_id
      JOIN building b ON b.id = cr.building_id
      WHERE cr.created_by = $1
         OR c.primary_tenant_id IN (SELECT id FROM tenant WHERE person_id = $2)
      ORDER BY cr.created_at DESC
    `;
    const result = await pool.query(query, [userId, personId]);
    res.json({ data: result.rows });
  } catch (err) {
    console.error('Lỗi lấy danh sách đề nghị:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi lấy danh sách đề nghị hợp đồng.' });
  }
});

/**
 * POST /api/v1/resident/contract-requests (FR-019, AC-006.1)
 * Cư dân gửi đề nghị gia hạn hoặc chấm dứt hợp đồng
 */
router.post('/contract-requests', authenticateToken, async (req, res) => {
  const { type, desired_date, note } = req.body;
  if (!['RENEWAL', 'TERMINATION'].includes(type)) {
    return res.status(400).json({ code: 'INVALID_TYPE', message: 'Loại đề nghị phải là RENEWAL hoặc TERMINATION.' });
  }

  try {
    const personId = req.user.person_id;
    const userId = req.user.sub;

    // Tìm hợp đồng ACTIVE của cư dân
    const contractRes = await pool.query(
      `SELECT c.id, c.building_id, c.org_id, c.end_date, a.code as apartment_code
       FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN apartment a ON a.id = c.apartment_id
       WHERE t.person_id = $1 AND c.status = 'ACTIVE'
       ORDER BY c.created_at DESC
       LIMIT 1`,
      [personId]
    );

    if (contractRes.rows.length === 0) {
      return res.status(404).json({ code: 'CONTRACT_NOT_FOUND', message: 'Bạn không có hợp đồng thuê nào đang hiệu lực để gửi đề nghị.' });
    }

    const contract = contractRes.rows[0];

    if (type === 'TERMINATION') {
      if (!desired_date) {
        return res.status(422).json({ code: 'INVALID_DATE', message: 'Vui lòng chọn ngày mong muốn chấm dứt hợp đồng.' });
      }
      const desired = new Date(desired_date);
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (desired < today) {
        return res.status(422).json({ code: 'INVALID_DATE', message: 'Ngày mong muốn chấm dứt phải từ hôm nay trở đi.' });
      }
    }

    const insertRes = await pool.query(
      `INSERT INTO contract_request (org_id, contract_id, building_id, type, desired_date, note, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'SUBMITTED', $7)
       RETURNING *`,
      [contract.org_id, contract.id, contract.building_id, type, desired_date || null, note?.trim() || null, userId]
    );

    // Ghi audit log
    await pool.query(
      `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
       VALUES ($1, 'CREATE', 'contract_request', $2, $3)`,
      [userId, insertRes.rows[0].id, JSON.stringify({ type, desired_date, note, contract_id: contract.id })]
    );

    const noticeNotice = type === 'TERMINATION'
      ? 'Theo quy định (AC-006.1), đề nghị chấm dứt cần báo trước tối thiểu 30 ngày để BQL sắp xếp kiểm tra bàn giao phòng.'
      : 'BQL sẽ liên hệ để thống nhất điều khoản gia hạn và lập phụ lục hợp đồng.';

    res.status(201).json({
      message: 'Gửi đề nghị thành công. ' + noticeNotice,
      data: insertRes.rows[0],
      notice_period_info: noticeNotice,
    });
  } catch (err) {
    console.error('Lỗi gửi đề nghị hợp đồng:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi gửi đề nghị hợp đồng.' });
  }
});

/**
 * GET /api/v1/resident/deposit-transactions (D9, AC-024.1)
 * Sổ cọc & Bảng kê giao dịch của cư dân
 */
router.get('/deposit-transactions', authenticateToken, async (req, res) => {
  try {
    const personId = req.user.person_id;

    const contractRes = await pool.query(
      `SELECT c.id as contract_id, c.status as contract_status, c.deposit_amount, c.start_date, c.end_date,
              d.id as deposit_id, d.amount_held, d.status as deposit_status, d.settlement,
              a.code as apartment_code, b.name as building_name
       FROM contract c
       JOIN tenant t ON t.id = c.primary_tenant_id
       JOIN apartment a ON a.id = c.apartment_id
       JOIN building b ON b.id = c.building_id
       LEFT JOIN deposit d ON d.contract_id = c.id
       WHERE t.person_id = $1
       ORDER BY (CASE WHEN c.status = 'ACTIVE' THEN 0 ELSE 1 END), c.created_at DESC
       LIMIT 1`,
      [personId]
    );

    if (contractRes.rows.length === 0) {
      return res.json({ data: { contract: null, deposit: null, transactions: [] } });
    }

    const contractInfo = contractRes.rows[0];
    let transactions = [];

    if (contractInfo.deposit_id) {
      const txRes = await pool.query(
        `SELECT id, type, amount, category, method, note, status, created_at
         FROM deposit_transaction
         WHERE deposit_id = $1 AND status = 'APPROVED'
         ORDER BY created_at ASC`,
        [contractInfo.deposit_id]
      );
      transactions = txRes.rows;
    }

    res.json({
      data: {
        contract: {
          id: contractInfo.contract_id,
          status: contractInfo.contract_status,
          deposit_amount: contractInfo.deposit_amount,
          start_date: contractInfo.start_date,
          end_date: contractInfo.end_date,
          apartment_code: contractInfo.apartment_code,
          building_name: contractInfo.building_name,
        },
        deposit: contractInfo.deposit_id ? {
          id: contractInfo.deposit_id,
          amount_held: contractInfo.amount_held,
          status: contractInfo.deposit_status,
          settlement: contractInfo.settlement,
        } : null,
        transactions,
      },
    });
  } catch (err) {
    console.error('Lỗi lấy sổ cọc cư dân:', err);
    res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi lấy thông tin sổ cọc.' });
  }
});

export default router;
