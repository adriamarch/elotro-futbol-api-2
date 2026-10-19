-- Migración: corrección manual de jugadores (estadísticas, Fase 1).
--
-- Los jugadores de /estadisticas se calculan solos a partir del minuto a
-- minuto, donde el nombre es texto libre. Cuando el cálculo parte a un
-- jugador en dos filas ("Rodrigo" / "Rodrigo Martínez") o deja un "Dorsal 9"
-- sin nombre, un admin lo arregla desde Funcionalidades > Jugadores:
--   - "jugadores": la ficha corregida (nombre, dorsal, slug estable de su URL,
--     oculto = no sale en tops ni tiene ficha pública).
--   - "jugador_alias": qué claves automáticas (club + clave) se funden en ella.
-- Sin estas tablas todo sigue funcionando con el cálculo automático.
--
--   wrangler d1 execute elotrofutbol --remote --file=worker/migracion_jugadores.sql

CREATE TABLE IF NOT EXISTS jugadores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  club TEXT NOT NULL,
  nombre TEXT NOT NULL,
  dorsal INTEGER,
  oculto INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jugador_alias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jugador_id INTEGER NOT NULL REFERENCES jugadores(id) ON DELETE CASCADE,
  club TEXT NOT NULL,
  clave TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (club, clave)
);

CREATE INDEX IF NOT EXISTS idx_jugador_alias_jugador ON jugador_alias(jugador_id);
CREATE INDEX IF NOT EXISTS idx_jugadores_club ON jugadores(club);
