-- Punto 5: "Guardar noticias para leer luego" e "Historial de lectura" en la
-- cuenta del lector.
--
-- Los visitantes sin cuenta guardan ambas cosas en su navegador (localStorage,
-- ver public/js/lecturas.js). Al iniciar sesión, lo del navegador se fusiona
-- con la cuenta (POST /api/readers/me/lecturas/sincronizar) y desde entonces
-- la fuente de verdad es esta base de datos.
--
-- reader_saved_articles: "Guardadas para leer luego". Una fila por (lector,
--   noticia). Quitar una noticia guardada borra la fila. Máximo 200 por lector
--   (se aplica en el Worker, no aquí).
--
-- reader_reading_history: noticias que el lector ha abierto, la más reciente
--   primero. Una fila por (lector, noticia): volver a leer una noticia la
--   BORRA y la REINSERTA (id y created_at nuevos), igual que comment_votes.
--   Así ambas tablas son de solo-inserción para el sincronizador D1 -> Postgres
--   (changeStrategy "immutable" con created_at) sin necesidad de updated_at.
--   Máximo 100 filas por lector: el Worker poda las más antiguas al insertar.
--
-- Al borrarse un lector o una noticia, se borran sus filas (ON DELETE CASCADE).
-- Una noticia que pasa a borrador deja de mostrarse (los listados filtran
-- publicado = 1) pero la fila se conserva por si vuelve a publicarse.
CREATE TABLE IF NOT EXISTS reader_saved_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reader_id INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (reader_id, article_id)
);
CREATE INDEX IF NOT EXISTS idx_reader_saved_reader_fecha ON reader_saved_articles(reader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reader_saved_article ON reader_saved_articles(article_id);

CREATE TABLE IF NOT EXISTS reader_reading_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reader_id INTEGER NOT NULL REFERENCES readers(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (reader_id, article_id)
);
CREATE INDEX IF NOT EXISTS idx_reader_history_reader_fecha ON reader_reading_history(reader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reader_history_article ON reader_reading_history(article_id);
