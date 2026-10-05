BEGIN;
ALTER TABLE media ADD COLUMN IF NOT EXISTS visibilidad TEXT NOT NULL DEFAULT 'publico';
CREATE INDEX IF NOT EXISTS idx_media_visibilidad ON media(visibilidad);
COMMIT;