-- Migración: punto de foco de la foto de las noticias rápidas.
-- Permite elegir qué parte de la foto no se debe recortar nunca en las
-- tarjetas de la portada, del listado y de la ventana (mismo formato
-- "50% 50%" que usan el resto de fotos del sitio). NULL = centrada.
-- Aplicar en D1 con:
--   wrangler d1 execute elotrofutbol --remote --file=./migracion_noticias_rapidas_foco.sql
ALTER TABLE noticias_rapidas ADD COLUMN imagen_foco TEXT DEFAULT '50% 50%';
