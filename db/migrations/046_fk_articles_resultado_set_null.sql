-- Equivalente Postgres de worker/migracion_fk_resultado_id_set_null.sql (D1):
-- al borrar un resultado, la noticia/crónica vinculada se queda sin partido
-- (resultado_id = NULL) en vez de bloquear el borrado. Idempotente.
DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'articles'::regclass AND contype = 'f'
      AND confrelid = 'results'::regclass
  LOOP
    EXECUTE format('ALTER TABLE articles DROP CONSTRAINT %I', c);
  END LOOP;
  ALTER TABLE articles ADD CONSTRAINT articles_resultado_id_fk
    FOREIGN KEY (resultado_id) REFERENCES results (id) ON DELETE SET NULL;
END $$;
