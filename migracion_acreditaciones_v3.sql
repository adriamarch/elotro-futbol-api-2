-- Migración v3 de ACREDITACIONES: índice para el tiempo real del panel.
--
-- El panel consulta cada pocos segundos una "huella" de la bandeja (GET /api/acreditaciones/huella:
-- número de solicitudes, último id y último updated_at). Con este índice el MAX(updated_at) es
-- instantáneo y no hay que recorrer la tabla en cada consulta.
--
--   wrangler d1 execute elotrofutbol --remote --file=./migracion_acreditaciones_v3.sql
--
-- Es opcional (sin ella todo funciona, solo gasta algo más de lectura) y se puede ejecutar varias veces.
CREATE INDEX IF NOT EXISTS idx_acreditaciones_updated ON acreditaciones(updated_at);
