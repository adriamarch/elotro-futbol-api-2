-- Migración 044: imagen_foco en noticias_rapidas (punto de foco "X% Y%" de la
-- foto). Mismo cambio que worker/migracion_noticias_rapidas_foco.sql en D1.
-- Sin esta columna, el failover a Railway fallaría al leer/guardar noticias
-- rápidas con "column imagen_foco does not exist".
ALTER TABLE noticias_rapidas ADD COLUMN IF NOT EXISTS imagen_foco TEXT DEFAULT '50% 50%';
