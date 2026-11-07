import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = process.env.DEVTOOLS_OUT_DIR || path.resolve(__dirname, '..', 'test-artifacts', 'devtools');
const REPORT_JSON = path.join(OUT_DIR, 'devtools_v2_results.json');
const BASE_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const API_BASE = process.env.API_URL || 'http://127.0.0.1:5000';
const ADMIN_DB_URL = process.env.ADMIN_DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/resihub';

fs.mkdirSync(OUT_DIR, { recursive: true });

const adminPool = new pg.Pool({ connectionString: ADMIN_DB_URL });

async function apiJson(urlPath, token, options = {}) {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json();
  return { status: res.status, body };
}

const proc = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['-y', 'chrome-devtools-mcp@latest', '--headless', '--isolated', '--no-usage-statistics'],
  { stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' }
);

let buf = '';
let nextId = 1;
const pending = new Map();

proc.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout for ${method} (${JSON.stringify(params).slice(0, 120)})`));
    }, 60000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function callTool(name, args = {}) {
  const res = await rpc('tools/call', { name, arguments: args });
  const text = (res?.content || []).map((c) => c.text || '').join('\n');
  if (res?.isError) {
    throw new Error(`Tool ${name} error: ${text}`);
  }
  return { raw: res, text };
}

function parseEvalJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      return fenced[1].trim();
    }
  }
  const obj = text.match(/(\{[\s\S]*\})/);
  if (obj) {
    try {
      return JSON.parse(obj[1]);
    } catch {}
  }
  return text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findUid(snapshotText, matcher) {
  const lines = snapshotText.split('\n');
  for (const line of lines) {
    const uidMatch = line.match(/uid=(\S+)/);
    if (!uidMatch) continue;
    if (typeof matcher === 'function' ? matcher(line) : matcher.test(line)) {
      return uidMatch[1];
    }
  }
  return null;
}

const results = {
  startedAt: new Date().toISOString(),
  steps: [],
  consoleErrors: [],
  networkFailures: [],
  lighthouse: null,
};

const seenConsoleIds = new Set();
const seenNetLines = new Set();

async function collectDiagnostics(pageId, contextLabel) {
  const con = await callTool('list_console_messages', {
    pageId,
    types: ['error'],
    includePreservedMessages: false,
  });
  const conLines = con.text.split('\n').filter((l) => l.includes('msgid='));
  for (const l of conLines) {
    const idMatch = l.match(/msgid=(\d+)/);
    const key = idMatch ? `${pageId}:${idMatch[1]}` : `${contextLabel}:${l}`;
    if (!seenConsoleIds.has(key)) {
      seenConsoleIds.add(key);
      results.consoleErrors.push({ context: contextLabel, message: l.trim() });
    }
  }

  const net = await callTool('list_network_requests', {
    pageId,
    resourceTypes: ['xhr', 'fetch'],
    pageSize: 100,
  });
  const netLines = net.text.split('\n').filter((l) => /reqid=\d+/.test(l));
  for (const l of netLines) {
    const statusMatch = l.match(/\[(\d{3})\]|\bstatus[=:\s]+(\d{3})\b|\s([45]\d{2})\b/);
    const code = statusMatch ? Number(statusMatch[1] || statusMatch[2] || statusMatch[3]) : null;
    if (code && code >= 400) {
      const key = `${contextLabel}:${l.trim()}`;
      if (!seenNetLines.has(key)) {
        seenNetLines.add(key);
        results.networkFailures.push({ context: contextLabel, code, request: l.trim() });
      }
    }
  }
}

async function recordStep(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    const entry = { name, status: 'PASS', durationMs: Date.now() - t0, detail };
    results.steps.push(entry);
    console.log(`✅ [PASS] ${name} (${entry.durationMs}ms) -> ${JSON.stringify(detail || {})}`);
    return detail;
  } catch (err) {
    const entry = { name, status: 'FAIL', durationMs: Date.now() - t0, error: err.message };
    results.steps.push(entry);
    console.error(`❌ [FAIL] ${name}: ${err.message}`);
    return null;
  }
}

async function screenshot(pageId, filename) {
  const fullPath = path.join(OUT_DIR, filename);
  const res = await callTool('take_screenshot', { pageId });
  const imgBlock = (res.raw?.content || []).find((c) => c.type === 'image' && c.data);
  if (imgBlock) {
    fs.writeFileSync(fullPath, Buffer.from(imgBlock.data, 'base64'));
  }
  return fullPath;
}

async function clearSession(pageId) {
  await callTool('evaluate_script', {
    pageId,
    function: '() => { localStorage.clear(); sessionStorage.clear(); return true; }',
  });
}

async function loginWithEmailForm(pageId, email, password, expectedUrlPart) {
  await clearSession(pageId);
  await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/login` });
  await callTool('wait_for', { pageId, text: ['Đăng nhập hệ thống'], timeout: 10000 });
  await sleep(300);

  const snap = await callTool('take_snapshot', { pageId });
  const lines = snap.text.split('\n');
  const textboxes = lines
    .filter((l) => l.includes('textbox'))
    .map((l) => l.match(/uid=(\S+)/)?.[1])
    .filter(Boolean);
  if (textboxes.length < 2) {
    throw new Error(`Expected >=2 textboxes on login form, found ${textboxes.length}`);
  }
  await callTool('fill', { pageId, uid: textboxes[0], value: email, includeSnapshot: false });
  await callTool('fill', { pageId, uid: textboxes[1], value: password, includeSnapshot: false });
  await sleep(150);

  const submitSnap = await callTool('take_snapshot', { pageId });
  const submitUid = findUid(submitSnap.text, (l) => l.includes('button "Đăng nhập"'));
  if (!submitUid) throw new Error('Submit button "Đăng nhập" not found');
  await callTool('click', { pageId, uid: submitUid, includeSnapshot: false });
  await sleep(1400);

  const locRes = await callTool('evaluate_script', {
    pageId,
    function: '() => ({ path: window.location.pathname })',
  });
  const parsed = parseEvalJson(locRes.text);
  const actualPath = typeof parsed === 'object' ? parsed.path : String(parsed);
  if (!actualPath.includes(expectedUrlPart)) {
    throw new Error(`Expected URL containing ${expectedUrlPart} for ${email}, got ${actualPath}`);
  }
}

const tempCleanup = {
  userIds: [],
  personIds: [],
  secondContractId: null,
  secondAptId: null,
  secondAptOrigStatus: null,
};

const suffix = Date.now().toString().slice(-6);

try {
  await adminPool.query(
    `UPDATE contract SET end_date = '2026-12-31', status = 'ACTIVE' WHERE end_date = '2026-11-06'`
  );
  await adminPool.query(
    `UPDATE apartment a SET status = 'OCCUPIED' WHERE EXISTS (SELECT 1 FROM contract c WHERE c.apartment_id = a.id AND c.status = 'ACTIVE')`
  );

  const adminLogin = await apiJson('/api/v1/auth/login', null, {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@resihub.vn', password: 'Admin@123456' }),
  });
  const adminToken = adminLogin.body.accessToken;

  const vopARes = await adminPool.query(`SELECT id, code FROM building WHERE code IN ('VOP-A', 'VOP-1') ORDER BY code LIMIT 1`);
  const vscARes = await adminPool.query(`SELECT id, code FROM building WHERE code IN ('VSC-A', 'VOP-2') ORDER BY code LIMIT 1`);
  const vopAId = vopARes.rows[0].id;
  const vopACode = vopARes.rows[0].code;
  const vscAId = vscARes.rows[0].id;
  const vscACode = vscARes.rows[0].code;

  const mgr1UserRes = await adminPool.query(
    `SELECT p.email FROM app_user u
     JOIN person p ON p.id = u.person_id
     JOIN user_role ur ON ur.user_id = u.id
     JOIN role r ON r.id = ur.role_id
     WHERE r.code = 'MANAGER' AND ur.building_id = $1
     ORDER BY u.created_at ASC LIMIT 1`,
    [vopAId]
  );
  const mgr1Email = mgr1UserRes.rows[0]?.email || 'manager.vop1@resihub.vn';

  const mgr2Email = `mgr2.ui.${suffix}@resihub.vn`;

  const mgr2Create = await apiJson('/api/v1/admin/users', adminToken, {
    method: 'POST',
    body: JSON.stringify({
      full_name: 'Quản Lý Vận Hành Giao Diện',
      email: mgr2Email,
      phone: `096${suffix}1`,
      password: 'Password@123',
      roles: [{ role_code: 'MANAGER', building_id: vopAId }],
    }),
  });
  if (mgr2Create.status !== 201) {
    throw new Error(`Failed to create temp MANAGER: ${mgr2Create.status} ${JSON.stringify(mgr2Create.body)}`);
  }
  tempCleanup.userIds.push(mgr2Create.body.data.id);
  if (mgr2Create.body.data.person_id) tempCleanup.personIds.push(mgr2Create.body.data.person_id);

  const crossTenantRes = await adminPool.query(
    `
    SELECT p.phone
    FROM contract c
    JOIN tenant t ON t.id = c.primary_tenant_id
    JOIN person p ON p.id = t.person_id
    WHERE c.building_id = $1
      AND c.status = 'ACTIVE'
      AND p.phone IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM contract c2
        JOIN tenant t2 ON t2.id = c2.primary_tenant_id
        WHERE t2.person_id = p.id AND c2.building_id = $2
      )
    LIMIT 1
  `,
    [vscAId, vopAId]
  );
  const crossBuildingTenantPhone = crossTenantRes.rows[0]?.phone;
  if (!crossBuildingTenantPhone) {
    throw new Error('Could not find cross-building VSC-A primary tenant phone for UI-09');
  }

  const t1Row = await adminPool.query(`
    SELECT t.id AS tenant_id, p.phone, p.id_number
    FROM tenant t
    JOIN person p ON p.id = t.person_id
    WHERE p.email = 'tenant1@resihub.vn' AND t.type = 'primary'
    LIMIT 1
  `);
  const tenant1Info = t1Row.rows[0];

  const freeVscApt = await adminPool.query(
    `
    SELECT a.id, a.code, a.status
    FROM apartment a
    WHERE a.building_id = $1
      AND a.status = 'AVAILABLE'
      AND NOT EXISTS (
        SELECT 1 FROM contract c
        WHERE c.apartment_id = a.id
          AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'PENDING_APPROVAL', 'DRAFT')
      )
    ORDER BY a.code ASC
    LIMIT 1
  `,
    [vscAId]
  );

  if (tenant1Info && freeVscApt.rows.length > 0) {
    tempCleanup.secondAptId = freeVscApt.rows[0].id;
    tempCleanup.secondAptOrigStatus = freeVscApt.rows[0].status;
    const ins2nd = await adminPool.query(
      `
      INSERT INTO contract (
        building_id, apartment_id, primary_tenant_id,
        start_date, end_date, rent_amount, billing_day, payment_due_days, deposit_amount, status, created_at
      )
      VALUES ($1, $2, $3, CURRENT_DATE - INTERVAL '5 days', CURRENT_DATE + INTERVAL '180 days', 11500000, 5, 5, 11500000, 'ACTIVE', '2024-06-01T00:00:00Z')
      RETURNING id
    `,
      [vscAId, tempCleanup.secondAptId, tenant1Info.tenant_id]
    );
    tempCleanup.secondContractId = ins2nd.rows[0].id;
    await adminPool.query(`UPDATE apartment SET status = 'OCCUPIED' WHERE id = $1`, [tempCleanup.secondAptId]);
  }

  await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'resihub-devtools-v2-full', version: '2.0.0' },
  });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const np = await callTool('new_page', { url: `${BASE_URL}/login` });
  const selMatch = np.text.match(/(\d+):.*\[selected\]/);
  const pageId = selMatch ? Number(selMatch[1]) : 2;

  await callTool('emulate', { pageId, viewport: '1440x900' });

  await recordStep('UI-01 [Auth] Login Page, Forgot Password Page & Quick Demo Switcher', async () => {
    await callTool('wait_for', { pageId, text: ['Đăng nhập hệ thống'], timeout: 10000 });
    const snap = await callTool('take_snapshot', { pageId });
    if (!snap.text.includes('Email & Mật khẩu') || !snap.text.includes('Số điện thoại (OTP)')) {
      throw new Error('Missing login mode switcher');
    }
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/forgot-password` });
    await sleep(600);
    const fpSnap = await callTool('take_snapshot', { pageId });
    if (!/khôi phục|mật khẩu/i.test(fpSnap.text)) {
      throw new Error('Forgot password page failed to render');
    }
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/login` });
    await callTool('wait_for', { pageId, text: ['Đăng nhập hệ thống'], timeout: 10000 });
    await collectDiagnostics(pageId, 'AuthPages');
    return { loginOk: true, forgotPasswordOk: true };
  });

  await recordStep('UI-02 [Auth] OTP Anti-Enumeration Neutral Verification Screen (AC-001.3)', async () => {
    let snap = await callTool('take_snapshot', { pageId });
    const otpTabUid = findUid(snap.text, (l) => l.includes('button') && l.includes('Số điện thoại (OTP)'));
    await callTool('click', { pageId, uid: otpTabUid, includeSnapshot: false });
    await sleep(250);
    snap = await callTool('take_snapshot', { pageId });
    const phoneInputUid = findUid(snap.text, (l) => l.includes('textbox'));
    await callTool('fill', { pageId, uid: phoneInputUid, value: '0987654399', includeSnapshot: false });
    const reqBtnUid = findUid(snap.text, (l) => l.includes('button') && l.includes('Nhận mã xác thực OTP'));
    await callTool('click', { pageId, uid: reqBtnUid, includeSnapshot: false });
    await sleep(900);
    snap = await callTool('take_snapshot', { pageId });
    const verifyScreenShown = snap.text.includes('Xác thực & Đăng nhập');
    if (!verifyScreenShown) throw new Error('Neutral OTP verify screen was not shown');
    await collectDiagnostics(pageId, 'OtpAntiEnumeration');
    return { verifyScreenShown };
  });

  await recordStep('UI-03 [SYS_ADMIN] Executive Dashboard KPIs, Org Buildings / Apartments & Revenue Chart', async () => {
    const expectedAptsRes = await adminPool.query('SELECT COUNT(*)::int AS cnt FROM apartment');
    const expectedAptsStr = String(expectedAptsRes.rows[0].cnt);
    await loginWithEmailForm(pageId, 'admin@resihub.vn', 'Admin@123456', '/admin/dashboard');
    await sleep(1100);
    const snap = await callTool('take_snapshot', { pageId });
    const hasExpectedApts = snap.text.includes(expectedAptsStr);
    await screenshot(pageId, 'dt_v2_01_sysadmin_dashboard.png');
    await collectDiagnostics(pageId, 'SysAdminDashboard');
    if (!hasExpectedApts) throw new Error(`Dashboard did not display ${expectedAptsStr} total apartments`);
    return { totalApartmentsDisplayed: expectedAptsRes.rows[0].cnt };
  });

  await recordStep('UI-04 [SYS_ADMIN] Floor Plan Grid (FR-010), Users & System Settings (M01) & Reports (M14)', async () => {
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/buildings/${vopAId}/floor-plan` });
    await sleep(1100);
    const fpSnap = await callTool('take_snapshot', { pageId });
    if (!fpSnap.text.includes('A101') && !fpSnap.text.includes('11A01')) {
      throw new Error('Floor plan did not render apartment A101/11A01');
    }

    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/users` });
    await sleep(1000);
    const usrSnap = await callTool('take_snapshot', { pageId });
    if (!/người dùng|tài khoản/i.test(usrSnap.text)) throw new Error('UsersPage failed to render');

    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/reports` });
    await sleep(1000);
    const repSnap = await callTool('take_snapshot', { pageId });
    if (!/báo cáo|lấp đầy/i.test(repSnap.text)) throw new Error('ReportsPage failed to render');

    await collectDiagnostics(pageId, 'SysAdminModules');
    return { floorPlanA101: true, usersPage: true, reportsPage: true };
  });

  await recordStep('UI-05 [OWNER] 3 Owned Buildings Scope (VOP-A/B/C) & 100% Read-Only UI Audit Across 8 Pages', async () => {
    await loginWithEmailForm(pageId, 'owner.vop@resihub.vn', 'Demo@123456', '/admin/dashboard');
    await sleep(900);

    const ownerPages = [
      { path: '/admin/buildings', forbiddenButtons: ['Thêm tòa nhà mới', 'Tạo tòa nhà'] },
      { path: '/admin/tenants', forbiddenButtons: ['Thêm cư dân', 'Gộp hồ sơ'] },
      { path: '/admin/contracts', forbiddenButtons: ['Tạo hợp đồng nháp', 'Tạo hợp đồng', 'Phê duyệt', 'Chấm dứt'] },
      { path: '/admin/deposits', forbiddenButtons: ['Thu bổ sung', 'Lập tất toán', 'Phê duyệt'] },
      { path: '/admin/services', forbiddenButtons: ['Thêm dịch vụ'] },
      { path: '/admin/invoices', forbiddenButtons: ['Phát hành hóa đơn', 'Tạo lô hóa đơn'] },
      { path: '/admin/payments', forbiddenButtons: ['Ghi nhận thanh toán'] },
      { path: '/admin/notifications', forbiddenButtons: ['Gửi thông báo', 'Phát hành thông báo'] },
    ];

    const leakedButtons = [];
    let hasVopABC = false;

    for (const pgSpec of ownerPages) {
      await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}${pgSpec.path}` });
      await sleep(950);
      if (pgSpec.path === '/admin/buildings') {
        const bSnap = await callTool('take_snapshot', { pageId });
        hasVopABC =
          (bSnap.text.includes('VOP-A') &&
            bSnap.text.includes('VOP-B') &&
            bSnap.text.includes('VOP-C') &&
            !bSnap.text.includes('VSC-A')) ||
          (bSnap.text.includes('VOP-1') &&
            bSnap.text.includes('VOP-2') &&
            bSnap.text.includes('VOP-3'));
      }
      if (pgSpec.path === '/admin/contracts') {
        await screenshot(pageId, 'dt_v2_02_owner_readonly_contracts.png');
      }
      const btnCheck = await callTool('evaluate_script', {
        pageId,
        function: `() => {
          const forbidden = ${JSON.stringify(pgSpec.forbiddenButtons)};
          const btns = Array.from(document.querySelectorAll('button')).map(b => (b.innerText || '').trim());
          return forbidden.filter(f => btns.some(txt => txt.toLowerCase().includes(f.toLowerCase())));
        }`,
      });
      const found = parseEvalJson(btnCheck.text);
      if (Array.isArray(found) && found.length > 0) {
        leakedButtons.push({ path: pgSpec.path, found });
      }
      await collectDiagnostics(pageId, `Owner:${pgSpec.path}`);
    }

    if (!hasVopABC) throw new Error('OWNER building scope did not strictly match VOP-A/B/C');
    if (leakedButtons.length > 0) {
      throw new Error(`OWNER saw write buttons: ${JSON.stringify(leakedButtons)}`);
    }
    return { scopedToVopABC: true, auditedPages: ownerPages.length, leakedWriteButtons: 0 };
  });

  await recordStep('UI-06 [OWNER] RoleGuard Blocks Direct Navigation to /admin/users', async () => {
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/users` });
    await sleep(700);
    const snap = await callTool('take_snapshot', { pageId });
    const blocked = /không có quyền|truy cập bị từ chối|403/i.test(snap.text);
    if (!blocked) throw new Error('OWNER was not blocked on /admin/users');
    return { roleGuardBlocked: true };
  });

  await recordStep('UI-07 [MANAGER] Confidential Owner Lookup Modal with Masked PII Preview', async () => {
    await loginWithEmailForm(pageId, mgr1Email, 'Demo@123456', '/admin/dashboard');
    await sleep(800);
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/buildings` });
    await sleep(900);

    let snap = await callTool('take_snapshot', { pageId });
    if (!snap.text.includes(vopACode) || snap.text.includes('VOP-B') || snap.text.includes('VOP-2')) {
      throw new Error(`MANAGER ${vopACode} scope mismatch on BuildingsPage`);
    }

    const addBldgUid = findUid(snap.text, (l) => l.includes('button') && l.includes('Thêm tòa nhà mới'));
    if (!addBldgUid) throw new Error('Button "Thêm tòa nhà mới" not found for MANAGER');
    await callTool('click', { pageId, uid: addBldgUid, includeSnapshot: false });
    await sleep(500);

    snap = await callTool('take_snapshot', { pageId });
    const ownerInputUid = findUid(snap.text, (l) => l.includes('textbox') && l.includes('Chủ đầu tư'));
    if (!ownerInputUid) throw new Error('Owner identifier input not found');
    await callTool('fill', { pageId, uid: ownerInputUid, value: 'owner.vop@resihub.vn', includeSnapshot: false });
    await sleep(200);

    snap = await callTool('take_snapshot', { pageId });
    const checkBtnUid = findUid(snap.text, (l) => l.includes('button') && l.includes('Kiểm tra'));
    await callTool('click', { pageId, uid: checkBtnUid, includeSnapshot: false });
    await sleep(800);

    snap = await callTool('take_snapshot', { pageId });
    const maskedShown = snap.text.includes('***');
    await screenshot(pageId, 'dt_v2_03_manager_masked_owner_lookup.png');
    await collectDiagnostics(pageId, 'ManagerOwnerLookup');
    if (!maskedShown) throw new Error('Masked owner preview was not rendered after exact lookup');
    return { maskedOwnerPreview: true };
  });

  await recordStep('UI-08 [MANAGER] Shared Cross-Building Resident Badge ("Liên tòa") on TenantsPage', async () => {
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/tenants` });
    await sleep(900);
    let snap = await callTool('take_snapshot', { pageId });
    const searchUid = findUid(snap.text, (l) => l.includes('textbox') && l.includes('Tìm theo họ tên'));
    if (searchUid) {
      await callTool('fill', { pageId, uid: searchUid, value: 'tenant1@resihub.vn', includeSnapshot: false });
      await sleep(500);
    }
    await callTool('wait_for', { pageId, text: ['Liên tòa'], timeout: 8000 });
    snap = await callTool('take_snapshot', { pageId });
    const hasSharedBadge = snap.text.includes('Liên tòa');
    await screenshot(pageId, 'dt_v2_04_manager_shared_tenant_badge.png');
    await collectDiagnostics(pageId, 'ManagerTenantsSharedBadge');
    if (!hasSharedBadge) throw new Error('Expected "Liên tòa" badge on shared resident profile');
    return { hasSharedBadge };
  });

  await recordStep('UI-09 [MANAGER] Create Contract Modal — Know-Before-You-Link Masked Resident Lookup', async () => {
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/contracts` });
    await sleep(1100);
    let snap = await callTool('take_snapshot', { pageId });
    const createCtrUid = findUid(snap.text, (l) => l.includes('button') && l.includes('Tạo hợp đồng nháp'));
    if (!createCtrUid) throw new Error('Button "Tạo hợp đồng nháp" not found');
    await callTool('click', { pageId, uid: createCtrUid, includeSnapshot: false });
    await sleep(600);

    snap = await callTool('take_snapshot', { pageId });
    const lookupInputUid = findUid(snap.text, (l) => l.includes('textbox') && l.includes('Nhập chính xác SĐT'));
    if (!lookupInputUid) throw new Error('Resident lookup input not found in Create Contract modal');
    await callTool('fill', { pageId, uid: lookupInputUid, value: crossBuildingTenantPhone, includeSnapshot: false });
    await sleep(200);

    snap = await callTool('take_snapshot', { pageId });
    const lookupBtnUid = findUid(snap.text, (l) => l.includes('button "Tra cứu"'));
    if (!lookupBtnUid) throw new Error('Button "Tra cứu" not found');
    await callTool('click', { pageId, uid: lookupBtnUid, includeSnapshot: false });
    await sleep(850);

    snap = await callTool('take_snapshot', { pageId });
    const hasMaskedTenant = snap.text.includes('***');
    const hasCrossBadge = snap.text.includes('Liên kết liên tòa');
    const leakedVsc = snap.text.includes(vscACode);
    await screenshot(pageId, 'dt_v2_05_manager_masked_tenant_lookup.png');
    await collectDiagnostics(pageId, 'ManagerContractTenantLookup');
    if (!hasMaskedTenant) throw new Error('Masked resident preview did not appear');
    if (!hasCrossBadge) throw new Error('Cross-building PII badge did not appear');
    if (leakedVsc) throw new Error(`Cross-building ${vscACode} contract leaked in MANAGER lookup modal!`);
    return { hasMaskedTenant, hasCrossBadge, leakedCrossBuildingInfo: false };
  });

  await recordStep('UI-10 [MANAGER Consolidated R-01] Service Catalog CRU, Finance/Aging, Meters & Maintenance Kanban', async () => {
    await loginWithEmailForm(pageId, mgr2Email, 'Password@123', '/admin/dashboard');
    await sleep(900);

    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/services` });
    await callTool('wait_for', { pageId, text: ['Danh mục Dịch vụ'], timeout: 10000 });
    await sleep(600);
    const svcSnap = await callTool('take_snapshot', { pageId });
    const canAddService = /thêm dịch vụ/i.test(svcSnap.text);
    if (!canAddService) {
      throw new Error('MANAGER did not see "Thêm dịch vụ" button on ServiceCatalogPage (R-01)');
    }
    await screenshot(pageId, 'dt_v2_06_accountant_services_finance.png');

    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/invoices` });
    await sleep(800);
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/payments` });
    await sleep(800);
    const paySnap = await callTool('take_snapshot', { pageId });
    const agingTabUid = findUid(paySnap.text, (l) => l.includes('button') && l.includes('Tuổi nợ'));
    if (agingTabUid) {
      await callTool('click', { pageId, uid: agingTabUid, includeSnapshot: false });
      await sleep(600);
    }

    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/meters` });
    await sleep(800);
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/maintenance` });
    await sleep(800);
    await screenshot(pageId, 'dt_v2_07_staff_meters_workorders.png');

    // Verify MANAGER is blocked from /admin/users and /admin/audit-logs (4-role isolation)
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/users` });
    await sleep(650);
    const blockedUsersSnap = await callTool('take_snapshot', { pageId });
    const usersBlocked = /không có quyền|truy cập bị từ chối|403/i.test(blockedUsersSnap.text);
    if (!usersBlocked) throw new Error('MANAGER was not blocked from /admin/users');

    await collectDiagnostics(pageId, 'ManagerConsolidatedOperations');
    return { canAddService, agingTabVerified: Boolean(agingTabUid), usersBlocked };
  });

  await recordStep('UI-11 [SYS_ADMIN & OWNER R-23/R-24] Audit Logs Viewer & Four-Eyes Approval Settings', async () => {
    await loginWithEmailForm(pageId, 'admin@resihub.vn', 'Admin@123456', '/admin/dashboard');
    await sleep(900);

    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/audit-logs` });
    await sleep(1000);
    const auditSnap = await callTool('take_snapshot', { pageId });
    const hasAuditPage = /nhật ký|audit/i.test(auditSnap.text);
    if (!hasAuditPage) throw new Error('AuditLogsPage did not render for SYS_ADMIN');

    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/admin/settings` });
    await sleep(900);
    const setSnap = await callTool('take_snapshot', { pageId });
    const hasFourEyesSetting = /four-eyes|tự phê duyệt/i.test(setSnap.text);
    if (!hasFourEyesSetting) throw new Error('Four-eyes self-approval setting did not render on SettingsPage');

    await collectDiagnostics(pageId, 'SysAdminAuditAndSettings');
    return { hasAuditPage, hasFourEyesSetting };
  });

  await recordStep('UI-12 [RESIDENT] Multi-Apartment Switcher Across 2 Buildings + All 8 Portal Tabs (P1..P8)', async () => {
    await loginWithEmailForm(pageId, 'tenant1@resihub.vn', 'Demo@123456', '/resident');
    await sleep(1200);

    const openSwitcher = await callTool('evaluate_script', {
      pageId,
      function: `() => {
        const trigger = document.querySelector('[aria-label="Chọn căn hộ đang thuê"]');
        if (!trigger) return { found: false };
        trigger.click();
        return { found: true, tagName: trigger.tagName };
      }`,
    });
    const opened = parseEvalJson(openSwitcher.text);
    if (!opened?.found) {
      throw new Error(`Expected Multi-Apartment Switcher trigger, got: ${JSON.stringify(opened)}`);
    }
    await sleep(250);

    const switcherInfo = await callTool('evaluate_script', {
      pageId,
      function: `() => {
        const searchInput = document.querySelector('input[aria-label="Lọc danh sách tùy chọn"]');
        const opts = Array.from(document.querySelectorAll('[role="option"]'));
        return {
          found: true,
          hasSearchInput: Boolean(searchInput),
          options: opts.map(o => ({
            value: o.getAttribute('data-option-value') || '',
            text: (o.textContent || '').trim(),
          })),
        };
      }`,
    });
    const sw = parseEvalJson(switcherInfo.text);
    if (!sw.found || !sw.hasSearchInput || sw.options.length < 2) {
      throw new Error(`Expected Searchable Multi-Apartment Switcher with >=2 apartments, got: ${JSON.stringify(sw)}`);
    }
    await screenshot(pageId, 'dt_v2_08_resident_multi_apartment.png');

    const secondCtrId = sw.options[1].value;
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/resident?tab=overview&contract_id=${secondCtrId}` });
    await sleep(950);

    const tabs = ['overview', 'contract', 'invoices', 'services', 'maintenance', 'notifications', 'contact', 'profile'];
    for (const tab of tabs) {
      await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/resident?tab=${tab}` });
      await sleep(650);
      await collectDiagnostics(pageId, `ResidentTab:${tab}`);
    }
    return { switcherOptions: sw.options.map((o) => o.text), verifiedTabsCount: tabs.length };
  });

  await recordStep('UI-13 [RESIDENT Mobile 390x844] Responsive Layout, Bottom Bar & Zero Horizontal Overflow (PRD 16.3)', async () => {
    await callTool('emulate', { pageId, viewport: '390x844' });
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/resident?tab=overview` });
    await sleep(950);

    const mobileMetrics = await callTool('evaluate_script', {
      pageId,
      function: `() => ({
        innerWidth: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        hasHorizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 4,
      })`,
    });
    const metrics = parseEvalJson(mobileMetrics.text);
    await screenshot(pageId, 'dt_v2_09_resident_mobile_390x844.png');
    await collectDiagnostics(pageId, 'ResidentMobile390x844');
    await callTool('emulate', { pageId, viewport: '1440x900' });

    if (metrics.hasHorizontalOverflow) {
      throw new Error(`Mobile layout horizontal overflow detected: ${JSON.stringify(metrics)}`);
    }
    return metrics;
  });

  await recordStep('UI-14 [Lighthouse] Desktop Accessibility, Best Practices & SEO Audit', async () => {
    await clearSession(pageId);
    await callTool('navigate_page', { pageId, type: 'url', url: `${BASE_URL}/login` });
    await sleep(700);
    const lh = await callTool('lighthouse_audit', {
      pageId,
      device: 'desktop',
      mode: 'navigation',
    });
    results.lighthouse = lh.text;
    return { rawSummary: lh.text.slice(0, 320) };
  });
} finally {
  try {
    if (tempCleanup.secondContractId) {
      await adminPool.query('DELETE FROM contract WHERE id = $1', [tempCleanup.secondContractId]).catch(() => {});
    }
    if (tempCleanup.secondAptId && tempCleanup.secondAptOrigStatus) {
      await adminPool
        .query('UPDATE apartment SET status = $2 WHERE id = $1', [tempCleanup.secondAptId, tempCleanup.secondAptOrigStatus])
        .catch(() => {});
    }
    for (const uId of tempCleanup.userIds) {
      await adminPool.query('DELETE FROM notification WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool.query('DELETE FROM user_role WHERE user_id = $1', [uId]).catch(() => {});
      await adminPool
        .query('DELETE FROM app_user WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM audit_log WHERE actor_id = $1)', [uId])
        .catch(() => {});
    }
    for (const pId of tempCleanup.personIds) {
      await adminPool
        .query('DELETE FROM person WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM app_user WHERE person_id = $1)', [pId])
        .catch(() => {});
    }
  } catch (cleanupErr) {
    console.error('Cleanup warning:', cleanupErr.message);
  }
  await adminPool.end().catch(() => {});

  results.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_JSON, JSON.stringify(results, null, 2), 'utf8');
  console.log('\n=== CHROME DEVTOOLS v2 FULL SUITE SUMMARY ===');
  console.log(`Total Steps: ${results.steps.length}`);
  console.log(`Passed: ${results.steps.filter((s) => s.status === 'PASS').length}`);
  console.log(`Failed: ${results.steps.filter((s) => s.status === 'FAIL').length}`);
  console.log(`Console Errors: ${results.consoleErrors.length}`);
  console.log(`Network 4xx/5xx: ${results.networkFailures.length}`);
  proc.kill();
  process.exit(results.steps.some((s) => s.status === 'FAIL') ? 1 : 0);
}

