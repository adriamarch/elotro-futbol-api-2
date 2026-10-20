-- Migración 067: bandeja de acreditaciones v2 (estados solicitada/cancelada, fecha del partido, asignación).
-- Mismo esquema que worker/migracion_acreditaciones_v2.sql en D1. Sin estas columnas
-- sync/incremental.mjs cortaría la sincronización de "acreditaciones" al detectarlas en D1.

BEGIN;

ALTER TABLE acreditaciones ADD COLUMN IF NOT EXISTS solicitada_at TEXT;
ALTER TABLE acreditaciones ADD COLUMN IF NOT EXISTS solicitada_por TEXT;
ALTER TABLE acreditaciones ADD COLUMN IF NOT EXISTS fecha_partido TEXT;
ALTER TABLE acreditaciones ADD COLUMN IF NOT EXISTS asignado_a TEXT;
CREATE INDEX IF NOT EXISTS idx_acreditaciones_fecha_partido ON acreditaciones(fecha_partido);

COMMIT;
