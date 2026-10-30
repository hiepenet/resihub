-- 037_deposit_txn_immutable.sql
-- Đảm bảo tính bất biến của bút toán cọc (deposit_transaction) sau khi đã được phê duyệt (APPROVED)
-- theo Mục 3.3 bao-cao-luong-chuc-nang.md & PRD v2.0.

BEGIN;

CREATE OR REPLACE FUNCTION trg_deposit_txn_no_modify()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'APPROVED' THEN
    IF current_user <> 'resihub_app' AND current_setting('app.allow_test_cleanup', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Bút toán cọc (deposit_transaction) đã duyệt là bất biến, không được phép sửa hoặc xóa.'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deposit_txn_immutable ON deposit_transaction;
CREATE TRIGGER trg_deposit_txn_immutable
  BEFORE UPDATE OR DELETE ON deposit_transaction
  FOR EACH ROW EXECUTE FUNCTION trg_deposit_txn_no_modify();

-- Siết RLS UPDATE trên deposit_transaction: không cho phép sửa dòng đã APPROVED
DROP POLICY IF EXISTS rls_deposit_txn_update ON deposit_transaction;
CREATE POLICY rls_deposit_txn_update ON deposit_transaction
  FOR UPDATE
  USING (
    status <> 'APPROVED'
    AND (
      is_org_admin()
      OR deposit_id IN (
        SELECT d.id
        FROM deposit d
        JOIN contract c ON c.id = d.contract_id
        WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
      )
    )
  )
  WITH CHECK (
    is_org_admin()
    OR deposit_id IN (
      SELECT d.id
      FROM deposit d
      JOIN contract c ON c.id = d.contract_id
      WHERE c.building_id IN (SELECT building_id FROM get_manager_building_ids())
    )
  );

COMMIT;
