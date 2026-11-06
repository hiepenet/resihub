-- ============================================================================
-- Consolidated Migration: 006_triggers.sql
-- Description: System triggers for immutability, role cleanup, and status normalization
-- ============================================================================

-- 1. Audit Log Immutability (FR-007)
CREATE OR REPLACE FUNCTION prevent_audit_log_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Audit log is append-only and cannot be updated or deleted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_no_update_delete ON audit_log;
CREATE TRIGGER trg_audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION prevent_audit_log_modification();

-- 2. Building Creator Auto-assignment to Manager Role (FR-029)
CREATE OR REPLACE FUNCTION auto_assign_creator_manager_to_building()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id UUID;
  v_manager_role_id UUID;
BEGIN
  v_user_id := get_current_user_id();

  -- Chỉ tự động gán khi người tạo là MANAGER thực thụ (không áp dụng cho SYS_ADMIN)
  IF v_user_id IS NOT NULL AND is_manager() AND NOT is_org_admin() THEN
    SELECT r.id INTO v_manager_role_id
    FROM role r
    WHERE r.code = 'MANAGER'
      AND (r.org_id = NEW.org_id OR r.org_id IS NULL)
    ORDER BY (r.org_id IS NULL) ASC
    LIMIT 1;

    IF v_manager_role_id IS NOT NULL THEN
      INSERT INTO user_role (user_id, role_id, building_id)
      VALUES (v_user_id, v_manager_role_id, NEW.id)
      ON CONFLICT (user_id, role_id, building_id) DO NOTHING;

      INSERT INTO audit_log (actor_id, action, entity, entity_id, before, after)
      VALUES (
        v_user_id,
        'ASSIGN_BUILDING_SCOPE',
        'user_role',
        NEW.id,
        NULL,
        jsonb_build_object(
          'user_id', v_user_id,
          'role_code', 'MANAGER',
          'building_id', NEW.id,
          'building_code', NEW.code,
          'source', 'auto_assign_on_building_create'
        )
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET row_security = off;

DROP TRIGGER IF EXISTS trg_auto_assign_creator_manager_to_building ON building;
CREATE TRIGGER trg_auto_assign_creator_manager_to_building
  AFTER INSERT ON building
  FOR EACH ROW
  EXECUTE FUNCTION auto_assign_creator_manager_to_building();

-- 3. Building Deletion Cleanup for User Roles (FR-029)
CREATE OR REPLACE FUNCTION cleanup_user_roles_on_building_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM user_role WHERE building_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET row_security = off;

DROP TRIGGER IF EXISTS trg_cleanup_user_roles_on_building_delete ON building;
CREATE TRIGGER trg_cleanup_user_roles_on_building_delete
  AFTER DELETE ON building
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_user_roles_on_building_delete();

-- 4. Deposit Transaction Immutability (FR-037)
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
  FOR EACH ROW
  EXECUTE FUNCTION trg_deposit_txn_no_modify();

-- 5. Service Subscription Status Normalization & Auto Price Lock (FR-048)
CREATE OR REPLACE FUNCTION trg_normalize_legacy_subscription_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'CANCELLED' THEN
    NEW.status := 'TERMINATED';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.is_price_locked IS NULL THEN
    NEW.is_price_locked := CASE
      WHEN NEW.status = 'TERMINATED' AND NEW.end_date IS NOT NULL THEN TRUE
      ELSE COALESCE((SELECT sc.unit_price <> NEW.unit_price FROM service_catalog sc WHERE sc.id = NEW.service_id), FALSE)
    END;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normalize_subscription_status ON service_subscription;
CREATE TRIGGER trg_normalize_subscription_status
  BEFORE INSERT OR UPDATE ON service_subscription
  FOR EACH ROW
  EXECUTE FUNCTION trg_normalize_legacy_subscription_status();

-- 6. Invoice Status Normalization (FR-048)
CREATE OR REPLACE FUNCTION trg_normalize_legacy_invoice_status()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'CANCELLED' THEN
    NEW.status := 'VOID';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_normalize_invoice_status ON invoice;
CREATE TRIGGER trg_normalize_invoice_status
  BEFORE INSERT OR UPDATE OF status ON invoice
  FOR EACH ROW
  EXECUTE FUNCTION trg_normalize_legacy_invoice_status();
