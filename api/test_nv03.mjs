import { pool } from './src/db/client.js';

async function testNv03() {
  console.log('=== VERIFYING NV-03: TẠO TÒA NHÀ & STATE MACHINE ===');

  // 1. Reactivate RH-THAODIEN
  const bRes = await pool.query("SELECT id FROM building WHERE code = 'RH-THAODIEN'");
  const bId = bRes.rows[0].id;
  await pool.query("UPDATE building SET status = 'ACTIVE' WHERE id = $1", [bId]);

  // 2. Apartment
  const aptRes = await pool.query("SELECT id FROM apartment WHERE building_id = $1 LIMIT 1", [bId]);
  const aptId = aptRes.rows[0].id;

  // 3. Organization & Tenant
  const orgRes = await pool.query("SELECT id FROM organization LIMIT 1");
  const orgId = orgRes.rows[0].id;
  
  let tRes = await pool.query("SELECT id FROM tenant WHERE org_id = $1 LIMIT 1", [orgId]);
  let tenantId;
  if (tRes.rows.length === 0) {
    const p = await pool.query("SELECT id FROM person LIMIT 1");
    let personId = p.rows[0]?.id;
    if (!personId) {
      const np = await pool.query("INSERT INTO person (full_name, phone) VALUES ('Nguyen Van A', '0912345678') RETURNING id");
      personId = np.rows[0].id;
    }
    const nt = await pool.query(
      "INSERT INTO tenant (person_id, org_id, type, status) VALUES ($1, $2, 'primary', 'APPROVED') RETURNING id",
      [personId, orgId]
    );
    tenantId = nt.rows[0].id;
  } else {
    tenantId = tRes.rows[0].id;
  }

  // 4. Create an ACTIVE contract
  const cRes = await pool.query(
    `INSERT INTO contract (apartment_id, building_id, primary_tenant_id, start_date, end_date, rent_amount, billing_day, status)
     VALUES ($1, $2, $3, '2026-01-01', '2026-12-31', 8000000, 5, 'ACTIVE')
     RETURNING id`,
    [aptId, bId, tenantId]
  );
  const contractId = cRes.rows[0].id;
  console.log(`[Setup] Đã gán HĐ ACTIVE (${contractId}) vào tòa RH-THAODIEN (${bId})`);

  // Login
  const loginRes = await fetch('http://localhost:5000/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'manager@resihub.vn', password: 'password123' })
  }).then(r => r.json());
  const token = loginRes.accessToken;

  // 5. Test TC-006: Trying to deactivate building while having ACTIVE contract
  const deactRes = await fetch(`http://localhost:5000/api/v1/buildings/${bId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status: 'INACTIVE' })
  });
  const deactData = await deactRes.json();
  console.log('TC-006 [Deactivate khi có HĐ active]: HTTP Status =', deactRes.status, '(Mong đợi 400)');
  console.log('       Code:', deactData.code);
  console.log('       Message:', deactData.message);

  // 6. Check Audit Log for building actions
  const auditRes = await pool.query(
    "SELECT action, entity, entity_id, at FROM audit_log WHERE entity = 'building' ORDER BY at DESC LIMIT 5"
  );
  console.log('\n[Audit Log Check] 5 bản ghi audit gần nhất cho building:');
  console.table(auditRes.rows);

  // Clean up test contract
  await pool.query("DELETE FROM contract WHERE id = $1", [contractId]);
  console.log('\n[Cleanup] Đã dọn dẹp test contract.');
  await pool.end();
}

testNv03().catch(console.error);
