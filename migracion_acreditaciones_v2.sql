-- Migración v2 de ACREDITACIONES (bandeja del revisor).
--
-- Añade lo necesario para revisar mejor las solicitudes:
--   * estado "solicitada" (pedida al club, a la espera de su respuesta) y
--     "cancelada" (partido suspendido o la persona ya no va), además de los
--     de siempre: pendiente / aprobada / rechazada. "estado" es texto libre,
--     no hace falta tocar la columna.
--   * solicitada_at / solicitada_por: cuándo y quién la pidió al club.
--   * fecha_partido (AAAA-MM-DD): para ordenar y avisar de las más urgentes.
--   * asignado_a: quién del equipo se encarga de la solicitud.
--
--   wrangler d1 execute elotrofutbol --remote --file=./migracion_acreditaciones_v2.sql
--
-- (ALTER TABLE ... ADD COLUMN no admite IF NOT EXISTS en D1: ejecútala una sola vez.)
ALTER TABLE acreditaciones ADD COLUMN solicitada_at TEXT;
ALTER TABLE acreditaciones ADD COLUMN solicitada_por TEXT;
ALTER TABLE acreditaciones ADD COLUMN fecha_partido TEXT;
ALTER TABLE acreditaciones ADD COLUMN asignado_a TEXT;
CREATE INDEX IF NOT EXISTS idx_acreditaciones_fecha_partido ON acreditaciones(fecha_partido);
