-- 001_extensions.sql
-- Kích hoạt extension cho UUID và btree_gist (dùng cho loại trừ trùng lịch hợp đồng)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
