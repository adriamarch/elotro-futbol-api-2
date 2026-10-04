-- Migración 035: partidazo de la jornada.
--
-- Mismo cambio que worker/migracion_partidazo.sql en D1. Ejecutar ANTES o
-- a la vez que la de D1: el sincronizador compara columnas y, si D1 tiene
-- alguna que Postgres no tiene, deja de sincronizar results (ver 029).
-- El cálculo se hace solo en D1; Postgres recibe estos valores por sync.

BEGIN;

ALTER TABLE results ADD COLUMN IF NOT EXISTS partidazo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE results ADD COLUMN IF NOT EXISTS partidazo_puntuacion INTEGER;
ALTER TABLE results ADD COLUMN IF NOT EXISTS partidazo_motivos TEXT;

COMMIT;
