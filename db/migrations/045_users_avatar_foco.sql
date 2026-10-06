-- Migración 045: avatar_foco en users (encuadre "X% Y%" de la foto de perfil).
-- Mismo cambio que worker/migracion_users_avatar_foco.sql en D1, para que el
-- esquema de ambas bases coincida. Sin esta columna, tras un failover a
-- Railway el encuadre de los avatares de autor volvería a salir centrado.
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_foco TEXT;
