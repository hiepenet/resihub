-- 014_contract_exclusion.sql
-- A4: chặn chồng lấn kỳ thuê ở tầng DB (PRD 13.3), btree_gist đã bật ở 001.
-- Constraint chỉ ghim bản ghi đã hiệu lực (ACTIVE/RENEWAL_PENDING);
-- DRAFT/PENDING_APPROVAL bị chặn ở tầng app (overlap check trong POST/PATCH contracts).
ALTER TABLE contract DROP CONSTRAINT IF EXISTS contract_no_overlap;
ALTER TABLE contract ADD CONSTRAINT contract_no_overlap
  EXCLUDE USING gist (
    apartment_id WITH =,
    daterange(start_date, end_date, '[)') WITH &&
  )
  WHERE (status IN ('ACTIVE','RENEWAL_PENDING'));
