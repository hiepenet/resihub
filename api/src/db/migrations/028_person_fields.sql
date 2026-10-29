-- 028_person_fields.sql
-- Module M04: Bổ sung trường pháp lý cho hồ sơ cư dân (FR-011: address, nationality, avatar_url)

ALTER TABLE person ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE person ADD COLUMN IF NOT EXISTS nationality TEXT DEFAULT 'Việt Nam';
ALTER TABLE person ADD COLUMN IF NOT EXISTS avatar_url TEXT;

UPDATE person
SET nationality = COALESCE(nationality, 'Việt Nam'),
    address = COALESCE(address, 'Hà Nội, Việt Nam')
WHERE nationality IS NULL OR address IS NULL;

