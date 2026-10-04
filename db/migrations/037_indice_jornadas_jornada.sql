-- Igual que worker/migracion_indice_jornadas_jornada.sql (D1): búsqueda de
-- jornadas_calendario por número de jornada.
CREATE INDEX IF NOT EXISTS idx_jornadas_calendario_jornada
  ON jornadas_calendario(competicion, grupo, jornada);
