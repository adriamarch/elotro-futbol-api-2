-- Migración 030: columnas match_events.var_motivo y match_events.var_decision.
--
-- Réplica en PostgreSQL de worker/migracion_var_motivo_decision.sql (D1).
-- Guardan los datos extra de la "Revisión VAR" (tipo "var") del panel de
-- Minuto a Minuto: jugada revisada (var_motivo) y estado de la revisión
-- (var_decision). NULL en cualquier otro tipo de evento.
--
-- Sin estas columnas, sync/incremental.mjs detecta columnas de D1 sin
-- equivalente en PG y corta la tabla match_events (ver migración 029).
-- IF NOT EXISTS: se puede ejecutar más de una vez sin error.

ALTER TABLE match_events ADD COLUMN IF NOT EXISTS var_motivo TEXT;
ALTER TABLE match_events ADD COLUMN IF NOT EXISTS var_decision TEXT;
