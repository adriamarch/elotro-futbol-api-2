-- Migración: verificación en dos pasos (TOTP) obligatoria para administradores.
-- SOLO ejecutar si la base de datos YA existía antes de este cambio.
-- Si es una base de datos nueva, ignora este archivo: schema.sql ya incluye
-- las columnas.
--
--   totp_secret       secreto TOTP CIFRADO (AES-GCM, clave derivada de JWT_SECRET)
--   totp_activo       1 cuando la persona ya ha confirmado su app de autenticación
--   totp_ultimo_paso  último intervalo de 30 s aceptado (impide reutilizar un código)
--   totp_recovery     JSON con los HASHES de los códigos de recuperación sin usar
--
-- Ejemplo de ejecución con wrangler:
--   wrangler d1 execute elotrofutbol --remote --file=./migracion_2fa_admins.sql

ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_activo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_ultimo_paso INTEGER;
ALTER TABLE users ADD COLUMN totp_recovery TEXT;
