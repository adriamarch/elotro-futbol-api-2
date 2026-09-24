-- Migración 025: preferencia de fecha de publicación del REDACTOR
-- (equivalente a worker/migracion_fecha_preferencia_publicacion.sql en
-- D1, aplicada aquí a Postgres para que el esquema de ambas bases
-- coincida; ver esa migración para la explicación completa).
--
-- Son fechas simples (TEXT, "YYYY-MM-DD", mismo patrón que el resto de
-- columnas de fecha de este esquema), puramente informativas: no se
-- comparan con CURRENT_TIMESTAMP en ninguna consulta (a diferencia de
-- programado_para), así que no hace falta tocar sql-compat.js.
--
-- Sin esta migración, sync/incremental.mjs (articles sincroniza
-- columnas dinámicamente, ver tables.mjs) detectaría
-- fecha_preferencia_desde/fecha_preferencia_hasta como columnas sin
-- equivalente en PG y cortaría la sincronización de "articles" en cada
-- pasada.

BEGIN;

ALTER TABLE articles ADD COLUMN IF NOT EXISTS fecha_preferencia_desde TEXT;
ALTER TABLE articles ADD COLUMN IF NOT EXISTS fecha_preferencia_hasta TEXT;

COMMIT;
