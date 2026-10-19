-- Migración: invitaciones de formulario (personas añadidas sin editar el formulario).
--
-- Solicitudes > Formularios > (un formulario) > "Personas invitadas": el admin escribe
-- los nombres y cada uno aparece en la lista desplegable del formulario público durante
-- unos días (7 por defecto) y desaparece solo al caducar o cuando esa persona responde.
-- Así no hay que abrir el editor del formulario ni tocar su lista de opciones.
--
-- expira_at: NULL = no caduca. Formato 'YYYY-MM-DD HH:MM:SS' (UTC), igual que datetime('now').
--
-- Aplicar en D1 con:
--   wrangler d1 execute elotrofutbol --remote --file=./migracion_formularios_invitados.sql
CREATE TABLE IF NOT EXISTS formularios_invitados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  formulario_id INTEGER NOT NULL,
  campo_id TEXT NOT NULL,
  opcion TEXT NOT NULL,
  opcion_norm TEXT NOT NULL,
  expira_at TEXT,
  creado_por TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_formularios_invitados_unica ON formularios_invitados(formulario_id, campo_id, opcion_norm);
CREATE INDEX IF NOT EXISTS idx_formularios_invitados_form ON formularios_invitados(formulario_id, expira_at);
