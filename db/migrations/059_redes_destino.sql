-- Migración 059: etiqueta de redes (carrusel 1 / carrusel 2 / individual) en
-- noticias programadas. Equivalente a worker/migracion_redes_destino.sql en D1.
--
-- Sin esta migración, sync/incremental.mjs (tables.mjs: "articles" sincroniza
-- columnas dinámicamente) detecta redes_destino como columna sin equivalente
-- en PG y corta la sincronización de "articles" en cada pasada (mismo caso que
-- la migración 020_banner_urgente.sql).

BEGIN;

ALTER TABLE articles ADD COLUMN IF NOT EXISTS redes_destino TEXT;

CREATE INDEX IF NOT EXISTS idx_articles_redes_destino ON articles(redes_destino) WHERE redes_destino IS NOT NULL;

COMMIT;
