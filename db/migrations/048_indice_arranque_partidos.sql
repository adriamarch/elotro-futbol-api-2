-- Migración 048: índices compuestos para el arranque automático de partidos.
-- Mismo cambio que worker/migracion_indice_arranque_partidos.sql en D1.
BEGIN;
CREATE INDEX IF NOT EXISTS idx_results_estado_fecha_partido
  ON results(estado, fecha_partido);
CREATE INDEX IF NOT EXISTS idx_results_estado_fecha_retrasado
  ON results(estado, fecha_partido_retrasado);
COMMIT;
