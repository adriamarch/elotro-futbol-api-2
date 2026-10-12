-- Migración: organización de noticias para redes (carruseles de Instagram).
--
-- Las noticias y crónicas menos importantes se suben a X sin portada y a
-- Instagram juntas en carrusel (dos al día: mañana y tarde). Desde el panel
-- se etiqueta cada noticia programada con su destino.
--
-- redes_destino: NULL (sin etiqueta) | 'carousel_1' | 'carousel_2' | 'individual'
--   - Solo se puede poner en noticias programadas (lo valida el servidor).
--   - Se pone a NULL sola cuando la noticia se publica
--     (publicarArticulosProgramados) o deja de estar programada (PUT).
ALTER TABLE articles ADD COLUMN redes_destino TEXT;

-- Solo hay unas pocas noticias etiquetadas a la vez: índice parcial para
-- no escanear toda la tabla al agruparlas por carrusel.
CREATE INDEX idx_articles_redes_destino ON articles(redes_destino) WHERE redes_destino IS NOT NULL;
