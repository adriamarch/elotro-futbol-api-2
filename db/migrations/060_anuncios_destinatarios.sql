-- Migración 060: registro de a quién se ha enviado cada anuncio por correo.
-- Mismo esquema que worker/migracion_anuncios_destinatarios.sql en D1 (el Worker también
-- la crea sola la primera vez que se envía un anuncio, así que esta migración es de cortesía).
-- estado: 'enviando' | 'enviado' | 'fallido'.

BEGIN;

CREATE TABLE IF NOT EXISTS anuncios_email_destinatarios (
  anuncio_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  estado TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (anuncio_id, email)
);

COMMIT;
