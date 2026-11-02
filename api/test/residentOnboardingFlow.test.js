import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const API_BASE = process.env.TEST_API_BASE || 'http://127.0.0.1:5000';
const ADMIN_DB_URL =
  process.env.DATABASE_URL ||
  'postgres://postgres:postgres@127.0.0.1:5433/resihub';
const APP_DB_URL =
  process.env.APP_DATABASE_URL ||
  'postgres://resihub_app:resihub_app_secret@127.0.0.1:5433/resihub';

async function login(email, password) {
  const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json();
  assert.equal(res.status, 200, `Login failed for ${email}: ${JSON.stringify(body)}`);
  return { token: body.accessToken, user: body.user };
}

async function apiFetch(path, token, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('application/json') ? await res.json() : await res.text();
  return { status: res.status, body };
}

function vnDaysFromToday(offsetDays) {
  const vnTodayStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = vnTodayStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
}

test('Task 1 — Migration 040 Schema & RLS: desired_building_id visibility & OWNER person-attachment block', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const appPool = new pg.Pool({ connectionString: APP_DB_URL });

  let createdPersonId = null;
  let createdAttachmentId = null;

  t.after(async () => {
    if (createdAttachmentId) {
      await adminPool.query('DELETE FROM attachment WHERE id = $1', [createdAttachmentId]);
    }
    if (createdPersonId) {
      await adminPool.query(
        'DELETE FROM user_role WHERE user_id IN (SELECT id FROM app_user WHERE person_id = $1)',
        [createdPersonId]
      );
      await adminPool.query('DELETE FROM app_user WHERE person_id = $1', [createdPersonId]);
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [createdPersonId]);
      await adminPool.query('DELETE FROM person WHERE id = $1', [createdPersonId]);
    }
    await adminPool.end();
    await appPool.end();
  });

  const mgrA = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const mgrB = await login('manager.vop.b@resihub.vn', 'Demo@123456');
  const ownerVop = await login('owner.vop@resihub.vn', 'Demo@123456');

  const mgrADb = await adminPool.query(
    `SELECT au.id AS user_id, p.org_id
     FROM app_user au JOIN person p ON p.id = au.person_id
     WHERE LOWER(p.email) = 'manager.vop.a@resihub.vn' LIMIT 1`
  );
  const mgrBDb = await adminPool.query(
    `SELECT au.id AS user_id
     FROM app_user au JOIN person p ON p.id = au.person_id
     WHERE LOWER(p.email) = 'manager.vop.b@resihub.vn' LIMIT 1`
  );
  const mgrAUserId = mgrADb.rows[0].user_id;
  const mgrBUserId = mgrBDb.rows[0].user_id;
  const ownerDb = await adminPool.query(
    `SELECT au.id AS user_id
     FROM app_user au JOIN person p ON p.id = au.person_id
     WHERE LOWER(p.email) = 'owner.vop@resihub.vn' LIMIT 1`
  );
  const ownerUserId = ownerDb.rows[0].user_id;
  const orgId = mgrADb.rows[0].org_id;

  const aptsRes = await apiFetch('/api/v1/apartments?limit=5', mgrA.token);
  assert.equal(aptsRes.status, 200);
  assert.ok(aptsRes.body.data.length > 0, 'Expected at least 1 apartment in Manager A building');
  const aptAId = aptsRes.body.data[0].id;
  const bldgAId = aptsRes.body.data[0].building_id;

  await adminPool.query(
    `DELETE FROM user_role WHERE user_id IN (SELECT au.id FROM app_user au JOIN person p ON p.id = au.person_id WHERE p.phone = '0961040001')`
  );
  await adminPool.query(
    `DELETE FROM app_user WHERE person_id IN (SELECT id FROM person WHERE phone = '0961040001')`
  );
  await adminPool.query(
    `DELETE FROM tenant WHERE person_id IN (SELECT id FROM person WHERE phone = '0961040001')`
  );
  await adminPool.query(`DELETE FROM person WHERE phone = '0961040001'`);

  // Create self-registered resident + tenant application targeting Building A (without reservation or contract)
  const pIns = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone, id_number, privacy_consent_at, privacy_policy_version)
     VALUES ($1, 'Ứng Viên Tự Khai Task 1', '0961040001', '001204040001', NOW(), 'v1.0')
     RETURNING id`,
    [orgId]
  );
  createdPersonId = pIns.rows[0].id;

  const uIns = await adminPool.query(
    `INSERT INTO app_user (person_id, auth_uid, status)
     VALUES ($1, 'user_0961040001', 'ACTIVE')
     RETURNING id`,
    [createdPersonId]
  );
  const residentUserId = uIns.rows[0].id;
  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id)
     SELECT $1, id, NULL FROM role WHERE code = 'RESIDENT' LIMIT 1`,
    [residentUserId]
  );
  await adminPool.query('UPDATE person SET created_by = $1 WHERE id = $2', [residentUserId, createdPersonId]);

  const tIns = await adminPool.query(
    `INSERT INTO tenant (
       person_id, org_id, type, status, created_by,
       desired_apartment_id, desired_building_id, application_note, rejection_reason
     ) VALUES ($1, $2, 'primary', 'PENDING', $3, $4, $5, 'Muốn dọn vào đầu tháng', NULL)
     RETURNING id`,
    [createdPersonId, orgId, residentUserId, aptAId, bldgAId]
  );
  const tenantId = tIns.rows[0].id;

  const attIns = await adminPool.query(
    `INSERT INTO attachment (owner_entity, owner_id, storage_path, mime, size_bytes, uploaded_by)
     VALUES ('person', $1, 'uploads/person/mock_cccd_task1.jpg', 'image/jpeg', 1024, $2)
     RETURNING id`,
    [createdPersonId, residentUserId]
  );
  createdAttachmentId = attIns.rows[0].id;

  async function queryAsUser(userId, sql, params) {
    const c = await appPool.connect();
    try {
      await c.query(`SELECT set_config('app.current_user_id', $1, false)`, [userId]);
      return await c.query(sql, params);
    } finally {
      await c.query('RESET app.current_user_id').catch(() => {});
      c.release();
    }
  }

  // Manager A (manages desired_building_id) MUST see person, tenant, and person attachment
  const mgrAPerson = await queryAsUser(mgrAUserId, 'SELECT id FROM person WHERE id = $1', [createdPersonId]);
  assert.equal(mgrAPerson.rows.length, 1, 'Manager A must see applicant person via desired_building_id');

  const mgrATenant = await queryAsUser(mgrAUserId, 'SELECT id FROM tenant WHERE id = $1', [tenantId]);
  assert.equal(mgrATenant.rows.length, 1, 'Manager A must see applicant tenant via desired_building_id');

  const mgrAAtt = await queryAsUser(mgrAUserId, 'SELECT id FROM attachment WHERE id = $1', [createdAttachmentId]);
  assert.equal(mgrAAtt.rows.length, 1, 'Manager A must see applicant CCCD attachment');

  // Manager B (other building) MUST NOT see person, tenant, or attachment
  const mgrBPerson = await queryAsUser(mgrBUserId, 'SELECT id FROM person WHERE id = $1', [createdPersonId]);
  assert.equal(mgrBPerson.rows.length, 0, 'Manager B must NOT see Building A applicant person');

  const mgrBTenant = await queryAsUser(mgrBUserId, 'SELECT id FROM tenant WHERE id = $1', [tenantId]);
  assert.equal(mgrBTenant.rows.length, 0, 'Manager B must NOT see Building A applicant tenant');

  const mgrBAtt = await queryAsUser(mgrBUserId, 'SELECT id FROM attachment WHERE id = $1', [createdAttachmentId]);
  assert.equal(mgrBAtt.rows.length, 0, 'Manager B must NOT see Building A applicant attachment');

  // Resident (self) MUST see own attachment
  const resAtt = await queryAsUser(residentUserId, 'SELECT id FROM attachment WHERE id = $1', [createdAttachmentId]);
  assert.equal(resAtt.rows.length, 1, 'Resident must see own CCCD attachment');

  // OWNER of Building A MUST NOT see raw person CCCD attachment (PRD 13.5)
  const ownerAtt = await queryAsUser(ownerUserId, 'SELECT id FROM attachment WHERE id = $1', [createdAttachmentId]);
  assert.equal(ownerAtt.rows.length, 0, 'OWNER must NOT read raw person CCCD attachment per PRD 13.5');
});

test('Task 2 — Reservation auto-provisions preliminary person & OTP RESIDENT account without overwriting existing identity', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const testPhoneRaw = '+84 961 040 002';
  const testPhoneClean = '0961040002';
  const existingPhone = '0961040003';

  let createdReservationIds = [];

  async function cleanup() {
    for (const rId of createdReservationIds) {
      const rRow = await adminPool.query('SELECT apartment_id FROM reservation WHERE id = $1', [rId]);
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]);
      if (rRow.rows[0]?.apartment_id) {
        await adminPool.query(
          `UPDATE apartment SET status = 'AVAILABLE'
           WHERE id = $1 AND status = 'RESERVED'
             AND NOT EXISTS (SELECT 1 FROM reservation WHERE apartment_id = $1 AND status = 'HELD')`,
          [rRow.rows[0].apartment_id]
        );
      }
    }
    await adminPool.query(
      'DELETE FROM reservation WHERE phone = ANY($1::text[])',
      [[testPhoneClean, testPhoneRaw, existingPhone]]
    );
    await adminPool.query(
      `DELETE FROM user_role WHERE user_id IN (
         SELECT au.id FROM app_user au JOIN person p ON p.id = au.person_id
         WHERE p.phone = ANY($1::text[])
       )`,
      [[testPhoneClean, existingPhone]]
    );
    await adminPool.query(
      'DELETE FROM app_user WHERE person_id IN (SELECT id FROM person WHERE phone = ANY($1::text[]))',
      [[testPhoneClean, existingPhone]]
    );
    await adminPool.query(
      'DELETE FROM tenant WHERE person_id IN (SELECT id FROM person WHERE phone = ANY($1::text[]))',
      [[testPhoneClean, existingPhone]]
    );
    await adminPool.query('DELETE FROM person WHERE phone = ANY($1::text[])', [[testPhoneClean, existingPhone]]);
  }

  t.after(async () => {
    await cleanup();
    await adminPool.end();
  });

  await cleanup();

  const mgrA = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const aptsRes = await apiFetch('/api/v1/apartments?status=AVAILABLE&limit=20', mgrA.token);
  assert.equal(aptsRes.status, 200);
  const apt1 = aptsRes.body.data[0];
  const apt2 = aptsRes.body.data[1] || apt1;
  assert.ok(apt1, 'Need at least 1 AVAILABLE apartment');

  const dFrom = vnDaysFromToday(2);
  const dUntil = vnDaysFromToday(9);

  // 1. Create reservation for brand-new phone
  const rsvRes = await apiFetch('/api/v1/reservations', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt1.id,
      prospect_name: 'Khách Giữ Chỗ Mới',
      phone: testPhoneRaw,
      hold_amount: 2000000,
      hold_from: dFrom,
      hold_until: dUntil,
      note: 'Giữ chỗ chờ khai hồ sơ online',
    }),
  });
  assert.equal(rsvRes.status, 201, `Create reservation failed: ${JSON.stringify(rsvRes.body)}`);
  createdReservationIds.push(rsvRes.body.data.id);
  assert.equal(rsvRes.body.data.phone, testPhoneClean, 'Reservation phone must be normalized');

  // 2. Request OTP & login as RESIDENT immediately
  const otpReq = await apiFetch('/api/v1/auth/otp/request', null, {
    method: 'POST',
    body: JSON.stringify({ phone: testPhoneClean }),
  });
  assert.equal(otpReq.status, 200);
  assert.ok(otpReq.body.devOtp, 'Expected devOtp to be issued for newly reserved prospect phone');

  const otpVerify = await apiFetch('/api/v1/auth/otp/verify', null, {
    method: 'POST',
    body: JSON.stringify({ phone: testPhoneClean, otp: otpReq.body.devOtp }),
  });
  assert.equal(otpVerify.status, 200, `OTP verify failed: ${JSON.stringify(otpVerify.body)}`);
  assert.ok(otpVerify.body.accessToken, 'Expected JWT accessToken');

  const meRes = await apiFetch('/api/v1/resident/overview', otpVerify.body.accessToken);
  assert.equal(meRes.status, 200);
  assert.equal(meRes.body.data.reservation?.reservation_id, rsvRes.body.data.id, 'Resident portal must display active reservation');

  // 2b. If prospect walks in instead of self-onboarding:
  //     - check-dup for Manager A must NOT falsely flag inScope=false or block UI creation before a tenant row exists
  //     - Manager creating tenant profile for testPhoneClean must upgrade the preliminary person -> 201
  //     - 2nd attempt after tenant row exists -> check-dup isDuplicate=true (inScope=true) & POST -> 409 DUPLICATE_PHONE
  const checkDupPre = await apiFetch(`/api/v1/tenants/check-dup?phone=${testPhoneClean}`, mgrA.token);
  assert.equal(checkDupPre.status, 200);
  assert.equal(checkDupPre.body.isDuplicate, false, 'Preliminary reservation person without tenant row must not block UI check-dup');
  assert.equal(checkDupPre.body.inScope, true);

  const walkInTenant = await apiFetch('/api/v1/tenants', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Khách Giữ Chỗ Mới (Ký Trực Tiếp)',
      phone: testPhoneClean,
      id_number: '001204040002',
    }),
  });
  assert.equal(walkInTenant.status, 201, `Expected 201 upgrading preliminary reservation person, got: ${JSON.stringify(walkInTenant.body)}`);
  assert.equal(walkInTenant.body.data.status, 'APPROVED');

  const dupWalkIn = await apiFetch('/api/v1/tenants', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Tạo Lặp Lần 2',
      phone: testPhoneClean,
    }),
  });
  assert.equal(dupWalkIn.status, 409);
  assert.equal(dupWalkIn.body.code, 'DUPLICATE_PHONE');

  // 3. Existing resident identity must NOT be overwritten by a new reservation prospect_name
  const createTenantRes = await apiFetch('/api/v1/tenants', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Tên Gốc Cư Dân Cũ',
      phone: existingPhone,
      id_number: '001204040003',
    }),
  });
  assert.equal(createTenantRes.status, 201);

  const dFrom2 = vnDaysFromToday(12);
  const dUntil2 = vnDaysFromToday(18);
  const rsvExisting = await apiFetch('/api/v1/reservations', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt2.id,
      prospect_name: 'Tên Gọi Tạm Khi Đặt Cọc',
      phone: existingPhone,
      hold_amount: 1000000,
      hold_from: dFrom2,
      hold_until: dUntil2,
    }),
  });
  assert.equal(rsvExisting.status, 201);
  createdReservationIds.push(rsvExisting.body.data.id);

  const checkPerson = await adminPool.query('SELECT full_name FROM person WHERE phone = $1', [existingPhone]);
  assert.equal(checkPerson.rows[0].full_name, 'Tên Gốc Cư Dân Cũ', 'Must not overwrite existing person full_name');
});

// Tiny valid 1x1 PNG base64 data URI for CCCD upload tests
const TINY_PNG_BASE64 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('Task 3 — Resident self-onboarding (FR-012): consent, CCCD upload, duplicate 409, manager visibility/notification & reject/resubmit/approve loop', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const applicantPhone = '0961040004';
  const applicantCccd = '001204040004';
  const otherPhone = '0961040005';
  const otherCccd = '001204040005';

  let reservationId = null;
  let reservedAptId = null;

  async function cleanup() {
    if (reservationId) {
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [reservationId]);
    }
    if (reservedAptId) {
      await adminPool.query(
        `UPDATE apartment SET status = 'AVAILABLE'
         WHERE id = $1 AND status = 'RESERVED'
           AND NOT EXISTS (SELECT 1 FROM reservation WHERE apartment_id = $1 AND status = 'HELD')`,
        [reservedAptId]
      );
    }
    const pRes = await adminPool.query(
      'SELECT id FROM person WHERE phone = ANY($1::text[]) OR id_number = ANY($2::text[])',
      [[applicantPhone, otherPhone], [applicantCccd, otherCccd]]
    );
    for (const row of pRes.rows) {
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'person' AND owner_id = $1", [row.id]);
      const uRes = await adminPool.query('SELECT id FROM app_user WHERE person_id = $1', [row.id]);
      for (const u of uRes.rows) {
        await adminPool.query('DELETE FROM notification WHERE user_id = $1', [u.id]);
        await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [u.id]);
        const hasAudit = await adminPool.query('SELECT 1 FROM audit_log WHERE actor_id = $1 LIMIT 1', [u.id]);
        if (hasAudit.rows.length === 0) {
          await adminPool.query('DELETE FROM app_user WHERE id = $1', [u.id]);
        } else {
          await adminPool.query('UPDATE app_user SET person_id = NULL, auth_uid = $2 WHERE id = $1', [
            u.id,
            `archived_${u.id}`,
          ]);
        }
      }
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [row.id]);
      await adminPool.query('DELETE FROM person WHERE id = $1', [row.id]);
    }
  }

  t.after(async () => {
    await cleanup();
    await adminPool.end();
  });

  await cleanup();

  const mgrA = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const mgrB = await login('manager.vop.b@resihub.vn', 'Demo@123456');

  // Seed another person holding otherCccd to test 409 DUPLICATE_ID_NUMBER
  const seedOther = await apiFetch('/api/v1/tenants', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Người Khác Đã Có CCCD',
      phone: otherPhone,
      id_number: otherCccd,
    }),
  });
  assert.equal(seedOther.status, 201);

  // 1. Manager A creates reservation for applicantPhone -> apartment becomes RESERVED
  const aptsRes = await apiFetch('/api/v1/apartments?status=AVAILABLE&limit=10', mgrA.token);
  const targetApt = aptsRes.body.data[0];
  assert.ok(targetApt);
  reservedAptId = targetApt.id;

  const dFrom = vnDaysFromToday(1);
  const dUntil = vnDaysFromToday(7);
  const rsv = await apiFetch('/api/v1/reservations', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: targetApt.id,
      prospect_name: 'Lê Thị Tự Khai',
      phone: applicantPhone,
      hold_amount: 3000000,
      hold_from: dFrom,
      hold_until: dUntil,
    }),
  });
  assert.equal(rsv.status, 201);
  reservationId = rsv.body.data.id;

  // Applicant logs in via OTP
  const otpReq = await apiFetch('/api/v1/auth/otp/request', null, {
    method: 'POST',
    body: JSON.stringify({ phone: applicantPhone }),
  });
  const otpVer = await apiFetch('/api/v1/auth/otp/verify', null, {
    method: 'POST',
    body: JSON.stringify({ phone: applicantPhone, otp: otpReq.body.devOtp }),
  });
  assert.equal(otpVer.status, 200);
  const resToken = otpVer.body.accessToken;

  // 2. Submitting without privacy_consent -> 400 PRIVACY_CONSENT_REQUIRED
  const noConsent = await apiFetch('/api/v1/resident/rental-application', resToken, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Lê Thị Tự Khai',
      id_number: applicantCccd,
      desired_apartment_id: targetApt.id,
    }),
  });
  assert.equal(noConsent.status, 400);
  assert.equal(noConsent.body.code, 'PRIVACY_CONSENT_REQUIRED');

  // 3. Submitting with duplicate id_number -> 409 DUPLICATE_ID_NUMBER (not 500)
  const dupIdRes = await apiFetch('/api/v1/resident/rental-application', resToken, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Lê Thị Tự Khai',
      id_number: otherCccd,
      desired_apartment_id: targetApt.id,
      privacy_consent: true,
    }),
  });
  assert.equal(dupIdRes.status, 409);
  assert.equal(dupIdRes.body.code, 'DUPLICATE_ID_NUMBER');

  // 4. Resident uploads front & back CCCD images via /api/v1/resident/id-images
  const upFront = await apiFetch('/api/v1/resident/id-images', resToken, {
    method: 'POST',
    body: JSON.stringify({ side: 'front', image_base64: TINY_PNG_BASE64 }),
  });
  assert.equal(upFront.status, 201);
  const upBack = await apiFetch('/api/v1/resident/id-images', resToken, {
    method: 'POST',
    body: JSON.stringify({ side: 'back', image_base64: TINY_PNG_BASE64 }),
  });
  assert.equal(upBack.status, 201);

  // 5. Valid application submission (targeting their RESERVED apartment)
  const submitRes = await apiFetch('/api/v1/resident/rental-application', resToken, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Lê Thị Tự Khai Chính Thức',
      id_number: applicantCccd,
      dob: '1998-05-20',
      desired_apartment_id: targetApt.id,
      note: 'Mong nhận phòng sáng thứ 7',
      privacy_consent: true,
    }),
  });
  assert.equal(submitRes.status, 201, `Submit failed: ${JSON.stringify(submitRes.body)}`);
  const tenantId = submitRes.body.data.tenant_id;
  assert.ok(tenantId);

  // 6. Manager A sees tenant in GET /api/v1/tenants with desired_apartment_code & application_note; Manager B does not
  const mgrAList = await apiFetch('/api/v1/tenants', mgrA.token);
  assert.equal(mgrAList.status, 200);
  const foundInA = mgrAList.body.data.find((x) => x.id === tenantId);
  assert.ok(foundInA, 'Manager A must see self-submitted tenant in /api/v1/tenants');
  assert.equal(foundInA.desired_apartment_code, targetApt.code);
  assert.equal(foundInA.application_note, 'Mong nhận phòng sáng thứ 7');
  assert.ok(foundInA.privacy_consent_at, 'privacy_consent_at must be recorded');

  const mgrBList = await apiFetch('/api/v1/tenants', mgrB.token);
  assert.equal(mgrBList.body.data.find((x) => x.id === tenantId), undefined, 'Manager B must NOT see applicant');

  // Manager A received a notification about the new application
  const mgrANotifs = await apiFetch('/api/v1/notifications', mgrA.token);
  assert.ok(
    mgrANotifs.body.data.some((n) => n.type === 'TENANT_APPLICATION' && n.payload?.tenant_id === tenantId),
    'Manager A must receive TENANT_APPLICATION notification'
  );

  // 7. Manager A rejects without reason -> 400 REASON_REQUIRED
  const rejectNoReason = await apiFetch(`/api/v1/tenants/${tenantId}`, mgrA.token, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'reject' }),
  });
  assert.equal(rejectNoReason.status, 400);
  assert.equal(rejectNoReason.body.code, 'REASON_REQUIRED');

  // 8. Manager A rejects WITH reason -> 200 REJECTED + notification to resident + overview shows rejection_reason
  const rejectOk = await apiFetch(`/api/v1/tenants/${tenantId}`, mgrA.token, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'reject', reason: 'Ảnh mặt sau CCCD bị mờ, vui lòng chụp rõ hơn' }),
  });
  assert.equal(rejectOk.status, 200);
  assert.equal(rejectOk.body.data.status, 'REJECTED');
  assert.equal(rejectOk.body.data.rejection_reason, 'Ảnh mặt sau CCCD bị mờ, vui lòng chụp rõ hơn');

  const ovAfterReject = await apiFetch('/api/v1/resident/overview', resToken);
  assert.equal(ovAfterReject.body.data.onboarding_application?.status, 'REJECTED');
  assert.equal(
    ovAfterReject.body.data.onboarding_application?.rejection_reason,
    'Ảnh mặt sau CCCD bị mờ, vui lòng chụp rõ hơn'
  );

  const resNotifs1 = await apiFetch('/api/v1/notifications', resToken);
  assert.ok(
    resNotifs1.body.data.some((n) => n.type === 'TENANT_APPLICATION_REJECTED'),
    'Resident must receive TENANT_APPLICATION_REJECTED notification'
  );

  // 9. Resident resubmits -> resets status to PENDING and clears rejection_reason
  const resubmit = await apiFetch('/api/v1/resident/rental-application', resToken, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Lê Thị Tự Khai Chính Thức',
      id_number: applicantCccd,
      dob: '1998-05-20',
      desired_apartment_id: targetApt.id,
      note: 'Đã tải lại ảnh CCCD rõ nét',
      privacy_consent: true,
    }),
  });
  assert.equal(resubmit.status, 201);
  assert.equal(resubmit.body.data.tenant_id, tenantId, 'Resubmit should reuse rejected tenant record');

  // 10. Manager A approves -> status APPROVED + notification to resident
  const approveOk = await apiFetch(`/api/v1/tenants/${tenantId}`, mgrA.token, {
    method: 'PATCH',
    body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(approveOk.status, 200);
  assert.equal(approveOk.body.data.status, 'APPROVED');
  assert.equal(approveOk.body.data.rejection_reason, null);

  const resNotifs2 = await apiFetch('/api/v1/notifications', resToken);
  assert.ok(
    resNotifs2.body.data.some((n) => n.type === 'TENANT_APPLICATION_APPROVED'),
    'Resident must receive TENANT_APPLICATION_APPROVED notification'
  );
});

test('Task 4 — Occupant active_contract resolution, has_past_contract flag & OWNER PII masking/attachment 403 (PRD 13.5)', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const occPhone = '0961040006';
  const occCccd = '001204040006';

  let createdOccTenantId = null;
  let linkedContractId = null;

  async function cleanup() {
    if (linkedContractId && createdOccTenantId) {
      await adminPool.query(
        'DELETE FROM contract_occupant WHERE contract_id = $1 AND tenant_id = $2',
        [linkedContractId, createdOccTenantId]
      );
    }
    const pRes = await adminPool.query('SELECT id FROM person WHERE phone = $1 OR id_number = $2', [
      occPhone,
      occCccd,
    ]);
    for (const row of pRes.rows) {
      await adminPool.query("DELETE FROM attachment WHERE owner_entity = 'person' AND owner_id = $1", [row.id]);
      const uRes = await adminPool.query('SELECT id FROM app_user WHERE person_id = $1', [row.id]);
      for (const u of uRes.rows) {
        await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [u.id]);
        const hasAudit = await adminPool.query('SELECT 1 FROM audit_log WHERE actor_id = $1 LIMIT 1', [u.id]);
        if (hasAudit.rows.length === 0) {
          await adminPool.query('DELETE FROM app_user WHERE id = $1', [u.id]);
        } else {
          await adminPool.query('UPDATE app_user SET person_id = NULL, auth_uid = $2 WHERE id = $1', [
            u.id,
            `archived_${u.id}`,
          ]);
        }
      }
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [row.id]);
      await adminPool.query('DELETE FROM person WHERE id = $1', [row.id]);
    }
  }

  t.after(async () => {
    await cleanup();
    await adminPool.end();
  });

  await cleanup();

  const mgrA = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const ownerVop = await login('owner.vop@resihub.vn', 'Demo@123456');

  // 1. Manager A creates a new occupant profile with privacy_consent = true & uploads front CCCD
  const createOcc = await apiFetch('/api/v1/tenants', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Phạm Văn Ở Ghép Task 4',
      phone: occPhone,
      id_number: occCccd,
      type: 'occupant',
      privacy_consent: true,
    }),
  });
  assert.equal(createOcc.status, 201);
  createdOccTenantId = createOcc.body.data.id;
  assert.equal(createOcc.body.data.type, 'occupant');
  assert.equal(createOcc.body.data.status, 'APPROVED');

  const upImg = await apiFetch(`/api/v1/tenants/${createdOccTenantId}/id-images`, mgrA.token, {
    method: 'POST',
    body: JSON.stringify({ side: 'front', image_base64: TINY_PNG_BASE64 }),
  });
  assert.equal(upImg.status, 201);
  const attId = upImg.body.data.attachment_id;

  // Before attaching to any contract: active_contract === null & has_past_contract === false
  const listBefore = await apiFetch('/api/v1/tenants', mgrA.token);
  const rowBefore = listBefore.body.data.find((x) => x.id === createdOccTenantId);
  assert.ok(rowBefore);
  assert.equal(rowBefore.active_contract, null);
  assert.equal(rowBefore.has_past_contract, false, 'Newly created tenant must have has_past_contract = false');
  assert.ok(rowBefore.privacy_consent_at, 'Admin-created tenant with privacy_consent must record timestamp');

  // 2. Attach occupant to an existing ACTIVE contract in Manager A's building
  const activeContractsRes = await apiFetch('/api/v1/contracts?status=ACTIVE&limit=10', mgrA.token);
  assert.equal(activeContractsRes.status, 200);
  const activeContract = activeContractsRes.body.data[0];
  assert.ok(activeContract, 'Expected at least 1 ACTIVE contract in Manager A building');
  linkedContractId = activeContract.id;

  await adminPool.query(
    `INSERT INTO contract_occupant (contract_id, tenant_id, relationship)
     VALUES ($1, $2, 'roommate')
     ON CONFLICT DO NOTHING`,
    [linkedContractId, createdOccTenantId]
  );

  // Now GET /api/v1/tenants & GET /api/v1/tenants/:id MUST resolve active_contract for this occupant
  const listAfter = await apiFetch('/api/v1/tenants', mgrA.token);
  const rowAfter = listAfter.body.data.find((x) => x.id === createdOccTenantId);
  assert.ok(rowAfter?.active_contract, 'Occupant in ACTIVE contract must have active_contract populated');
  assert.equal(rowAfter.active_contract.contract_id, linkedContractId);

  const detailMgr = await apiFetch(`/api/v1/tenants/${createdOccTenantId}`, mgrA.token);
  assert.equal(detailMgr.status, 200);
  assert.equal(detailMgr.body.data.id_number, occCccd, 'MANAGER must see full id_number');
  assert.ok(
    detailMgr.body.data.contracts.some((c) => c.id === linkedContractId),
    'Occupant detail must include contract from contract_occupant'
  );

  // 3. OWNER of VOP building MUST receive masked id_number & be blocked from raw CCCD attachment
  const ownerList = await apiFetch('/api/v1/tenants', ownerVop.token);
  const ownerRow = ownerList.body.data.find((x) => x.id === createdOccTenantId);
  assert.ok(ownerRow, 'OWNER must see occupant in owned building list');
  assert.notEqual(ownerRow.id_number, occCccd, 'OWNER must NOT receive raw id_number in list');
  assert.ok(ownerRow.id_number.endsWith('0006') && ownerRow.id_number.includes('*'));

  const ownerDetail = await apiFetch(`/api/v1/tenants/${createdOccTenantId}`, ownerVop.token);
  assert.equal(ownerDetail.status, 200);
  assert.notEqual(ownerDetail.body.data.id_number, occCccd, 'OWNER must NOT receive raw id_number in detail');
  assert.ok(ownerDetail.body.data.id_number.endsWith('0006') && ownerDetail.body.data.id_number.includes('*'));

  const ownerImgs = await apiFetch(`/api/v1/tenants/${createdOccTenantId}/id-images`, ownerVop.token);
  assert.equal(ownerImgs.status, 200);
  assert.equal(ownerImgs.body.data.length, 0, 'OWNER must not receive raw CCCD attachment list');
  assert.equal(ownerImgs.body.masked_for_owner, true);
  assert.equal(ownerImgs.body.has_id_images, true);

  const ownerViewAtt = await apiFetch(`/api/v1/attachments/${attId}/view`, ownerVop.token);
  assert.equal(ownerViewAtt.status, 403, 'OWNER must receive 403 when attempting to view raw CCCD image');
});

test('Final Review Fixes — (1) block applying to another prospect RESERVED apartment, (2) validate phone in reservations, (3) block conflicting CCCD on occupant phone', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const prospectAPhone = '0961040091';
  const prospectBPhone = '0961040092';
  const occConflictPhone = '0961040093';
  const occOriginalCccd = '001204040093';
  const occDifferentCccd = '001204049999';

  const createdRsvIds = [];
  let reservedAptId = null;
  let occContractId = null;
  let occTenantIdToDetach = null;

  async function cleanup() {
    if (occContractId && occTenantIdToDetach) {
      await adminPool.query(
        'DELETE FROM contract_occupant WHERE contract_id = $1 AND tenant_id = $2',
        [occContractId, occTenantIdToDetach]
      );
    }
    for (const rId of createdRsvIds) {
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]);
    }
    await adminPool.query(
      'DELETE FROM reservation WHERE phone = ANY($1::text[])',
      [[prospectAPhone, prospectBPhone, '09123']]
    );
    if (reservedAptId) {
      await adminPool.query(
        `UPDATE apartment SET status = 'AVAILABLE'
         WHERE id = $1 AND status = 'RESERVED'
           AND NOT EXISTS (SELECT 1 FROM reservation WHERE apartment_id = $1 AND status = 'HELD')`,
        [reservedAptId]
      );
    }
    const pRes = await adminPool.query(
      'SELECT id FROM person WHERE phone = ANY($1::text[]) OR id_number = ANY($2::text[])',
      [[prospectAPhone, prospectBPhone, occConflictPhone, '09123'], [occOriginalCccd, occDifferentCccd]]
    );
    for (const row of pRes.rows) {
      await adminPool.query(
        'DELETE FROM contract_occupant WHERE tenant_id IN (SELECT id FROM tenant WHERE person_id = $1)',
        [row.id]
      );
      const uRes = await adminPool.query('SELECT id FROM app_user WHERE person_id = $1', [row.id]);
      for (const u of uRes.rows) {
        await adminPool.query('DELETE FROM notification WHERE user_id = $1', [u.id]);
        await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [u.id]);
        const hasAudit = await adminPool.query('SELECT 1 FROM audit_log WHERE actor_id = $1 LIMIT 1', [u.id]);
        if (hasAudit.rows.length === 0) {
          await adminPool.query('DELETE FROM app_user WHERE id = $1', [u.id]);
        } else {
          await adminPool.query('UPDATE app_user SET person_id = NULL, auth_uid = $2 WHERE id = $1', [
            u.id,
            `archived_${u.id}`,
          ]);
        }
      }
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [row.id]);
      await adminPool.query('DELETE FROM person WHERE id = $1', [row.id]);
    }
  }

  t.after(async () => {
    await cleanup();
    await adminPool.end();
  });

  await cleanup();

  const mgrA = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const aptsRes = await apiFetch('/api/v1/apartments?status=AVAILABLE&limit=10', mgrA.token);
  const targetApt = aptsRes.body.data[0];
  const aptForFix1 = aptsRes.body.data[1] || targetApt;
  assert.ok(targetApt);
  reservedAptId = aptForFix1.id;

  const dFrom = vnDaysFromToday(1);
  const dUntil = vnDaysFromToday(6);

  await t.test('Fix 2 — POST /api/v1/reservations rejects malformed phone (<10 digits) with 400 INVALID_PHONE', async () => {
    const badRsv = await apiFetch('/api/v1/reservations', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: targetApt.id,
        prospect_name: 'Khách Sai SĐT',
        phone: '09123',
        hold_amount: 1000000,
        hold_from: dFrom,
        hold_until: dUntil,
      }),
    });
    assert.equal(badRsv.status, 400, `Expected 400 INVALID_PHONE, got ${badRsv.status}: ${JSON.stringify(badRsv.body)}`);
    assert.equal(badRsv.body.code, 'INVALID_PHONE');
  });

  await t.test('Fix 1 — POST /api/v1/resident/rental-application blocks applying to another prospect RESERVED apartment', async () => {
    const rsvA = await apiFetch('/api/v1/reservations', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        apartment_id: aptForFix1.id,
        prospect_name: 'Khách Giữ Chỗ A',
        phone: prospectAPhone,
        hold_amount: 2000000,
        hold_from: dFrom,
        hold_until: dUntil,
      }),
    });
    assert.equal(rsvA.status, 201);
    createdRsvIds.push(rsvA.body.data.id);

    const todayStr = vnDaysFromToday(0);
    await adminPool.query(`UPDATE reservation SET hold_from = $1 WHERE id = $2`, [todayStr, rsvA.body.data.id]);
    await adminPool.query(`UPDATE apartment SET status = 'RESERVED' WHERE id = $1`, [aptForFix1.id]);

    // Prospect B gets a preliminary account
    const createB = await apiFetch('/api/v1/tenants', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Khách Khác B',
        phone: prospectBPhone,
      }),
    });
    assert.equal(createB.status, 201);

    const otpReqB = await apiFetch('/api/v1/auth/otp/request', null, {
      method: 'POST',
      body: JSON.stringify({ phone: prospectBPhone }),
    });
    const otpVerB = await apiFetch('/api/v1/auth/otp/verify', null, {
      method: 'POST',
      body: JSON.stringify({ phone: prospectBPhone, otp: otpReqB.body.devOtp }),
    });
    assert.equal(otpVerB.status, 200);

    const stealRes = await apiFetch('/api/v1/resident/rental-application', otpVerB.body.accessToken, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Khách Khác B',
        id_number: '001204040092',
        desired_apartment_id: aptForFix1.id,
        privacy_consent: true,
      }),
    });
    assert.equal(stealRes.status, 409, `Expected 409 APARTMENT_RESERVED_BY_OTHER, got ${stealRes.status}: ${JSON.stringify(stealRes.body)}`);
    assert.equal(stealRes.body.code, 'APARTMENT_RESERVED_BY_OTHER');
  });

  await t.test('Fix 3 — POST /api/v1/contracts/:id/occupants returns 409 CONFLICT_ID_NUMBER when phone already has different CCCD', async () => {
    const seedOcc = await apiFetch('/api/v1/tenants', mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Cư Dân Đã Có CCCD Gốc',
        phone: occConflictPhone,
        id_number: occOriginalCccd,
      }),
    });
    assert.equal(seedOcc.status, 201);

    const activeContracts = await apiFetch('/api/v1/contracts?status=ACTIVE&limit=5', mgrA.token);
    occContractId = activeContracts.body.data[0].id;

    const addConflict = await apiFetch(`/api/v1/contracts/${occContractId}/occupants`, mgrA.token, {
      method: 'POST',
      body: JSON.stringify({
        full_name: 'Cư Dân Nhập Nhầm CCCD Khác',
        phone: occConflictPhone,
        relationship: 'roommate',
        id_number: occDifferentCccd,
      }),
    });
    if (addConflict.body?.data?.tenant_id) {
      occTenantIdToDetach = addConflict.body.data.tenant_id;
    }
    assert.equal(addConflict.status, 409, `Expected 409 CONFLICT_ID_NUMBER, got ${addConflict.status}: ${JSON.stringify(addConflict.body)}`);
    assert.equal(addConflict.body.code, 'CONFLICT_ID_NUMBER');
  });
});

test('Scenario 1 Regression — Resident overview exposes full reservation metadata, desired_apartment_code without reservation, and clean onboarding state alongside active contracts', async (t) => {
  const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });
  const rsvPhone = '0961040191';
  const walkInOnlinePhone = '0961040192';
  const createdRsvIds = [];
  const touchedAptIds = [];

  async function cleanup() {
    for (const rId of createdRsvIds) {
      await adminPool.query('DELETE FROM reservation WHERE id = $1', [rId]);
    }
    await adminPool.query('DELETE FROM reservation WHERE phone = ANY($1::text[])', [[rsvPhone, walkInOnlinePhone]]);
    for (const aId of touchedAptIds) {
      await adminPool.query(
        `UPDATE apartment SET status = 'AVAILABLE'
         WHERE id = $1 AND status = 'RESERVED'
           AND NOT EXISTS (SELECT 1 FROM reservation WHERE apartment_id = $1 AND status = 'HELD')`,
        [aId]
      );
    }
    const pRes = await adminPool.query('SELECT id FROM person WHERE phone = ANY($1::text[])', [
      [rsvPhone, walkInOnlinePhone],
    ]);
    for (const row of pRes.rows) {
      const uRes = await adminPool.query('SELECT id FROM app_user WHERE person_id = $1', [row.id]);
      for (const u of uRes.rows) {
        await adminPool.query('DELETE FROM notification WHERE user_id = $1', [u.id]);
        await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [u.id]);
        const hasAudit = await adminPool.query('SELECT 1 FROM audit_log WHERE actor_id = $1 LIMIT 1', [u.id]);
        if (hasAudit.rows.length === 0) {
          await adminPool.query('DELETE FROM app_user WHERE id = $1', [u.id]);
        } else {
          await adminPool.query('UPDATE app_user SET person_id = NULL, auth_uid = $2 WHERE id = $1', [
            u.id,
            `archived_${u.id}`,
          ]);
        }
      }
      await adminPool.query('DELETE FROM tenant WHERE person_id = $1', [row.id]);
      await adminPool.query('DELETE FROM person WHERE id = $1', [row.id]);
    }
  }

  t.after(async () => {
    await cleanup();
    await adminPool.end();
  });

  await cleanup();

  const mgrA = await login('manager.vop.a@resihub.vn', 'Demo@123456');
  const aptsRes = await apiFetch('/api/v1/apartments?status=AVAILABLE&limit=10', mgrA.token);
  const apt1 = aptsRes.body.data[0];
  const apt2 = aptsRes.body.data[1];
  assert.ok(apt1 && apt2, 'Need at least 2 AVAILABLE apartments');
  touchedAptIds.push(apt1.id, apt2.id);

  const todayStr = vnDaysFromToday(0);
  const dUntil = vnDaysFromToday(5);

  // 1. Create reservation for rsvPhone and verify overview returns hold_from, apartment_type/bedrooms, and reservations array
  const createRsv = await apiFetch('/api/v1/reservations', mgrA.token, {
    method: 'POST',
    body: JSON.stringify({
      apartment_id: apt1.id,
      prospect_name: 'Nguyễn Văn Test Kịch Bản 1',
      phone: rsvPhone,
      hold_amount: 2000000,
      hold_from: todayStr,
      hold_until: dUntil,
      note: 'Giữ chỗ căn hộ kịch bản 1',
    }),
  });
  assert.equal(createRsv.status, 201);
  createdRsvIds.push(createRsv.body.data.id);

  const otpReq1 = await apiFetch('/api/v1/auth/otp/request', null, {
    method: 'POST',
    body: JSON.stringify({ phone: rsvPhone }),
  });
  const otpVer1 = await apiFetch('/api/v1/auth/otp/verify', null, {
    method: 'POST',
    body: JSON.stringify({ phone: rsvPhone, otp: otpReq1.body.devOtp }),
  });
  assert.equal(otpVer1.status, 200);

  const ov1 = await apiFetch('/api/v1/resident/overview', otpVer1.body.accessToken);
  assert.equal(ov1.status, 200);
  assert.ok(Array.isArray(ov1.body.data.reservations), 'overview.reservations must be an array');
  assert.equal(ov1.body.data.reservations.length, 1);
  assert.ok(ov1.body.data.reservation?.hold_from, 'overview.reservation.hold_from must be populated');
  assert.equal(ov1.body.data.reservation?.prospect_name, 'Nguyễn Văn Test Kịch Bản 1');

  // 2. Resident without a reservation applies for apt2 -> desired_apartment_code & desired_building_name must NOT be null under RLS
  const pIns = await adminPool.query(
    `INSERT INTO person (org_id, full_name, phone)
     SELECT org_id, 'Ứng Viên Không Giữ Chỗ', $1 FROM building WHERE id = $2 LIMIT 1
     RETURNING id`,
    [walkInOnlinePhone, apt2.building_id]
  );
  const pId2 = pIns.rows[0].id;
  const uIns = await adminPool.query(
    `INSERT INTO app_user (person_id, auth_uid, status) VALUES ($1, $2, 'ACTIVE') RETURNING id`,
    [pId2, `user_${walkInOnlinePhone}`]
  );
  await adminPool.query(
    `INSERT INTO user_role (user_id, role_id, building_id) SELECT $1, id, NULL FROM role WHERE code = 'RESIDENT' LIMIT 1`,
    [uIns.rows[0].id]
  );

  const otpReq2 = await apiFetch('/api/v1/auth/otp/request', null, {
    method: 'POST',
    body: JSON.stringify({ phone: walkInOnlinePhone }),
  });
  const otpVer2 = await apiFetch('/api/v1/auth/otp/verify', null, {
    method: 'POST',
    body: JSON.stringify({ phone: walkInOnlinePhone, otp: otpReq2.body.devOtp }),
  });
  assert.equal(otpVer2.status, 200);

  const appNoRsv = await apiFetch('/api/v1/resident/rental-application', otpVer2.body.accessToken, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Ứng Viên Không Giữ Chỗ',
      id_number: '001204040192',
      desired_apartment_id: apt2.id,
      privacy_consent: true,
    }),
  });
  assert.equal(appNoRsv.status, 201);

  const ov2 = await apiFetch('/api/v1/resident/overview', otpVer2.body.accessToken);
  assert.equal(ov2.status, 200);
  assert.equal(
    ov2.body.data.onboarding_application?.desired_apartment_code,
    apt2.code,
    'desired_apartment_code must be resolved even without a reservation'
  );
  assert.ok(
    ov2.body.data.onboarding_application?.desired_building_name,
    'desired_building_name must be resolved even without a reservation'
  );

  // 3. Existing resident with an active contract does NOT have onboarding_application falsely populated from their contract's APPROVED tenant row
  const existingTenantLogin = await login('tenant1@resihub.vn', 'Demo@123456');
  const ovExisting = await apiFetch('/api/v1/resident/overview', existingTenantLogin.token);
  assert.equal(ovExisting.status, 200);
  if (ovExisting.body.data.has_contract) {
    assert.notEqual(
      ovExisting.body.data.onboarding_application?.status,
      'APPROVED',
      'Contracted tenant row must not appear as an uncontracted APPROVED onboarding application'
    );
  }
});
