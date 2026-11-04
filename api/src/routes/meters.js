import express from 'express';
import { pool, getUserClient } from '../db/client.js';
import { authenticateToken } from '../middleware/auth.js';
import { requireRole } from '../middleware/rbac.js';
import { idempotencyGuard } from '../middleware/idempotency.js';
import { saveBase64Image } from '../services/imageUpload.js';
import {
  scopedBuildingFilter,
  checkBuildingAccess,
} from '../services/ownerScope.js';
import {
  currentVietnamPeriod,
  evaluateMeterReadingAnomaly,
  getMonthBoundsYmd,
  resolveChainedReadingBounds,
  resolveUtilityUnitPrice,
  roundReadingValue,
  selectTargetPeriodContract,
  validateChainedReadingInput,
} from '../services/serviceBilling.js';
import {
  formatContractCode,
  loadApartmentPeriodContractsMap,
  loadMeterPeriodReadingsWithLocks,
  loadPriorAndNextMeterReadings,
  syncDraftInvoiceMeterLineInTx,
} from '../services/meterTurnoverContext.js';
import { reviewAiSuggestion } from '../services/aiGateway.js';

const router = express.Router();

const PERIOD_RE = /^\d{4}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_READING_STATUSES = ['DRAFT', 'CONFIRMED', 'FLAGGED'];

async function resolveResourceScope(queryable, entity, id) {
  if (!id || !UUID_RE.test(String(id))) return null;
  const res = await queryable.query(
    `SELECT resource_id, org_id, building_id
     FROM fn_get_finance_resource_scope($1, $2::uuid)`,
    [entity, String(id)]
  );
  return res.rows[0] || null;
}

async function loadBillingConfigValues(queryable, orgId) {
  const res = await queryable.query(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'billing_config' LIMIT 1`,
    [orgId]
  );
  const cfg = res.rows[0]?.value || {};
  const pct = Number(cfg.meter_anomaly_threshold_pct);
  const anomalyThresholdPct = Number.isFinite(pct) && pct > 0 ? pct : 30;
  const elecDef = Number(cfg.electricity_default_price);
  const waterDef = Number(cfg.water_default_price);
  return {
    anomalyThresholdPct,
    anomalyThresholdRatio: anomalyThresholdPct / 100,
    electricityDefaultPrice: Number.isFinite(elecDef) && elecDef >= 0 ? Math.round(elecDef) : 3800,
    waterDefaultPrice: Number.isFinite(waterDef) && waterDef >= 0 ? Math.round(waterDef) : 22000,
  };
}

function findMatchingReadingForSlot(samePeriodReadings = [], targetContractId = null, slotIndex = 0) {
  if (targetContractId) {
    const exact = samePeriodReadings.find(
      (r) => r.contract_id && String(r.contract_id) === String(targetContractId)
    );
    if (exact) return exact;
    if (slotIndex <= 1) {
      const orphan = samePeriodReadings.find((r) => !r.contract_id && !r.is_billed);
      if (orphan) return orphan;
    }
    return null;
  }
  const nullRow = samePeriodReadings.find((r) => !r.contract_id);
  if (nullRow) return nullRow;
  return samePeriodReadings.length > 0 ? samePeriodReadings[samePeriodReadings.length - 1] : null;
}

/**
 * GET /api/v1/meters
 * Danh sách đồng hồ điện / nước theo tòa nhà & căn hộ, kèm chỉ số đợt hợp đồng đang chọn trong kỳ (M08)
 */
router.get(
  '/',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id, meter_type, period, search, status, contract_id } = req.query;
    const orgId = req.user.org_id;
    const targetPeriod = period && PERIOD_RE.test(period) ? period : currentVietnamPeriod();
    const normalizedStatusFilter =
      status && VALID_READING_STATUSES.includes(String(status).trim().toUpperCase())
        ? String(status).trim().toUpperCase()
        : null;

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'meter');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xem đồng hồ tòa nhà này.' });
        }
      }

      const params = [orgId, targetPeriod];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'm.building_id', params);

      let sql = `
        SELECT m.*,
               a.code AS apartment_code,
               a.status AS apartment_status,
               b.name AS building_name,
               b.code AS building_code,
               f.name AS floor_name,
               mr_base.avg_consumption AS prior_baseline_avg_consumption,
               mr_prev.current_reading AS prior_period_reading,
               mr_prev.consumption AS prior_period_consumption,
               mr_prev.period AS prior_period_ym
        FROM meter m
        JOIN apartment a ON a.id = m.apartment_id
        JOIN building b ON b.id = m.building_id
        LEFT JOIN floor f ON f.id = a.floor_id
        LEFT JOIN LATERAL (
          SELECT current_reading, consumption, period
          FROM meter_reading
          WHERE meter_id = m.id AND period < $2
          ORDER BY period DESC, current_reading DESC, recorded_at DESC
          LIMIT 1
        ) mr_prev ON TRUE
        LEFT JOIN LATERAL (
          SELECT ROUND(AVG(sub.consumption)::numeric, 2) AS avg_consumption
          FROM (
            SELECT consumption
            FROM meter_reading
            WHERE meter_id = m.id
              AND period < $2
              AND status = 'CONFIRMED'
              AND consumption > 0
            ORDER BY period DESC, current_reading DESC, recorded_at DESC
            LIMIT 3
          ) sub
        ) mr_base ON TRUE
        WHERE m.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND m.building_id = $${params.length}`;
      }
      if (meter_type) {
        params.push(meter_type);
        sql += ` AND m.meter_type = $${params.length}`;
      }
      if (search && search.trim()) {
        params.push(`%${search.trim()}%`);
        const idx = params.length;
        sql += ` AND (m.meter_code ILIKE $${idx} OR a.code ILIKE $${idx})`;
      }

      sql += ` ORDER BY b.code ASC, a.code ASC, m.meter_type ASC`;

      const [result, billingCfg] = await Promise.all([
        pool.query(sql, params),
        loadBillingConfigValues(pool, orgId),
      ]);

      let enrichedRows = result.rows;
      if (enrichedRows.length > 0) {
        const { monthEnd: periodEndYmd } = getMonthBoundsYmd(targetPeriod);
        const aptIds = [...new Set(enrichedRows.map((r) => r.apartment_id).filter(Boolean))];
        const meterIds = enrichedRows.map((r) => r.id);

        const contractsByApt = await loadApartmentPeriodContractsMap(pool, aptIds, targetPeriod);
        const catalogRes = await pool.query(
          `SELECT id, code, building_id, unit_price, is_active
           FROM service_catalog
           WHERE org_id = $1 AND is_active = TRUE`,
          [orgId]
        );

        const periodReadingsByMeter = await loadMeterPeriodReadingsWithLocks(
          pool,
          meterIds,
          targetPeriod,
          contractsByApt
        );

        const allContractIds = [
          ...new Set(
            [...contractsByApt.values()].flatMap((list) => list.map((c) => c.contract_id))
          ),
        ];
        const cspByContract = new Map();
        if (allContractIds.length > 0) {
          const cspRes = await pool.query(
            `SELECT contract_id, service_code, unit_price, effective_from
             FROM contract_service_price
             WHERE contract_id = ANY($1::uuid[])
               AND effective_from <= $2::date
             ORDER BY effective_from DESC`,
            [allContractIds, periodEndYmd]
          );
          for (const csp of cspRes.rows) {
            const cid = String(csp.contract_id);
            if (!cspByContract.has(cid)) cspByContract.set(cid, []);
            cspByContract.get(cid).push(csp);
          }
        }

        const reqContractId =
          contract_id && UUID_RE.test(String(contract_id)) ? String(contract_id) : null;

        enrichedRows = enrichedRows.map((m) => {
          const overlappingContracts = contractsByApt.get(String(m.apartment_id)) || [];
          const samePeriodReadings = periodReadingsByMeter.get(String(m.id)) || [];
          const priorObj =
            m.prior_period_reading !== null && m.prior_period_reading !== undefined
              ? {
                  current_reading: m.prior_period_reading,
                  consumption: m.prior_period_consumption,
                  period: m.prior_period_ym,
                }
              : null;

          const explicitValid =
            reqContractId &&
            overlappingContracts.some((c) => String(c.contract_id) === reqContractId)
              ? reqContractId
              : null;
          const { targetContract, slotIndex, totalSlots } = selectTargetPeriodContract(
            overlappingContracts,
            explicitValid
          );
          const targetContractId = targetContract ? targetContract.contract_id : null;
          const curReading = findMatchingReadingForSlot(
            samePeriodReadings,
            targetContractId,
            slotIndex
          );

          const bounds = resolveChainedReadingBounds({
            priorPeriodReading: priorObj,
            samePeriodReadings,
            nextPeriodReading: null,
            overlappingContracts,
            targetContractId,
            existingReadingId: curReading?.id || null,
            initialReading: m.initial_reading,
          });

          const slotSummaries = overlappingContracts.map((c, idx) => {
            const sIdx = idx + 1;
            const matchedRow = findMatchingReadingForSlot(samePeriodReadings, c.contract_id, sIdx);
            const slotBounds = resolveChainedReadingBounds({
              priorPeriodReading: priorObj,
              samePeriodReadings,
              nextPeriodReading: null,
              overlappingContracts,
              targetContractId: c.contract_id,
              existingReadingId: matchedRow?.id || null,
              initialReading: m.initial_reading,
            });
            return {
              contract_id: c.contract_id,
              contract_code: c.contract_code,
              tenant_name: c.tenant_name,
              status: c.status,
              overlap_start: c.overlap_start,
              overlap_end: c.overlap_end,
              slot_index: sIdx,
              total_slots: totalSlots,
              is_period_finalized: c.is_period_finalized,
              reading_id: matchedRow?.id || null,
              previous_reading:
                matchedRow?.previous_reading !== undefined && matchedRow?.previous_reading !== null
                  ? Number(matchedRow.previous_reading)
                  : slotBounds.previousReading,
              current_reading:
                matchedRow?.current_reading !== undefined && matchedRow?.current_reading !== null
                  ? Number(matchedRow.current_reading)
                  : null,
              consumption:
                matchedRow?.consumption !== undefined && matchedRow?.consumption !== null
                  ? Number(matchedRow.consumption)
                  : null,
              reading_status: matchedRow?.status || null,
              is_abnormal: Boolean(matchedRow?.is_abnormal),
              abnormal_note: matchedRow?.abnormal_note || null,
              image_url: matchedRow?.image_url || null,
              is_billed: Boolean(matchedRow?.is_billed),
            };
          });

          const defaultUtilityPrice =
            m.meter_type === 'ELECTRICITY'
              ? billingCfg.electricityDefaultPrice
              : billingCfg.waterDefaultPrice;
          const effPeriodEnd = targetContract?.overlap_end || periodEndYmd;
          const resolved = resolveUtilityUnitPrice({
            meterType: m.meter_type,
            meterUnitPrice: m.unit_price,
            contractBuildingId: targetContract?.building_id || m.building_id,
            periodEndYmd: effPeriodEnd,
            contractServicePrices: targetContractId
              ? cspByContract.get(String(targetContractId)) || []
              : [],
            catalogItems: catalogRes.rows,
            defaultUtilityPrice,
          });

          const hasPriorOrChained =
            priorObj !== null || samePeriodReadings.some((r) => r.id !== curReading?.id);

          return {
            ...m,
            target_contract_id: targetContractId,
            target_contract_code: targetContract?.contract_code || null,
            target_tenant_name: targetContract?.tenant_name || null,
            period_slot_index: slotIndex,
            period_total_slots: totalSlots,
            period_reading_billed: Boolean(curReading?.is_billed),
            overlapping_contracts: slotSummaries,
            period_reading_id: curReading?.id || null,
            current_period: curReading?.period || null,
            period_previous_reading:
              curReading?.previous_reading !== undefined && curReading?.previous_reading !== null
                ? curReading.previous_reading
                : null,
            period_current_reading:
              curReading?.current_reading !== undefined && curReading?.current_reading !== null
                ? curReading.current_reading
                : null,
            period_consumption:
              curReading?.consumption !== undefined && curReading?.consumption !== null
                ? curReading.consumption
                : null,
            period_is_abnormal: curReading ? Boolean(curReading.is_abnormal) : null,
            period_abnormal_note: curReading?.abnormal_note || null,
            period_image_url: curReading?.image_url || null,
            period_reading_status: curReading?.status || null,
            period_confirmed_at: curReading?.confirmed_at || null,
            period_confirmed_by: curReading?.confirmed_by || null,
            baseline_avg_consumption:
              curReading?.baseline_avg_consumption ?? m.prior_baseline_avg_consumption ?? null,
            last_known_reading: hasPriorOrChained ? bounds.previousReading : m.prior_period_reading,
            last_known_consumption: m.prior_period_consumption,
            last_known_period: m.prior_period_ym,
            effective_unit_price: resolved.unitPrice,
            effective_price_source: resolved.priceSource,
          };
        });

        if (normalizedStatusFilter) {
          enrichedRows = enrichedRows.filter(
            (r) => r.period_reading_status === normalizedStatusFilter
          );
        }
      }

      res.json({
        data: enrichedRows,
        period: targetPeriod,
        anomaly_threshold_pct: billingCfg.anomalyThresholdPct,
      });
    } catch (err) {
      console.error('[Meters List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách đồng hồ điện/nước.' });
    }
  }
);

/**
 * POST /api/v1/meters
 * Khởi tạo đồng hồ điện/nước cho căn hộ (FR-030, PRD 6.2: chỉ MANAGER tòa nhà được ghi)
 */
router.post(
  '/',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { apartment_id, meter_type, meter_code, unit_price, initial_reading = 0 } = req.body;
    const orgId = req.user.org_id;

    if (!apartment_id || !['ELECTRICITY', 'WATER'].includes(meter_type)) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Căn hộ và loại đồng hồ (ELECTRICITY / WATER) là bắt buộc.',
      });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const scope = await resolveResourceScope(client, 'apartment', apartment_id);
      if (!scope) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
      }
      const ok = await checkBuildingAccess(req, scope.building_id, 'meter', apartment_id);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không quản lý tòa nhà này.' });
      }

      const aptRes = await client.query(
        `SELECT a.id, a.code, a.building_id, b.code AS building_code
         FROM apartment a
         JOIN building b ON b.id = a.building_id
         WHERE a.id = $1 AND b.org_id = $2`,
        [apartment_id, orgId]
      );
      if (aptRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy căn hộ.' });
      }
      const apt = aptRes.rows[0];

      const billingCfg = await loadBillingConfigValues(client, orgId);
      const defaultCode = `${meter_type === 'ELECTRICITY' ? 'EL' : 'WT'}-${apt.building_code}-${apt.code}`;
      const defaultUnit = meter_type === 'ELECTRICITY' ? 'kWh' : 'm³';
      const defaultPrice =
        meter_type === 'ELECTRICITY'
          ? billingCfg.electricityDefaultPrice
          : billingCfg.waterDefaultPrice;

      const ins = await client.query(
        `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          orgId,
          apt.building_id,
          apartment_id,
          meter_type,
          meter_code?.trim() || defaultCode,
          defaultUnit,
          unit_price !== undefined ? Number(unit_price) : defaultPrice,
          Number(initial_reading) || 0,
        ]
      );
      const created = ins.rows[0];

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'CREATE_METER', 'meter', $2, $3)`,
        [req.user.sub, created.id, JSON.stringify(created)]
      );

      await client.query('COMMIT');
      res.status(201).json({ message: 'Tạo đồng hồ thành công.', data: created });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') {
        return res.status(409).json({
          code: 'DUPLICATE_METER',
          message: 'Căn hộ đã có đồng hồ loại này hoặc mã đồng hồ bị trùng.',
        });
      }
      console.error('[Create Meter Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tạo đồng hồ.' });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/meters/readings
 * Lịch sử ghi chỉ số lọc theo tòa, kỳ, loại, trạng thái xác nhận, bất thường (>30%)
 */
router.get(
  '/readings',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { building_id, period, meter_type, abnormal_only, status, contract_id } = req.query;
    const orgId = req.user.org_id;

    try {
      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'meter_reading');
        if (!ok) {
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền truy cập tòa nhà này.' });
        }
      }

      const params = [orgId];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'mr.building_id', params);

      let sql = `
        SELECT mr.*,
               CASE
                 WHEN mr.contract_id IS NOT NULL THEN 'HĐ-' || UPPER(LEFT(mr.contract_id::text, 8))
                 ELSE NULL
               END AS contract_code,
               mr.status AS period_reading_status,
               mr.confirmed_at AS period_confirmed_at,
               m.meter_type,
               m.meter_code,
               m.unit,
               m.unit_price,
               a.code AS apartment_code,
               b.name AS building_name,
               b.code AS building_code,
               p.full_name AS recorded_by_name,
               pc.full_name AS confirmed_by_name
        FROM meter_reading mr
        JOIN meter m ON m.id = mr.meter_id
        JOIN apartment a ON a.id = mr.apartment_id
        JOIN building b ON b.id = mr.building_id
        LEFT JOIN app_user au ON au.id = mr.recorded_by
        LEFT JOIN person p ON p.id = au.person_id
        LEFT JOIN app_user auc ON auc.id = mr.confirmed_by
        LEFT JOIN person pc ON pc.id = auc.person_id
        WHERE mr.org_id = $1
        ${scopeSql}
      `;

      if (building_id) {
        params.push(building_id);
        sql += ` AND mr.building_id = $${params.length}`;
      }
      if (period) {
        params.push(period);
        sql += ` AND mr.period = $${params.length}`;
      }
      if (contract_id && UUID_RE.test(String(contract_id))) {
        params.push(String(contract_id));
        sql += ` AND mr.contract_id = $${params.length}`;
      }
      if (meter_type) {
        params.push(meter_type);
        sql += ` AND m.meter_type = $${params.length}`;
      }
      if (status && VALID_READING_STATUSES.includes(String(status).trim().toUpperCase())) {
        params.push(String(status).trim().toUpperCase());
        sql += ` AND mr.status = $${params.length}`;
      }
      if (abnormal_only === 'true') {
        sql += ` AND mr.is_abnormal = TRUE`;
      }

      sql += ` ORDER BY mr.period DESC, b.code ASC, a.code ASC, mr.current_reading DESC, mr.recorded_at DESC`;
      const result = await pool.query(sql, params);
      res.json({ data: result.rows });
    } catch (err) {
      console.error('[Meter Readings List Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải danh sách chỉ số.' });
    }
  }
);

/**
 * Helper ghi nhận 1 chỉ số đồng hồ theo đợt hợp đồng trong kỳ + cảnh báo bất thường > ngưỡng 3 kỳ + khóa hóa đơn + đồng bộ HĐ nháp
 */
async function upsertSingleReading(
  client,
  req,
  meterId,
  {
    period,
    contract_id,
    current_reading,
    reading_value,
    abnormal_note,
    image_base64,
    image_url,
    status,
    hold_if_abnormal,
    ai_suggestion_id,
    source,
  },
  billingCfg = { anomalyThresholdRatio: 0.3, electricityDefaultPrice: 3800, waterDefaultPrice: 22000 }
) {
  if (!period || !PERIOD_RE.test(period)) {
    throw Object.assign(new Error('Kỳ chốt chỉ số phải theo định dạng YYYY-MM.'), { status: 400, code: 'INVALID_PERIOD' });
  }

  const reqStatus = status !== undefined && status !== null && String(status).trim() !== ''
    ? String(status).trim().toUpperCase()
    : null;
  if (reqStatus && !VALID_READING_STATUSES.includes(reqStatus)) {
    throw Object.assign(new Error('Trạng thái chỉ số không hợp lệ (DRAFT | CONFIRMED | FLAGGED).'), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  if (contract_id !== undefined && contract_id !== null && String(contract_id).trim() !== '' && !UUID_RE.test(String(contract_id).trim())) {
    throw Object.assign(new Error('Mã hợp đồng (contract_id) không hợp lệ.'), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const scope = await resolveResourceScope(client, 'meter', meterId);
  if (!scope) {
    throw Object.assign(new Error('Không tìm thấy đồng hồ.'), { status: 404, code: 'NOT_FOUND' });
  }
  const ok = await checkBuildingAccess(req, scope.building_id, 'meter_reading', meterId);
  if (!ok) {
    throw Object.assign(new Error('Bạn không có quyền ghi chỉ số tòa nhà này.'), { status: 403, code: 'ACCESS_DENIED' });
  }

  const meterRes = await client.query(
    'SELECT * FROM meter WHERE id = $1 AND org_id = $2 FOR UPDATE',
    [meterId, req.user.org_id]
  );
  if (meterRes.rows.length === 0) {
    throw Object.assign(new Error('Không tìm thấy đồng hồ.'), { status: 404, code: 'NOT_FOUND' });
  }
  const meter = meterRes.rows[0];

  const thresholdRatio = Number(billingCfg.anomalyThresholdRatio ?? 0.3);
  const defaultUtilityPrice =
    meter.meter_type === 'ELECTRICITY'
      ? Number(billingCfg.electricityDefaultPrice ?? 3800)
      : Number(billingCfg.waterDefaultPrice ?? 22000);

  const contractsByApt = await loadApartmentPeriodContractsMap(client, [meter.apartment_id], period);
  const overlappingContracts = contractsByApt.get(String(meter.apartment_id)) || [];
  const { targetContract, slotIndex } = selectTargetPeriodContract(
    overlappingContracts,
    contract_id || null
  );
  const targetContractId = targetContract ? targetContract.contract_id : null;

  const [samePeriodMap, { priorReading, nextPeriodReading, baselineConsumptions }] =
    await Promise.all([
      loadMeterPeriodReadingsWithLocks(client, [meter.id], period, contractsByApt),
      loadPriorAndNextMeterReadings(client, meter.id, period),
    ]);
  const samePeriodReadings = samePeriodMap.get(String(meter.id)) || [];
  const existingRow = findMatchingReadingForSlot(samePeriodReadings, targetContractId, slotIndex);

  if (existingRow && existingRow.is_billed) {
    throw Object.assign(
      new Error('Chỉ số đồng hồ của đợt hợp đồng này đã được lập hóa đơn phát hành, không thể chỉnh sửa hoặc ghi đè.'),
      { status: 409, code: 'READING_ALREADY_BILLED' }
    );
  }

  const { previousReading, nextReading } = resolveChainedReadingBounds({
    priorPeriodReading: priorReading,
    samePeriodReadings,
    nextPeriodReading,
    overlappingContracts,
    targetContractId,
    existingReadingId: existingRow?.id || null,
    initialReading: meter.initial_reading,
  });

  const rawReadingInput =
    current_reading !== undefined && current_reading !== null && current_reading !== ''
      ? current_reading
      : reading_value;
  const { currentVal } = validateChainedReadingInput({
    currentReading: rawReadingInput,
    previousReading,
    nextReading,
  });

  const { consumption, isAbnormal, baselineAvg, diffPct } = evaluateMeterReadingAnomaly({
    previousReading,
    currentReading: currentVal,
    recentConsumptions: baselineConsumptions,
    thresholdRatio,
  });

  const explicitNoteProvided = abnormal_note !== undefined;
  const trimmedNote = abnormal_note !== undefined && abnormal_note !== null
    ? String(abnormal_note).trim()
    : '';

  let resolvedStatus;
  if (reqStatus === 'DRAFT') {
    resolvedStatus = isAbnormal ? 'FLAGGED' : 'DRAFT';
  } else if (reqStatus === 'FLAGGED') {
    resolvedStatus = 'FLAGGED';
  } else if (hold_if_abnormal === true && isAbnormal && !trimmedNote) {
    resolvedStatus = 'FLAGGED';
  } else {
    resolvedStatus = 'CONFIRMED';
  }

  let computedNote = trimmedNote || null;
  if (resolvedStatus === 'CONFIRMED' && isAbnormal && !computedNote && baselineAvg !== null) {
    const sign = (diffPct || 0) >= 0 ? '+' : '';
    computedNote = `Sản lượng biến động ${sign}${diffPct || 0}% so với trung bình các kỳ trước (${baselineAvg} ${meter.unit})`;
  }

  const confirmedBy = resolvedStatus === 'CONFIRMED' ? req.user.sub : null;
  const validAiSuggestionId =
    ai_suggestion_id && UUID_RE.test(String(ai_suggestion_id)) ? String(ai_suggestion_id) : null;
  const resolvedSource = validAiSuggestionId ? 'AI' : source === 'IOT' ? 'IOT' : 'MANUAL';

  let row;
  if (existingRow) {
    const upd = await client.query(
      `UPDATE meter_reading
       SET contract_id = $1,
           previous_reading = $2,
           current_reading = $3,
           consumption = $4,
           is_abnormal = $5,
           abnormal_note = CASE
             WHEN $11::boolean THEN $6
             WHEN $8 = 'CONFIRMED' THEN COALESCE($6, abnormal_note)
             ELSE $6
           END,
           image_url = COALESCE($7, image_url),
           recorded_by = $12,
           recorded_at = NOW(),
           status = $8,
           confirmed_by = $9,
           confirmed_at = CASE WHEN $8 = 'CONFIRMED' THEN NOW() ELSE NULL END,
           baseline_avg_consumption = $10,
           source = CASE WHEN $13::uuid IS NOT NULL THEN 'AI' ELSE source END,
           ai_suggestion_id = COALESCE($13::uuid, ai_suggestion_id)
       WHERE id = $14
       RETURNING *`,
      [
        targetContractId,
        previousReading,
        currentVal,
        consumption,
        isAbnormal,
        computedNote,
        image_url || null,
        resolvedStatus,
        confirmedBy,
        baselineAvg,
        explicitNoteProvided,
        req.user.sub,
        validAiSuggestionId,
        existingRow.id,
      ]
    );
    row = upd.rows[0];
  } else {
    const conflictClause = targetContractId
      ? `ON CONFLICT (meter_id, period, contract_id) WHERE contract_id IS NOT NULL`
      : `ON CONFLICT (meter_id, period) WHERE contract_id IS NULL`;
    const ins = await client.query(
      `INSERT INTO meter_reading (
         org_id, building_id, meter_id, apartment_id, contract_id, period,
         previous_reading, current_reading, consumption,
         is_abnormal, abnormal_note, image_url,
         recorded_by, recorded_at,
         status, confirmed_by, confirmed_at, baseline_avg_consumption,
         source, ai_suggestion_id
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9,
         $10, $11, $12,
         $13, NOW(),
         $14, $15, CASE WHEN $14 = 'CONFIRMED' THEN NOW() ELSE NULL END, $16,
         $18, $19
       )
       ${conflictClause} DO UPDATE
         SET previous_reading = EXCLUDED.previous_reading,
             current_reading = EXCLUDED.current_reading,
             consumption = EXCLUDED.consumption,
             is_abnormal = EXCLUDED.is_abnormal,
             abnormal_note = CASE
               WHEN $17::boolean THEN EXCLUDED.abnormal_note
               WHEN EXCLUDED.status = 'CONFIRMED' THEN COALESCE(EXCLUDED.abnormal_note, meter_reading.abnormal_note)
               ELSE EXCLUDED.abnormal_note
             END,
             image_url = COALESCE(EXCLUDED.image_url, meter_reading.image_url),
             recorded_by = EXCLUDED.recorded_by,
             recorded_at = NOW(),
             status = EXCLUDED.status,
             confirmed_by = EXCLUDED.confirmed_by,
             confirmed_at = CASE WHEN EXCLUDED.status = 'CONFIRMED' THEN NOW() ELSE NULL END,
             baseline_avg_consumption = EXCLUDED.baseline_avg_consumption,
             source = CASE WHEN $19::uuid IS NOT NULL THEN 'AI' ELSE meter_reading.source END,
             ai_suggestion_id = COALESCE($19::uuid, meter_reading.ai_suggestion_id)
       RETURNING *`,
      [
        meter.org_id,
        meter.building_id,
        meter.id,
        meter.apartment_id,
        targetContractId,
        period,
        previousReading,
        currentVal,
        consumption,
        isAbnormal,
        computedNote,
        image_url || null,
        req.user.sub,
        resolvedStatus,
        confirmedBy,
        baselineAvg,
        explicitNoteProvided,
        resolvedSource,
        validAiSuggestionId,
      ]
    );
    row = ins.rows[0];
  }

  if (validAiSuggestionId) {
    try {
      await reviewAiSuggestion(client, {
        suggestionId: validAiSuggestionId,
        actorId: req.user.sub,
        decision: 'ACCEPT',
        finalValues: { reading_value: currentVal },
        targetEntityId: row.id,
      });
    } catch (aiErr) {
      if (aiErr.code !== 'SUGGESTION_NOT_PENDING') {
        throw aiErr;
      }
    }
  }

  if (image_base64 && typeof image_base64 === 'string' && image_base64.startsWith('data:image/')) {
    const uploaded = await saveBase64Image({
      imageBase64: image_base64,
      folder: 'meters',
      entityId: row.id,
      entity: 'meter_reading',
      ownerId: row.id,
      req,
      query: (t, p) => client.query(t, p),
    });
    if (!uploaded.error && uploaded.attachment) {
      const viewUrl = `/api/v1/attachments/${uploaded.attachment.id}/view`;
      const imgUpdate = await client.query(
        'UPDATE meter_reading SET image_url = $1 WHERE id = $2 RETURNING *',
        [viewUrl, row.id]
      );
      row = imgUpdate.rows[0];
    }
  }

  // Cascade baseline update onto immediate unlocked successor reading if its previous_reading shifted
  if (nextReading && !nextReading.is_billed && roundReadingValue(nextReading.previous_reading) !== currentVal) {
    let nextBaselineConsumptions = baselineConsumptions;
    if (nextReading.period !== period) {
      const nextCtx = await loadPriorAndNextMeterReadings(client, meter.id, nextReading.period);
      nextBaselineConsumptions = nextCtx.baselineConsumptions;
    }
    const nextEval = evaluateMeterReadingAnomaly({
      previousReading: currentVal,
      currentReading: roundReadingValue(nextReading.current_reading),
      recentConsumptions: nextBaselineConsumptions,
      thresholdRatio,
    });
    const nextHasNote = Boolean(nextReading.abnormal_note && String(nextReading.abnormal_note).trim());
    let nextStatus = nextReading.status || 'CONFIRMED';
    if (nextEval.isAbnormal && !nextHasNote) {
      nextStatus = 'FLAGGED';
    } else if (nextStatus === 'DRAFT' && nextEval.isAbnormal) {
      nextStatus = 'FLAGGED';
    }

    const nextUpd = await client.query(
      `UPDATE meter_reading
       SET previous_reading = $1,
           consumption = $2,
           is_abnormal = $3,
           baseline_avg_consumption = $4,
           status = $5,
           confirmed_by = CASE WHEN $5 = 'CONFIRMED' THEN confirmed_by ELSE NULL END,
           confirmed_at = CASE WHEN $5 = 'CONFIRMED' THEN confirmed_at ELSE NULL END
       WHERE id = $6
       RETURNING *`,
      [
        currentVal,
        nextEval.consumption,
        nextEval.isAbnormal,
        nextEval.baselineAvg,
        nextStatus,
        nextReading.id,
      ]
    );
    const updatedNextRow = nextUpd.rows[0];
    if (updatedNextRow?.contract_id) {
      await syncDraftInvoiceMeterLineInTx(client, {
        orgId: meter.org_id,
        contractId: updatedNextRow.contract_id,
        period: updatedNextRow.period,
        meter,
        readingRow: updatedNextRow,
        defaultUtilityPrice,
        actorId: req.user.sub,
      });
    }
  }

  if (row.contract_id) {
    await syncDraftInvoiceMeterLineInTx(client, {
      orgId: meter.org_id,
      contractId: row.contract_id,
      period: row.period,
      meter,
      readingRow: row,
      defaultUtilityPrice,
      actorId: req.user.sub,
    });
  }

  await client.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
     VALUES ($1, 'RECORD_METER_READING', 'meter_reading', $2, $3)`,
    [
      req.user.sub,
      row.id,
      JSON.stringify({
        meter_id: row.meter_id,
        contract_id: row.contract_id,
        period: row.period,
        previous_reading: row.previous_reading,
        current_reading: row.current_reading,
        consumption: row.consumption,
        is_abnormal: row.is_abnormal,
        baseline_avg_consumption: row.baseline_avg_consumption,
        status: row.status,
      }),
    ]
  );

  return {
    ...row,
    contract_code: formatContractCode(row.contract_id),
  };
}

/**
 * POST /api/v1/meters/readings/batch
 * Ghi chỉ số nhanh hàng loạt theo kỳ
 */
router.post(
  '/readings/batch',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { period, readings, status, hold_if_abnormal } = req.body;
    if (!Array.isArray(readings) || readings.length === 0) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Danh sách chỉ số trống.' });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const billingCfg = await loadBillingConfigValues(client, req.user.org_id);
      const saved = [];
      for (const item of readings) {
        const rawItemReading = item.current_reading ?? item.reading_value;
        if (rawItemReading === undefined || rawItemReading === '' || rawItemReading === null) continue;
        const row = await upsertSingleReading(
          client,
          req,
          item.meter_id,
          {
            period: item.period || period,
            contract_id: item.contract_id,
            current_reading: rawItemReading,
            abnormal_note: item.abnormal_note,
            image_base64: item.image_base64,
            image_url: item.image_url,
            status: item.status ?? status,
            hold_if_abnormal: item.hold_if_abnormal ?? hold_if_abnormal,
            ai_suggestion_id: item.ai_suggestion_id,
            source: item.source,
          },
          billingCfg
        );
        saved.push(row);
      }
      await client.query('COMMIT');
      const abnormalCount = saved.filter((r) => r.is_abnormal).length;
      const flaggedCount = saved.filter((r) => r.status === 'FLAGGED').length;
      res.status(201).json({
        message: `Đã lưu ${saved.length} chỉ số${abnormalCount > 0 ? ` (${abnormalCount} chỉ số biến động bất thường)` : ''}.`,
        data: saved,
        abnormal_count: abnormalCount,
        flagged_count: flaggedCount,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Batch Meter Reading Error]:', err);
      res.status(err.status || 500).json({
        code: err.code || 'DB_ERROR',
        message: err.message || 'Lỗi khi ghi chỉ số hàng loạt.',
      });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/meters/readings/confirm-batch
 * Xác nhận hàng loạt các chỉ số DRAFT / FLAGGED đủ điều kiện (FR-030, FR-031)
 */
router.post(
  '/readings/confirm-batch',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { period, building_id, reading_ids } = req.body || {};

    if (!period && (!Array.isArray(reading_ids) || reading_ids.length === 0)) {
      return res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'Cần cung cấp kỳ chốt (period) hoặc danh sách reading_ids để xác nhận.',
      });
    }
    if (period && !PERIOD_RE.test(period)) {
      return res.status(400).json({ code: 'INVALID_PERIOD', message: 'Kỳ chốt chỉ số phải theo định dạng YYYY-MM.' });
    }

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const billingCfg = await loadBillingConfigValues(client, req.user.org_id);

      if (building_id) {
        const ok = await checkBuildingAccess(req, building_id, 'meter_reading');
        if (!ok) {
          await client.query('ROLLBACK');
          return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xác nhận chỉ số tòa nhà này.' });
        }
      }

      if (Array.isArray(reading_ids) && reading_ids.length > 0) {
        for (const rId of reading_ids) {
          const scope = await resolveResourceScope(client, 'meter_reading', rId);
          if (!scope) {
            await client.query('ROLLBACK');
            return res.status(404).json({ code: 'NOT_FOUND', message: `Không tìm thấy bản ghi chỉ số ${rId}.` });
          }
          const ok = await checkBuildingAccess(req, scope.building_id, 'meter_reading', rId);
          if (!ok) {
            await client.query('ROLLBACK');
            return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xác nhận chỉ số thuộc tòa nhà khác.' });
          }
        }
      }

      const params = [req.user.org_id];
      const { sql: scopeSql } = await scopedBuildingFilter(req, 'mr.building_id', params);
      let sql = `
        SELECT mr.*
        FROM meter_reading mr
        WHERE mr.org_id = $1
          AND mr.status IN ('DRAFT', 'FLAGGED')
          ${scopeSql}
      `;
      if (building_id) {
        params.push(building_id);
        sql += ` AND mr.building_id = $${params.length}`;
      }
      if (period) {
        params.push(period);
        sql += ` AND mr.period = $${params.length}`;
      }
      if (Array.isArray(reading_ids) && reading_ids.length > 0) {
        params.push(reading_ids);
        sql += ` AND mr.id = ANY($${params.length}::uuid[])`;
      }
      sql += ` FOR UPDATE`;

      const candidates = await client.query(sql, params);
      const confirmed = [];
      let skippedAbnormalWithoutNote = 0;

      const candMeterIds = [...new Set(candidates.rows.map((r) => r.meter_id))];
      const metersMap = new Map();
      if (candMeterIds.length > 0) {
        const mRes = await client.query(`SELECT * FROM meter WHERE id = ANY($1::uuid[])`, [candMeterIds]);
        for (const m of mRes.rows) metersMap.set(String(m.id), m);
      }

      for (const row of candidates.rows) {
        const hasNote = row.abnormal_note && String(row.abnormal_note).trim().length > 0;
        if (row.is_abnormal && !hasNote) {
          skippedAbnormalWithoutNote += 1;
          continue;
        }
        const upd = await client.query(
          `UPDATE meter_reading
           SET status = 'CONFIRMED',
               confirmed_by = $1,
               confirmed_at = NOW()
           WHERE id = $2
           RETURNING *`,
          [req.user.sub, row.id]
        );
        const updatedRow = upd.rows[0];
        confirmed.push(updatedRow);

        const meter = metersMap.get(String(updatedRow.meter_id));
        if (updatedRow.contract_id && meter) {
          const defaultUtilityPrice =
            meter.meter_type === 'ELECTRICITY'
              ? billingCfg.electricityDefaultPrice
              : billingCfg.waterDefaultPrice;
          await syncDraftInvoiceMeterLineInTx(client, {
            orgId: req.user.org_id,
            contractId: updatedRow.contract_id,
            period: updatedRow.period,
            meter,
            readingRow: updatedRow,
            defaultUtilityPrice,
            actorId: req.user.sub,
          });
        }

        await client.query(
          `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
           VALUES ($1, 'CONFIRM_METER_READING', 'meter_reading', $2, $3, $4)`,
          [
            req.user.sub,
            row.id,
            JSON.stringify({ status: row.status, confirmed_by: row.confirmed_by }),
            JSON.stringify({
              status: updatedRow.status,
              confirmed_by: updatedRow.confirmed_by,
              confirmed_at: updatedRow.confirmed_at,
              abnormal_note: updatedRow.abnormal_note,
            }),
          ]
        );
      }

      await client.query('COMMIT');
      res.json({
        message: `Đã xác nhận ${confirmed.length} chỉ số đồng hồ${skippedAbnormalWithoutNote > 0 ? ` (bỏ qua ${skippedAbnormalWithoutNote} chỉ số bất thường chưa nhập ghi chú)` : ''}.`,
        confirmed_count: confirmed.length,
        skipped_abnormal_without_note: skippedAbnormalWithoutNote,
        data: confirmed,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Confirm Batch Meter Readings Error]:', err);
      res.status(err.status || 500).json({
        code: err.code || 'DB_ERROR',
        message: err.message || 'Lỗi khi xác nhận chỉ số hàng loạt.',
      });
    } finally {
      await release();
    }
  }
);

/**
 * POST /api/v1/meters/readings/:readingId/confirm
 * Xác nhận 1 chỉ số đồng hồ DRAFT / FLAGGED -> CONFIRMED (bắt buộc abnormal_note nếu is_abnormal = true)
 */
router.post(
  '/readings/:readingId/confirm',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { readingId } = req.params;
    const incomingNote = req.body?.abnormal_note;

    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');

      const scope = await resolveResourceScope(client, 'meter_reading', readingId);
      if (!scope) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy bản ghi chỉ số đồng hồ.' });
      }
      const ok = await checkBuildingAccess(req, scope.building_id, 'meter_reading', readingId);
      if (!ok) {
        await client.query('ROLLBACK');
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền xác nhận chỉ số tòa nhà này.' });
      }

      const existingRes = await client.query(
        `SELECT * FROM meter_reading WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [readingId, req.user.org_id]
      );
      if (existingRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy bản ghi chỉ số đồng hồ.' });
      }
      const existing = existingRes.rows[0];

      const effectiveNote =
        incomingNote !== undefined && incomingNote !== null && String(incomingNote).trim().length > 0
          ? String(incomingNote).trim()
          : existing.abnormal_note && String(existing.abnormal_note).trim().length > 0
          ? String(existing.abnormal_note).trim()
          : '';

      if (existing.is_abnormal && !effectiveNote) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          code: 'ABNORMAL_NOTE_REQUIRED',
          message: 'Chỉ số có biến động bất thường (>30%), vui lòng nhập ghi chú xác minh trước khi chốt.',
        });
      }

      const upd = await client.query(
        `UPDATE meter_reading
         SET status = 'CONFIRMED',
             confirmed_by = $1,
             confirmed_at = NOW(),
             abnormal_note = COALESCE($2, abnormal_note)
         WHERE id = $3
         RETURNING *`,
        [req.user.sub, effectiveNote || null, readingId]
      );
      const updated = upd.rows[0];

      if (updated.contract_id) {
        const [meterRes, billingCfg] = await Promise.all([
          client.query(`SELECT * FROM meter WHERE id = $1`, [updated.meter_id]),
          loadBillingConfigValues(client, req.user.org_id),
        ]);
        const meter = meterRes.rows[0];
        if (meter) {
          const defaultUtilityPrice =
            meter.meter_type === 'ELECTRICITY'
              ? billingCfg.electricityDefaultPrice
              : billingCfg.waterDefaultPrice;
          await syncDraftInvoiceMeterLineInTx(client, {
            orgId: req.user.org_id,
            contractId: updated.contract_id,
            period: updated.period,
            meter,
            readingRow: updated,
            defaultUtilityPrice,
            actorId: req.user.sub,
          });
        }
      }

      await client.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
         VALUES ($1, 'CONFIRM_METER_READING', 'meter_reading', $2, $3, $4)`,
        [
          req.user.sub,
          readingId,
          JSON.stringify({
            status: existing.status,
            confirmed_by: existing.confirmed_by,
            abnormal_note: existing.abnormal_note,
          }),
          JSON.stringify({
            status: updated.status,
            confirmed_by: updated.confirmed_by,
            confirmed_at: updated.confirmed_at,
            abnormal_note: updated.abnormal_note,
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        message: 'Xác nhận chỉ số đồng hồ thành công.',
        data: updated,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Confirm Meter Reading Error]:', err);
      res.status(err.status || 500).json({
        code: err.code || 'DB_ERROR',
        message: err.message || 'Lỗi khi xác nhận chỉ số đồng hồ.',
      });
    } finally {
      await release();
    }
  }
);

/**
 * GET /api/v1/meters/:id/readings
 * Lịch sử chỉ số của 1 đồng hồ
 */
router.get(
  '/:id/readings',
  authenticateToken,
  requireRole(['SYS_ADMIN', 'OWNER', 'MANAGER']),
  async (req, res) => {
    const { id } = req.params;
    try {
      const scope = await resolveResourceScope(pool, 'meter', id);
      if (!scope) {
        return res.status(404).json({ code: 'NOT_FOUND', message: 'Không tìm thấy đồng hồ.' });
      }
      const ok = await checkBuildingAccess(req, scope.building_id, 'meter', id);
      if (!ok) {
        return res.status(403).json({ code: 'ACCESS_DENIED', message: 'Bạn không có quyền truy cập đồng hồ này.' });
      }

      const rows = await pool.query(
        `SELECT mr.*,
                CASE
                  WHEN mr.contract_id IS NOT NULL THEN 'HĐ-' || UPPER(LEFT(mr.contract_id::text, 8))
                  ELSE NULL
                END AS contract_code,
                mr.status AS period_reading_status,
                mr.confirmed_at AS period_confirmed_at,
                p.full_name AS recorded_by_name,
                pc.full_name AS confirmed_by_name
         FROM meter_reading mr
         LEFT JOIN app_user au ON au.id = mr.recorded_by
         LEFT JOIN person p ON p.id = au.person_id
         LEFT JOIN app_user auc ON auc.id = mr.confirmed_by
         LEFT JOIN person pc ON pc.id = auc.person_id
         WHERE mr.meter_id = $1
         ORDER BY mr.period DESC, mr.current_reading DESC, mr.recorded_at DESC`,
        [id]
      );
      res.json({ data: rows.rows });
    } catch (err) {
      console.error('[Single Meter Readings Error]:', err);
      res.status(500).json({ code: 'DB_ERROR', message: 'Lỗi khi tải lịch sử đồng hồ.' });
    }
  }
);

/**
 * POST /api/v1/meters/:id/readings
 * Ghi chỉ số cho 1 đồng hồ kèm ảnh chụp đồng hồ (FR-030, FR-031)
 */
router.post(
  '/:id/readings',
  authenticateToken,
  requireRole(['MANAGER']),
  idempotencyGuard(),
  async (req, res) => {
    const { id } = req.params;
    const { client, release } = await getUserClient(req);
    try {
      await client.query('BEGIN');
      const billingCfg = await loadBillingConfigValues(client, req.user.org_id);
      const row = await upsertSingleReading(client, req, id, req.body, billingCfg);
      await client.query('COMMIT');
      res.status(201).json({
        message: row.is_abnormal
          ? 'Đã ghi chỉ số (Cảnh báo: sản lượng biến động vượt ngưỡng so với trung bình các kỳ trước).'
          : 'Ghi chỉ số đồng hồ thành công.',
        data: row,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[Create Meter Reading Error]:', err);
      res.status(err.status || 500).json({
        code: err.code || 'DB_ERROR',
        message: err.message || 'Lỗi khi ghi chỉ số đồng hồ.',
      });
    } finally {
      await release();
    }
  }
);

export default router;
