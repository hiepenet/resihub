-- 008_indexes.sql
-- Nhóm 7: Indexes hiệu năng

CREATE INDEX IF NOT EXISTS idx_apartment_building_status ON apartment(building_id, status);
CREATE INDEX IF NOT EXISTS idx_contract_apartment_status ON contract(apartment_id, status);
CREATE INDEX IF NOT EXISTS idx_contract_status_dates ON contract(status, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_deposit_contract ON deposit(contract_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_person_org_phone ON person(org_id, phone);
CREATE INDEX IF NOT EXISTS idx_floor_building ON floor(building_id, level);
CREATE INDEX IF NOT EXISTS idx_user_role_user ON user_role(user_id);
CREATE INDEX IF NOT EXISTS idx_reservation_apartment ON reservation(apartment_id, status);
