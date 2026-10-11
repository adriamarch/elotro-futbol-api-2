-- Búsqueda de artículos en PostgreSQL (failover), equivalente al FTS5 de D1.
-- Sin código de aplicación: un trigger mantiene articles.busqueda_tsv, también
-- cuando el sincronizador (sync/pg-writer.mjs) inserta o actualiza artículos.
--
-- Requiere las extensiones "unaccent" (viene con postgres-contrib; Railway la
-- permite). Se prefiere una configuración de texto propia con unaccent a llamar
-- a unaccent() en cada consulta: así ts_headline resalta sobre el texto original
-- con tildes.

CREATE EXTENSION IF NOT EXISTS unaccent;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'es_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION es_unaccent (COPY = spanish);
    ALTER TEXT SEARCH CONFIGURATION es_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, spanish_stem;
  END IF;
END $$;

ALTER TABLE articles ADD COLUMN IF NOT EXISTS busqueda_tsv tsvector;

CREATE OR REPLACE FUNCTION articles_busqueda_actualizar() RETURNS trigger AS $$
BEGIN
  NEW.busqueda_tsv :=
    setweight(to_tsvector('es_unaccent', coalesce(NEW.titulo, '')), 'A') ||
    setweight(to_tsvector('es_unaccent', coalesce(NEW.club, '')), 'A') ||
    setweight(to_tsvector('es_unaccent',
      coalesce(NEW.subtitulo, '') || ' ' || coalesce(NEW.autor_nombre, '') || ' ' || coalesce(NEW.coautor_nombre, '')), 'B') ||
    setweight(to_tsvector('es_unaccent',
      coalesce(NEW.titulo_eu, '') || ' ' || coalesce(NEW.subtitulo_eu, '') || ' ' ||
      coalesce(NEW.titulo_ca, '') || ' ' || coalesce(NEW.subtitulo_ca, '') || ' ' ||
      coalesce(NEW.titulo_gl, '') || ' ' || coalesce(NEW.subtitulo_gl, '') || ' ' ||
      coalesce(NEW.titulo_en, '') || ' ' || coalesce(NEW.subtitulo_en, '')), 'C') ||
    setweight(to_tsvector('es_unaccent',
      left(regexp_replace(regexp_replace(coalesce(NEW.contenido, ''), '<[^>]*>', ' ', 'g'), '&[a-z0-9#]+;', ' ', 'g'), 100000)), 'D');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS articles_busqueda_trg ON articles;
CREATE TRIGGER articles_busqueda_trg
  BEFORE INSERT OR UPDATE OF titulo, subtitulo, contenido, club, autor_nombre, coautor_nombre,
    titulo_eu, subtitulo_eu, titulo_ca, subtitulo_ca, titulo_gl, subtitulo_gl, titulo_en, subtitulo_en
  ON articles FOR EACH ROW EXECUTE FUNCTION articles_busqueda_actualizar();

-- Backfill: "UPDATE OF titulo" dispara el trigger aunque el valor no cambie, y
-- no toca updated_at, así que no genera trabajo extra al sincronizador.
UPDATE articles SET titulo = titulo WHERE busqueda_tsv IS NULL;

CREATE INDEX IF NOT EXISTS idx_articles_busqueda_tsv ON articles USING GIN (busqueda_tsv);
