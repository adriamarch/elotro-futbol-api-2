-- Migración 034: stock y galería de imágenes en la tienda.
--
-- Mismo cambio que worker/migracion_tienda_mejoras.sql en D1, portado a
-- Postgres. stock NULL = sin límite; imagenes es un array JSON (texto) con
-- URLs extra para la galería de la ficha del producto.

BEGIN;

ALTER TABLE tienda_productos ADD COLUMN IF NOT EXISTS stock INTEGER;
ALTER TABLE tienda_productos ADD COLUMN IF NOT EXISTS imagenes TEXT;

COMMIT;
