-- 002_organization_users.sql
-- Nhóm 1: Tổ chức & Người dùng (M01)

CREATE TABLE IF NOT EXISTS organization (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  tax_code        TEXT,
  settings        JSONB DEFAULT '{}',
  payment_account JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS owner (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organization(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organization(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('org', 'building')),
  UNIQUE (org_id, code)
);

CREATE TABLE IF NOT EXISTS person (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES organization(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  dob         DATE,
  id_number   TEXT,
  id_images   TEXT[] DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (org_id, phone)
);

CREATE TABLE IF NOT EXISTS app_user (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     UUID REFERENCES person(id) ON DELETE CASCADE,
  auth_uid      TEXT UNIQUE,
  password_hash TEXT,
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_role (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES app_user(id) ON DELETE CASCADE,
  role_id     UUID REFERENCES role(id) ON DELETE CASCADE,
  building_id UUID,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, role_id, building_id)
);
