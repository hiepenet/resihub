-- 053_auto_provision_meters_for_active_contracts.sql
-- Backfill ELECTRICITY & WATER meters for apartments with active contracts (e.g. VOP-D / A002)

INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status)
SELECT
  b.org_id,
  a.building_id,
  a.id,
  'ELECTRICITY',
  CASE
    WHEN EXISTS (
      SELECT 1 FROM meter m_col
      WHERE m_col.building_id = a.building_id
        AND m_col.meter_code = ('EL-' || b.code || '-' || a.code)
        AND m_col.apartment_id <> a.id
    )
    THEN 'EL-' || b.code || '-' || a.code || '-' || UPPER(SUBSTRING(REPLACE(a.id::text, '-', ''), 1, 6))
    ELSE 'EL-' || b.code || '-' || a.code
  END,
  'kWh',
  COALESCE(
    NULLIF((ss.value->>'electricity_default_price')::numeric, NULL)::bigint,
    3800
  ),
  0,
  'ACTIVE'
FROM apartment a
JOIN building b ON b.id = a.building_id
LEFT JOIN system_setting ss ON ss.org_id = b.org_id AND ss.key = 'billing_config'
WHERE EXISTS (
  SELECT 1 FROM contract c
  WHERE c.apartment_id = a.id
    AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
)
AND NOT EXISTS (
  SELECT 1 FROM meter m
  WHERE m.apartment_id = a.id AND m.meter_type = 'ELECTRICITY'
)
ON CONFLICT (apartment_id, meter_type) DO NOTHING;

INSERT INTO meter (org_id, building_id, apartment_id, meter_type, meter_code, unit, unit_price, initial_reading, status)
SELECT
  b.org_id,
  a.building_id,
  a.id,
  'WATER',
  CASE
    WHEN EXISTS (
      SELECT 1 FROM meter m_col
      WHERE m_col.building_id = a.building_id
        AND m_col.meter_code = ('WT-' || b.code || '-' || a.code)
        AND m_col.apartment_id <> a.id
    )
    THEN 'WT-' || b.code || '-' || a.code || '-' || UPPER(SUBSTRING(REPLACE(a.id::text, '-', ''), 1, 6))
    ELSE 'WT-' || b.code || '-' || a.code
  END,
  'm³',
  COALESCE(
    NULLIF((ss.value->>'water_default_price')::numeric, NULL)::bigint,
    22000
  ),
  0,
  'ACTIVE'
FROM apartment a
JOIN building b ON b.id = a.building_id
LEFT JOIN system_setting ss ON ss.org_id = b.org_id AND ss.key = 'billing_config'
WHERE EXISTS (
  SELECT 1 FROM contract c
  WHERE c.apartment_id = a.id
    AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
)
AND NOT EXISTS (
  SELECT 1 FROM meter m
  WHERE m.apartment_id = a.id AND m.meter_type = 'WATER'
)
ON CONFLICT (apartment_id, meter_type) DO NOTHING;

