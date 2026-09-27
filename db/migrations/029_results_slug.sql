-- Migración 029: columna results.slug, que faltaba en PostgreSQL.
--
-- Contexto (bug real encontrado en el sincronizador D1 -> PostgreSQL):
-- worker/migracion_galeria_partido_equipo_slug.sql añadió en D1, en el
-- mismo cambio que creó match_gallery (ver migración 027 de este mismo
-- directorio), dos columnas: match_gallery.equipo y results.slug. Solo
-- la tabla match_gallery se replicó en PostgreSQL; results.slug se
-- quedó sin su equivalente aquí.
--
-- Efecto: sync/incremental.mjs (rama "authoritative", results tiene
-- syncMode: "authoritative" en sync/tables.mjs) compara las columnas de
-- la primera página leída de D1 contra las columnas reales de Postgres
-- (obtenerColumnasPostgres). Al encontrar "slug" en D1 sin equivalente
-- en PG, marca erroresColumnas=true y corta esa tabla en seco (ver
-- incremental.mjs líneas ~217-226 y el "return detalle;" de la línea
-- 293), sin insertar/actualizar nada de "results" en toda la pasada.
-- Como articles, match_events, alineaciones, comments (y en cascada
-- comment_votes, comment_reports, polls, poll_options, poll_votes)
-- dependen de results por FK (ver DEPENDENCIAS_FK en sync/tables.mjs),
-- el orquestador las omite también en cada pasada ("Omitida en esta
-- pasada: depende de results, que falló al sincronizar."), repitiéndose
-- indefinidamente pasada tras pasada.
--
-- Bug adicional (aparte, ya corregido en sync/incremental.mjs): ese
-- caso concreto (erroresColumnas=true) no imprimía ningún log de error
-- ni de "fin" por consola -el motivo solo quedaba guardado en
-- sync_runs.detail vía registrarFin-, así que en los logs de Railway
-- "results" simplemente desaparecía sin explicación entre
-- "[results] leyendo D1 por páginas..." y la siguiente tabla.
BEGIN;

ALTER TABLE results ADD COLUMN IF NOT EXISTS slug TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_results_slug
  ON results(slug) WHERE slug IS NOT NULL;

COMMIT;
