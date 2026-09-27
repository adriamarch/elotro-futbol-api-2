-- Migración 028: añade portada_segundo y portada_foco a "media" (mismas
-- migraciones que worker/migracion_media_portada.sql y
-- worker/migracion_media_portada_foco.sql en D1, aplicadas aquí a
-- Postgres para que el esquema de ambas bases coincida).
--
-- portada_segundo: instante (en segundos) del vídeo del que se saca el
-- fotograma de portada/miniatura; NULL usa el segundo 1 por defecto. Solo
-- se usa en vídeos.
--
-- portada_foco: qué punto de la miniatura no se debe recortar nunca,
-- formato "50% 50%" (mismo formato que el resto de fotos del sitio).
-- Aplica tanto a fotos como a vídeos: en vídeos es el punto del fotograma
-- de portada, en fotos el punto de la propia imagen. NULL usa el centro.

ALTER TABLE media ADD COLUMN IF NOT EXISTS portada_segundo REAL;
ALTER TABLE media ADD COLUMN IF NOT EXISTS portada_foco TEXT;
