-- Migración: formularios personalizados (constructor de formularios del panel).
--
-- Solicitudes > Formularios: el formulario de acreditaciones es un formulario ya
-- creado (tabla "acreditaciones", sin cambios). Esta migración añade las tablas
-- para que un admin pueda crear más formularios, cada uno con su enlace público
-- (/formulario?f=<slug>) y su bandeja de respuestas.
--
-- Aplicar en D1 con:
--   wrangler d1 execute elotrofutbol --remote --file=./migracion_formularios.sql
CREATE TABLE IF NOT EXISTS formularios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  titulo TEXT NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  aviso TEXT NOT NULL DEFAULT '',
  texto_boton TEXT NOT NULL DEFAULT 'Enviar',
  mensaje_final TEXT NOT NULL DEFAULT '',
  campos TEXT NOT NULL DEFAULT '[]',
  acceso TEXT NOT NULL DEFAULT 'libre',
  pin TEXT,
  activo INTEGER NOT NULL DEFAULT 1,
  notificar_email INTEGER NOT NULL DEFAULT 1,
  creado_por TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_formularios_created ON formularios(created_at DESC);

CREATE TABLE IF NOT EXISTS formularios_respuestas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  formulario_id INTEGER NOT NULL,
  datos TEXT NOT NULL DEFAULT '{}',
  estado TEXT NOT NULL DEFAULT 'nueva',
  nota_admin TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_formularios_respuestas_form ON formularios_respuestas(formulario_id, created_at DESC);
