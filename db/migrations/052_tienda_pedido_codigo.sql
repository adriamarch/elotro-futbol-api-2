-- Migración 052: número de pedido, método de pago y entrega en la tienda.
--
-- Mismo cambio que worker/migracion_tienda_pedido_codigo.sql en D1, portado
-- a Postgres (las columnas deben existir aquí para que el sincronizador
-- D1 -> Postgres pueda copiar los pedidos nuevos).

BEGIN;

ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS codigo TEXT;
ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS metodo_pago TEXT;
ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS entrega TEXT;
ALTER TABLE tienda_pedidos ADD COLUMN IF NOT EXISTS direccion_envio TEXT;

UPDATE tienda_pedidos SET codigo = 'EOF-' || LPAD(id::text, 4, '0') WHERE codigo IS NULL;
UPDATE tienda_pedidos SET metodo_pago = 'paypal' WHERE metodo_pago IS NULL AND referencia_pago LIKE '[PayPal]%';
UPDATE tienda_pedidos SET metodo_pago = 'bizum' WHERE metodo_pago IS NULL AND referencia_pago LIKE '[Bizum]%';

CREATE INDEX IF NOT EXISTS idx_tienda_pedidos_codigo ON tienda_pedidos(codigo);

COMMIT;
