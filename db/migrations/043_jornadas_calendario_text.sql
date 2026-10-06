-- Migración 043: jornadas_calendario con created_at/updated_at como TEXT.
-- En D1 son TEXT ("YYYY-MM-DD HH:MM:SS"); en PG eran TIMESTAMPTZ (migración 008),
-- así que el comparador veía las 400 filas "distintas" solo por el formato.
-- Se alinea con el resto de tablas replicadas (TEXT). El sync (authoritative)
-- vuelve a copiar los valores exactos de D1 en la siguiente pasada.
BEGIN;

ALTER TABLE jornadas_calendario ALTER COLUMN created_at DROP DEFAULT;
ALTER TABLE jornadas_calendario ALTER COLUMN updated_at DROP DEFAULT;

ALTER TABLE jornadas_calendario
  ALTER COLUMN created_at TYPE TEXT USING to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  ALTER COLUMN updated_at TYPE TEXT USING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');

ALTER TABLE jornadas_calendario ALTER COLUMN created_at SET DEFAULT (CURRENT_TIMESTAMP);
ALTER TABLE jornadas_calendario ALTER COLUMN updated_at SET DEFAULT (CURRENT_TIMESTAMP);

COMMIT;
