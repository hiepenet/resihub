-- ============================================================================
-- 005_rls_enable_and_policies.sql
-- Consolidated Row-Level Security Enablement, Force RLS, and Policies
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Enable & Force Row-Level Security on All Operational Tables
-- ----------------------------------------------------------------------------
ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization FORCE ROW LEVEL SECURITY;
ALTER TABLE owner ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner FORCE ROW LEVEL SECURITY;
ALTER TABLE role ENABLE ROW LEVEL SECURITY;
ALTER TABLE role FORCE ROW LEVEL SECURITY;
ALTER TABLE building ENABLE ROW LEVEL SECURITY;
ALTER TABLE building FORCE ROW LEVEL SECURITY;
ALTER TABLE floor ENABLE ROW LEVEL SECURITY;
ALTER TABLE floor FORCE ROW LEVEL SECURITY;
ALTER TABLE zone ENABLE ROW LEVEL SECURITY;
ALTER TABLE zone FORCE ROW LEVEL SECURITY;
ALTER TABLE apartment ENABLE ROW LEVEL SECURITY;
ALTER TABLE apartment FORCE ROW LEVEL SECURITY;
ALTER TABLE person ENABLE ROW LEVEL SECURITY;
ALTER TABLE person FORCE ROW LEVEL SECURITY;
ALTER TABLE app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user FORCE ROW LEVEL SECURITY;
ALTER TABLE user_role ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_role FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
ALTER TABLE reservation ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservation FORCE ROW LEVEL SECURITY;
ALTER TABLE contract ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract FORCE ROW LEVEL SECURITY;
ALTER TABLE contract_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_version FORCE ROW LEVEL SECURITY;
ALTER TABLE contract_occupant ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_occupant FORCE ROW LEVEL SECURITY;
ALTER TABLE contract_service_price ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_service_price FORCE ROW LEVEL SECURITY;
ALTER TABLE contract_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_request FORCE ROW LEVEL SECURITY;
ALTER TABLE deposit ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit FORCE ROW LEVEL SECURITY;
ALTER TABLE deposit_transaction ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_transaction FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachment FORCE ROW LEVEL SECURITY;
ALTER TABLE announcement ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement FORCE ROW LEVEL SECURITY;
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;
ALTER TABLE zalo_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE zalo_group FORCE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestion ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestion FORCE ROW LEVEL SECURITY;
ALTER TABLE service_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_request FORCE ROW LEVEL SECURITY;
ALTER TABLE meter ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter FORCE ROW LEVEL SECURITY;
ALTER TABLE meter_reading ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_reading FORCE ROW LEVEL SECURITY;
ALTER TABLE service_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_catalog FORCE ROW LEVEL SECURITY;
ALTER TABLE service_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_subscription FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line FORCE ROW LEVEL SECURITY;
ALTER TABLE invoice_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_adjustment FORCE ROW LEVEL SECURITY;
ALTER TABLE credit_balance ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balance FORCE ROW LEVEL SECURITY;
ALTER TABLE late_fee_accrual_tracker ENABLE ROW LEVEL SECURITY;
ALTER TABLE late_fee_accrual_tracker FORCE ROW LEVEL SECURITY;
ALTER TABLE payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment FORCE ROW LEVEL SECURITY;
ALTER TABLE receivable ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable FORCE ROW LEVEL SECURITY;
ALTER TABLE system_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_setting FORCE ROW LEVEL SECURITY;
ALTER TABLE cron_job_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE cron_job_run FORCE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 2. Consolidated RLS Policies (Idempotent: DROP POLICY IF EXISTS ... CREATE POLICY ...)
-- ----------------------------------------------------------------------------

-- ============================================================================
-- Table: organization
-- ============================================================================
DROP POLICY IF EXISTS rls_organization_select ON organization;
CREATE POLICY rls_organization_select ON organization FOR SELECT USING (
  id = (SELECT get_current_user_org_id()) OR (SELECT is_org_member())
);

DROP POLICY IF EXISTS rls_organization_modify ON organization;
CREATE POLICY rls_organization_modify ON organization FOR ALL USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: owner
-- ============================================================================
DROP POLICY IF EXISTS rls_owner_select ON owner;
CREATE POLICY rls_owner_select ON owner FOR SELECT USING (
  org_id = (SELECT get_current_user_org_id()) OR (SELECT is_org_member())
);

DROP POLICY IF EXISTS rls_owner_modify ON owner;
CREATE POLICY rls_owner_modify ON owner FOR ALL USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: role
-- ============================================================================
DROP POLICY IF EXISTS rls_role_select ON role;
CREATE POLICY rls_role_select ON role FOR SELECT USING (
  org_id = (SELECT get_current_user_org_id()) OR (SELECT is_org_member())
);

DROP POLICY IF EXISTS rls_role_modify ON role;
CREATE POLICY rls_role_modify ON role FOR ALL USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: building
-- ============================================================================
DROP POLICY IF EXISTS rls_building_select ON building;
CREATE POLICY rls_building_select ON building FOR SELECT USING (
  (SELECT is_org_admin())
  OR id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR id IN (
    SELECT c.building_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
  OR id IN (
    SELECT rsv.building_id FROM reservation rsv
    WHERE rsv.phone = (SELECT get_current_user_phone())
  )
);

DROP POLICY IF EXISTS rls_building_insert ON building;
CREATE POLICY rls_building_insert ON building FOR INSERT
  WITH CHECK (
    (SELECT is_org_admin())
    OR (
      (SELECT is_manager())
      AND org_id = (SELECT get_current_user_org_id())
    )
  );

DROP POLICY IF EXISTS rls_building_update ON building;
CREATE POLICY rls_building_update ON building FOR UPDATE
  USING ((SELECT is_org_admin()) OR id IN (SELECT building_id FROM get_manager_building_ids()))
  WITH CHECK ((SELECT is_org_admin()) OR id IN (SELECT building_id FROM get_manager_building_ids()));

DROP POLICY IF EXISTS rls_building_delete ON building;
CREATE POLICY rls_building_delete ON building FOR DELETE
  USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: floor
-- ============================================================================
DROP POLICY IF EXISTS rls_floor_select ON floor;
CREATE POLICY rls_floor_select ON floor FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (
    SELECT c.building_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
  OR building_id IN (
    SELECT rsv.building_id FROM reservation rsv
    WHERE rsv.phone = (SELECT get_current_user_phone())
  )
);

DROP POLICY IF EXISTS rls_floor_insert ON floor;
CREATE POLICY rls_floor_insert ON floor FOR INSERT
WITH CHECK (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

DROP POLICY IF EXISTS rls_floor_update ON floor;
CREATE POLICY rls_floor_update ON floor FOR UPDATE
USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
)
WITH CHECK (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

DROP POLICY IF EXISTS rls_floor_delete ON floor;
CREATE POLICY rls_floor_delete ON floor FOR DELETE
USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);


-- ============================================================================
-- Table: zone
-- ============================================================================
DROP POLICY IF EXISTS rls_zone_select ON zone;
CREATE POLICY rls_zone_select ON zone FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (
    SELECT c.building_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

DROP POLICY IF EXISTS rls_zone_insert ON zone;
CREATE POLICY rls_zone_insert ON zone FOR INSERT
  WITH CHECK ((SELECT is_org_admin()) OR building_id IN (SELECT building_id FROM get_manager_building_ids()));

DROP POLICY IF EXISTS rls_zone_update ON zone;
CREATE POLICY rls_zone_update ON zone FOR UPDATE
  USING ((SELECT is_org_admin()) OR building_id IN (SELECT building_id FROM get_manager_building_ids()))
  WITH CHECK ((SELECT is_org_admin()) OR building_id IN (SELECT building_id FROM get_manager_building_ids()));

DROP POLICY IF EXISTS rls_zone_delete ON zone;
CREATE POLICY rls_zone_delete ON zone FOR DELETE
  USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: apartment
-- ============================================================================
DROP POLICY IF EXISTS rls_apartment_select ON apartment;
CREATE POLICY rls_apartment_select ON apartment FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR id IN (
    SELECT c.apartment_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
  OR id IN (
    SELECT rsv.apartment_id FROM reservation rsv
    WHERE rsv.phone = (SELECT get_current_user_phone())
  )
);

DROP POLICY IF EXISTS rls_apartment_insert ON apartment;
CREATE POLICY rls_apartment_insert ON apartment FOR INSERT
  WITH CHECK ((SELECT is_org_admin()) OR building_id IN (SELECT building_id FROM get_manager_building_ids()));

DROP POLICY IF EXISTS rls_apartment_update ON apartment;
CREATE POLICY rls_apartment_update ON apartment FOR UPDATE
  USING (
    (SELECT is_org_admin())
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  WITH CHECK (
    (SELECT is_org_admin())
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_apartment_delete ON apartment;
CREATE POLICY rls_apartment_delete ON apartment FOR DELETE
  USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: person
-- ============================================================================
DROP POLICY IF EXISTS rls_person_select ON person;
CREATE POLICY rls_person_select ON person FOR SELECT
USING (
  (SELECT get_current_user_id()) IS NOT NULL
  AND (
    (SELECT is_org_admin())
    OR person.id = (SELECT get_current_user_person_id())
    OR person.id IN (SELECT gp.person_id FROM get_accessible_person_ids() gp)
    OR (
      person.phone IS NOT NULL
      AND person.phone IN (SELECT rp.phone FROM get_assigned_building_reservation_phones() rp)
    )
    OR (
      (SELECT is_manager())
      AND person.org_id = (SELECT get_current_user_org_id())
      AND person.created_by = (SELECT get_current_user_id())
      AND NOT (person.id IN (SELECT op.person_id FROM get_other_building_contract_person_ids() op))
    )
  )
);

DROP POLICY IF EXISTS rls_person_insert ON person;
CREATE POLICY rls_person_insert ON person FOR INSERT
  WITH CHECK (
    (SELECT is_org_admin())
    OR ((SELECT is_manager()) AND person.org_id = (SELECT get_current_user_org_id()))
  );

DROP POLICY IF EXISTS rls_person_update ON person;
CREATE POLICY rls_person_update ON person FOR UPDATE
  USING (
    (SELECT is_org_admin())
    OR person.id = (SELECT get_current_user_person_id())
    OR ((SELECT is_manager()) AND person.org_id = (SELECT get_current_user_org_id()))
  )
  WITH CHECK (
    (SELECT is_org_admin())
    OR person.id = (SELECT get_current_user_person_id())
    OR ((SELECT is_manager()) AND person.org_id = (SELECT get_current_user_org_id()))
  );

DROP POLICY IF EXISTS rls_person_delete ON person;
CREATE POLICY rls_person_delete ON person FOR DELETE
  USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: app_user
-- ============================================================================
DROP POLICY IF EXISTS rls_app_user_select ON app_user;
CREATE POLICY rls_app_user_select ON app_user FOR SELECT
  USING (can_select_app_user(id, person_id));

DROP POLICY IF EXISTS rls_app_user_insert ON app_user;
CREATE POLICY rls_app_user_insert ON app_user FOR INSERT
WITH CHECK (
  (SELECT is_org_admin())
);

DROP POLICY IF EXISTS rls_app_user_update ON app_user;
CREATE POLICY rls_app_user_update ON app_user FOR UPDATE
USING (
  id = (SELECT get_current_user_id())
  OR (SELECT is_org_admin())
)
WITH CHECK (
  id = (SELECT get_current_user_id())
  OR (SELECT is_org_admin())
);

DROP POLICY IF EXISTS rls_app_user_delete ON app_user;
CREATE POLICY rls_app_user_delete ON app_user FOR DELETE
USING (
  (SELECT is_org_admin())
);


-- ============================================================================
-- Table: user_role
-- ============================================================================
DROP POLICY IF EXISTS rls_user_role_select ON user_role;
CREATE POLICY rls_user_role_select ON user_role FOR SELECT USING (
  (SELECT is_org_admin())
  OR user_id = (SELECT get_current_user_id())
  OR user_id IN (SELECT manager_user_id FROM get_resident_manager_user_ids((SELECT get_current_user_id())))
);

DROP POLICY IF EXISTS rls_user_role_insert ON user_role;
CREATE POLICY rls_user_role_insert ON user_role FOR INSERT
  WITH CHECK (
    (SELECT is_org_admin())
    OR (
      (SELECT is_manager())
      AND role_id IN (SELECT id FROM role WHERE code = 'RESIDENT')
      AND user_id != (SELECT get_current_user_id())
    )
  );

DROP POLICY IF EXISTS rls_user_role_update ON user_role;
CREATE POLICY rls_user_role_update ON user_role FOR UPDATE
  USING ((SELECT is_org_admin()))
  WITH CHECK ((SELECT is_org_admin()));

DROP POLICY IF EXISTS rls_user_role_delete ON user_role;
CREATE POLICY rls_user_role_delete ON user_role FOR DELETE
  USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: tenant
-- ============================================================================
DROP POLICY IF EXISTS rls_tenant_select ON tenant;
CREATE POLICY rls_tenant_select ON tenant FOR SELECT
USING (
  (SELECT get_current_user_id()) IS NOT NULL
  AND (
    (SELECT is_org_admin())
    OR tenant.person_id = (SELECT get_current_user_person_id())
    OR tenant.id IN (SELECT gt.tenant_id FROM get_accessible_tenant_ids() gt)
    OR (
      tenant.desired_building_id IS NOT NULL
      AND tenant.desired_building_id IN (SELECT ub.building_id FROM get_user_assigned_buildings() ub)
    )
    OR (
      (SELECT is_manager())
      AND tenant.org_id = (SELECT get_current_user_org_id())
      AND (
        tenant.created_by = (SELECT get_current_user_id())
        OR tenant.person_id IN (SELECT mp.person_id FROM get_manager_created_person_ids() mp)
      )
      AND NOT (tenant.id IN (SELECT ot.tenant_id FROM get_other_building_contract_tenant_ids() ot))
    )
  )
);

DROP POLICY IF EXISTS rls_tenant_insert ON tenant;
CREATE POLICY rls_tenant_insert ON tenant FOR INSERT
  WITH CHECK (
    (SELECT is_org_admin())
    OR ((SELECT is_manager()) AND tenant.org_id = (SELECT get_current_user_org_id()))
    OR (tenant.org_id = (SELECT get_current_user_org_id()) AND tenant.person_id = (SELECT get_current_user_person_id()))
  );

DROP POLICY IF EXISTS rls_tenant_update ON tenant;
CREATE POLICY rls_tenant_update ON tenant FOR UPDATE
  USING (
    (SELECT is_org_admin())
    OR ((SELECT is_manager()) AND tenant.org_id = (SELECT get_current_user_org_id()))
    OR tenant.id IN (SELECT tenant_id FROM get_resident_tenant_ids())
  )
  WITH CHECK (
    (SELECT is_org_admin())
    OR ((SELECT is_manager()) AND tenant.org_id = (SELECT get_current_user_org_id()))
    OR tenant.id IN (SELECT tenant_id FROM get_resident_tenant_ids())
  );

DROP POLICY IF EXISTS rls_tenant_delete ON tenant;
CREATE POLICY rls_tenant_delete ON tenant FOR DELETE
  USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: reservation
-- ============================================================================
DROP POLICY IF EXISTS rls_reservation_select ON reservation;
CREATE POLICY rls_reservation_select ON reservation FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR phone = (SELECT get_current_user_phone())
);

DROP POLICY IF EXISTS rls_reservation_insert ON reservation;
CREATE POLICY rls_reservation_insert ON reservation FOR INSERT
  WITH CHECK (
    (SELECT is_manager())
    AND building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_reservation_update ON reservation;
CREATE POLICY rls_reservation_update ON reservation FOR UPDATE
  USING (
    (
      (SELECT is_manager())
      AND building_id IN (SELECT building_id FROM get_manager_building_ids())
      AND status IN ('PENDING_CONFIRM', 'HELD', 'EXPIRED', 'CANCEL_PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT')
    )
    OR (
      status IN ('HELD', 'EXPIRED', 'CANCEL_PENDING_APPROVAL')
      AND (
        ((SELECT is_owner()) AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
        OR ((SELECT is_org_admin()) AND NOT building_has_active_owner(building_id))
      )
    )
  )
  WITH CHECK (
    (
      (SELECT is_manager())
      AND building_id IN (SELECT building_id FROM get_manager_building_ids())
      AND status IN (
        'HELD',
        'REJECTED',
        'CONVERTED',
        'CANCEL_PENDING_APPROVAL',
        'APPROVED_PENDING_PAYOUT',
        'FORFEITED',
        'REFUNDED',
        'PARTIALLY_REFUNDED',
        'EXPIRED'
      )
    )
    OR (
      status IN ('HELD', 'EXPIRED', 'APPROVED_PENDING_PAYOUT', 'FORFEITED')
      AND (
        ((SELECT is_owner()) AND building_id IN (SELECT building_id FROM get_owner_building_ids()))
        OR ((SELECT is_org_admin()) AND NOT building_has_active_owner(building_id))
      )
    )
  );

DROP POLICY IF EXISTS rls_reservation_delete ON reservation;
CREATE POLICY rls_reservation_delete ON reservation FOR DELETE
  USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: contract
-- ============================================================================
DROP POLICY IF EXISTS rls_contract_select ON contract;
CREATE POLICY rls_contract_select ON contract FOR SELECT
USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  OR id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_contract_insert ON contract;
CREATE POLICY rls_contract_insert ON contract FOR INSERT
  WITH CHECK (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_update ON contract;
CREATE POLICY rls_contract_update ON contract FOR UPDATE
  USING (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (
      (SELECT is_owner())
      AND status = 'PENDING_APPROVAL'
      AND building_id IN (SELECT building_id FROM get_owner_building_ids())
    )
    OR (
      (SELECT is_org_admin())
      AND status = 'PENDING_APPROVAL'
      AND NOT building_has_active_owner(building_id)
    )
  )
  WITH CHECK (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
    OR (
      (SELECT is_owner())
      AND status IN ('ACTIVE', 'DRAFT')
      AND building_id IN (SELECT building_id FROM get_owner_building_ids())
    )
    OR (
      (SELECT is_org_admin())
      AND status IN ('ACTIVE', 'DRAFT')
      AND NOT building_has_active_owner(building_id)
    )
  );

DROP POLICY IF EXISTS rls_contract_delete ON contract;
CREATE POLICY rls_contract_delete ON contract FOR DELETE
  USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: contract_version
-- ============================================================================
DROP POLICY IF EXISTS rls_contract_version_select ON contract_version;
CREATE POLICY rls_contract_version_select ON contract_version FOR SELECT USING (
  (SELECT is_org_admin())
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_contract_version_insert ON contract_version;
CREATE POLICY rls_contract_version_insert ON contract_version FOR INSERT
  WITH CHECK (
    contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_contract_version_update ON contract_version;
CREATE POLICY rls_contract_version_update ON contract_version FOR UPDATE
  USING (
    (SELECT is_manager())
    AND contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    (SELECT is_manager())
    AND contract_id IN (
      SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );


-- ============================================================================
-- Table: contract_occupant
-- ============================================================================
DROP POLICY IF EXISTS rls_contract_occupant_select ON contract_occupant;
CREATE POLICY rls_contract_occupant_select ON contract_occupant FOR SELECT
USING (
  (SELECT is_org_admin())
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

DROP POLICY IF EXISTS rls_contract_occupant_modify ON contract_occupant;
CREATE POLICY rls_contract_occupant_modify ON contract_occupant FOR ALL
  USING (
    contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );


-- ============================================================================
-- Table: contract_service_price
-- ============================================================================
DROP POLICY IF EXISTS rls_contract_service_price_select ON contract_service_price;
CREATE POLICY rls_contract_service_price_select ON contract_service_price FOR SELECT
USING (
  (SELECT is_org_admin())
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_contract_service_price_modify ON contract_service_price;
CREATE POLICY rls_contract_service_price_modify ON contract_service_price FOR ALL
USING (
  (SELECT is_manager())
  AND contract_id IN (
    SELECT id FROM contract
    WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
)
WITH CHECK (
  (SELECT is_manager())
  AND contract_id IN (
    SELECT id FROM contract
    WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);


-- ============================================================================
-- Table: contract_request
-- ============================================================================
DROP POLICY IF EXISTS rls_contract_request_select ON contract_request;
CREATE POLICY rls_contract_request_select ON contract_request FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR created_by = (SELECT get_current_user_id())
);

DROP POLICY IF EXISTS rls_contract_request_insert ON contract_request;
CREATE POLICY rls_contract_request_insert ON contract_request FOR INSERT
  WITH CHECK (
    created_by = (SELECT get_current_user_id())
    OR building_id IN (SELECT building_id FROM get_manager_building_ids())
  );

DROP POLICY IF EXISTS rls_contract_request_update ON contract_request;
CREATE POLICY rls_contract_request_update ON contract_request FOR UPDATE
  USING (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  WITH CHECK (
    building_id IN (SELECT building_id FROM get_manager_building_ids())
  );


-- ============================================================================
-- Table: deposit
-- ============================================================================
DROP POLICY IF EXISTS rls_deposit_select ON deposit;
CREATE POLICY rls_deposit_select ON deposit FOR SELECT USING (
  (SELECT is_org_admin())
  OR contract_id IN (
    SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_deposit_insert ON deposit;
CREATE POLICY rls_deposit_insert ON deposit FOR INSERT
  WITH CHECK (
    (SELECT is_manager())
    AND contract_id IN (
      SELECT id FROM contract
      WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

DROP POLICY IF EXISTS rls_deposit_update ON deposit;
CREATE POLICY rls_deposit_update ON deposit FOR UPDATE
  USING (
    (
      (SELECT is_manager())
      AND contract_id IN (
        SELECT id FROM contract
        WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
      )
    )
    OR (
      status IN ('PENDING_APPROVAL', 'APPROVED_PENDING_PAYOUT', 'DISPUTED')
      AND contract_id IN (
        SELECT c.id FROM contract c
        WHERE ((SELECT is_owner()) AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))
           OR ((SELECT is_org_admin()) AND NOT building_has_active_owner(c.building_id))
      )
    )
  )
  WITH CHECK (
    (
      (SELECT is_manager())
      AND contract_id IN (
        SELECT id FROM contract
        WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
      )
    )
    OR (
      status IN (
        'SETTLEMENT_DRAFT',
        'PENDING_APPROVAL',
        'APPROVED_PENDING_PAYOUT',
        'PARTIALLY_REFUNDED',
        'REFUNDED',
        'DEDUCTED_FULL',
        'RETURNED'
      )
      AND contract_id IN (
        SELECT c.id FROM contract c
        WHERE ((SELECT is_owner()) AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))
           OR ((SELECT is_org_admin()) AND NOT building_has_active_owner(c.building_id))
      )
    )
  );

DROP POLICY IF EXISTS rls_deposit_delete ON deposit;
CREATE POLICY rls_deposit_delete ON deposit FOR DELETE
  USING ((SELECT is_org_admin()));


-- ============================================================================
-- Table: deposit_transaction
-- ============================================================================
DROP POLICY IF EXISTS rls_deposit_txn_select ON deposit_transaction;
CREATE POLICY rls_deposit_txn_select ON deposit_transaction FOR SELECT USING (
  (SELECT is_org_admin())
  OR deposit_id IN (SELECT id FROM deposit)
);

DROP POLICY IF EXISTS rls_deposit_txn_insert ON deposit_transaction;
CREATE POLICY rls_deposit_txn_insert ON deposit_transaction FOR INSERT
  WITH CHECK (
    (
      (SELECT is_manager())
      AND deposit_id IN (
        SELECT d.id FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
      )
    )
    OR (
      type = 'deduct'
      AND deposit_id IN (
        SELECT d.id FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE ((SELECT is_owner()) AND c.building_id IN (SELECT building_id FROM get_owner_building_ids()))
           OR ((SELECT is_org_admin()) AND NOT building_has_active_owner(c.building_id))
      )
    )
  );

DROP POLICY IF EXISTS rls_deposit_txn_update ON deposit_transaction;
CREATE POLICY rls_deposit_txn_update ON deposit_transaction FOR UPDATE
  USING (
    status <> 'APPROVED'
    AND (SELECT is_manager())
    AND deposit_id IN (
      SELECT d.id FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  )
  WITH CHECK (
    (SELECT is_manager())
    AND deposit_id IN (
      SELECT d.id FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );


-- ============================================================================
-- Table: audit_log
-- ============================================================================
DROP POLICY IF EXISTS rls_audit_log_select ON audit_log;
CREATE POLICY rls_audit_log_select ON audit_log FOR SELECT
  USING (
    (SELECT is_org_admin())
    OR actor_id = (SELECT get_current_user_id())
    OR (
      (SELECT is_owner()) AND (
        (entity = 'building' AND entity_id IN (SELECT building_id FROM get_owner_building_ids()))
        OR (entity = 'apartment' AND entity_id IN (SELECT id FROM apartment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'reservation' AND entity_id IN (SELECT id FROM reservation WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'contract' AND entity_id IN (SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'deposit' AND entity_id IN (SELECT d.id FROM deposit d JOIN contract c ON c.id = d.contract_id WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'deposit_transaction' AND entity_id IN (
          SELECT dt.id
          FROM deposit_transaction dt
          JOIN deposit d ON d.id = dt.deposit_id
          JOIN contract c ON c.id = d.contract_id
          WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())
        ))
        OR (entity = 'invoice' AND entity_id IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'invoice_line' AND (
          entity_id IN (SELECT il.id FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id WHERE i.building_id IN (SELECT building_id FROM get_owner_building_ids()))
          OR (before->>'invoice_id')::uuid IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_owner_building_ids()))
        ))
        OR (entity = 'invoice_adjustment' AND entity_id IN (SELECT id FROM invoice_adjustment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'payment' AND entity_id IN (SELECT id FROM payment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'receivable' AND entity_id IN (SELECT id FROM receivable WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'credit_balance' AND entity_id IN (SELECT id FROM credit_balance WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'service_subscription' AND entity_id IN (SELECT id FROM service_subscription WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'service_catalog' AND (
          entity_id IN (SELECT id FROM service_catalog WHERE building_id IN (SELECT building_id FROM get_owner_building_ids()))
          OR entity_id IN (SELECT id FROM service_catalog WHERE building_id IS NULL AND org_id = (SELECT get_current_user_org_id()))
        ))
        OR (entity = 'contract_service_price' AND entity_id IN (
          SELECT csp.id FROM contract_service_price csp JOIN contract c ON c.id = csp.contract_id WHERE c.building_id IN (SELECT building_id FROM get_owner_building_ids())
        ))
        OR (entity = 'meter' AND entity_id IN (SELECT id FROM meter WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
        OR (entity = 'meter_reading' AND entity_id IN (SELECT id FROM meter_reading WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
      )
    )
    OR (
      (SELECT is_manager()) AND (
        (entity = 'building' AND entity_id IN (SELECT building_id FROM get_manager_building_ids()))
        OR (entity = 'apartment' AND entity_id IN (SELECT id FROM apartment WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'reservation' AND entity_id IN (SELECT id FROM reservation WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'contract' AND entity_id IN (SELECT id FROM contract WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'deposit' AND entity_id IN (SELECT d.id FROM deposit d JOIN contract c ON c.id = d.contract_id WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'deposit_transaction' AND entity_id IN (
          SELECT dt.id
          FROM deposit_transaction dt
          JOIN deposit d ON d.id = dt.deposit_id
          JOIN contract c ON c.id = d.contract_id
          WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
        ))
        OR (entity = 'invoice' AND entity_id IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'invoice_line' AND (
          entity_id IN (SELECT il.id FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id WHERE i.building_id IN (SELECT building_id FROM get_manager_building_ids()))
          OR (before->>'invoice_id')::uuid IN (SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids()))
        ))
        OR (entity = 'invoice_adjustment' AND entity_id IN (SELECT id FROM invoice_adjustment WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'payment' AND entity_id IN (SELECT id FROM payment WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'receivable' AND entity_id IN (SELECT id FROM receivable WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'credit_balance' AND entity_id IN (SELECT id FROM credit_balance WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'service_subscription' AND entity_id IN (SELECT id FROM service_subscription WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'service_catalog' AND (
          entity_id IN (SELECT id FROM service_catalog WHERE building_id IN (SELECT building_id FROM get_manager_building_ids()))
          OR entity_id IN (SELECT id FROM service_catalog WHERE building_id IS NULL AND org_id = (SELECT get_current_user_org_id()))
        ))
        OR (entity = 'contract_service_price' AND entity_id IN (
          SELECT csp.id FROM contract_service_price csp JOIN contract c ON c.id = csp.contract_id WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
        ))
        OR (entity = 'meter' AND entity_id IN (SELECT id FROM meter WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
        OR (entity = 'meter_reading' AND entity_id IN (SELECT id FROM meter_reading WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())))
      )
    )
  );

DROP POLICY IF EXISTS rls_audit_log_select_m11_m13 ON audit_log;
CREATE POLICY rls_audit_log_select_m11_m13 ON audit_log FOR SELECT
USING (
  ((SELECT is_owner()) OR (SELECT is_manager()))
  AND (
    (
      entity = 'service_request'
      AND (
        entity_id IN (
          SELECT sr.id FROM service_request sr
          WHERE sr.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        )
        OR entity_id IN (SELECT building_id FROM get_user_assigned_buildings())
      )
    )
    OR (
      entity = 'announcement'
      AND (
        entity_id IN (
          SELECT ann.id FROM announcement ann
          WHERE ann.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        )
        OR entity_id IN (SELECT building_id FROM get_user_assigned_buildings())
      )
    )
    OR (
      entity = 'zalo_group'
      AND (
        entity_id IN (
          SELECT zg.id FROM zalo_group zg
          WHERE zg.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        )
        OR entity_id IN (SELECT building_id FROM get_user_assigned_buildings())
      )
    )
    OR (
      entity = 'notification'
      AND (
        entity_id IN (
          SELECT n.id FROM notification n
          JOIN announcement ann ON ann.id = n.announcement_id
          WHERE ann.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        )
        OR entity_id IN (SELECT building_id FROM get_user_assigned_buildings())
      )
    )
  )
);

DROP POLICY IF EXISTS rls_audit_log_select_m15 ON audit_log;
CREATE POLICY rls_audit_log_select_m15 ON audit_log FOR SELECT
USING (
  ((SELECT is_owner()) OR (SELECT is_manager()))
  AND entity = 'ai_suggestion'
  AND (
    entity_id IN (
      SELECT s.id FROM ai_suggestion s
      WHERE s.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
        AND (NOT (SELECT is_owner()) OR s.task_type IN ('METER_OCR', 'TICKET_TRIAGE'))
    )
    OR entity_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
);

DROP POLICY IF EXISTS rls_audit_log_insert ON audit_log;
CREATE POLICY rls_audit_log_insert ON audit_log FOR INSERT
WITH CHECK (
  actor_id = (SELECT get_current_user_id()) 
  OR actor_id IS NULL
);


-- ============================================================================
-- Table: attachment
-- ============================================================================
DROP POLICY IF EXISTS rls_attachment_select ON attachment;
CREATE POLICY rls_attachment_select ON attachment FOR SELECT
  USING (can_select_attachment(owner_entity, owner_id, uploaded_by));

DROP POLICY IF EXISTS rls_attachment_insert ON attachment;
CREATE POLICY rls_attachment_insert ON attachment FOR INSERT
WITH CHECK (
  (SELECT is_org_admin())
  OR (SELECT is_manager())
  OR uploaded_by = (SELECT get_current_user_id())
);

DROP POLICY IF EXISTS rls_attachment_delete ON attachment;
CREATE POLICY rls_attachment_delete ON attachment FOR DELETE
USING (
  (SELECT is_org_admin())
  OR uploaded_by = (SELECT get_current_user_id())
);


-- ============================================================================
-- Table: announcement
-- ============================================================================
DROP POLICY IF EXISTS rls_announcement_select ON announcement;
CREATE POLICY rls_announcement_select ON announcement FOR SELECT
USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR (
    (SELECT is_resident())
    AND status = 'SENT'
    AND (
      (
        target_scope = 'BUILDING'
        AND EXISTS (
          SELECT 1 FROM contract c
          WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
            AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
            AND c.building_id = announcement.building_id
        )
      )
      OR (
        target_scope = 'FLOOR'
        AND EXISTS (
          SELECT 1 FROM contract c
          JOIN apartment apt ON apt.id = c.apartment_id
          WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
            AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
            AND apt.floor_id = announcement.floor_id
        )
      )
      OR (
        target_scope = 'APARTMENT'
        AND EXISTS (
          SELECT 1 FROM contract c
          WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
            AND c.status IN ('ACTIVE', 'RENEWAL_PENDING', 'TERMINATION_PENDING')
            AND c.apartment_id = announcement.apartment_id
        )
      )
    )
  )
);

DROP POLICY IF EXISTS rls_announcement_insert ON announcement;
CREATE POLICY rls_announcement_insert ON announcement FOR INSERT
WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_announcement_update ON announcement;
CREATE POLICY rls_announcement_update ON announcement FOR UPDATE
USING (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
)
WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_announcement_delete ON announcement;
CREATE POLICY rls_announcement_delete ON announcement FOR DELETE
USING (FALSE);


-- ============================================================================
-- Table: notification
-- ============================================================================
DROP POLICY IF EXISTS rls_notification_select ON notification;
CREATE POLICY rls_notification_select ON notification FOR SELECT
USING (
  (SELECT is_org_admin())
  OR user_id = (SELECT get_current_user_id())
  OR (
    user_id IS NULL
    AND (SELECT get_current_user_id()) IS NOT NULL
    AND org_id = (SELECT get_current_user_org_id())
  )
  OR (
    ((SELECT is_manager()) OR (SELECT is_accountant()))
    AND org_id = (SELECT get_current_user_org_id())
    AND (payload->>'sent_by') = (SELECT get_current_user_id())::text
  )
  OR (
    ((SELECT is_manager()) OR (SELECT is_owner()))
    AND announcement_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM announcement ann
      WHERE ann.id = notification.announcement_id
        AND ann.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
    )
  )
);

DROP POLICY IF EXISTS rls_notification_insert ON notification;
CREATE POLICY rls_notification_insert ON notification FOR INSERT
  WITH CHECK (
    (SELECT is_org_admin())
    OR (
      ((SELECT is_manager()) OR (SELECT is_accountant()))
      AND org_id = (SELECT get_current_user_org_id())
      AND user_id IS NOT NULL
    )
    OR (
      user_id = (SELECT get_current_user_id())
      AND org_id = (SELECT get_current_user_org_id())
    )
  );

DROP POLICY IF EXISTS rls_notification_update ON notification;
CREATE POLICY rls_notification_update ON notification FOR UPDATE
USING (
  (SELECT is_org_admin())
  OR user_id = (SELECT get_current_user_id())
)
WITH CHECK (
  (SELECT is_org_admin())
  OR user_id = (SELECT get_current_user_id())
);

DROP POLICY IF EXISTS rls_notification_delete ON notification;
CREATE POLICY rls_notification_delete ON notification FOR DELETE
USING (
  (SELECT is_org_admin())
  OR user_id = (SELECT get_current_user_id())
);


-- ============================================================================
-- Table: zalo_group
-- ============================================================================
DROP POLICY IF EXISTS rls_zalo_group_select ON zalo_group;
CREATE POLICY rls_zalo_group_select ON zalo_group FOR SELECT
USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
);

DROP POLICY IF EXISTS rls_zalo_group_insert ON zalo_group;
CREATE POLICY rls_zalo_group_insert ON zalo_group FOR INSERT
WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_zalo_group_update ON zalo_group;
CREATE POLICY rls_zalo_group_update ON zalo_group FOR UPDATE
USING (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
)
WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_zalo_group_delete ON zalo_group;
CREATE POLICY rls_zalo_group_delete ON zalo_group FOR DELETE
USING (FALSE);


-- ============================================================================
-- Table: ai_suggestion
-- ============================================================================
DROP POLICY IF EXISTS rls_ai_suggestion_select ON ai_suggestion;
CREATE POLICY rls_ai_suggestion_select ON ai_suggestion FOR SELECT
USING (
  (
    (SELECT is_org_admin())
    AND org_id = (SELECT get_current_user_org_id())
  )
  OR (
    (SELECT is_manager())
    AND org_id = (SELECT get_current_user_org_id())
    AND (
      building_id IN (SELECT building_id FROM get_manager_building_ids())
      OR (building_id IS NULL AND created_by = (SELECT get_current_user_id()))
    )
  )
  OR (
    -- PRD 13.5: OWNER chỉ đọc dữ liệu vận hành tòa sở hữu, bị chặn cứng CCCD_EXTRACT & CONTRACT_EXTRACT
    (SELECT is_owner())
    AND org_id = (SELECT get_current_user_org_id())
    AND building_id IN (SELECT building_id FROM get_owner_building_ids())
    AND task_type IN ('METER_OCR', 'TICKET_TRIAGE')
  )
);

DROP POLICY IF EXISTS rls_ai_suggestion_insert ON ai_suggestion;
CREATE POLICY rls_ai_suggestion_insert ON ai_suggestion FOR INSERT
WITH CHECK (
  (
    (SELECT is_manager())
    AND org_id = (SELECT get_current_user_org_id())
    AND (
      building_id IN (SELECT building_id FROM get_manager_building_ids())
      OR (building_id IS NULL AND task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT'))
    )
  )
  OR (
    (SELECT is_org_admin())
    AND org_id = (SELECT get_current_user_org_id())
    AND task_type = 'CCCD_EXTRACT'
  )
);

DROP POLICY IF EXISTS rls_ai_suggestion_update ON ai_suggestion;
CREATE POLICY rls_ai_suggestion_update ON ai_suggestion FOR UPDATE
USING (
  (
    (SELECT is_manager())
    AND org_id = (SELECT get_current_user_org_id())
    AND (
      building_id IN (SELECT building_id FROM get_manager_building_ids())
      OR (building_id IS NULL AND created_by = (SELECT get_current_user_id()))
    )
  )
  OR (
    (SELECT is_org_admin())
    AND org_id = (SELECT get_current_user_org_id())
    AND task_type = 'CCCD_EXTRACT'
  )
)
WITH CHECK (
  (
    (SELECT is_manager())
    AND org_id = (SELECT get_current_user_org_id())
    AND (
      building_id IN (SELECT building_id FROM get_manager_building_ids())
      OR (building_id IS NULL AND task_type IN ('CCCD_EXTRACT', 'CONTRACT_EXTRACT'))
    )
  )
  OR (
    (SELECT is_org_admin())
    AND org_id = (SELECT get_current_user_org_id())
    AND task_type = 'CCCD_EXTRACT'
  )
);

DROP POLICY IF EXISTS rls_ai_suggestion_delete ON ai_suggestion;
CREATE POLICY rls_ai_suggestion_delete ON ai_suggestion FOR DELETE
USING (FALSE);


-- ============================================================================
-- Table: service_request
-- ============================================================================
DROP POLICY IF EXISTS rls_service_request_select ON service_request;
CREATE POLICY rls_service_request_select ON service_request FOR SELECT
USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR created_by = (SELECT get_current_user_id())
  OR apartment_id IN (
    SELECT c.apartment_id
    FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

DROP POLICY IF EXISTS rls_service_request_insert ON service_request;
CREATE POLICY rls_service_request_insert ON service_request FOR INSERT
WITH CHECK (
  (
    (SELECT is_manager())
    AND building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  OR (
    (SELECT is_resident())
    AND apartment_id IN (
      SELECT c.apartment_id
      FROM contract c
      WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
    )
  )
);

DROP POLICY IF EXISTS rls_service_request_update ON service_request;
CREATE POLICY rls_service_request_update ON service_request FOR UPDATE
USING (
  (
    (SELECT is_manager())
    AND building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  OR (
    (SELECT is_resident())
    AND (
      created_by = (SELECT get_current_user_id())
      OR apartment_id IN (
        SELECT c.apartment_id
        FROM contract c
        WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
      )
    )
  )
)
WITH CHECK (
  (
    (SELECT is_manager())
    AND building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
  OR (
    (SELECT is_resident())
    AND (
      created_by = (SELECT get_current_user_id())
      OR apartment_id IN (
        SELECT c.apartment_id
        FROM contract c
        WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
      )
    )
  )
);

DROP POLICY IF EXISTS rls_service_request_delete ON service_request;
CREATE POLICY rls_service_request_delete ON service_request FOR DELETE
USING (FALSE);


-- ============================================================================
-- Table: meter
-- ============================================================================
DROP POLICY IF EXISTS rls_meter_select ON meter;
CREATE POLICY rls_meter_select ON meter FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR apartment_id IN (
    SELECT c.apartment_id FROM contract c
    WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
  )
);

DROP POLICY IF EXISTS rls_meter_modify ON meter;
CREATE POLICY rls_meter_modify ON meter FOR ALL
USING (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
)
WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);


-- ============================================================================
-- Table: meter_reading
-- ============================================================================
DROP POLICY IF EXISTS rls_meter_reading_select ON meter_reading;
CREATE POLICY rls_meter_reading_select ON meter_reading FOR SELECT USING (
  (SELECT is_org_admin())
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

DROP POLICY IF EXISTS rls_meter_reading_modify ON meter_reading;
CREATE POLICY rls_meter_reading_modify ON meter_reading FOR ALL
USING (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
)
WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);


-- ============================================================================
-- Table: service_catalog
-- ============================================================================
DROP POLICY IF EXISTS rls_service_catalog_select ON service_catalog;
CREATE POLICY rls_service_catalog_select ON service_catalog FOR SELECT USING (
  org_id = (SELECT get_current_user_org_id())
  AND (
    (SELECT is_org_admin())
    OR building_id IS NULL
    OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
    OR building_id IN (
      SELECT c.building_id FROM contract c
      WHERE c.id IN (SELECT contract_id FROM get_resident_contract_ids())
    )
  )
);

DROP POLICY IF EXISTS rls_service_catalog_modify ON service_catalog;
CREATE POLICY rls_service_catalog_modify ON service_catalog FOR ALL
USING (
  (SELECT is_manager())
  AND org_id = (SELECT get_current_user_org_id())
  AND (building_id IS NULL OR building_id IN (SELECT building_id FROM get_manager_building_ids()))
)
WITH CHECK (
  (SELECT is_manager())
  AND org_id = (SELECT get_current_user_org_id())
  AND (building_id IS NULL OR building_id IN (SELECT building_id FROM get_manager_building_ids()))
);


-- ============================================================================
-- Table: service_subscription
-- ============================================================================
DROP POLICY IF EXISTS rls_service_sub_select ON service_subscription;
CREATE POLICY rls_service_sub_select ON service_subscription FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR building_id IN (SELECT building_id FROM get_staff_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR requested_by = (SELECT get_current_user_id())
);

DROP POLICY IF EXISTS rls_service_sub_insert ON service_subscription;
CREATE POLICY rls_service_sub_insert ON service_subscription FOR INSERT WITH CHECK (
  building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR requested_by = (SELECT get_current_user_id())
);

DROP POLICY IF EXISTS rls_service_sub_update ON service_subscription;
CREATE POLICY rls_service_sub_update ON service_subscription FOR UPDATE USING (
  building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
) WITH CHECK (
  building_id IN (SELECT building_id FROM get_manager_building_ids())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_service_sub_delete ON service_subscription;
CREATE POLICY rls_service_sub_delete ON service_subscription FOR DELETE USING (
  building_id IN (SELECT building_id FROM get_manager_building_ids())
  AND status IN ('PENDING_APPROVAL', 'TERMINATED')
);


-- ============================================================================
-- Table: invoice
-- ============================================================================
DROP POLICY IF EXISTS rls_invoice_select ON invoice;
CREATE POLICY rls_invoice_select ON invoice FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR (
    status <> 'DRAFT'
    AND (
      contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
      OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
    )
  )
);

DROP POLICY IF EXISTS rls_invoice_insert ON invoice;
CREATE POLICY rls_invoice_insert ON invoice FOR INSERT WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_invoice_update ON invoice;
CREATE POLICY rls_invoice_update ON invoice FOR UPDATE USING (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
) WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);


-- ============================================================================
-- Table: invoice_line
-- ============================================================================
DROP POLICY IF EXISTS rls_invoice_line_select ON invoice_line;
CREATE POLICY rls_invoice_line_select ON invoice_line FOR SELECT USING (
  (SELECT is_org_admin())
  OR invoice_id IN (SELECT id FROM invoice)
);

DROP POLICY IF EXISTS rls_invoice_line_insert ON invoice_line;
CREATE POLICY rls_invoice_line_insert ON invoice_line FOR INSERT WITH CHECK (
  (SELECT is_manager())
  AND invoice_id IN (
    SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);

DROP POLICY IF EXISTS rls_invoice_line_update ON invoice_line;
CREATE POLICY rls_invoice_line_update ON invoice_line FOR UPDATE USING (
  (SELECT is_manager())
  AND invoice_id IN (
    SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
) WITH CHECK (
  (SELECT is_manager())
  AND invoice_id IN (
    SELECT id FROM invoice WHERE building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);

DROP POLICY IF EXISTS rls_invoice_line_delete ON invoice_line;
CREATE POLICY rls_invoice_line_delete ON invoice_line FOR DELETE USING (
  (SELECT is_manager())
  AND EXISTS (
    SELECT 1 FROM invoice i
    WHERE i.id = invoice_line.invoice_id
      AND i.status = 'DRAFT'
      AND i.building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);


-- ============================================================================
-- Table: invoice_adjustment
-- ============================================================================
DROP POLICY IF EXISTS rls_invoice_adjustment_select ON invoice_adjustment;
CREATE POLICY rls_invoice_adjustment_select ON invoice_adjustment FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR (
    status = 'APPROVED'
    AND invoice_id IN (
      SELECT id FROM invoice
      WHERE contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
         OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
    )
  )
);

DROP POLICY IF EXISTS rls_invoice_adjustment_insert ON invoice_adjustment;
CREATE POLICY rls_invoice_adjustment_insert ON invoice_adjustment FOR INSERT WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_invoice_adjustment_update ON invoice_adjustment;
CREATE POLICY rls_invoice_adjustment_update ON invoice_adjustment FOR UPDATE USING (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
) WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);


-- ============================================================================
-- Table: credit_balance
-- ============================================================================
DROP POLICY IF EXISTS rls_credit_balance_select ON credit_balance;
CREATE POLICY rls_credit_balance_select ON credit_balance FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

DROP POLICY IF EXISTS rls_credit_balance_insert ON credit_balance;
CREATE POLICY rls_credit_balance_insert ON credit_balance FOR INSERT WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_credit_balance_update ON credit_balance;
CREATE POLICY rls_credit_balance_update ON credit_balance FOR UPDATE USING (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
) WITH CHECK (
  (SELECT is_manager())
  AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);


-- ============================================================================
-- Table: late_fee_accrual_tracker
-- ============================================================================
DROP POLICY IF EXISTS rls_lf_tracker_select ON late_fee_accrual_tracker;
CREATE POLICY rls_lf_tracker_select ON late_fee_accrual_tracker FOR SELECT USING (
  (SELECT is_org_admin())
  OR contract_id IN (
    SELECT c.id FROM contract c
    WHERE c.building_id IN (SELECT building_id FROM get_user_assigned_buildings())
  )
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
);

DROP POLICY IF EXISTS rls_lf_tracker_update ON late_fee_accrual_tracker;
CREATE POLICY rls_lf_tracker_update ON late_fee_accrual_tracker FOR UPDATE USING (
  (SELECT is_manager())
  AND contract_id IN (
    SELECT c.id FROM contract c
    WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
) WITH CHECK (
  (SELECT is_manager())
  AND contract_id IN (
    SELECT c.id FROM contract c
    WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
  )
);


-- ============================================================================
-- Table: payment
-- ============================================================================
DROP POLICY IF EXISTS rls_payment_select ON payment;
CREATE POLICY rls_payment_select ON payment FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR reported_by = (SELECT get_current_user_id())
);

DROP POLICY IF EXISTS rls_payment_insert ON payment;
CREATE POLICY rls_payment_insert ON payment FOR INSERT WITH CHECK (
  ((SELECT is_manager()) AND building_id IN (SELECT building_id FROM get_manager_building_ids()))
  OR (
    (SELECT is_resident())
    AND reported_by = (SELECT get_current_user_id())
    AND invoice_id IN (
      SELECT id FROM invoice
      WHERE status <> 'DRAFT'
        AND (
          contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
          OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
        )
    )
  )
);

DROP POLICY IF EXISTS rls_payment_update ON payment;
CREATE POLICY rls_payment_update ON payment FOR UPDATE USING (
  (SELECT is_manager()) AND building_id IN (SELECT building_id FROM get_manager_building_ids())
) WITH CHECK (
  (SELECT is_manager()) AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);


-- ============================================================================
-- Table: receivable
-- ============================================================================
DROP POLICY IF EXISTS rls_receivable_select ON receivable;
CREATE POLICY rls_receivable_select ON receivable FOR SELECT USING (
  (SELECT is_org_admin())
  OR building_id IN (SELECT building_id FROM get_non_staff_assigned_buildings())
  OR contract_id IN (SELECT contract_id FROM get_resident_contract_ids())
  OR tenant_id IN (SELECT tenant_id FROM get_resident_tenant_ids())
);

DROP POLICY IF EXISTS rls_receivable_insert ON receivable;
CREATE POLICY rls_receivable_insert ON receivable FOR INSERT WITH CHECK (
  (SELECT is_manager()) AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);

DROP POLICY IF EXISTS rls_receivable_update ON receivable;
CREATE POLICY rls_receivable_update ON receivable FOR UPDATE USING (
  (SELECT is_manager()) AND building_id IN (SELECT building_id FROM get_manager_building_ids())
) WITH CHECK (
  (SELECT is_manager()) AND building_id IN (SELECT building_id FROM get_manager_building_ids())
);


-- ============================================================================
-- Table: system_setting
-- ============================================================================
DROP POLICY IF EXISTS rls_system_setting_select ON system_setting;
CREATE POLICY rls_system_setting_select ON system_setting FOR SELECT USING (
  org_id = (SELECT get_current_user_org_id())
  OR (SELECT is_org_admin())
);

DROP POLICY IF EXISTS rls_system_setting_modify ON system_setting;
CREATE POLICY rls_system_setting_modify ON system_setting FOR ALL
USING ((SELECT is_org_admin()))
WITH CHECK ((SELECT is_org_admin()));


-- ============================================================================
-- Table: cron_job_run
-- ============================================================================
DROP POLICY IF EXISTS rls_cron_job_run_select ON cron_job_run;
CREATE POLICY rls_cron_job_run_select ON cron_job_run FOR SELECT
  USING ((SELECT is_org_admin()));

