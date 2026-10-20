# Fix Auth & RLS Findings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sửa toàn bộ 20 findings trong `Bao_Cao_Audit_Dang_Nhap_va_RLS.md` (đăng nhập OTP/refresh, 3 lỗ hổng PII, bật RLS thật tại runtime), mỗi nhóm lỗi 1 commit, và kiểm thử đầy đủ bằng test scripts + Chrome DevTools.

**Architecture:** API Express + PostgreSQL. Fix nhỏ giữ nguyên mỗi file; fix RLS runtime giữ nguyên 100% signature `pool.query(text, params)` của routes bằng cách: pool chính nối bằng role `resihub_app` (RLS-bound), user context luân chuyển qua `AsyncLocalStorage` (middleware `authenticateToken` set, `pool.query` tự mở `BEGIN/SET LOCAL/.../COMMIT` khi có context), các luồng auth/seed/migration dùng `adminPool` (superuser) như mối bypass hợp lệ phía server. Policy DB cập nhật qua migration mới `013_rls_fixes.sql` (không sửa migration đã chạy).

**Tech Stack:** Node 22 + Express, `pg`, `jsonwebtoken`, `bcryptjs`, PostgreSQL 16 (Docker, port 5433), React + Vite (port 3000, proxy /api → :5000).

**Spec:** `PRD - Quan ly Can ho va Nha cho thue v2.0.md` — mục 6.2 (ma trận RBAC + "hai lớp UI + RLS"), FR-001..004, US-001/US-019 + AC-001.x/AC-019.1, mục 14.2, NFR-008, R-08. Kèm báo cáo audit: `Bao_Cao_Audit_Dang_Nhap_va_RLS.md` (mỗi finding có ID D1..D20 / R1..R7, plan mapping trực tiếp theo ID).

## Global Constraints

- Không đổi signature/hành vi API cho client hợp lệ; lỗi mới chỉ thêm: 403 cho vai trò sai, message trung lập cho auth.
- Không sửa file migration `001..012` (đã apply, có tracker `_migrations`). Mọi thay đổi policy DB nằm trong `api/src/db/migrations/013_rls_fixes.sql`.
- Franchise PRD giữ nguyên: OTP 5 phút/5 lần sai/khóa 15 phút/3 tin-giờ-SĐT; token 15m + 7d;-owner liền file RLS "RLS bật trên mọi bảng chứa dữ liệu theo tòa/hợp đồng, có test tự động".
- Vietnamese copy cho code comments và message giữ nguyên format `/resi`.
- Không thêm dependency mới (pg, AsyncLocalStorage, jsonwebtoken đã có sẵn; chrome-devtools là tool).
- NODE_ENV=development duy trì trong quá trình fix; fix phải quan sát an toàn khi NODE_ENV=production (thought-experiment + de-fence mỗi task).

## Review Focus

*(REVISED per second-round review — 6 rủi ro đã xác minh; tổng 11 vị trí `pool.connect()`, không còn con số "7-8".)*

1. **Pool starvation (Điểm 1):** wrapper per-query + checkout riêng mỗi query cạn pool (default max 10) khi `Promise.all`. Design Task 7 mới: **1 client dedicated/request** (set_config 1 lần, release qua `res finish/close`), `pool.query` route vào client đó → 0 checkout thêm/query. KHÔNG bọc transaction lớn per-request (nhánh `catch 23505 → 409` sẽ bị `25P02` giết kluster query sau). Test pin ở Task 7 step 7 + Task 9 step 2b.
2. **Sót transaction thủ công (Điểm 2):** 11 vị trí `pool.connect()` (đã kiểm kê ở Task 7 Files) phải đi qua helper `getUserClient(req)`; thiếu 1 chỗ = thao tác cọc/hợp đồng bị RLS default-deny (500). Test pin ở Task 9 step 3 (test_crud + compliance đầy đủ qua HTTP).
3. **NULL-context hoá bypass (R1):** `is_org_admin()` khóa NULL→FALSE; bypass duy nhất = `adminPool` (server-trusted). Test pin ở Task 8 (test 5 mới: SYS_ADMIN riêng + default-deny MANAGER chưa gán tòa).
4. **Luồng OTP fixture (Điểm 4):** test compliance đổi fixture `0901234567 → 0907778899`; Task 9 chạy lại test_phase1_compliance full. DevTools flow OTP dùng fixture từ `setup_resident_test_accounts.js`.
5. **UI FR-021 (Điểm 3):** `duplicates` trả `{id, full_name, phone}` (bỏ email/dob/CCCD); pin ở Task 9 DevTools step cảnh báo trùng trên TenantsPage.
6. **Contact BQL cho cư dân (Điểm 5):** policy app_user/user_role/person mở theo "tòa cư dân đang ở" (không mở theo org); pin ở Task 9 DevTools (cổng cư dân hiển thị đúng contact BQL tòa mình, không thấy tòa khác).
7. **Occupant (Điểm 6):** scope tenants list gồm `contract_occupant`; pin ở Task 9 (test compliance tạo tenant + sót data seed occupant nếu có).
8. **Log-out flow** không ảnh hưởng: được thử bằng DevTools Task 9 (logout → 401 → redirect login).

---

### Task 0: Báo cáo audit + kế hoạch vào kho (docs)

**Files:**
- Commit cả 2 file: `Bao_Cao_Audit_Dang_Nhap_va_RLS.md`, `docs/superpowers/plans/2026-10-21-fix-auth-rls-findings.md`

- [ ] **Step 1: Commit**

```bash
git add Bao_Cao_Audit_Dang_Nhap_va_RLS.md docs/superpowers/plans/
git commit -m "docs: báo cáo audit đăng nhập & RLS + kế hoạch fix 20 findings"
```

### Task 1: (D5) JWT secret fail-fast

**Files:**
- Modify: `api/src/routes/auth.js:16-17`
- Modify: `api/src/middleware/auth.js:14`

**Interfaces:** không đổi.

- [ ] **Step 1:** Ở `auth.js`, thay 2 dòng fallback bằng:
```js
const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;
if (!JWT_SECRET || !JWT_REFRESH_SECRET) throw new Error('JWT_SECRET / JWT_REFRESH_SECRET bắt buộc (xem .env.example)');
```
Tương tự 1 dòng ở `middleware/auth.js:14` (import secret từ `auth.js`? không — giữ independent check này, hoặc export `JWT_SECRET` từ 1 file dùng chung nếu hai công nhận quan trọng: chọn **export từ `auth.js`** và `middleware/auth.js` import `JWT_SECRET` avoids duplicate throw).

- [ ] **Step 2: verify fail-fast**
Run (PowerShell, từ `api/`):
```bash
$env:JWT_SECRET='x'; $env:JWT_REFRESH_SECRET='y'; node -e "import('./src/routes/auth.js').then(()=>console.log('boot OK'))"
```
Expected: `boot OK`. Sau đó:
```bash
node -e "import('./src/routes/auth.js').catch(e=>console.log('BLOCKED:', e.message))"
```
Expected: `BLOCKED: JWT_SECRET / JWT_REFRESH_SECRET bắt buộc ...`
- [ ] **Step 3: chạy server thật** `node src/server.js` (đọc .env) → `GET /health` 200.
- [ ] **Step 4: Commit** `git commit -am "fix(auth): D5 - fail fast khi thiếu JWT_SECRET/không có secret fallback"`.

### Task 2: (D7) /refresh kiểm tra SUSPENDED + reload roles

**Files:**
- Modify: `api/src/routes/auth.js` (handler `/refresh`, dòng 375-402 → dùng `pool.query` đúng, route này KHÔNG có user-context kích hoạt theo Task 7 → dùng `adminPool` (task 7 mới định nghĩa; hiện dùng `pool` chờ gán Task 7 sửa lại).

**Interfaces (Task 7 phụ thuộc):** refresh cuối cùng viết truy vấn qua `adminPool`.

- [ ] **Step 1:** Trong `jwt.verify` callback của `/refresh` đổi thành async handler:
```js
// 1. SELECT app_user status: SELECT status FROM app_user WHERE id = decoded.sub (adminPool)
// nếu 404 hoặc status !== 'ACTIVE' → 403 {code: 'ACCOUNT_SUSPENDED', ...}
// 2. reload roles bằng cùng QUERY login (user_role JOIN role) qua adminPool
// 3. sign access 15m với payload như login (org_id/phone/email lấy từ DB person, như flow login email)
```
- [ ] **Step 2: verify thủ công** POST /otp/verify user test; ثم `UPDATE app_user SET status='SUSPENDED' WHERE id=...`; `POST /auth/refresh` với refresh token cũ → Expect **403 ACCOUNT_SUSPENDED**. Trước khi commit đợi dùng test DB Task 9? KHÔNG — bước này chỉ code đúng, verify DB chạy được ở Task 9 step regression; local node không có DB sẽ skip curl.
- [ ] **Step 3: Commit** `git commit -am "fix(auth): D7 - /refresh kiểm tra SUSPENDED + reload roles từ DB"`.

### Task 3: (D6+D8) OTP chỉ cho tài khoản có sẵn + audit khi khóa

**Files:**
- Modify: `api/src/routes/auth.js` — handler `/otp/request` (L37-96), handler `/otp/verify` (L166-209), và chèn audit khi khóa (L148-154).
- Modify: `api/test_phase1_compliance.mjs:30,39` — đổi test OTP từ SĐT hard-code `0901234567` (không có trong seed) sang fixture có sẵn `0907778899` (`resident_active@resihub.vn`, seeded bởi `setup_resident_test_accounts.js:53-59`). *[Bổ sung per review Điểm 4]*

**Interfaces:** dùng `adminPool` cho lookup auth (Task 7 định nghĩa export từ `db/client.js`); giờ viết `pool`, Task 7 đổi import.

- [ ] **Step 1:** `/otp/request`: sau khi đã normalize `cleanPhone`, thay khối "kiểm lock" — giữ nguyên; thêm kiểm tra trước sinh OTP:
```js
const acct = await adminPool.query(
  `SELECT au.status FROM person p JOIN app_user au ON au.person_id = p.id WHERE p.phone = $1`,
  [cleanPhone]
);
// nếu rows.length === 0 hoặc status !== 'ACTIVE' → KHÔNG set otpStore, KHÔNG sinh OTP, vẫn trả res.json({message: 'OTP đã được gửi thành công.'}) (AC-001.3 trung lập)
```
- [ ] **Step 2:** `/otp/verify`: **xóa** toàn khối tự tạo person/app_user/role mặc định (L172-209). Nếu `personRes.rows.length === 0` → trả 400 neutral `OTP_NOT_FOUND` (cùng code 'OTP không tồn tại hoặc đã hết hạn'). Tài `app_user` cũng phải tồn tại; nếu không có app_user → cùng neutral error.
- [ ] **Step 3:**ở điểm khóa 15 phút (`record.attempts >= 5`) trước khi return 429:
```js
await adminPool.query(
  `INSERT INTO audit_log (actor_id, action, entity, entity_id, after) VALUES ($1, 'AUTH_LOCK', 'phone', $2, $3)`,
  [null, require('crypto').randomUUID() /* entity_id UUID NOT NULL - dùng uuid ngẫu nhiên vì phone không phải UUID */, JSON.stringify({ phone: cleanPhone })]
);
```
*(Lưu ý: `entity_id UUID NOT NULL` trong 007 — dùng `gen_random_uuid()` inline trong SQL thay vì crypto import.)*
- [ ] **Step 3b (test compliance):** trong `test_phase1_compliance.mjs` đổi `'0901234567'` → `'0907778899'` ở L30 và L39 (TEST 0 giữ nguyên các assert 200 + accessToken) — bài test OTP xuyên qua luồng "tài khoản có sẵn" đúng nghiệp vụ mới.
- [ ] **Step 3c:** Verify mơ (console Task 9): request OTP cho SĐT lạ `0999xxx` rồi `/otp/verify` đúng OTP → generic error; SĐT fixture `0907778899`: sau 5 lần sai → audit_log có bản ghi `AUTH_LOCK`.
- [ ] **Step 4: Commit** `git commit -am "fix(auth): D6+D8 - OTP chỉ cho tài khoản có sẵn, bỏ self-registration, audit khi khóa SĐT; test compliance dùng fixture SĐT chuẩn"`.

### Task 4: (D2+D3+D4) Chặn lộ PII Tenants + Reservations

> **REVISED per review (Điểm 3 + 6):** check-dup VẪN trả `duplicates` cho OWNER/MANAGER (FR-021 UI cần `duplicates[0].full_name` ở `TenantsPage.jsx:68,210`) nhưng chỉ tối thiểu `{id, full_name, phone}` — bỏ email/dob/`id_number`(CCCD). Manager scope cho tenants list phải bao gồm **occupant** qua `contract_occupant` (schema `005:41-47`).

**Files:**
- Modify: `api/src/routes/tenants.js:12-45` (check-dup), `:51-63` (GET list)
- Modify: `api/src/routes/reservations.js:12-49` (GET list)

**Interfaces:** không đổi; test `test_phase1_compliance.mjs:241-243` chỉ assert `isDuplicate === true` → không bị phá bởi rút gọn `duplicates`.

- [ ] **Step 1 (`tenants.js` check-dup):** thêm `requireRole(['OWNER', 'MANAGER'])` và rút gọn danh sách trả về:
```js
// SELECT đổi thành: SELECT p.id, p.full_name, p.phone FROM person p WHERE ... (bỏ *, bỏ email/dob/id_number)
res.json({
  isDuplicate: result.rows.length > 0,
  duplicates: result.rows,   // [{id, full_name, phone}] — đủ cho UI FR-021 + hợp nhất hồ sơ
});
```
- [ ] **Step 2 (`tenants.js` GET list):** MANAGER không phải OWNER — scope bằng hợp đồng (primary **+ occupant**):
```js
if (isManager && !isOwner) {
  params.push(req.user.sub);
  sql += ` AND (
    t.id IN (SELECT c.primary_tenant_id FROM contract c
             WHERE c.building_id IN (SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL))
    OR t.id IN (SELECT co.tenant_id FROM contract_occupant co
             JOIN contract c ON c.id = co.contract_id
             WHERE c.building_id IN (SELECT building_id FROM user_role WHERE user_id = $${params.length}))
  )`;
}
```
- [ ] **Step 3 (`reservations.js` GET):** thêm `requireRole(['OWNER', 'MANAGER'])`; MANAGER scope theo tòa:
```js
if (isManager && !isOwner) {
  params.push(req.user.sub);
  sql += ` AND r.building_id IN (
    SELECT building_id FROM user_role WHERE user_id = $${params.length} AND building_id IS NOT NULL
  )`;
}
```
- [ ] **Step 4: Commit** `git commit -am "fix(api): D2+D3+D4 - check-dup role-gated + rút gọn PII trả về, scope tenants (primary+occupant)/reservations theo tòa"`.

### Task 5: (D12+D14+D15+D16) 4 lỗi nhỏ

**Files:**
- Modify: `api/src/routes/contracts.js:95-99` (resident match person_id)
- Modify: `api/src/routes/buildings.js:475-495` (DELETE floor guard)
- Modify: `api/src/routes/notifications.js:44-59` (PATCH /:id/read check user)
- Modify: `api/src/routes/resident.js:137-146` (manager_contact theo tòa hợp đồng cư dân)

- [ ] **Step 1 (`contracts.js`):** RESIDENT branch so-khop bằng `row.primary_tenant_id JOIN tenant→person_id` thay phone/email:
```js
} else if (isResident && !isOwner && !isManager) {
  if (row.person_id !== req.user.person_id) {
    return res.status(403).json({ code: 'FORBIDDEN', message: 'Bạn chỉ có quyền xem hợp đồng của chính mình.' });
  }
}
```
*(vì SELECT trước đã JOIN person p — thêm `p.id as person_id` vào select-list.)*
- [ ] **Step 2 (`buildings.js` DELETE floor):** đầu route thêm `checkBuildingAccess(req.user.sub, roleCodes, req.user.org_id, req.params.id, 'delete')` + 403 dựa trên status trả về. `checkBuildingAccess` MANAGER branch đã trả `{allowed:false, 403}` cho action 'delete' — route chỉ forward kết quả.
- [ ] **Step 3 (`notifications.js` PATCH /:id/read):**
```js
WHERE id = $1 AND org_id = $2 AND (user_id = $3 OR user_id IS NULL) AND read_at IS NULL
```
- [ ] **Step 4 (`resident.js` manager_contact):** filter theo tòa của hợp đồng cư dân nếu có:
```js
managerContactRes = ...(nếu có contract: LEFT JOIN theo ur.building_id = $contract.building_id; ngược lại fallback như cũ)
```
- [ ] **Step 5: Commit** `git commit -am "fix(api): D12+D14+D15+D16 - hợp đồng theo person_id, guard xóa tầng, notification theo user, contact BQL theo tòa"`.

### Task 6: (R1+R2+R3/D13+R5+INSERT-WITH-CHECK) Migration `013_rls_fixes.sql`

**Files:**
- Create: `api/src/db/migrations/013_rls_fixes.sql`

**Contents (tiêu đề các khối trong file):**
1. `get_current_user_id()` giữ nguyên.
2. **`is_org_admin()`**: context NULL → `FALSE` (cryptography bỏ-case-NULL theo R1/không chủ default-deny); check role `code IN ('OWNER','SYS_ADMIN')` (R2). *(Migration/seed/db-client test chạy superuser vẫn bypass — an toàn.)*
3. **`get_user_assigned_buildings()`**: bỏ-owner-branch giữ nguyên,Manager-branch giữ; context NULL → không trả gì, chỉ superuser bypass.
4. **`get_resident_tenant_ids()`**: bỏ `RETURN QUERY SELECT id FROM tenant` NULL-branch → trả rỗng khi không context.
5. **ENABLE + FORCE RLS** cho bảng mới-covered: `floor`, `reservation`, `notification`, `app_user`, `user_role`, `audit_log`.
6. Policy từng bảng (tư `SELECT` + `ALL`):
   - `floor`: building-scoped giống `apartment`.
   - `reservation`: SELECT = manager scope (building trong `get_user_assigned_buildings`) OR is_org_admin OR **resident-match-phone** (`EXISTS ... JOIN person p ON p.id = r.phone-cmp: r.phone = own phone`); MODIFY = is_org_admin OR manager-building-scope.
   - `notification`: SELECT `(user_id IS NULL OR user_id = get_current_user_id()) AND org_id match`; MODIFY same.
   - `app_user`: SELECT self (`id = get_current_user_id()`) OR is_org_admin **OR là quản lý của tòa cư dân đang ở**:
     ```sql
     OR EXISTS (
       SELECT 1 FROM user_role ur2
       JOIN role r2 ON r2.id = ur2.role_id
       WHERE ur2.user_id = app_user.id
         AND r2.code IN ('MANAGER','STAFF')
         AND ur2.building_id IN (
           SELECT c.building_id FROM contract c
           JOIN tenant t ON t.id = c.primary_tenant_id
           WHERE t.person_id = (SELECT person_id FROM app_user WHERE id = get_current_user_id())
             AND c.status = 'ACTIVE'
         )
     )
     ```
     *(Chỉnh từ review Điểm 5: ch琛 hẹp hơn đề xuất ban đầu — không mở mọi MANAGER/STAFF của org cho mỗi cư dân, chỉ经理 của CHÍNH tòa mình; chủ yếu phục vụ widget "Liên hệ BQL" của `/resident/overview:137-146` và danh bạ.)*
   - `user_role`: SELECT self OR is_org_admin **OR dòng role là MANAGER/STAFF thuộc tòa cư dân đang ở** (SAME predicate như app_user, thay `ur2.user_id = app_user.id` bằng `ur2.id = user_role.id`): phục vụ cùng query contact; MODIFY is_org_admin.
   - `person`: SELECT giữ policy 010 + thêm branch: person là identified-manager của tòa cư dân:
     ```sql
     OR EXISTS (
       SELECT 1 FROM app_user au2
       JOIN user_role ur3 ON ur3.user_id = au2.id
       JOIN role r3 ON r3.id = ur3.role_id
       WHERE au2.person_id = person.id AND r3.code IN ('MANAGER','STAFF')
         AND ur3.building_id IN ( /* own-building-set như trên */ )
     )
     ```
     MODIFY thêm self (`id = own person_id` → phục vụ `rental-application` update chính mình) OR MANAGER-org (same org, phục vụ tenants POST).
   - `tenant`: MODIFY thêm: is_org_admin OR MANAGER-create/CRU (guard same-org: `EXISTS (SELECT 1 FROM app_user u JOIN person pu ON pu.id = u.person_id WHERE u.id = get_current_user_id() AND t.org_id = pu.org_id)`) OR self-id trong `get_resident_tenant_ids()`.
   - `audit_log`: INSERT `WITH CHECK (actor_id = get_current_user_id() OR actor_id IS NULL)`; SELECT is_org_admin (routes hiện không đọc audit).
   - `building`: MODIFY thêm `FOR INSERT WITH CHECK (owner/org match, manager org)`: manager tạo mới tòa cần INSERT permitir: `EXISTS (person-org of current = org_id)` (đúng lobby của MANAGER tạo tòa tổ chức mình).
   - `deposit`, `deposit_transaction`, `apartment`, `contract`, `person_select`, giữ policy có sẵn của 010 (không phá).
7. Khối ghi chú JSDoc từng policy theo mục PRD 6.2.

- [ ] **Step 1:** viết file theo khối trên.
- [ ] **Step 2:** không chạy cục bộ (DB offline), verification dựa vào Task 9 (`node src/db/migrate.js` apply đây và `test_rls_zero_leak.mjs` PASS). *_Syntax check sớm qua* `psql` khi DB khởi động.
- [ ] **Step 3: Commit** `git commit -am "fix(db): Task 6 - 013_rls_fixes.sql SYS_ADMIN/NULL病情 context, RLS phủ floor/reservation/notification/app_user/user_role/audit_log, self & INSERT policies"`.

### Task 7: (D1) Bật RLS thật tại runtime — REVISED per review

> **REVISED per review ( Điểm 1 + 2):** bỏ design "per-query transaction" (nguy cơ cạn pool: mỗi query checkout riêng client + 3 round-trips; pg.Pool max mặc định 10). Design mới: **1 client dedicated cho toàn request**, set context **một lần** bằng session-level `set_config('app.current_user_id', uid, false)` (KHÔNG bọc transaction lớn — giữ nguyên autocommit từng query để nhánh `catch (23505) → 409` ở buildings/apartments không bị "current transaction is aborted" giết kluster các câu query sau khi handler cố tình catch; client riêng của request không leak context sang request khác vì `RESET` trước release).

**Files (cập nhật danh sách 11 vị trí `pool.connect()` — đã grep xác minh):**
- Modify: `api/src/db/client.js` (dual pool + AsyncLocalStorage + helper `getRlsClient`/`attachUserContext`)
- Modify: `api/src/middleware/auth.js` (set context sau jwt.verify)
- Modify: `api/src/routes/auth.js` (auth-flow queries dùng `adminPool`)
- Modify: các routes dùng `pool.connect()` trực tiếp (11 chỗ đã kiểm kê):
  - `tenants.js:82` (Tạo hồ sơ cư dân)
  - `resident.js:183` (rental-application)
  - `reservations.js:66` (POST reservations), `reservations.js:147` (convert), `reservations.js:194` (refund), `reservations.js:247` (forfeit)
  - `deposits.js:77` (POST transactions)
  - `contracts.js:155` (POST contracts), `contracts.js:249` (terminate)
  - `buildings.js:199` (POST buildings), `buildings.js:299` (PATCH status)
  *(Chú ý: `buildings.js:247-252` catch/dbErr-transaction — được bao bởi cùng client 199, chỉ set context 1 lần cho client đó.)*
- Modify: `api/src/db/migrate.js`, `api/src/db/seed.js` → import `adminPool`.
- Modify: `api/.env` + `api/.env.example` + `docker-compose.yml` (bổ sung biến).

**Interfaces (chốt):**
```js
// db/client.js exports (giữ nguyên tên cũ + thêm):
export const adminPool;          // postgres superuser (migrate/seed/auth — server-trusted)
export const pool;               // resihub_app (RLS-bound) — KHÔNG đổi signature pool.query(text, params)
export const userScope;          // AsyncLocalStorage; store = { client } — middleware import để als.run
export async function getUserClient(req) // checkout 1 client + set_config 1 lần (dùng tại 11 vị trí transaction thủ công)
// ALS store có client → pool.query wrapper chạy query TRÊN CLIENT ĐÓ (0 checkout thêm, 1 round-trip).
// ALS rỗng (route không auth: /health, cron) → appPool.query bình thường.
```

- [ ] **Step 1 (`client.js`):**
  - `adminPool` từ `DATABASE_URL` (postgres).
  - `appPool` gồm `APP_DATABASE_URL` (postgres://resihub_app:...@db) — **required**; dev thiếu → fallback adminPool + `console.warn`; `NODE_ENV=production` thiếu → throw ở startup.
  - `als = new AsyncLocalStorage()`; `pool = appPool`; override `query(text, params)`:
    ```js
    const store = als.getStore();
    if (store?.client) return store.client.query(text, params); // request-scoped
    return appPool.query(text, params);                          // fallback (health, cron)
    ```
  - export helper cho 11 vị trí transaction-thủ-công:
    ```js
    export async function getUserClient(req) {
      const client = await pool.connect();
      await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [req.user.sub]);
      const release = async () => {
        try { await client.query('RESET app.current_user_id'); } catch {}
        client.release();
      };
      return { client, release };
    }
    ```
- [ ] **Step 2 (`middleware/auth.js`):** sau `req.user = decoded`:
  ```js
  const client = await pool.connect();                       // 1 client cho toàn request
  try {
    await client.query(`SELECT set_config('app.current_user_id', $1, false)`, [req.user.sub]);
    req.dbClient = client;
    res.on('close', cleanup);                                // release đúng cả finish + close/error; guard release chồng (once + flag)
    res.on('finish', cleanup);
    als.run({ client }, () => next());
  } catch (e) { await cleanup(); throw e; }
  ```
  *(cleanup: `RESET app.current_user_id` best-effort → `client.release()` → xóa listener; dùng try/finally để chắc chắn không rò connection kể cả khi `next()` throw.)*
- [ ] **Step 3 (11 vị trí `pool.connect()`):** mỗi chỗ đổi:
  ```js
  - const client = await pool.connect();
  + const { client, release } = await getUserClient(req);
  // finally:
  - client.release();
  + await release();
  ```
  *(Không sửa transaction logic bên trong — client này đã có context từ bước connect.)*
- [ ] **Step 4 (`routes/auth.js`):** các lookup đăng nhập (person/app_user/roles/X + refresh + lock-audit) đổi sang `adminPool` (server-trusted; PRD 14.2 chows không yêu RLS hai lớp cho chính flow auth).
- [ ] **Step 5 (`migrate.js`, `seed.js`):** import `adminPool` thay `pool`.
- [ ] **Step 6 (`.env`, `.env.example`, `docker-compose.yml`):** thêm
  ```
  APP_DATABASE_URL=postgres://resihub_app:resihub_app_secret@localhost:5433/resihub
  ```
  `docker-compose.yml` api.environment thêm `APP_DATABASE_URL: postgres://resihub_app:...@postgres:5432/resihub`.
- [ ] **Step 7: Test pin (Review Focus #1):** bắt ít nhất hai request đồng thời đang gán tòa khác nhau (test fixture manager A + owner) chạy song song `Promise.all` trên cùng endpoints `GET /buildings` rồi đối chiếu: **kh-request nào thấy đúng scope của mình** + không có client rò rỉ (`pool.totalCount - pool.idleCount ≤ max`). Lệnh smoke trong Task 9 Step 2b.
- [ ] **Step 8: Commit** `git commit -am "feat(security): D1 - bật RLS runtime: pool resihub_app + 1 client/request (set_config session) + 11 transaction thủ công có context + adminPool cho auth/seed/migrate"`.

### Task 8: (R6+D10) Thai test RLS zero-leak + case SYS_ADMIN

**Files:**
- Modify: `api/test_rls_zero_leak.mjs`

- [ ] **Step 1:** sửa TEST 4: cleanup DELETE chuyển ra ngoài transaction (hoặc commit transaction trước, rồi chạy cleanup riêng) — hết-arrass dät test data.
- [ ] **Step 2:** thêm TEST 5: tạo user có **CHỈ** role `SYS_ADMIN` (không OWNER) → set context → `SELECT * FROM building` PASS khi is_org_admin mới nhận SYS_ADMIN; còn bật'un user role `MANAGER` không gán building nào → không thấy tòa nào (default-deny).
- [ ] **Step 3: Commit** `git commit -am "test(db): Task 8 - fix leak dữ liệu test + thêm case SYS_ADMIN riêng và default-deny cho MANAGER chưa gán tòa"`.

### Task 9: Verify toàn bộ — Docker up, migrate/seed, test scripts, Chrome DevTools E2E

**Files:** không code; có thể thêm `docs/superpowers/plans/2026-10-21-verification-results.md` (kết quả + screenshot).

- [ ] **Step 1: bring-up**
```bash
docker compose up -d postgres     # 이미 pre-require: Docker Desktop đang chạy
cd api && node src/db/migrate.js && node src/db/seed.js && node setup_resident_test_accounts.js
node src/server.js                # background
cd ../frontend && npm install && npm run dev   # background, http://localhost:3000
```
- [ ] **Step 2: regression test scripts (console):**
```bash
node test_rls_zero_leak.mjs       # PASS mới được
node test_rbac_matrix.mjs         # PASS với API đang chạy (fixture email login dev password)
node test_crud_scoping.mjs
node test_phase1_compliance.mjs   # optional nếu fix tác động
```
Expected: 3 PASS 100% (nếu fail, quay lại Task 6/7 fix chỗ sót, mỗi fix 1 commit bằng tên task).
- [ ] **Step 2b (pool starvation + stale context — Review Focus #1/#4):**
  ```bash
  # a) Load-safe: chạy 50 request đồng thời hai user khác scope, đối chiếu kết quả per-user vẫn đúng:
  node -e "Promise.all(Array.from({length:25},()=>fetch.login_manager_then GET /buildings))..." (script smoke ngắn, hoặc dùng test_rls_zero_leak đã CHECK-in)
  PASS: mỗi token nhận đúng scope của user đó; sai lệch = stale context (BUG Task 7).
  # b) Sau toàn bộ regression: pool.totalCount - pool.idleCount == 0 (không rò connection).
  ```
- [ ] **Step 3: đọc `setup_resident_test_accounts.js` để chán số phone/SSO fixture cư dân test** (dùng cho DevTools). Fixture đã xác minh: `0900000005` (resident@resihub.vn — có cọc giữ chỗ, chưa có HĐ), `0907778899` (resident_active@resihub.vn — HĐ ACTIVE căn A102).
- [ ] **Step 4: Chrome DevTools E2E (dùng tool `chromium-devtools`):**
  1. `list_pages → navigate http://localhost:3000` → Login **MANAGER** (email `manager@resihub.vn`, dev password fixture) → verify `/admin/buildings` chỉ list tòa MANAGER quản lý.
  2. Chép một `building_id` của tòa KHÔNG thuộc quyền (get từ store/API) → tự paste URL `/admin/buildings` + test API direct access bằng `Page.evaluate(fetch('/api/v1/buildings/<id-khác>'))` → Expect 403.
  3. Login **OWNER** (`owner@resihub.vn`) → dashboard toàn bộ tòa; g prób `POST /api/v1/buildings` từ console (`fetch`) → Expect 403 (OWNER R-only).
  4. Đăng **RESIDENT** qua luồng OTP theo phone fixture: nhập SĐT → lay `devOtp` từ console API (server log) hoặc fix response → login xong → Router tự redirect `/resident`; dỉ paste URL `/admin/dashboard` → `AccessDenied`; gọi `fetch('/api/v1/tenants/check-dup?phone=...')` từ console → Expect 403 (nay không phải manager).
  5. Login RESIDENT khác (cư dân khác) → verify 0 crossovers: `/resident/apartment` chỉ hiện căn hợp đồng của chính mình.
  6. **FR-021 UI (Review Focus #5):** ở MANAGER → `/admin/tenants` nhập đúng SĐT trùng → banner "Số này đã thuộc hồ sơ: <full_name>" vẫn hiện (dữ liệu `{id, full_name, phone}` đã rút gọn); nhập SĐT mới → không banner.
  7. **Contact BQL (Review Focus #6):** cổng cư dân (`/resident`) widget Liên hệ BQL hiển thị đúng quản lý của tòa sở hữu hợp đồng, không trống (policy `app_user/user_role/person` branch manager-of-my-building).
  8. Screenshot từng vai trại chụp mỗi lần use case pass → `docs/.../2026-10-21-verification-results.md`.
- [ ] **Step 5: Commit docs** `git commit -am "docs: kết quả verify Fix Auth & RLS (test scripts + DevTools E2E)"`.

**Notes:** nếu Word thàm fix là ZERO Failing test工程有限公司; mỗi commit đi từ một ID finding duy nhất để dễ revert.

---

## Self-review checklist (đã chạy + chạy lại sau revision-round-1)

1. **Spec coverage:** D1..D20/R1..R7 — D1(T6+T7), D2-D4(T4), D5(T1), D6+D8(T3), D7(T2), D10-R2(T6), D12-D16(T5), D18-R6(T8), D20(FR-004 — out-of-scope). Hijacks phải thiết kế outlier được pin lại: pool starvation(Điểm 1 → T7 step 7 / T9 2b), 11 vị trí Không-set-context(Điểm 2 → T7 Files), UI FR-021 (Điểm 3 → T4 step 1 + T9 DevTools 6), test compliance fixture (Điểm 4 → T3 step 3b), contact BQL (Điểm 5 → T6 policies + T9 DevTools 7), occupant (Điểm 6 → T4 step 2).
2. **Step scan:** mỗi step một hành động + expected result, đủ nhận biết tên file/dòng.
3. **Type consistency:** `adminPool`, `getUserClient(req) → { client, release }`, ALS store `{client}`, migration `013_rls_fixes.sql` — thống nhất trong T2/T3/T6/T7/T8; T2 note "dùng pool chờ gán Task 7 sửa lại" giữhoạt require.
4. **Review Focus:** 8 input-modes mỗi mode đều có test pin chỉ vào task cụ thể.
5. **Proportion:** plan ~380 dòng cho ~9 task × mã thật đã list — không transcribe body code mà không được signature/test xác định.
