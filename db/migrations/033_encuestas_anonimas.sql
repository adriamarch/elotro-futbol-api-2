-- Migración 033: encuestas libres (votar sin cuenta ni sesión).
--
-- Mismo esquema que worker/migracion_encuestas_anonimas.sql en D1, para que
-- ambas bases coincidan y el sync no pierda la columna voter_hash (pg-writer
-- solo copia las columnas que existen en Postgres) ni falle al llegar votos
-- con reader_id NULL.
--
-- reader_id pasa a ser opcional (solo lo tienen los votos antiguos, de
-- cuando votar exigía cuenta). Los votos nuevos se identifican por
-- voter_hash: hash no reversible de IP + User-Agent + id de encuesta +
-- secreto del servidor. Aplicar ANTES de desplegar el código nuevo, o los
-- votos anónimos que entren por Railway fallarán.
BEGIN;
ALTER TABLE poll_votes ALTER COLUMN reader_id DROP NOT NULL;
ALTER TABLE poll_votes ADD COLUMN IF NOT EXISTS voter_hash TEXT;
-- Necesario para el ON CONFLICT (poll_id, voter_hash) del voto. Los NULL
-- no chocan entre sí en Postgres: los votos antiguos (sin voter_hash)
-- conviven sin problema.
CREATE UNIQUE INDEX IF NOT EXISTS uq_poll_votes_poll_voter ON poll_votes(poll_id, voter_hash);
COMMIT;
