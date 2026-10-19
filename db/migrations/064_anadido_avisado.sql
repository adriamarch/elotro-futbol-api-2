-- Push del tiempo añadido: marca si ya se avisó (ver worker/migracion_anadido_avisado.sql).
--   0 = pendiente de avisar, 1 = ya avisado, NULL = sin dato.
-- Sin esta columna sync/incremental.mjs cortaría la sincronización de
-- "results" al detectarla en D1 sin equivalente en PG.
ALTER TABLE results ADD COLUMN IF NOT EXISTS anadido_avisado INTEGER;
