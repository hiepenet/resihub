-- 029_manager_create_building.sql
-- Mở quyền khởi tạo Tòa nhà (C trong CRU) cho vai trò MANAGER theo PRD v2.0:
--   - Mục 6.2 (dòng 186): Tòa/khu/tầng/căn hộ -> MANAGER = CRU, SYS_ADMIN = CRUD, OWNER = R
--   - FR-007 (dòng 365): Khởi tạo tòa nhà, khu, tầng -> Actor chính: MANAGER
--   - US-008 (dòng 625) & Mục 14.3 (dòng 972): POST /buildings -> MANAGER+
--
-- Bảo mật chống leo thang đặc quyền (Anti-Privilege-Escalation):
--   1. Giữ nguyên rls_user_role_insert khóa chặt (MANAGER KHÔNG ĐƯỢC tự chèn user_role trực tiếp cho bản thân,
--      không thể tự gán mình vào tòa nhà có sẵn của người khác hay nâng quyền lên OWNER/SYS_ADMIN).
--   2. Sử dụng trigger SECURITY DEFINER gắn chặt sự kiện INSERT trên bảng building:
--      Khi chính MANAGER tạo một tòa nhà mới trong cùng org_id, hệ thống tự động gán duy nhất
--      vai trò MANAGER trên đúng building.id vừa khởi tạo + ghi nhận audit_log.
--   3. Quyền Xóa tòa nhà (DELETE) vẫn chỉ dành riêng cho SYS_ADMIN (is_org_admin()).

-- ============================================================================
-- 1. CẬP NHẬT RLS POLICY INSERT TRÊN BẢNG BUILDING
-- ============================================================================
DROP POLICY IF EXISTS rls_building_insert ON building;

CREATE POLICY rls_building_insert ON building FOR INSERT
  WITH CHECK (
    is_org_admin()
    OR (
      is_manager()
      AND org_id = get_current_user_org_id()
    )
  );

-- Đảm bảo policy DELETE trên building vẫn chỉ dành cho SYS_ADMIN (CRUD vs CRU)
DROP POLICY IF EXISTS rls_building_delete ON building;

CREATE POLICY rls_building_delete ON building FOR DELETE
  USING (is_org_admin());

-- ============================================================================
-- 2. TRIGGER TỰ ĐỘNG GÁN SCOPE TÒA NHÀ VỪA TẠO CHO MANAGER KHỞI TẠO
-- ============================================================================
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

-- ============================================================================
-- 3. TRIGGER DỌN SẠCH USER_ROLE KHI TÒA NHÀ TRỐNG ĐƯỢC SYS_ADMIN XÓA
-- ============================================================================
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
