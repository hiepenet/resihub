/**
 * seed_demo.js — Seed dữ liệu demo chuẩn PRD v2.0 (v0.2) cho ResiHub
 *
 * Cấu trúc dữ liệu theo PRD Mục 6.1, 6.2, 8.1, FR-007 & FR-070:
 *   - 3 Chủ đầu tư (OWNER): Vinhomes Ocean Park, Vinhomes Smart City, Royal City
 *   - owner (1) ──< building (n): Mỗi chủ đầu tư sở hữu 3 tòa độc lập (Tòa A, Tòa B, Tòa C) = 9 building
 *     (VOP-A, VOP-B, VOP-C, VSC-A, VSC-B, VSC-C, RCT-A, RCT-B, RCT-C)
 *   - Mỗi building: 2 phân khu nội bộ (zone: DONG = Khu Đông, TAY = Khu Tây), 10 tầng, 5 căn/tầng = 50 căn/tòa (tổng 450 căn)
 *   - Mỗi building: 1 Quản lý tòa nhà (MANAGER) được gán duy nhất 1 building_id trong user_role
 *   - ~34% căn hộ có hợp đồng ACTIVE + sổ cọc HELD + tài khoản cư dân (RESIDENT)
 *   - 1 Quản trị hệ thống (SYS_ADMIN): admin@resihub.vn
 *
 * Chạy: node src/db/seed_demo.js
 */

import pg from 'pg';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

dotenv.config();

const { Pool } = pg;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    `postgres://${process.env.POSTGRES_USER || 'postgres'}:${process.env.POSTGRES_PASSWORD || 'postgres'}@${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || '5433'}/${process.env.POSTGRES_DB || 'resihub'}`,
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function phone(n) {
  return `09${String(n).padStart(8, '0')}`;
}

function idNumber(n) {
  return `07900${String(n).padStart(7, '0')}`;
}

async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function seed() {
  const client = await pool.connect();
  try {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  ResiHub — Demo Seed (PRD v2.0 / v0.2 Multi-Building)');
    console.log('═══════════════════════════════════════════════════════');

    await client.query('BEGIN');

    // ── BƯỚC 1: Xóa dữ liệu cũ ─────────────────────────────────────────────
    console.log('\n[1/7] Xóa dữ liệu cũ...');
    await client.query(`
      TRUNCATE TABLE
        deposit_transaction, deposit,
        contract_service_price, contract_version, contract_occupant, contract_request, contract,
        reservation,
        tenant,
        user_role, app_user,
        notification, attachment, audit_log,
        apartment,
        zone,
        floor,
        building,
        person,
        owner,
        role,
        organization
      RESTART IDENTITY CASCADE;
    `);
    console.log('   ✓ Đã xóa toàn bộ dữ liệu cũ.');

    // ── BƯỚC 2: Organization & Roles ────────────────────────────────────────
    console.log('\n[2/7] Tạo Organization & Roles...');

    const { rows: [org] } = await client.query(`
      INSERT INTO organization (name, tax_code, settings, payment_account)
      VALUES (
        'Tập đoàn Quản lý Bất động sản ResiHub',
        '0312345678',
        '{"currency": "VND", "timezone": "Asia/Ho_Chi_Minh"}',
        '{"bank": "Vietcombank", "account_no": "99988877766", "account_name": "RESIHUB CORP", "type": "corporate"}'
      )
      RETURNING id;
    `);
    const orgId = org.id;
    console.log(`   ✓ Organization: ${orgId}`);

    const rolesMeta = [
      { code: 'OWNER',     name: 'Chủ đầu tư / Chủ nhà', scope: 'org' },
      { code: 'MANAGER',   name: 'Quản lý tòa nhà',        scope: 'building' },
      { code: 'RESIDENT',  name: 'Cư dân',                  scope: 'building' },
      { code: 'SYS_ADMIN', name: 'Quản trị hệ thống',      scope: 'org' },
    ];
    const roleIdMap = {};
    for (const r of rolesMeta) {
      const { rows: [row] } = await client.query(
        `INSERT INTO role (org_id, code, name, scope)
         VALUES ($1, $2, $3, $4)
         RETURNING id;`,
        [orgId, r.code, r.name, r.scope]
      );
      roleIdMap[r.code] = row.id;
    }
    console.log('   ✓ Roles: OWNER, MANAGER, RESIDENT, SYS_ADMIN');

    // ── BƯỚC 3: 3 Chủ đầu tư (OWNER) + 9 Tòa nhà độc lập (BUILDING) ────────
    console.log('\n[3/7] Tạo 3 Chủ đầu tư (OWNER) và 9 Tòa nhà (BUILDING)...');

    const defaultPassword = await hashPassword('Demo@123456');

    const complexesMeta = [
      {
        complexName: 'Vinhomes Ocean Park',
        prefix: 'VOP',
        address: 'Gia Lâm, Hà Nội',
        ownerName: 'Chủ đầu tư Vinhomes Ocean Park',
        ownerPhone: phone(1000001),
        ownerEmail: 'owner.vop@resihub.vn',
        ownerIdNo: idNumber(1000001),
      },
      {
        complexName: 'Vinhomes Smart City',
        prefix: 'VSC',
        address: 'Nam Từ Liêm, Hà Nội',
        ownerName: 'Chủ đầu tư Vinhomes Smart City',
        ownerPhone: phone(1000002),
        ownerEmail: 'owner.vsc@resihub.vn',
        ownerIdNo: idNumber(1000002),
      },
      {
        complexName: 'Royal City',
        prefix: 'RCT',
        address: '72A Nguyễn Trãi, Thanh Xuân, Hà Nội',
        ownerName: 'Chủ đầu tư Royal City',
        ownerPhone: phone(1000003),
        ownerEmail: 'owner.rct@resihub.vn',
        ownerIdNo: idNumber(1000003),
      },
    ];

    const towerLetters = ['A', 'B', 'C'];
    const buildings = []; // [{ id, code, name, prefix, letter, ownerId }]

    for (const cm of complexesMeta) {
      // 1. Tạo person cho owner
      const { rows: [personRec] } = await client.query(
        `INSERT INTO person (org_id, full_name, phone, email, id_number)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id;`,
        [orgId, cm.ownerName, cm.ownerPhone, cm.ownerEmail, cm.ownerIdNo]
      );
      const personId = personRec.id;

      // 2. Tạo owner record liên kết chặt với person_id
      const { rows: [ownerRec] } = await client.query(
        `INSERT INTO owner (org_id, person_id, full_name, phone, email)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id;`,
        [orgId, personId, cm.ownerName, cm.ownerPhone, cm.ownerEmail]
      );
      const ownerId = ownerRec.id;

      // 3. Tạo app_user & gán role OWNER cho owner
      const { rows: [userRec] } = await client.query(
        `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
         VALUES ($1, $2, $3, 'ACTIVE')
         RETURNING id;`,
        [personId, `owner-${cm.prefix.toLowerCase()}`, defaultPassword]
      );
      await client.query(
        `INSERT INTO user_role (user_id, role_id, building_id)
         VALUES ($1, $2, NULL);`,
        [userRec.id, roleIdMap['OWNER']]
      );

      console.log(`   ✓ Owner: ${cm.ownerName} (${cm.ownerEmail})`);

      // 4. Tạo 3 tòa độc lập (Tòa A, Tòa B, Tòa C) thuộc quyền sở hữu của owner này
      for (const letter of towerLetters) {
        const bldgCode = `${cm.prefix}-${letter}`;
        const bldgName = `${cm.complexName} - Tòa ${letter}`;
        const bldgAddr = `Tòa ${letter}, ${cm.complexName}, ${cm.address}`;

        const { rows: [bldg] } = await client.query(
          `INSERT INTO building (org_id, owner_id, name, code, address, status)
           VALUES ($1, $2, $3, $4, $5, 'ACTIVE')
           RETURNING id;`,
          [orgId, ownerId, bldgName, bldgCode, bldgAddr]
        );

        buildings.push({
          id: bldg.id,
          code: bldgCode,
          name: bldgName,
          complexName: cm.complexName,
          prefix: cm.prefix,
          letter,
          ownerId,
        });
      }
    }

    // ── BƯỚC 4: Zones (Khu Đông/Tây) + 10 Floors + 1 Manager cho từng Tòa ───
    console.log('\n[4/7] Tạo phân khu (Khu Đông/Khu Tây), 10 tầng và 1 Manager riêng cho mỗi tòa...');

    const FLOORS_PER_BUILDING = 10;
    const APTS_PER_FLOOR = 5;

    let phoneCounter = 2000001;
    let idNoCounter = 2000001;

    // zonesMap: buildingId → { eastId, westId }
    const zonesMap = {};
    // floorsMap: buildingId → [{ id, level }]
    const floorsMap = {};
    // managerByBuilding: buildingId → managerUserId
    const managerByBuilding = {};

    for (const bldg of buildings) {
      // 1. Tạo 2 phân khu nội bộ theo đúng FR-007 (cánh/khu của tòa)
      const { rows: [eastZone] } = await client.query(
        `INSERT INTO zone (org_id, building_id, code, name)
         VALUES ($1, $2, 'DONG', 'Khu Đông')
         RETURNING id;`,
        [orgId, bldg.id]
      );
      const { rows: [westZone] } = await client.query(
        `INSERT INTO zone (org_id, building_id, code, name)
         VALUES ($1, $2, 'TAY', 'Khu Tây')
         RETURNING id;`,
        [orgId, bldg.id]
      );
      zonesMap[bldg.id] = { eastId: eastZone.id, westId: westZone.id };

      // 2. Tạo 10 tầng cho tòa này
      floorsMap[bldg.id] = [];
      for (let level = 1; level <= FLOORS_PER_BUILDING; level++) {
        const { rows: [floorRec] } = await client.query(
          `INSERT INTO floor (building_id, level, name)
           VALUES ($1, $2, $3)
           RETURNING id;`,
          [bldg.id, level, level === 1 ? 'Tầng 1 (Trệt)' : `Tầng ${level}`]
        );
        floorsMap[bldg.id].push({ id: floorRec.id, level });
      }

      // 3. Tạo 1 Manager chuyên trách duy nhất cho tòa này
      const mgEmail = `manager.${bldg.prefix.toLowerCase()}.${bldg.letter.toLowerCase()}@resihub.vn`;
      const mgName = `Quản lý ${bldg.name}`;
      const mgPhone = phone(phoneCounter++);
      const mgIdNo = idNumber(idNoCounter++);

      const { rows: [mgPerson] } = await client.query(
        `INSERT INTO person (org_id, full_name, phone, email, id_number)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id;`,
        [orgId, mgName, mgPhone, mgEmail, mgIdNo]
      );

      const { rows: [mgUser] } = await client.query(
        `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
         VALUES ($1, $2, $3, 'ACTIVE')
         RETURNING id;`,
        [mgPerson.id, `manager-${bldg.prefix.toLowerCase()}-${bldg.letter.toLowerCase()}`, defaultPassword]
      );

      // Gán MANAGER vào ĐÚNG 1 building_id của tòa này
      await client.query(
        `INSERT INTO user_role (user_id, role_id, building_id)
         VALUES ($1, $2, $3);`,
        [mgUser.id, roleIdMap['MANAGER'], bldg.id]
      );

      managerByBuilding[bldg.id] = mgUser.id;
      console.log(`   ✓ [${bldg.code}] ${bldg.name} → Manager: ${mgEmail}`);
    }

    // ── BƯỚC 5: Apartments (5 căn × 10 tầng × 9 tòa = 450 căn) ──────────────
    console.log('\n[5/7] Tạo căn hộ (5 căn × 10 tầng × 9 tòa = 450 căn)...');

    const aptsByBuilding = {};

    for (const bldg of buildings) {
      aptsByBuilding[bldg.id] = [];
      const zones = zonesMap[bldg.id];
      const floors = floorsMap[bldg.id];

      for (const floor of floors) {
        for (let aptNo = 1; aptNo <= APTS_PER_FLOOR; aptNo++) {
          // Mã căn: A101..A1005 (Tòa A), B101..B1005 (Tòa B), C101..C1005 (Tòa C)
          const aptCode = `${bldg.letter}${floor.level}0${aptNo}`;
          const zoneId = aptNo <= 3 ? zones.eastId : zones.westId;

          const bedroomsOptions = [1, 1, 2, 2, 3];
          const bedrooms = bedroomsOptions[(aptNo - 1) % bedroomsOptions.length];
          const area = 35 + (bedrooms - 1) * 15 + aptNo * 2;
          const baseRent = 5000000 + bedrooms * 2000000 + floor.level * 100000;

          const { rows: [aptRec] } = await client.query(
            `INSERT INTO apartment (building_id, floor_id, zone_id, code, area_m2, type, bedrooms, base_rent, status, amenities)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'AVAILABLE',
               '{"wifi": true, "air_conditioner": true, "water_heater": true, "elevator": true}')
             RETURNING id;`,
            [bldg.id, floor.id, zoneId, aptCode, area, `${bedrooms}PN`, bedrooms, baseRent]
          );

          aptsByBuilding[bldg.id].push({
            id: aptRec.id,
            code: aptCode,
            buildingId: bldg.id,
            floorLevel: floor.level,
            bedrooms,
            baseRent,
          });
        }
      }
    }

    const totalApts = Object.values(aptsByBuilding).reduce((s, arr) => s + arr.length, 0);
    console.log(`   ✓ ${totalApts} căn hộ đã tạo.`);

    // ── BƯỚC 6: Tenants + Contracts + Deposits + Residents (~34%) ───────────
    console.log('\n[6/7] Tạo cư dân, hợp đồng ACTIVE và sổ cọc...');

    let tenantCounter = 1;
    let contractCount = 0;

    for (const bldg of buildings) {
      const apts = aptsByBuilding[bldg.id];
      const creatorManagerId = managerByBuilding[bldg.id];
      // Deterministic: chọn mỗi căn thứ 3 (17/50 căn mỗi tòa = 153 căn trên toàn hệ thống)
      const toOccupy = apts.filter((_, i) => i % 3 === 0);

      for (const apt of toOccupy) {
        const tPhone = phone(phoneCounter++);
        const tIdNo = idNumber(idNoCounter++);
        const tEmail = `tenant${tenantCounter}@resihub.vn`;
        const tName = `Cư Dân ${tenantCounter}`;

        const { rows: [tPerson] } = await client.query(
          `INSERT INTO person (org_id, full_name, phone, email, id_number)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id;`,
          [orgId, tName, tPhone, tEmail, tIdNo]
        );

        const { rows: [tenantRec] } = await client.query(
          `INSERT INTO tenant (person_id, org_id, type, status)
           VALUES ($1, $2, 'primary', 'APPROVED')
           RETURNING id;`,
          [tPerson.id, orgId]
        );

        const { rows: [tUser] } = await client.query(
          `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
           VALUES ($1, $2, $3, 'ACTIVE')
           RETURNING id;`,
          [tPerson.id, `resident-${tenantCounter}`, defaultPassword]
        );

        await client.query(
          `INSERT INTO user_role (user_id, role_id, building_id)
           VALUES ($1, $2, $3);`,
          [tUser.id, roleIdMap['RESIDENT'], apt.buildingId]
        );

        // Tiền cọc = 1 tháng tiền thuê theo PRD Mục 10.3
        const startDate = '2026-01-01';
        const endDate = '2026-12-31';
        const depositAmt = apt.baseRent;

        const { rows: [contractRec] } = await client.query(
          `INSERT INTO contract (
             apartment_id, building_id, primary_tenant_id,
             start_date, end_date,
             rent_amount, billing_cycle, billing_day, payment_due_days,
             deposit_amount, status, created_by
           )
           VALUES ($1, $2, $3, $4, $5, $6, 'monthly', 5, 5, $7, 'ACTIVE', $8)
           RETURNING id;`,
          [
            apt.id,
            apt.buildingId,
            tenantRec.id,
            startDate,
            endDate,
            apt.baseRent,
            depositAmt,
            creatorManagerId,
          ]
        );

        await client.query(
          `UPDATE apartment SET status = 'OCCUPIED' WHERE id = $1;`,
          [apt.id]
        );

        const { rows: [depRec] } = await client.query(
          `INSERT INTO deposit (contract_id, amount_held, currency, status)
           VALUES ($1, $2, 'VND', 'HELD')
           RETURNING id;`,
          [contractRec.id, depositAmt]
        );

        await client.query(
          `INSERT INTO deposit_transaction (
             deposit_id, type, amount, description, method, status, approved_by, approved_at, created_by
           )
           VALUES ($1, 'collect', $2, 'Thu tiền cọc hợp đồng đầu kỳ', 'TRANSFER', 'APPROVED', $3, NOW(), $3);`,
          [depRec.id, depositAmt, creatorManagerId]
        );

        tenantCounter++;
        contractCount++;
      }
    }

    console.log(`   ✓ ${contractCount} hợp đồng ACTIVE + sổ cọc đã tạo cho ${contractCount} cư dân.`);

    // ── BƯỚC 7: Admin user (SYS_ADMIN) ──────────────────────────────────────
    console.log('\n[7/7] Tạo tài khoản Quản trị hệ thống (SYS_ADMIN)...');

    const { rows: [adminPerson] } = await client.query(
      `INSERT INTO person (org_id, full_name, phone, email, id_number)
       VALUES ($1, 'Quản trị viên ResiHub', '0900000001', 'admin@resihub.vn', '079000000001')
       RETURNING id;`,
      [orgId]
    );

    const adminPwd = await hashPassword('Admin@123456');
    const { rows: [adminUser] } = await client.query(
      `INSERT INTO app_user (person_id, auth_uid, password_hash, status)
       VALUES ($1, 'admin-resihub', $2, 'ACTIVE')
       RETURNING id;`,
      [adminPerson.id, adminPwd]
    );

    await client.query(
      `INSERT INTO user_role (user_id, role_id, building_id)
       VALUES ($1, $2, NULL);`,
      [adminUser.id, roleIdMap['SYS_ADMIN']]
    );

    console.log('   ✓ Admin: admin@resihub.vn | mật khẩu: Admin@123456');

    await client.query('COMMIT');

    // ── Tóm tắt ──────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  ✅ SEED HOÀN TẤT (CHUẨN ĐẶC TẢ PRD v2.0)');
    console.log('═══════════════════════════════════════════════════════');
    console.log('\nTài khoản demo:');
    console.log('┌───────────────────────────────────────────────────────────────┐');
    console.log('│ SYS_ADMIN (Mật khẩu: Admin@123456)                            │');
    console.log('│   • Toàn hệ thống (9 tòa)      : admin@resihub.vn             │');
    console.log('├───────────────────────────────────────────────────────────────┤');
    console.log('│ OWNER (Mật khẩu: Demo@123456) — Mỗi Owner sở hữu 3 tòa        │');
    console.log('│   • Vinhomes Ocean Park (A,B,C): owner.vop@resihub.vn         │');
    console.log('│   • Vinhomes Smart City (A,B,C): owner.vsc@resihub.vn         │');
    console.log('│   • Royal City (A,B,C)         : owner.rct@resihub.vn         │');
    console.log('├───────────────────────────────────────────────────────────────┤');
    console.log('│ MANAGER (Mật khẩu: Demo@123456) — Mỗi Manager quản lý 1 tòa   │');
    console.log('│   • VOP Tòa A / B / C          : manager.vop.a|b|c@resihub.vn │');
    console.log('│   • VSC Tòa A / B / C          : manager.vsc.a|b|c@resihub.vn │');
    console.log('│   • RCT Tòa A / B / C          : manager.rct.a|b|c@resihub.vn │');
    console.log('├───────────────────────────────────────────────────────────────┤');
    console.log(`│ RESIDENT (Mật khẩu: Demo@123456)                              │`);
    console.log(`│   • Cư dân đang thuê           : tenant1..${tenantCounter - 1}@resihub.vn      │`);
    console.log('└───────────────────────────────────────────────────────────────┘');
    console.log('\nSố liệu tổng hợp:');
    console.log(`  • Chủ đầu tư (Owner): 3`);
    console.log(`  • Tòa nhà độc lập (Building): ${buildings.length} (3 tòa/chủ đầu tư)`);
    console.log(`  • Phân khu nội bộ (Zone): ${buildings.length * 2} (Khu Đông + Khu Tây mỗi tòa)`);
    console.log(`  • Tầng (Floor): ${buildings.length * FLOORS_PER_BUILDING} (10 tầng/tòa)`);
    console.log(`  • Căn hộ (Apartment): ${totalApts} (50 căn/tòa)`);
    console.log(`  • Hợp đồng ACTIVE & Sổ cọc: ${contractCount}`);
    console.log(`  • Tài khoản cư dân: ${tenantCounter - 1}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ LỖI SEED:', err.message);
    console.error(err);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
