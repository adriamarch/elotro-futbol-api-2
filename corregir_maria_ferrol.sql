-- Corrige la respuesta de María: se guardó como «Laura — Racing Club de Ferrol» (correo ferrolmps3@gmail.com, La Coruña)
-- y por eso la opción «María — Racing Club de Ferrol» seguía saliendo en la lista.
-- Idempotente; funciona igual en D1 y en Postgres.
-- Aplicar en D1:  cd worker && npx wrangler d1 execute elotrofutbol --remote --file=./corregir_maria_ferrol.sql
UPDATE formularios_respuestas SET datos = REPLACE(datos, '"nombre_red":"Laura — Racing Club de Ferrol","correo":"ferrolmps3@gmail.com"', '"nombre_red":"María — Racing Club de Ferrol","correo":"ferrolmps3@gmail.com"')
 WHERE datos LIKE '%ferrolmps3@gmail.com%' AND formulario_id = (SELECT id FROM formularios WHERE slug = 'formulario-de-incorporacion-elotrofutbol');
