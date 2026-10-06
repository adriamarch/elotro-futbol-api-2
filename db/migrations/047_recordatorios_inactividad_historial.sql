-- Migración 047: historial de avisos de inactividad (JSON por aviso enviado).
-- Mismo cambio que worker/migracion_recordatorios_inactividad_historial.sql en D1.
BEGIN;
ALTER TABLE recordatorios_inactividad ADD COLUMN IF NOT EXISTS historial_avisos TEXT;
COMMIT;
