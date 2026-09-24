-- Migración 026: tabla avisos_desatendidos_cola (mismo esquema que
-- worker/migracion_avisos_desatendidos_cola.sql en D1; ver ese fichero
-- para el porqué completo).
--
-- IMPORTANTE: NO añadir esta tabla a sync/tables.mjs. El sincronizador
-- D1 -> PostgreSQL borraría en cada pasada las filas que no existan en
-- D1, y cada backend debe llevar su propia cola independiente.
--
-- encolado_ms es BIGINT (no INTEGER): un epoch en milisegundos (~1.7e12)
-- desborda el INTEGER de 32 bits de Postgres. En SQLite/D1 "INTEGER"
-- ya es de 64 bits, por eso allí se declara igual sin problema.
BEGIN;

CREATE TABLE IF NOT EXISTS avisos_desatendidos_cola (
  resultado_id INTEGER PRIMARY KEY,
  partido TEXT NOT NULL,
  jornada INTEGER,
  redactor TEXT,
  motivo_corto TEXT NOT NULL,
  encolado_ms BIGINT NOT NULL
);

COMMIT;
