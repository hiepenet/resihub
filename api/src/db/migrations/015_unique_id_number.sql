-- 015_unique_id_number.sql
-- A7: CCCD/hộ chiếu duy nhất trong phạm vi một tổ chức (FR-021).
-- Partial index: chỉ ghim bản ghi có giấy tờ; '' coi như chưa có.
CREATE UNIQUE INDEX IF NOT EXISTS uq_person_id_number_per_org
  ON person (org_id, id_number)
  WHERE id_number IS NOT NULL AND id_number <> '';
