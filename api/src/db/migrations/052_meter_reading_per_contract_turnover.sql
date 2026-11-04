-- 052_meter_reading_per_contract_turnover.sql
-- Hỗ trợ chốt chỉ số công tơ & lập hóa đơn độc lập cho nhiều hợp đồng đổi khách / chuyển phòng trong cùng kỳ YYYY-MM (M08 + M09 + M06)

-- ============================================================================
-- 1. Bổ sung cột contract_id trên meter_reading (ON DELETE SET NULL an toàn cho lịch sử & cleanup)
-- ============================================================================
ALTER TABLE meter_reading
  ADD COLUMN IF NOT EXISTS contract_id UUID REFERENCES contract(id) ON DELETE SET NULL;

-- ============================================================================
-- 2. Backfill dữ liệu hiện có (Idempotent)
-- ============================================================================
-- 2a. Gán contract_id từ các dòng invoice_line hiệu lực đã tham chiếu reading_id
UPDATE meter_reading mr
SET contract_id = inv.contract_id
FROM invoice_line il
JOIN invoice inv ON inv.id = il.invoice_id
WHERE mr.contract_id IS NULL
  AND il.item_type IN ('ELECTRICITY', 'WATER')
  AND inv.status NOT IN ('VOID', 'CANCELLED')
  AND (il.formula_meta->>'reading_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND (il.formula_meta->>'reading_id')::uuid = mr.id;

-- 2b. Với các dòng còn contract_id IS NULL: nếu căn hộ trong kỳ YYYY-MM chỉ có đúng 1 hợp đồng hiệu lực giao thoa thì gán contract_id
WITH single_overlap AS (
  SELECT mr.id AS reading_id,
         (ARRAY_AGG(c.id))[1] AS sole_contract_id
  FROM meter_reading mr
  JOIN contract c ON c.apartment_id = mr.apartment_id
  LEFT JOIN LATERAL (
    SELECT ch.start_date AS child_start_date
    FROM contract ch
    WHERE ch.parent_contract_id = c.id
      AND ch.is_room_transfer = TRUE
      AND ch.status NOT IN ('DRAFT', 'PENDING_APPROVAL', 'CANCELLED')
    ORDER BY ch.created_at DESC
    LIMIT 1
  ) rt ON TRUE
  WHERE mr.contract_id IS NULL
    AND mr.period ~ '^\d{4}-\d{2}$'
    AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING', 'TERMINATED', 'EXPIRED')
    AND c.start_date < ((mr.period || '-01')::date + INTERVAL '1 month')::date
    AND (
      (
        c.status = 'TERMINATED'
        AND COALESCE((rt.child_start_date - INTERVAL '1 day')::date, c.terminated_at, (c.end_date - INTERVAL '1 day')::date) >= (mr.period || '-01')::date
        AND COALESCE((rt.child_start_date - INTERVAL '1 day')::date, c.terminated_at, (c.end_date - INTERVAL '1 day')::date) >= c.start_date
      )
      OR (
        c.status <> 'TERMINATED'
        AND COALESCE(c.terminated_at, (c.end_date - INTERVAL '1 day')::date) >= (mr.period || '-01')::date
        AND COALESCE(c.terminated_at, (c.end_date - INTERVAL '1 day')::date) >= c.start_date
      )
    )
  GROUP BY mr.id
  HAVING COUNT(c.id) = 1
)
UPDATE meter_reading mr
SET contract_id = so.sole_contract_id
FROM single_overlap so
WHERE mr.id = so.reading_id
  AND mr.contract_id IS NULL;

-- ============================================================================
-- 3. Gỡ bỏ UNIQUE (meter_id, period) cũ & tạo Partial Unique Indexes theo contract_id
-- ============================================================================
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'meter_reading'::regclass
      AND c.contype = 'u'
      AND (
        SELECT ARRAY_AGG(a.attname::text ORDER BY a.attname::text)
        FROM unnest(c.conkey) AS col_num
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = col_num
      ) = ARRAY['meter_id', 'period']
  LOOP
    EXECUTE format('ALTER TABLE meter_reading DROP CONSTRAINT IF EXISTS %I', r.conname);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_reading_period_contract
  ON meter_reading (meter_id, period, contract_id)
  WHERE contract_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_meter_reading_period_null_contract
  ON meter_reading (meter_id, period)
  WHERE contract_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_meter_reading_contract_period
  ON meter_reading (contract_id, period)
  WHERE contract_id IS NOT NULL;

-- ============================================================================
-- 4. Cập nhật RLS rls_meter_reading_select: cách ly chỉ số giữa các hợp đồng của RESIDENT
-- ============================================================================
DROP POLICY IF EXISTS rls_meter_reading_select ON meter_reading;
CREATE POLICY rls_meter_reading_select ON meter_reading FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR (
    status = 'CONFIRMED'
    AND (
      (
        contract_id IS NOT NULL
        AND contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
      )
      OR (
        contract_id IS NULL
        AND apartment_id IN (
          SELECT c.apartment_id FROM contract c
          WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
        )
      )
    )
  )
);

-- ============================================================================
-- 5. Cập nhật can_select_attachment: cách ly ảnh đồng hồ giữa các hợp đồng của RESIDENT
-- ============================================================================
CREATE OR REPLACE FUNCTION can_select_attachment(p_owner_entity TEXT, p_owner_id UUID, p_uploaded_by UUID)
RETURNS BOOLEAN AS $$
BEGIN
  IF is_org_admin() OR p_uploaded_by = get_current_user_id() THEN
    RETURN TRUE;
  END IF;

  IF is_manager() OR is_owner() THEN
    IF p_owner_entity = 'contract' THEN
      RETURN EXISTS (
        SELECT 1 FROM contract c
        WHERE c.id = p_owner_id
          AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'person' THEN
      RETURN is_manager() AND EXISTS (
        SELECT 1 FROM person p
        WHERE p.id = p_owner_id
          AND can_select_person(p.id, p.org_id, p.phone, p.created_by)
      );
    ELSIF p_owner_entity = 'tenant' THEN
      RETURN is_manager() AND EXISTS (
        SELECT 1 FROM tenant t
        WHERE t.id = p_owner_id
          AND can_select_tenant(t.id, t.person_id, t.org_id, t.created_by, t.desired_building_id)
      );
    ELSIF p_owner_entity = 'deposit' THEN
      RETURN EXISTS (
        SELECT 1 FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE d.id = p_owner_id
          AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'reservation' THEN
      RETURN EXISTS (
        SELECT 1 FROM reservation r
        WHERE r.id = p_owner_id
          AND r.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'apartment' THEN
      RETURN EXISTS (
        SELECT 1 FROM apartment a
        WHERE a.id = p_owner_id
          AND a.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'service_request' THEN
      RETURN EXISTS (
        SELECT 1 FROM service_request sr
        WHERE sr.id = p_owner_id
          AND sr.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'payment' THEN
      RETURN EXISTS (
        SELECT 1 FROM payment pay
        WHERE pay.id = p_owner_id
          AND pay.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'meter_reading' THEN
      RETURN EXISTS (
        SELECT 1 FROM meter_reading mr
        WHERE mr.id = p_owner_id
          AND mr.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'credit_balance' THEN
      RETURN EXISTS (
        SELECT 1 FROM credit_balance cb
        WHERE cb.id = p_owner_id
          AND cb.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'invoice' THEN
      RETURN EXISTS (
        SELECT 1 FROM invoice i
        WHERE i.id = p_owner_id
          AND i.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    ELSIF p_owner_entity = 'invoice_adjustment' THEN
      RETURN EXISTS (
        SELECT 1 FROM invoice_adjustment ia
        WHERE ia.id = p_owner_id
          AND ia.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
      );
    END IF;
  END IF;

  IF is_resident() THEN
    IF p_owner_entity = 'person' AND p_owner_id = get_current_user_person_id() THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'tenant' AND p_owner_id IN (SELECT tenant_id FROM get_resident_tenant_ids()) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'contract' AND p_owner_id IN (SELECT contract_id FROM get_resident_contract_ids()) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'deposit' AND EXISTS (
      SELECT 1 FROM deposit d
      WHERE d.id = p_owner_id
        AND d.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'reservation' AND EXISTS (
      SELECT 1 FROM reservation r
      WHERE r.id = p_owner_id
        AND r.phone = (SELECT phone FROM person WHERE id = get_current_user_person_id())
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'service_request' AND EXISTS (
      SELECT 1 FROM service_request sr
      WHERE sr.id = p_owner_id
        AND (sr.created_by = get_current_user_id() OR sr.apartment_id IN (
          SELECT c.apartment_id FROM contract c WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
        ))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'payment' AND EXISTS (
      SELECT 1 FROM payment pay
      WHERE pay.id = p_owner_id
        AND (pay.reported_by = get_current_user_id() OR pay.contract_id IN (SELECT contract_id FROM get_resident_contract_ids()))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'meter_reading' AND EXISTS (
      SELECT 1 FROM meter_reading mr
      WHERE mr.id = p_owner_id
        AND mr.status = 'CONFIRMED'
        AND (
          (
            mr.contract_id IS NOT NULL
            AND mr.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          )
          OR (
            mr.contract_id IS NULL
            AND mr.apartment_id IN (
              SELECT c.apartment_id FROM contract c
              WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
            )
          )
        )
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'credit_balance' AND EXISTS (
      SELECT 1 FROM credit_balance cb
      WHERE cb.id = p_owner_id
        AND (cb.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR cb.tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids()))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'invoice' AND EXISTS (
      SELECT 1 FROM invoice i
      WHERE i.id = p_owner_id
        AND i.status <> 'DRAFT'
        AND (i.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR i.tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids()))
    ) THEN
      RETURN TRUE;
    ELSIF p_owner_entity = 'invoice_adjustment' AND EXISTS (
      SELECT 1 FROM invoice_adjustment ia
      JOIN invoice i ON i.id = ia.invoice_id
      WHERE ia.id = p_owner_id
        AND ia.status = 'APPROVED'
        AND (i.contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR i.tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids()))
    ) THEN
      RETURN TRUE;
    END IF;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp SET row_security = off;
