import {
  FINALIZED_SETTLEMENT_DEPOSIT_STATUSES,
  buildPeriodOverlappingContracts,
  getMonthBoundsYmd,
  resolveUtilityUnitPrice,
  roundReadingValue,
} from './serviceBilling.js';
import { roundVND } from './pricing.js';
import {
  applyAvailableCreditsInTx,
  recalculateDraftInvoiceTotalsInTx,
  releaseInvoiceCreditsInTx,
} from './invoiceLifecycle.js';

export function formatContractCode(contractId, rawCode = null) {
  if (rawCode && String(rawCode).trim()) return String(rawCode).trim();
  if (!contractId) return null;
  return `HĐ-${String(contractId).slice(0, 8).toUpperCase()}`;
}

/**
 * Loads overlapping billable contracts per apartment for a given YYYY-MM period,
 * sorted chronologically and annotated with is_period_finalized.
 */
export async function loadApartmentPeriodContractsMap(queryable, apartmentIds = [], periodYm) {
  const map = new Map();
  const validAptIds = [...new Set((apartmentIds || []).filter(Boolean).map(String))];
  if (validAptIds.length === 0 || !periodYm) return map;

  const { monthEnd } = getMonthBoundsYmd(periodYm);
  if (!monthEnd) return map;

  const res = await queryable.query(
    `SELECT c.id,
            c.apartment_id,
            c.building_id,
            c.status,
            c.start_date,
            c.end_date,
            c.terminated_at,
            c.is_room_transfer,
            c.created_at,
            p.full_name AS tenant_name,
            rt.child_start_date AS room_transfer_child_start_date,
            dep.status AS deposit_status,
            EXISTS (
              SELECT 1 FROM invoice inv
              WHERE inv.contract_id = c.id
                AND inv.period = $2
                AND inv.status NOT IN ('DRAFT', 'VOID', 'CANCELLED')
            ) AS has_finalized_invoice
     FROM contract c
     LEFT JOIN tenant t ON t.id = c.primary_tenant_id
     LEFT JOIN person p ON p.id = t.person_id
     LEFT JOIN LATERAL (
       SELECT ch.start_date AS child_start_date
       FROM contract ch
       WHERE ch.parent_contract_id = c.id
         AND ch.is_room_transfer = TRUE
         AND ch.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')
       ORDER BY ch.created_at DESC
       LIMIT 1
     ) rt ON TRUE
     LEFT JOIN LATERAL (
       SELECT d.status
       FROM deposit d
       WHERE d.contract_id = c.id
       ORDER BY d.created_at DESC
       LIMIT 1
     ) dep ON TRUE
     WHERE c.apartment_id = ANY($1::uuid[])
       AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'TERMINATED', 'EXPIRED')
       AND c.start_date <= $3::date`,
    [validAptIds, periodYm, monthEnd]
  );

  const rawByApt = new Map();
  for (const row of res.rows) {
    const aptId = String(row.apartment_id);
    if (!rawByApt.has(aptId)) rawByApt.set(aptId, []);
    rawByApt.get(aptId).push({
      ...row,
      contract_code: formatContractCode(row.id),
    });
  }

  for (const aptId of validAptIds) {
    const built = buildPeriodOverlappingContracts(rawByApt.get(aptId) || [], periodYm);
    map.set(aptId, built);
  }
  return map;
}

/**
 * Loads all meter_reading rows in periodYm for the given meterIds and annotates each with is_billed.
 */
export async function loadMeterPeriodReadingsWithLocks(
  queryable,
  meterIds = [],
  periodYm,
  contractsByApt = new Map()
) {
  const map = new Map();
  const validMeterIds = [...new Set((meterIds || []).filter(Boolean).map(String))];
  if (validMeterIds.length === 0 || !periodYm) return map;

  const res = await queryable.query(
    `SELECT mr.*,
            m.meter_type
     FROM meter_reading mr
     JOIN meter m ON m.id = mr.meter_id
     WHERE mr.meter_id = ANY($1::uuid[])
       AND mr.period = $2
     ORDER BY mr.current_reading ASC, mr.recorded_at ASC`,
    [validMeterIds, periodYm]
  );

  const readingIds = res.rows.map((r) => String(r.id));
  const aptIds = [...new Set(res.rows.map((r) => String(r.apartment_id)).filter(Boolean))];
  const billedReadingTypeSet = new Set();
  const legacyBilledLines = [];

  if (res.rows.length > 0 && aptIds.length > 0) {
    const billedRes = await queryable.query(
      `SELECT il.item_type,
              il.formula_meta->>'reading_id' AS reading_id,
              inv.apartment_id,
              inv.period,
              inv.contract_id
       FROM invoice inv
       JOIN invoice_line il ON il.invoice_id = inv.id
       WHERE inv.apartment_id = ANY($1::uuid[])
         AND inv.period = $2
         AND inv.status NOT IN ('DRAFT', 'VOID', 'CANCELLED')
         AND il.item_type IN ('ELECTRICITY', 'WATER')
       UNION ALL
       SELECT il.item_type,
              il.formula_meta->>'reading_id' AS reading_id,
              inv.apartment_id,
              inv.period,
              inv.contract_id
       FROM invoice_line il
       JOIN invoice inv ON inv.id = il.invoice_id
       WHERE (il.formula_meta->>'reading_id') IS NOT NULL
         AND (il.formula_meta->>'reading_id') = ANY($3::text[])
         AND il.item_type IN ('ELECTRICITY', 'WATER')
         AND inv.apartment_id = ANY($1::uuid[])
         AND inv.period <> $2
         AND inv.status NOT IN ('DRAFT', 'VOID', 'CANCELLED')`,
      [aptIds, periodYm, readingIds]
    );

    for (const b of billedRes.rows) {
      if (b.reading_id) {
        billedReadingTypeSet.add(`${String(b.reading_id).toLowerCase()}:${b.item_type}`);
      } else {
        legacyBilledLines.push(b);
      }
    }
  }

  for (const row of res.rows) {
    const meterId = String(row.meter_id);
    const readingKey = `${String(row.id).toLowerCase()}:${row.meter_type}`;
    const hasBilledLine =
      billedReadingTypeSet.has(readingKey) ||
      legacyBilledLines.some(
        (b) =>
          b.item_type === row.meter_type &&
          String(b.apartment_id) === String(row.apartment_id) &&
          String(b.period) === String(row.period) &&
          (!row.contract_id || String(b.contract_id) === String(row.contract_id))
      );

    const aptContracts = contractsByApt.get(String(row.apartment_id)) || [];
    const matchedContract = row.contract_id
      ? aptContracts.find((c) => String(c.contract_id) === String(row.contract_id))
      : null;

    const isBilled =
      Boolean(hasBilledLine) ||
      (row.status === 'CONFIRMED' &&
        Boolean(row.contract_id) &&
        Boolean(matchedContract?.is_period_finalized));

    if (!map.has(meterId)) map.set(meterId, []);
    map.get(meterId).push({
      ...row,
      has_billed_line: hasBilledLine,
      is_billed: isBilled,
    });
  }

  return map;
}

/**
 * Loads the latest reading from period < periodYm, the earliest reading from period > periodYm (with is_billed),
 * and up to 3 prior positive CONFIRMED period consumptions for 3-period anomaly checks.
 */
export async function loadPriorAndNextMeterReadings(queryable, meterId, periodYm) {
  const priorRes = await queryable.query(
    `SELECT id, period, contract_id, previous_reading, current_reading, consumption, status
     FROM meter_reading
     WHERE meter_id = $1 AND period < $2
     ORDER BY period DESC, current_reading DESC, recorded_at DESC
     LIMIT 1`,
    [meterId, periodYm]
  );
  const nextRes = await queryable.query(
    `SELECT mr.id, mr.period, mr.contract_id, mr.apartment_id,
            mr.previous_reading, mr.current_reading, mr.consumption,
            mr.is_abnormal, mr.abnormal_note, mr.status,
            EXISTS (
              SELECT 1
              FROM invoice inv
              JOIN invoice_line il ON il.invoice_id = inv.id
              WHERE inv.apartment_id = mr.apartment_id
                AND inv.status NOT IN ('DRAFT', 'VOID', 'CANCELLED')
                AND il.item_type = m.meter_type
                AND (
                  (
                    (il.formula_meta->>'reading_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    AND (il.formula_meta->>'reading_id')::uuid = mr.id
                  )
                  OR (
                    (il.formula_meta->>'reading_id') IS NULL
                    AND inv.period = mr.period
                    AND (mr.contract_id = inv.contract_id OR mr.contract_id IS NULL)
                  )
                )
            ) AS has_billed_line,
            EXISTS (
              SELECT 1 FROM invoice inv
              WHERE mr.contract_id IS NOT NULL
                AND inv.contract_id = mr.contract_id
                AND inv.period = mr.period
                AND inv.status NOT IN ('DRAFT', 'VOID', 'CANCELLED')
            ) AS contract_has_issued_invoice,
            EXISTS (
              SELECT 1 FROM contract c
              JOIN deposit d ON d.contract_id = c.id
              WHERE mr.contract_id IS NOT NULL
                AND c.id = mr.contract_id
                AND c.status IN ('TERMINATED', 'EXPIRED')
                AND d.status = ANY($3::text[])
            ) AS contract_has_settled_deposit
     FROM meter_reading mr
     JOIN meter m ON m.id = mr.meter_id
     WHERE mr.meter_id = $1 AND mr.period > $2
     ORDER BY mr.period ASC, mr.current_reading ASC, mr.recorded_at ASC
     LIMIT 1`,
    [meterId, periodYm, FINALIZED_SETTLEMENT_DEPOSIT_STATUSES]
  );
  const baselineRes = await queryable.query(
    `SELECT consumption
     FROM meter_reading
     WHERE meter_id = $1
       AND period < $2
       AND status = 'CONFIRMED'
       AND consumption > 0
     ORDER BY period DESC, current_reading DESC, recorded_at DESC
     LIMIT 3`,
    [meterId, periodYm]
  );

  let nextPeriodReading = null;
  if (nextRes.rows.length > 0) {
    const nr = nextRes.rows[0];
    nextPeriodReading = {
      ...nr,
      is_billed:
        Boolean(nr.has_billed_line) ||
        (nr.status === 'CONFIRMED' &&
          Boolean(nr.contract_id) &&
          (Boolean(nr.contract_has_issued_invoice) || Boolean(nr.contract_has_settled_deposit))),
    };
  }

  return {
    priorReading: priorRes.rows[0] || null,
    nextPeriodReading,
    baselineConsumptions: baselineRes.rows.map((r) => Number(r.consumption)),
  };
}

/**
 * Synchronizes the ELECTRICITY / WATER line on an existing DRAFT invoice for (contractId, period)
 * whenever a meter reading is created, edited, cascaded, or confirmed.
 */
export async function syncDraftInvoiceMeterLineInTx(
  client,
  { orgId, contractId, period, meter, readingRow, defaultUtilityPrice = 0, actorId = null } = {}
) {
  if (!contractId || !period || !meter) return;

  const draftRes = await client.query(
    `SELECT * FROM invoice
     WHERE contract_id = $1 AND period = $2 AND status = 'DRAFT'
     FOR UPDATE`,
    [contractId, period]
  );
  if (draftRes.rows.length === 0) return;

  const draftInv = draftRes.rows[0];
  const itemType = meter.meter_type === 'ELECTRICITY' ? 'ELECTRICITY' : 'WATER';

  const aptContractsMap = await loadApartmentPeriodContractsMap(client, [meter.apartment_id], period);
  const aptContracts = aptContractsMap.get(String(meter.apartment_id)) || [];
  const matchedContract = aptContracts.find((c) => String(c.contract_id) === String(contractId));
  const { monthEnd } = getMonthBoundsYmd(period);
  const periodEndYmd = matchedContract?.overlap_end || monthEnd;

  await releaseInvoiceCreditsInTx(client, { invoiceId: draftInv.id, actorId });

  await client.query(
    `DELETE FROM invoice_line
     WHERE invoice_id = $1 AND item_type = $2`,
    [draftInv.id, itemType]
  );

  if (readingRow && readingRow.status === 'CONFIRMED') {
    const prevReadNum = roundReadingValue(readingRow.previous_reading ?? 0);
    const currReadNum = roundReadingValue(readingRow.current_reading ?? 0);
    const cons = roundReadingValue(readingRow.consumption ?? currReadNum - prevReadNum);

    if (cons > 0) {
      const cspRes = await client.query(
        `SELECT service_code, unit_price, effective_from
         FROM contract_service_price
         WHERE contract_id = $1 AND effective_from <= $2::date
         ORDER BY effective_from DESC`,
        [contractId, periodEndYmd]
      );
      const catalogRes = await client.query(
        `SELECT id, code, building_id, unit_price, is_active
         FROM service_catalog
         WHERE org_id = $1 AND is_active = TRUE`,
        [orgId]
      );

      const { unitPrice, priceSource } = resolveUtilityUnitPrice({
        meterType: itemType,
        meterUnitPrice: meter.unit_price,
        contractBuildingId: matchedContract?.building_id || meter.building_id,
        periodEndYmd,
        contractServicePrices: cspRes.rows,
        catalogItems: catalogRes.rows,
        defaultUtilityPrice,
      });

      const lineAmt = roundVND(cons * unitPrice);
      if (lineAmt > 0) {
        await client.query(
          `INSERT INTO invoice_line (
             invoice_id, item_type, description, quantity, unit, unit_price, amount, formula_meta
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            draftInv.id,
            itemType,
            `${itemType === 'ELECTRICITY' ? 'Tiền điện' : 'Tiền nước'} (${prevReadNum} → ${currReadNum} ${meter.unit})${priceSource === 'CONTRACT_OVERRIDE' ? ' (Giá HĐ)' : ''}`,
            cons,
            meter.unit,
            unitPrice,
            lineAmt,
            JSON.stringify({
              meter_id: meter.id,
              meter_code: meter.meter_code || null,
              contract_id: contractId,
              reading_id: readingRow.id,
              meter_type: itemType,
              previous_reading: prevReadNum,
              current_reading: currReadNum,
              consumption: cons,
              unit_price: unitPrice,
              amount: lineAmt,
              price_source: priceSource,
              image_url: readingRow.image_url || null,
            }),
          ]
        );
      }
    }
  }

  await recalculateDraftInvoiceTotalsInTx(client, { invoiceId: draftInv.id, actorId });

  const afterRecalc = await client.query(
    `SELECT status, subtotal_amount FROM invoice WHERE id = $1`,
    [draftInv.id]
  );
  if (afterRecalc.rows[0]?.status === 'DRAFT') {
    const linesCheck = await client.query(
      `SELECT item_type, amount, credit_id FROM invoice_line WHERE invoice_id = $1`,
      [draftInv.id]
    );
    const manualAdj = roundVND(
      linesCheck.rows
        .filter((l) => l.item_type === 'ADJUSTMENT' && !l.credit_id)
        .reduce((s, l) => s + Number(l.amount || 0), 0)
    );
    const grossPayable = Math.max(0, Number(afterRecalc.rows[0].subtotal_amount || 0) + manualAdj);
    await applyAvailableCreditsInTx(client, {
      contractId,
      invoiceId: draftInv.id,
      subtotalAmount: grossPayable,
      actorId,
    });
  }
}
