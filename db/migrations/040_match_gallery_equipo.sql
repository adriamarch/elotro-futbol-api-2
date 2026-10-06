-- Migración 040: pestañas por equipo en la galería de partido.
-- Equivale a "ALTER TABLE match_gallery ADD COLUMN equipo TEXT" de
-- worker/migracion_galeria_partido_equipo_slug.sql en D1 ('local',
-- 'visitante' o NULL = foto general). results.slug ya está en la 029.
BEGIN;
ALTER TABLE match_gallery ADD COLUMN IF NOT EXISTS equipo TEXT;
COMMIT;
