-- 020_performance_optimization.sql
-- Tối ưu hóa hiệu năng Database & Index cho Dashboard, Cư Dân, Hợp Đồng, Sổ Cọc

-- 1. Tắt JIT ở cấp cơ sở dữ liệu (Tránh JIT compile overhead 14s+ trên các truy vấn phức tạp của RLS)
ALTER DATABASE resihub SET jit = off;

-- 2. Bổ sung các chỉ mục Foreign Key & Điều kiện JOIN cốt lõi
CREATE INDEX IF NOT EXISTS idx_contract_building_id ON contract(building_id);
CREATE INDEX IF NOT EXISTS idx_contract_primary_tenant_id ON contract(primary_tenant_id);
CREATE INDEX IF NOT EXISTS idx_contract_created_at ON contract(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_person_id ON tenant(person_id);
CREATE INDEX IF NOT EXISTS idx_tenant_org_id ON tenant(org_id);
CREATE INDEX IF NOT EXISTS idx_tenant_created_at ON tenant(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deposit_contract_id ON deposit(contract_id);
CREATE INDEX IF NOT EXISTS idx_deposit_created_at ON deposit(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_role_user_building ON user_role(user_id, building_id);
CREATE INDEX IF NOT EXISTS idx_reservation_phone ON reservation(phone);
CREATE INDEX IF NOT EXISTS idx_reservation_building_status ON reservation(building_id, status);

CREATE INDEX IF NOT EXISTS idx_building_org_id ON building(org_id);
CREATE INDEX IF NOT EXISTS idx_apartment_building_id ON apartment(building_id);
