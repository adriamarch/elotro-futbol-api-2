-- Corrige 3 respuestas históricas del «Formulario de incorporación» cuyo nombre no coincide con ninguna opción
-- de la lista, por eso esas opciones seguían saliendo aunque la persona ya había respondido.
-- Es idempotente (si ya está corregido no cambia nada) y funciona igual en D1 y en Postgres.
-- Aplicar en D1:  cd worker && npx wrangler d1 execute elotrofutbol --remote --file=./corregir_nombres_incorporacion.sql
-- (Daniel — CP Cacereño y Kiko ya no hacen falta: el código ahora los reconoce por nombre y equipo.)

-- Jose Morales: respondió con «CD Badajoz» y su opción es «Arbitraje».
UPDATE formularios_respuestas SET datos = REPLACE(datos, '"nombre_red":"Jose Morales  — CD Badajoz","correo":"josemamorales13@gmail.com"', '"nombre_red":"Jose Morales — Arbitraje","correo":"josemamorales13@gmail.com"')
 WHERE datos LIKE '%josemamorales13@gmail.com%' AND formulario_id = (SELECT id FROM formularios WHERE slug = 'formulario-de-incorporacion-elotrofutbol');

-- Laura (provincia Ourense): eligió «Racing Club de Ferrol» y su opción es «UD Ourense».
UPDATE formularios_respuestas SET datos = REPLACE(datos, '"nombre_red":"Laura — Racing Club de Ferrol","correo":"lausuarez17u@gmail.com"', '"nombre_red":"Laura — UD Ourense","correo":"lausuarez17u@gmail.com"')
 WHERE datos LIKE '%lausuarez17u@gmail.com%' AND formulario_id = (SELECT id FROM formularios WHERE slug = 'formulario-de-incorporacion-elotrofutbol');

-- María: hay DOS respuestas «Laura — Racing Club de Ferrol» y solo una opción de Laura (UD Ourense), así que la
-- otra (ferrolmps3@..., La Coruña) parece ser la de «María — Racing Club de Ferrol». ES UNA SUPOSICIÓN: confírmalo
-- con esa persona y, si es cierto, quita los «-- » de abajo y ejecuta de nuevo el fichero.
-- UPDATE formularios_respuestas SET datos = REPLACE(datos, '"nombre_red":"Laura — Racing Club de Ferrol","correo":"ferrolmps3@gmail.com"', '"nombre_red":"María — Racing Club de Ferrol","correo":"ferrolmps3@gmail.com"')
--  WHERE datos LIKE '%ferrolmps3@gmail.com%' AND formulario_id = (SELECT id FROM formularios WHERE slug = 'formulario-de-incorporacion-elotrofutbol');
