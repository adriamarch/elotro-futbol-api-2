-- Respuestas del «Formulario de incorporación» que no tienen rol -> «Redactor».
-- Las primeras respuestas (julio-septiembre) se recogieron antes de que existiera la pregunta «Selecciona tu rol»,
-- así que quedaron sin rol (y sus preguntas de redactor no se podían editar). Todas eran de redactores.
-- Idempotente: solo toca respuestas sin rol o con el rol vacío; las que ya son Redactor o Fotógrafo no cambian.
-- Funciona igual en D1 y en Postgres.
-- Aplicar en D1:  cd worker && npx wrangler d1 execute elotrofutbol --remote --file=./asignar_rol_redactor_incorporacion.sql

-- 1) Sin la clave «rol»: se añade al principio del JSON.
UPDATE formularios_respuestas
   SET datos = CASE WHEN datos = '{}' THEN '{"rol":"Redactor"}' ELSE '{"rol":"Redactor",' || SUBSTR(datos, 2) END
 WHERE formulario_id = (SELECT id FROM formularios WHERE slug = 'formulario-de-incorporacion-elotrofutbol')
   AND datos LIKE '{%'
   AND datos NOT LIKE '%"rol":%';

-- 2) Con «rol» vacío.
UPDATE formularios_respuestas
   SET datos = REPLACE(datos, '"rol":""', '"rol":"Redactor"')
 WHERE formulario_id = (SELECT id FROM formularios WHERE slug = 'formulario-de-incorporacion-elotrofutbol')
   AND datos LIKE '%"rol":""%';
