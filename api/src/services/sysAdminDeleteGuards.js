import { unlink } from 'node:fs/promises';
import path from 'node:path';

const UPLOADS_ROOT = path.join(process.cwd(), 'uploads');

export const DEFAULT_SYSTEM_SETTINGS = {
  billing_config: {
    billing_day: 1,
    payment_due_days: 5,
    due_date_offset_days: 5,
    late_fee_grace_days: 5,
    late_fee_per_day: 100000,
    late_fee_cap: null,
    meter_anomaly_threshold_pct: 30,
    reminder_days: [3, 7, 15],
    late_fee_percent: 0,
    electricity_default_price: 3800,
    water_default_price: 22000,
  },
  sla_config: {
    response_hours: 2,
    normal_resolve_hours: 24,
    urgent_resolve_hours: 4,
    deposit_refund_days: 5,
    reopen_window_days: 3,
  },
  contact_config: {
    working_hours: '08:00 – 18:00 (Thứ 2 – Thứ 7)',
    technical_hotline: '1900 6868',
    security_hotline: '1900 9119',
    emergency_phone: '0909 113 114',
    support_email: 'support@resihub.vn',
  },
  approval_config: {
    allow_self_approval: false,
  },
  reservation_cancel_policy: {
    max_hold_days: 30,
    public_max_hold_days: 7,
    full_refund_before_days: 3,
    partial_refund_pct: 50,
    default_hold_amount: 2000000,
  },
  ai_config: {
    enabled: true,
    cccd_extract_enabled: true,
    contract_extract_enabled: true,
    meter_ocr_enabled: true,
    ticket_triage_enabled: true,
    model: 'gemini-3.8-flash',
    confidence_threshold: 0.75,
    meter_ocr_threshold: 0.8,
    triage_threshold: 0.7,
    monthly_budget_vnd: 500000,
    monthly_token_limit: 2000000,
    warn_percent: 80,
    suggestion_ttl_hours: 72,
  },
};

export const VALID_SYSTEM_SETTING_KEYS = Object.keys(DEFAULT_SYSTEM_SETTINGS);

/**
 * Kiểm tra tòa nhà có thực sự trống trước khi xóa cứng (tránh xóa ngầm ON DELETE CASCADE).
 */
export async function checkBuildingEmptyForDelete(queryable, buildingId) {
  const depRes = await queryable.query(
    `SELECT
       (SELECT COUNT(*)::int FROM apartment WHERE building_id = $1) AS apt_cnt,
       (SELECT COUNT(*)::int FROM floor WHERE building_id = $1) AS floor_cnt,
       (SELECT COUNT(*)::int FROM zone WHERE building_id = $1) AS zone_cnt,
       (SELECT COUNT(*)::int FROM contract WHERE building_id = $1) AS contract_cnt,
       (SELECT COUNT(*)::int FROM reservation WHERE building_id = $1) AS reservation_cnt,
       (SELECT COUNT(*)::int FROM invoice WHERE building_id = $1) AS invoice_cnt,
       (SELECT COUNT(*)::int FROM service_request WHERE building_id = $1) AS ticket_cnt,
       (SELECT COUNT(*)::int FROM announcement WHERE building_id = $1) AS announcement_cnt,
       (SELECT COUNT(*)::int FROM ai_suggestion WHERE building_id = $1) AS ai_cnt,
       (SELECT COUNT(*)::int FROM zalo_group WHERE building_id = $1) AS zalo_cnt,
       (SELECT COUNT(*)::int FROM service_catalog WHERE building_id = $1) AS catalog_cnt`,
    [buildingId]
  );
  const counts = depRes.rows[0] || {};
  const total = Object.values(counts).reduce((sum, n) => sum + Number(n || 0), 0);
  return { empty: total === 0, counts };
}

/**
 * Kiểm tra căn hộ đã phát sinh lịch sử nghiệp vụ chưa (công tơ meter rỗng chưa có meter_reading vẫn được xóa).
 */
export async function checkApartmentHistoryForDelete(queryable, apartmentId) {
  const res = await queryable.query(
    `SELECT
       EXISTS (SELECT 1 FROM contract WHERE apartment_id = $1) AS has_contract,
       EXISTS (SELECT 1 FROM reservation WHERE apartment_id = $1) AS has_reservation,
       EXISTS (SELECT 1 FROM invoice WHERE apartment_id = $1) AS has_invoice,
       EXISTS (SELECT 1 FROM meter_reading WHERE apartment_id = $1) AS has_reading,
       EXISTS (SELECT 1 FROM service_request WHERE apartment_id = $1) AS has_ticket,
       EXISTS (SELECT 1 FROM service_subscription WHERE apartment_id = $1) AS has_subscription`,
    [apartmentId]
  );
  const row = res.rows[0] || {};
  if (row.has_contract || row.has_reservation) {
    return {
      hasHistory: true,
      reason: 'Không thể xóa căn hộ đã từng phát sinh hợp đồng hoặc giữ chỗ. Vui lòng chuyển sang trạng thái INACTIVE.',
    };
  }
  if (row.has_invoice || row.has_reading || row.has_ticket || row.has_subscription) {
    return {
      hasHistory: true,
      reason: 'Không thể xóa căn hộ đã có hóa đơn, chỉ số điện nước, đăng ký dịch vụ hoặc yêu cầu kỹ thuật. Vui lòng chuyển sang trạng thái INACTIVE.',
    };
  }
  return { hasHistory: false };
}

/**
 * Kiểm tra hồ sơ cư dân đã phát sinh hợp đồng, giữ chỗ (theo SĐT), hóa đơn hoặc giao dịch chưa.
 */
export async function checkTenantHistoryForDelete(queryable, { tenantId, orgId, phone = null }) {
  const cleanPhone = phone ? String(phone).trim() : null;
  const res = await queryable.query(
    `SELECT
       EXISTS (SELECT 1 FROM contract WHERE primary_tenant_id = $1) AS has_primary_contract,
       EXISTS (SELECT 1 FROM contract_occupant WHERE tenant_id = $1) AS has_occupant_contract,
       EXISTS (SELECT 1 FROM invoice WHERE tenant_id = $1) AS has_invoice,
       EXISTS (SELECT 1 FROM payment WHERE tenant_id = $1) AS has_payment,
       EXISTS (SELECT 1 FROM receivable WHERE tenant_id = $1) AS has_receivable,
       EXISTS (SELECT 1 FROM credit_balance WHERE tenant_id = $1) AS has_credit,
       EXISTS (SELECT 1 FROM service_request WHERE tenant_id = $1) AS has_ticket,
       ($3::text IS NOT NULL AND EXISTS (
         SELECT 1 FROM reservation WHERE org_id = $2 AND phone = $3
       )) AS has_reservation`,
    [tenantId, orgId, cleanPhone]
  );
  const r = res.rows[0] || {};
  if (r.has_primary_contract || r.has_occupant_contract) {
    return {
      hasHistory: true,
      reason: 'Không thể xóa hồ sơ cư dân đã gắn với hợp đồng thuê. Vui lòng lưu trữ ở trạng thái MOVED_OUT.',
    };
  }
  if (r.has_reservation) {
    return {
      hasHistory: true,
      reason: 'Không thể xóa hồ sơ cư dân đang có lịch sử đặt cọc giữ chỗ theo số điện thoại này.',
    };
  }
  if (r.has_invoice || r.has_payment || r.has_receivable || r.has_credit || r.has_ticket) {
    return {
      hasHistory: true,
      reason: 'Không thể xóa hồ sơ cư dân đã phát sinh hóa đơn, thanh toán, công nợ hoặc yêu cầu sửa chữa.',
    };
  }
  return { hasHistory: false };
}

/**
 * Kiểm tra tài khoản người dùng đã phát sinh dấu vết kiểm toán, sở hữu tòa nhà hoặc tác nghiệp vận hành chưa.
 * Bảo toàn tuyệt đối trigger bất biến prevent_audit_log_modification (mọi dòng audit_log đều chặn xóa).
 */
export async function checkUserHistoryForDelete(
  queryable,
  { userId, personId, orgId, phone = null, roleCodes = [] }
) {
  const cleanPhone = phone ? String(phone).trim() : null;
  const isResident = Array.isArray(roleCodes) && roleCodes.includes('RESIDENT');

  const res = await queryable.query(
    `SELECT
       EXISTS (
         SELECT 1 FROM owner o
         JOIN building b ON b.owner_id = o.id
         WHERE o.person_id = $2 AND o.org_id = $3
       ) AS owns_building,
       ($5::boolean AND $4::text IS NOT NULL AND EXISTS (
         SELECT 1 FROM reservation WHERE org_id = $3 AND phone = $4
       )) AS has_resident_reservation,
       EXISTS (SELECT 1 FROM audit_log WHERE actor_id = $1) AS has_audit,
       EXISTS (
         SELECT 1 FROM contract WHERE created_by = $1 OR approved_by = $1
         UNION ALL
         SELECT 1 FROM contract_version WHERE approved_by = $1
         UNION ALL
         SELECT 1 FROM contract_request WHERE created_by = $1
         UNION ALL
         SELECT 1 FROM reservation WHERE created_by = $1 OR confirmed_by = $1
         UNION ALL
         SELECT 1 FROM deposit_transaction WHERE created_by = $1 OR approved_by = $1
         UNION ALL
         SELECT 1 FROM invoice WHERE created_by = $1 OR issued_by = $1
         UNION ALL
         SELECT 1 FROM invoice_adjustment WHERE created_by = $1 OR updated_by = $1 OR approved_by = $1
         UNION ALL
         SELECT 1 FROM payment WHERE reported_by = $1 OR confirmed_by = $1
         UNION ALL
         SELECT 1 FROM credit_balance WHERE created_by = $1 OR updated_by = $1
         UNION ALL
         SELECT 1 FROM meter_reading WHERE recorded_by = $1 OR confirmed_by = $1
         UNION ALL
         SELECT 1 FROM service_subscription WHERE requested_by = $1 OR approved_by = $1
         UNION ALL
         SELECT 1 FROM service_request WHERE created_by = $1 OR assigned_to = $1 OR resolved_by = $1 OR ai_suggested_assignee_id = $1
         UNION ALL
         SELECT 1 FROM announcement WHERE created_by = $1 OR manual_sent_by = $1
         UNION ALL
         SELECT 1 FROM system_setting WHERE updated_by = $1
         UNION ALL
         SELECT 1 FROM zalo_group WHERE created_by = $1
         UNION ALL
         SELECT 1 FROM ai_suggestion WHERE created_by = $1 OR reviewed_by = $1
         UNION ALL
         SELECT 1 FROM attachment WHERE uploaded_by = $1
         UNION ALL
         SELECT 1 FROM tenant WHERE created_by = $1
         UNION ALL
         SELECT 1 FROM person WHERE created_by = $1 AND id <> $2
         LIMIT 1
       ) AS has_ops_ref`,
    [userId, personId, orgId, cleanPhone, isResident]
  );

  const r = res.rows[0] || {};
  if (r.owns_building) {
    return {
      hasHistory: true,
      reason: 'Không thể xóa tài khoản đang đứng tên Chủ đầu tư của tòa nhà. Vui lòng gỡ chủ sở hữu khỏi tòa nhà hoặc Tạm khóa (SUSPENDED).',
    };
  }
  if (r.has_resident_reservation) {
    return {
      hasHistory: true,
      reason: 'Không thể xóa tài khoản Cư dân đang gắn với lịch sử giữ chỗ. Vui lòng sử dụng chức năng Tạm khóa (SUSPENDED).',
    };
  }
  if (r.has_audit || r.has_ops_ref) {
    return {
      hasHistory: true,
      reason: 'Tài khoản đã phát sinh lịch sử thao tác hoặc phê duyệt trên hệ thống. Vui lòng sử dụng chức năng Tạm khóa (SUSPENDED) để bảo toàn dấu vết kiểm toán.',
    };
  }
  return { hasHistory: false };
}

/**
 * Dọn dẹp bản ghi định danh person (kèm owner rỗng / app_user RESIDENT tự sinh rỗng / attachment)
 * trong cùng transaction khi không còn thực thể nào khác tham chiếu.
 */
export async function cleanupOrphanedPersonInTx(
  client,
  { personId, orgId, allowAutoDeletePureResidentUser = false }
) {
  let residentUserDeleted = false;
  let ownerDeleted = false;
  let personDeleted = false;
  const deletedPaths = [];

  if (!personId) {
    return { personDeleted, residentUserDeleted, ownerDeleted, deletedPaths };
  }

  const personRes = await client.query('SELECT id, phone FROM person WHERE id = $1 AND org_id = $2', [
    personId,
    orgId,
  ]);
  if (personRes.rows.length === 0) {
    return { personDeleted, residentUserDeleted, ownerDeleted, deletedPaths };
  }
  const personPhone = personRes.rows[0].phone || null;

  const remTenantsRes = await client.query('SELECT COUNT(*)::int AS cnt FROM tenant WHERE person_id = $1', [
    personId,
  ]);
  if ((remTenantsRes.rows[0]?.cnt || 0) > 0) {
    return { personDeleted, residentUserDeleted, ownerDeleted, deletedPaths };
  }

  // Nếu xóa từ luồng Cư dân: tự động dọn tài khoản RESIDENT tự sinh (nếu không mang role nội bộ và chưa có lịch sử)
  if (allowAutoDeletePureResidentUser) {
    const usersRes = await client.query(
      `SELECT au.id,
              ARRAY_REMOVE(ARRAY_AGG(DISTINCT r.code), NULL) AS role_codes
       FROM app_user au
       LEFT JOIN user_role ur ON ur.user_id = au.id
       LEFT JOIN role r ON r.id = ur.role_id
       WHERE au.person_id = $1
       GROUP BY au.id`,
      [personId]
    );

    const ownCntRes = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM owner WHERE person_id = $1',
      [personId]
    );
    const hasOwnerRecord = (ownCntRes.rows[0]?.cnt || 0) > 0;

    if (!hasOwnerRecord && usersRes.rows.length === 1) {
      const candidate = usersRes.rows[0];
      const codes = Array.isArray(candidate.role_codes) ? candidate.role_codes : [];
      const hasInternalRole = codes.some((c) => ['SYS_ADMIN', 'OWNER', 'MANAGER'].includes(c));

      if (!hasInternalRole) {
        const hist = await checkUserHistoryForDelete(client, {
          userId: candidate.id,
          personId,
          orgId,
          phone: personPhone,
          roleCodes: codes,
        });
        if (!hist.hasHistory) {
          await client.query('DELETE FROM app_user WHERE id = $1', [candidate.id]);
          residentUserDeleted = true;
        }
      }
    }
  }

  const remUsersRes = await client.query('SELECT COUNT(*)::int AS cnt FROM app_user WHERE person_id = $1', [
    personId,
  ]);
  if ((remUsersRes.rows[0]?.cnt || 0) > 0) {
    return { personDeleted, residentUserDeleted, ownerDeleted, deletedPaths };
  }

  // Kiểm tra bảng owner (FK owner.person_id -> person.id là NO ACTION nên phải xóa owner rỗng trước)
  const ownerBldgRes = await client.query(
    `SELECT o.id,
            EXISTS (SELECT 1 FROM building b WHERE b.owner_id = o.id) AS has_bldg
     FROM owner o
     WHERE o.person_id = $1`,
    [personId]
  );
  if (ownerBldgRes.rows.some((o) => o.has_bldg)) {
    return { personDeleted, residentUserDeleted, ownerDeleted, deletedPaths };
  }
  if (ownerBldgRes.rows.length > 0) {
    await client.query('DELETE FROM owner WHERE person_id = $1 AND org_id = $2', [personId, orgId]);
    ownerDeleted = true;
  }

  // Dọn các bản ghi attachment thuộc về person trước khi xóa person
  const attRes = await client.query(
    `DELETE FROM attachment
     WHERE owner_entity = 'person' AND owner_id = $1
     RETURNING storage_path`,
    [personId]
  );
  for (const row of attRes.rows) {
    if (row.storage_path) deletedPaths.push(row.storage_path);
  }

  await client.query('DELETE FROM person WHERE id = $1 AND org_id = $2', [personId, orgId]);
  personDeleted = true;

  return { personDeleted, residentUserDeleted, ownerDeleted, deletedPaths };
}

/**
 * Xóa file vật lý trong uploads/ một cách an toàn sau khi transaction DB đã COMMIT.
 */
export async function unlinkStoragePathsBestEffort(storagePaths = []) {
  for (const relPath of storagePaths) {
    if (!relPath || typeof relPath !== 'string') continue;
    if (!relPath.startsWith('uploads/') || relPath.includes('..')) continue;
    const absPath = path.join(process.cwd(), relPath);
    if (!absPath.startsWith(UPLOADS_ROOT + path.sep)) continue;
    try {
      await unlink(absPath);
    } catch {
      // Best-effort: bỏ qua nếu file không còn trên đĩa
    }
  }
}
