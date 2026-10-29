-- 026_invoices_payments.sql
-- Module M09 & M10: Hóa đơn, Chi tiết hóa đơn, Thanh toán & Công nợ (FR-032 -> FR-040)

CREATE TABLE IF NOT EXISTS invoice (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id         UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  apartment_id        UUID NOT NULL REFERENCES apartment(id) ON DELETE RESTRICT,
  contract_id         UUID REFERENCES contract(id) ON DELETE SET NULL,
  tenant_id           UUID REFERENCES tenant(id) ON DELETE SET NULL,
  invoice_code        TEXT NOT NULL UNIQUE,
  period              TEXT NOT NULL, -- YYYY-MM
  issue_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date            DATE NOT NULL,
  subtotal_amount     BIGINT NOT NULL DEFAULT 0,
  adjustment_amount   BIGINT NOT NULL DEFAULT 0,
  total_amount        BIGINT NOT NULL DEFAULT 0,
  paid_amount         BIGINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED')),
  note                TEXT,
  created_by          UUID REFERENCES app_user(id) ON DELETE SET NULL,
  issued_by           UUID REFERENCES app_user(id) ON DELETE SET NULL,
  issued_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoice_line (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id  UUID NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  item_type   TEXT NOT NULL CHECK (item_type IN ('RENT','ELECTRICITY','WATER','SERVICE','ADJUSTMENT','OTHER')),
  description TEXT NOT NULL,
  quantity    NUMERIC(12,2) NOT NULL DEFAULT 1,
  unit        TEXT NOT NULL DEFAULT 'tháng',
  unit_price  BIGINT NOT NULL DEFAULT 0,
  amount      BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS payment (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id         UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  invoice_id          UUID REFERENCES invoice(id) ON DELETE SET NULL,
  contract_id         UUID REFERENCES contract(id) ON DELETE SET NULL,
  tenant_id           UUID REFERENCES tenant(id) ON DELETE SET NULL,
  payment_code        TEXT NOT NULL UNIQUE,
  amount              BIGINT NOT NULL CHECK (amount > 0),
  overpayment_amount  BIGINT NOT NULL DEFAULT 0,
  method              TEXT NOT NULL DEFAULT 'BANK_TRANSFER'
                      CHECK (method IN ('BANK_TRANSFER','CASH','CARD','EWALLET','OTHER')),
  reference_code      TEXT,
  proof_images        TEXT[] DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'CONFIRMED'
                      CHECK (status IN ('PENDING_CONFIRMATION','CONFIRMED','REJECTED')),
  paid_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note                TEXT,
  reported_by         UUID REFERENCES app_user(id) ON DELETE SET NULL,
  confirmed_by        UUID REFERENCES app_user(id) ON DELETE SET NULL,
  confirmed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS receivable (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  building_id UUID NOT NULL REFERENCES building(id) ON DELETE CASCADE,
  contract_id UUID REFERENCES contract(id) ON DELETE SET NULL,
  tenant_id   UUID REFERENCES tenant(id) ON DELETE SET NULL,
  invoice_id  UUID REFERENCES invoice(id) ON DELETE SET NULL,
  deposit_id  UUID REFERENCES deposit(id) ON DELETE SET NULL,
  type        TEXT NOT NULL DEFAULT 'INVOICE_DEBT'
              CHECK (type IN ('INVOICE_DEBT','RECEIVABLE_AFTER_MOVE_OUT','OTHER')),
  amount      BIGINT NOT NULL CHECK (amount > 0),
  paid_amount BIGINT NOT NULL DEFAULT 0,
  due_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  status      TEXT NOT NULL DEFAULT 'OPEN'
              CHECK (status IN ('OPEN','PARTIALLY_PAID','PAID','WRITTEN_OFF')),
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_building_period ON invoice(building_id, period, status);
CREATE INDEX IF NOT EXISTS idx_invoice_contract ON invoice(contract_id, period);
CREATE INDEX IF NOT EXISTS idx_payment_building ON payment(building_id, status);
CREATE INDEX IF NOT EXISTS idx_receivable_building ON receivable(building_id, status, due_date);

GRANT ALL PRIVILEGES ON TABLE invoice TO resihub_app;
GRANT ALL PRIVILEGES ON TABLE invoice_line TO resihub_app;
GRANT ALL PRIVILEGES ON TABLE payment TO resihub_app;
GRANT ALL PRIVILEGES ON TABLE receivable TO resihub_app;

-- RLS cho invoice
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_invoice_select ON invoice;
CREATE POLICY rls_invoice_select ON invoice FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

DROP POLICY IF EXISTS rls_invoice_modify ON invoice;
CREATE POLICY rls_invoice_modify ON invoice FOR ALL
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR (is_resident() AND contract_id IN (SELECT contract_id FROM get_resident_contract_ids()))
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR (is_resident() AND contract_id IN (SELECT contract_id FROM get_resident_contract_ids()))
);

-- RLS cho invoice_line
ALTER TABLE invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_invoice_line_select ON invoice_line;
CREATE POLICY rls_invoice_line_select ON invoice_line FOR SELECT USING (
  is_org_admin()
  OR invoice_id IN (SELECT id FROM invoice)
);

DROP POLICY IF EXISTS rls_invoice_line_modify ON invoice_line;
CREATE POLICY rls_invoice_line_modify ON invoice_line FOR ALL
USING (
  is_org_admin()
  OR invoice_id IN (
    SELECT id FROM invoice
    WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
       OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  )
)
WITH CHECK (
  is_org_admin()
  OR invoice_id IN (
    SELECT id FROM invoice
    WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
       OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  )
);

-- RLS cho payment
ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_payment_select ON payment;
CREATE POLICY rls_payment_select ON payment FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR reported_by = get_current_user_id()
);

DROP POLICY IF EXISTS rls_payment_insert ON payment;
CREATE POLICY rls_payment_insert ON payment FOR INSERT WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR reported_by = get_current_user_id()
);

DROP POLICY IF EXISTS rls_payment_update ON payment;
CREATE POLICY rls_payment_update ON payment FOR UPDATE
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
);

-- RLS cho receivable
ALTER TABLE receivable ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_receivable_select ON receivable;
CREATE POLICY rls_receivable_select ON receivable FOR SELECT USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

DROP POLICY IF EXISTS rls_receivable_modify ON receivable;
CREATE POLICY rls_receivable_modify ON receivable FOR ALL
USING (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_owner_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
)
WITH CHECK (
  is_org_admin()
  OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR building_id IN (SELECT building_id FROM get_owner_building_ids())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
);

-- Mở rộng hàm can_select_attachment để hỗ trợ xem ảnh báo hỏng, chứng từ TT, đồng hồ điện/nước
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
      RETURN EXISTS (
        SELECT 1 FROM person p
        WHERE p.id = p_owner_id
          AND can_select_person(p.id, p.org_id, p.phone)
      );
    ELSIF p_owner_entity = 'tenant' THEN
      RETURN EXISTS (
        SELECT 1 FROM tenant t
        WHERE t.id = p_owner_id
          AND can_select_tenant(t.id, t.person_id, t.org_id)
      );
    ELSIF p_owner_entity = 'deposit' THEN
      RETURN EXISTS (
        SELECT 1 FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE d.id = p_owner_id
          AND c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
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
    END IF;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET row_security = off;

-- Seed hóa đơn & doanh thu 12 tháng gần nhất để phục vụ biểu đồ AC-018, Hóa đơn & Công nợ
DO $$
DECLARE
  rec RECORD;
  m_offset INT;
  v_period TEXT;
  v_issue_date DATE;
  v_due_date DATE;
  v_inv_id UUID;
  v_elec BIGINT;
  v_water BIGINT;
  v_svc BIGINT;
  v_total BIGINT;
  v_status TEXT;
  v_paid BIGINT;
  v_seq INT := 1;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM invoice LIMIT 1) THEN
    -- 1. Tạo lịch sử hóa đơn đã thanh toán 11 tháng trước cho tối đa 27 hợp đồng (3 HĐ/tòa)
    FOR m_offset IN REVERSE 11..1 LOOP
      v_period := TO_CHAR(CURRENT_DATE - (m_offset || ' months')::interval, 'YYYY-MM');
      v_issue_date := DATE_TRUNC('month', CURRENT_DATE - (m_offset || ' months')::interval)::date;
      v_due_date := v_issue_date + 5;

      FOR rec IN (
        SELECT c.id AS contract_id, c.building_id, c.apartment_id, c.primary_tenant_id, c.rent_amount, b.org_id, a.code AS apt_code, b.code AS bldg_code
        FROM contract c
        JOIN building b ON b.id = c.building_id
        JOIN apartment a ON a.id = c.apartment_id
        WHERE c.status = 'ACTIVE'
        ORDER BY b.code, a.code
        LIMIT 36
      ) LOOP
        v_elec := 650000 + ((v_seq % 5) * 85000);
        v_water := 240000 + ((v_seq % 4) * 22000);
        v_svc := 570000;
        v_total := rec.rent_amount + v_elec + v_water + v_svc;

        INSERT INTO invoice (
          org_id, building_id, apartment_id, contract_id, tenant_id,
          invoice_code, period, issue_date, due_date,
          subtotal_amount, adjustment_amount, total_amount, paid_amount, status, issued_at
        ) VALUES (
          rec.org_id, rec.building_id, rec.apartment_id, rec.contract_id, rec.primary_tenant_id,
          'INV-' || REPLACE(v_period, '-', '') || '-' || LPAD(v_seq::text, 5, '0'),
          v_period, v_issue_date, v_due_date,
          v_total, 0, v_total, v_total, 'PAID', v_issue_date::timestamptz
        ) RETURNING id INTO v_inv_id;

        INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount) VALUES
          (v_inv_id, 'RENT', 'Tiền thuê căn hộ kỳ ' || v_period, 1, 'tháng', rec.rent_amount, rec.rent_amount),
          (v_inv_id, 'ELECTRICITY', 'Tiền điện sinh hoạt', ROUND(v_elec / 3800.0, 1), 'kWh', 3800, v_elec),
          (v_inv_id, 'WATER', 'Tiền nước sinh hoạt', ROUND(v_water / 22000.0, 1), 'm³', 22000, v_water),
          (v_inv_id, 'SERVICE', 'Internet & Phí quản lý vận hành', 1, 'gói', v_svc, v_svc);

        INSERT INTO payment (
          org_id, building_id, invoice_id, contract_id, tenant_id,
          payment_code, amount, method, reference_code, status, paid_at
        ) VALUES (
          rec.org_id, rec.building_id, v_inv_id, rec.contract_id, rec.primary_tenant_id,
          'PAY-' || REPLACE(v_period, '-', '') || '-' || LPAD(v_seq::text, 5, '0'),
          v_total, 'BANK_TRANSFER', 'VCB' || LPAD(v_seq::text, 8, '0'), 'CONFIRMED', (v_issue_date + 3)::timestamptz
        );

        v_seq := v_seq + 1;
      END LOOP;
    END LOOP;

    -- 2. Tạo hóa đơn kỳ hiện tại cho TẤT CẢ hợp đồng ACTIVE (gồm PAID, ISSUED, OVERDUE, PARTIALLY_PAID)
    v_period := TO_CHAR(CURRENT_DATE, 'YYYY-MM');
    v_issue_date := DATE_TRUNC('month', CURRENT_DATE)::date;
    v_due_date := v_issue_date + 5;

    FOR rec IN (
      SELECT c.id AS contract_id, c.building_id, c.apartment_id, c.primary_tenant_id, c.rent_amount, b.org_id
      FROM contract c
      JOIN building b ON b.id = c.building_id
      WHERE c.status = 'ACTIVE'
      ORDER BY c.created_at
    ) LOOP
      v_elec := 722000;
      v_water := 286000;
      v_svc := 570000;
      v_total := rec.rent_amount + v_elec + v_water + v_svc;

      IF v_seq % 5 = 0 THEN
        v_status := 'OVERDUE';
        v_paid := 0;
        v_due_date := CURRENT_DATE - ((v_seq % 4 + 1) * 18); -- phân bổ tuổi nợ 0-30, 31-60, 61-90
      ELSIF v_seq % 4 = 0 THEN
        v_status := 'ISSUED';
        v_paid := 0;
        v_due_date := CURRENT_DATE + 5;
      ELSIF v_seq % 7 = 0 THEN
        v_status := 'PARTIALLY_PAID';
        v_paid := rec.rent_amount;
        v_due_date := CURRENT_DATE - 10;
      ELSE
        v_status := 'PAID';
        v_paid := v_total;
        v_due_date := v_issue_date + 5;
      END IF;

      INSERT INTO invoice (
        org_id, building_id, apartment_id, contract_id, tenant_id,
        invoice_code, period, issue_date, due_date,
        subtotal_amount, adjustment_amount, total_amount, paid_amount, status, issued_at
      ) VALUES (
        rec.org_id, rec.building_id, rec.apartment_id, rec.contract_id, rec.primary_tenant_id,
        'INV-' || REPLACE(v_period, '-', '') || '-' || LPAD(v_seq::text, 5, '0'),
        v_period, v_issue_date, v_due_date,
        v_total, 0, v_total, v_paid, v_status, NOW()
      ) RETURNING id INTO v_inv_id;

      INSERT INTO invoice_line (invoice_id, item_type, description, quantity, unit, unit_price, amount) VALUES
        (v_inv_id, 'RENT', 'Tiền thuê căn hộ kỳ ' || v_period, 1, 'tháng', rec.rent_amount, rec.rent_amount),
        (v_inv_id, 'ELECTRICITY', 'Tiền điện sinh hoạt (190 kWh)', 190, 'kWh', 3800, v_elec),
        (v_inv_id, 'WATER', 'Tiền nước sinh hoạt (13 m³)', 13, 'm³', 22000, v_water),
        (v_inv_id, 'SERVICE', 'Internet Cáp quang & Phí quản lý', 1, 'gói', v_svc, v_svc);

      IF v_paid > 0 THEN
        INSERT INTO payment (
          org_id, building_id, invoice_id, contract_id, tenant_id,
          payment_code, amount, method, reference_code, status, paid_at
        ) VALUES (
          rec.org_id, rec.building_id, v_inv_id, rec.contract_id, rec.primary_tenant_id,
          'PAY-' || REPLACE(v_period, '-', '') || '-' || LPAD(v_seq::text, 5, '0'),
          v_paid, 'BANK_TRANSFER', 'VCB' || LPAD(v_seq::text, 8, '0'), 'CONFIRMED', NOW() - INTERVAL '2 days'
        );
      END IF;

      IF v_status IN ('OVERDUE', 'PARTIALLY_PAID') THEN
        INSERT INTO receivable (
          org_id, building_id, contract_id, tenant_id, invoice_id,
          type, amount, paid_amount, due_date, status, description
        ) VALUES (
          rec.org_id, rec.building_id, rec.contract_id, rec.primary_tenant_id, v_inv_id,
          'INVOICE_DEBT', v_total - v_paid, 0, v_due_date, 'OPEN',
          'Công nợ hóa đơn kỳ ' || v_period
        );
      END IF;

      v_seq := v_seq + 1;
    END LOOP;
  END IF;
END $$;

