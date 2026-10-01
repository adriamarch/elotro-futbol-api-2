-- Migración 032: marca "fuera de calendario" en articles (horario de
-- publicación). Mismo esquema que worker/migracion_horario_publicacion.sql
-- en D1, para que ambas bases coincidan y el sync no pierda la columna.
BEGIN;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS fuera_calendario INTEGER NOT NULL DEFAULT 0;
COMMIT;
