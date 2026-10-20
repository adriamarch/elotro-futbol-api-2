-- Migración 068: índice por updated_at para la "huella" del tiempo real de la bandeja de acreditaciones.
-- Mismo índice que worker/migracion_acreditaciones_v3.sql en D1. Opcional; se puede ejecutar varias veces.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_acreditaciones_updated ON acreditaciones(updated_at);

COMMIT;
