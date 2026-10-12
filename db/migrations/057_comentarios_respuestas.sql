-- Migración 057: comentarios con respuestas y avisos por correo
-- (mismo esquema que worker/migracion_comentarios_respuestas.sql en D1).
--
-- Sin estas columnas, sync/incremental.mjs vería columnas de D1 "sin
-- equivalente en PG" en comments/readers y cortaría la sincronización.
--
-- Las FK de parent_id/responde_a_id son DEFERRABLE INITIALLY DEFERRED para que
-- el sincronizador no falle si en un mismo lote llega una respuesta antes que
-- el comentario al que contesta.
BEGIN;

ALTER TABLE comments ADD COLUMN IF NOT EXISTS parent_id INTEGER REFERENCES comments(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS responde_a_id INTEGER REFERENCES comments(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS aviso_aprobado INTEGER NOT NULL DEFAULT 0;
ALTER TABLE comments ADD COLUMN IF NOT EXISTS respuesta_avisada INTEGER NOT NULL DEFAULT 0;
ALTER TABLE readers ADD COLUMN IF NOT EXISTS avisos_comentarios INTEGER NOT NULL DEFAULT 1;

-- Los comentarios que ya existen no deben generar correos al cambiar de estado.
UPDATE comments SET aviso_aprobado = 1, respuesta_avisada = 1;

CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

COMMIT;
