-- 038_audit_log_deposit_owner_scope.sql
-- Mở rộng rls_audit_log_select cho OWNER bao phủ đầy đủ nghiệp vụ thu/hoàn cọc:
-- deposit, deposit_transaction (thu bổ sung / kết chuyển) và reservation (đặt/hoàn/mất cọc giữ chỗ).

BEGIN;

DROP POLICY IF EXISTS rls_audit_log_select ON audit_log;
CREATE POLICY rls_audit_log_select ON audit_log FOR SELECT
  USING (
    is_org_admin()
    OR actor_id = get_current_user_id()
    OR (
      is_owner() AND (
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
        OR (entity = 'payment' AND entity_id IN (SELECT id FROM payment WHERE building_id IN (SELECT building_id FROM get_owner_building_ids())))
      )
    )
  );

COMMIT;

