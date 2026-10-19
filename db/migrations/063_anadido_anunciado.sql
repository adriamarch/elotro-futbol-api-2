-- Migración 063: tiempo añadido ANUNCIADO en directo (panel de Minuto a Minuto).
-- Mismo esquema que worker/migracion_anadido_anunciado.sql en D1.
--
--   anadido_minutos: minutos de añadido anunciados (NULL = nada anunciado).
--   anadido_parte:   1 = añadido de la 1ª parte, 2 = añadido de la 2ª.
--
-- Sin estas columnas sync/incremental.mjs cortaría la sincronización de
-- "results" (y la de sus tablas hijas) al detectarlas sin equivalente en PG.
ALTER TABLE results ADD COLUMN IF NOT EXISTS anadido_minutos INTEGER;
ALTER TABLE results ADD COLUMN IF NOT EXISTS anadido_parte INTEGER;
