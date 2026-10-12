-- Migracion 054: "avisarme de mi equipo" (push solo de los clubes elegidos).
-- Mismo esquema que worker/migracion_push_clubes.sql en D1.
BEGIN;

ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS solo_clubes INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS push_subscription_clubs (
  subscription_id INTEGER NOT NULL,
  club TEXT NOT NULL,
  PRIMARY KEY (subscription_id, club)
);
CREATE INDEX IF NOT EXISTS idx_push_clubs_club ON push_subscription_clubs(club);

COMMIT;
