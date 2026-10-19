-- Equivalente a worker/migracion_quitar_etiqueta_redes_publicadas.sql (D1).
UPDATE articles SET redes_destino = NULL WHERE publicado = 1 AND redes_destino IS NOT NULL;
