-- Migración: solicitudes de acreditación (formulario público acreditacion.html).
--
-- Cualquier persona con el enlace del formulario puede solicitar acreditación
-- para cubrir un partido, rueda de prensa o acto. Los administradores ven y
-- gestionan las solicitudes en el panel (Funcionalidades > Acreditaciones).
-- "estado": pendiente (al llegar) -> aprobada / rechazada (decide un admin;
-- la concesión real la decide siempre el club organizador).
--
-- Aplicar en D1 con:
--   wrangler d1 execute elotrofutbol --remote --file=./migracion_acreditaciones.sql
CREATE TABLE IF NOT EXISTS acreditaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL,
  dni TEXT NOT NULL,
  equipo TEXT NOT NULL,
  tipo_evento TEXT NOT NULL,
  tipo_acreditacion TEXT NOT NULL,
  funciones TEXT NOT NULL,
  jornada_partido TEXT NOT NULL,
  confirmado INTEGER NOT NULL DEFAULT 1,
  estado TEXT NOT NULL DEFAULT 'pendiente',
  nota_admin TEXT,
  revisado_por TEXT,
  revisado_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_acreditaciones_created ON acreditaciones(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_acreditaciones_estado ON acreditaciones(estado);
