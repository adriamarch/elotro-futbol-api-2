-- Migración 055: verificación en dos pasos (TOTP) obligatoria para admins.
-- Mismas columnas que worker/migracion_2fa_admins.sql en D1.
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_activo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_ultimo_paso BIGINT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery TEXT;

COMMIT;
