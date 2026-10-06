-- Migración: índices compuestos para el arranque automático de partidos
-- (iniciarPartidosProgramadosCuyaHoraHaLlegado, cron de cada minuto).
--
-- Esa función lanzaba 2 consultas por minuto (estado 'programado' y
-- 'retrasado') que leían TODOS los partidos programados de la temporada.
-- Ahora la consulta añade `fecha_partido <= ?` (o fecha_partido_retrasado),
-- y estos índices (estado + fecha) hacen que solo se lean los partidos ya
-- vencidos (normalmente ninguno). Solo añade índices; no toca datos.
--
-- Nota: se usan índices compuestos y no parciales porque, sin ANALYZE,
-- SQLite elegía idx_results_estado en vez del parcial; con el compuesto
-- usa estado y rango de fecha a la vez.
--
-- Ejecución con wrangler:
--   wrangler d1 execute elotrofutbol --remote --file=migracion_indice_arranque_partidos.sql

CREATE INDEX IF NOT EXISTS idx_results_estado_fecha_partido
  ON results(estado, fecha_partido);

CREATE INDEX IF NOT EXISTS idx_results_estado_fecha_retrasado
  ON results(estado, fecha_partido_retrasado);
