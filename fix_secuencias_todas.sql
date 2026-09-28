-- Ejecutar UNA VEZ en la base de datos de Railway (PostgreSQL).
-- Repara TODAS las secuencias autoincrementales que se han quedado por
-- detrás de MAX(id) (causa de "duplicate key value violates unique
-- constraint match_events_pkey / activity_log_pkey / readers_pkey").
-- No borra ni modifica filas; solo adelanta contadores y nunca los retrocede.
DO $$
DECLARE
  r RECORD;
  max_id BIGINT;
  cur_val BIGINT;
BEGIN
  FOR r IN
    SELECT c.table_name, c.column_name,
           pg_get_serial_sequence(format('public.%I', c.table_name), c.column_name) AS seq
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public'
      AND c.data_type IN ('smallint', 'integer', 'bigint')
      AND pg_get_serial_sequence(format('public.%I', c.table_name), c.column_name) IS NOT NULL
  LOOP
    EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM public.%I', r.column_name, r.table_name) INTO max_id;
    EXECUTE format('SELECT last_value FROM %s', r.seq) INTO cur_val;
    IF max_id >= cur_val THEN
      PERFORM setval(r.seq::regclass, GREATEST(max_id, 1), max_id > 0);
      RAISE NOTICE 'Secuencia % ajustada: % -> %', r.seq, cur_val, max_id;
    END IF;
  END LOOP;
END $$;
