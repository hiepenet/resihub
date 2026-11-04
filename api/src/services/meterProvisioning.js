export const ACTIVE_CONTRACT_STATUSES = [
  'ACTIVE',
  'RENEWAL_PENDING',
  'TERMINATION_PENDING',
];

export function buildDefaultMeterCode(
  meterType,
  buildingCode,
  apartmentCode,
  collisionSuffix = ''
) {
  const prefix = meterType === 'ELECTRICITY' ? 'EL' : 'WT';
  const base = `${prefix}-${String(buildingCode || '').trim()}-${String(apartmentCode || '').trim()}`;
  const cleanSuffix = String(collisionSuffix || '').trim().toUpperCase();
  return cleanSuffix ? `${base}-${cleanSuffix}` : base;
}

async function loadOrgDefaultMeterPrices(queryable, orgId) {
  const res = await queryable.query(
    `SELECT value FROM system_setting WHERE org_id = $1 AND key = 'billing_config' LIMIT 1`,
    [orgId]
  );
  const cfg = res.rows[0]?.value || {};
  const elecDef = Number(cfg.electricity_default_price);
  const waterDef = Number(cfg.water_default_price);
  return {
    ELECTRICITY: Number.isFinite(elecDef) && elecDef >= 0 ? Math.round(elecDef) : 3800,
    WATER: Number.isFinite(waterDef) && waterDef >= 0 ? Math.round(waterDef) : 22000,
  };
}

/**
 * Idempotently ensure an apartment has both ELECTRICITY and WATER meters
 * without overwriting or mutating any existing meter or meter_reading rows.
 */
export async function ensureApartmentMetersInTx(
  queryable,
  { apartmentId, actorId = null } = {}
) {
  if (!apartmentId) {
    return { created: [], existing: [] };
  }

  const aptRes = await queryable.query(
    `SELECT a.id, a.code AS apartment_code, a.building_id, b.code AS building_code, b.org_id
     FROM apartment a
     JOIN building b ON b.id = a.building_id
     WHERE a.id = $1
     LIMIT 1`,
    [apartmentId]
  );
  if (aptRes.rows.length === 0) {
    return { created: [], existing: [] };
  }

  const apt = aptRes.rows[0];
  const existingRes = await queryable.query(
    `SELECT * FROM meter WHERE apartment_id = $1 ORDER BY meter_type ASC`,
    [apartmentId]
  );
  const existingByType = new Map(existingRes.rows.map((m) => [m.meter_type, m]));
  const missingTypes = ['ELECTRICITY', 'WATER'].filter((t) => !existingByType.has(t));

  if (missingTypes.length === 0) {
    return { created: [], existing: existingRes.rows };
  }

  const defaultPrices = await loadOrgDefaultMeterPrices(queryable, apt.org_id);
  const shortAptSuffix = String(apt.id).replace(/-/g, '').slice(0, 6).toUpperCase();
  const created = [];

  for (const meterType of missingTypes) {
    let candidateCode = buildDefaultMeterCode(
      meterType,
      apt.building_code,
      apt.apartment_code
    );

    const codeTakenRes = await queryable.query(
      `SELECT 1 FROM meter
       WHERE building_id = $1 AND meter_code = $2 AND apartment_id <> $3
       LIMIT 1`,
      [apt.building_id, candidateCode, apt.id]
    );
    if (codeTakenRes.rows.length > 0) {
      candidateCode = buildDefaultMeterCode(
        meterType,
        apt.building_code,
        apt.apartment_code,
        shortAptSuffix
      );
    }

    const unit = meterType === 'ELECTRICITY' ? 'kWh' : 'm³';
    const unitPrice = defaultPrices[meterType];

    const insRes = await queryable.query(
      `INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 'ACTIVE')
       ON CONFLICT (apartment_id, meter_type) DO NOTHING
       RETURNING *`,
      [apt.org_id, apt.building_id, apt.id, meterType, candidateCode, unit, unitPrice]
    );

    if (insRes.rows.length > 0) {
      const row = insRes.rows[0];
      created.push(row);
      await queryable.query(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, after)
         VALUES ($1, 'AUTO_CREATE_METER', 'meter', $2, $3)`,
        [actorId || null, row.id, JSON.stringify(row)]
      );
    }
  }

  return { created, existing: existingRes.rows };
}

