-- Migración 041: estado de los recordatorios automáticos a redactores
-- inactivos. Mismo esquema que worker/migracion_recordatorios_inactividad.sql
-- en D1.
--
-- IMPORTANTE: esta tabla NO se sincroniza D1 -> PostgreSQL (igual que
-- avisos_desatendidos_cola, migración 026): cada backend lleva la suya,
-- porque es estado del propio envío de avisos y sincronizarla podría
-- provocar avisos duplicados o perdidos. NO añadir a sync/tables.mjs.
BEGIN;
CREATE TABLE IF NOT EXISTS recordatorios_inactividad (
  user_id INTEGER PRIMARY KEY,
  ref_actividad TEXT NOT NULL,
  avisos_enviados INTEGER NOT NULL DEFAULT 0,
  ultimo_aviso_at TEXT,
  admins_avisados_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
);
COMMIT;
