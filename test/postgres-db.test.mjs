import assert from "node:assert/strict";
import { translateSql } from "../src/sql-compat.js";
const a=translateSql("SELECT * FROM users WHERE id = ? AND activo = ?");
assert.equal(a.sql,"SELECT * FROM users WHERE id = $1 AND activo = $2");
assert.deepEqual(a.params,[]);
const b=translateSql("UPDATE results SET inicio_cronometro_at = datetime('now', ?), estado='en_juego' WHERE id=?");
assert.equal(b.sql,"UPDATE results SET inicio_cronometro_at = (CURRENT_TIMESTAMP + $1::interval), estado='en_juego' WHERE id=$2");
const c=translateSql("SELECT * FROM articles WHERE programado_para <= datetime('now') AND id = ?");
assert.equal(c.sql,"SELECT * FROM articles WHERE programado_para::timestamptz <= CURRENT_TIMESTAMP AND id = $1");
console.log("postgres-db translation tests: OK");

const d=translateSql("SELECT * FROM articles WHERE slug = ?1 AND publicado = ?2");
assert.equal(d.sql,"SELECT * FROM articles WHERE slug = $1 AND publicado = $2");
console.log("numbered placeholder test: OK");

// Fase 1 (paridad con el worker principal): "INSERT OR IGNORE" de SQLite.
const e=translateSql("INSERT OR IGNORE INTO votaciones_internas_participacion (votacion_id, usuario_id) VALUES (?, ?)");
assert.equal(e.sql,"INSERT INTO votaciones_internas_participacion (votacion_id, usuario_id) VALUES ($1, $2) ON CONFLICT DO NOTHING");
const f=translateSql("INSERT OR IGNORE INTO x (a) VALUES (?) RETURNING id");
assert.equal(f.sql,"INSERT INTO x (a) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id");
const g=translateSql("INSERT INTO a (b) VALUES (?) ON CONFLICT(b) DO NOTHING");
assert.equal(g.sql,"INSERT INTO a (b) VALUES ($1) ON CONFLICT(b) DO NOTHING"); // no se duplica
console.log("insert-or-ignore translation tests: OK");

// Punto 5 (guardadas + historial): las sentencias de los endpoints /api/readers/me/guardadas,
// /historial y /lecturas/sincronizar deben traducirse a PostgreSQL válido.
const h1 = translateSql("INSERT INTO reader_saved_articles (reader_id, article_id) VALUES (?, ?), (?, ?) ON CONFLICT(reader_id, article_id) DO NOTHING");
assert.equal(h1.sql, "INSERT INTO reader_saved_articles (reader_id, article_id) VALUES ($1, $2), ($3, $4) ON CONFLICT(reader_id, article_id) DO NOTHING");
const h2 = translateSql("DELETE FROM reader_reading_history WHERE reader_id = ? AND id IN (SELECT id FROM reader_reading_history WHERE reader_id = ? ORDER BY created_at DESC, id DESC LIMIT 1000 OFFSET 100)");
assert.equal(h2.sql, "DELETE FROM reader_reading_history WHERE reader_id = $1 AND id IN (SELECT id FROM reader_reading_history WHERE reader_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1000 OFFSET 100)");
const h3 = translateSql("SELECT h.article_id, h.created_at FROM reader_reading_history h JOIN articles a ON a.id = h.article_id WHERE h.reader_id = ? AND a.publicado = 1 ORDER BY h.created_at DESC, h.id DESC LIMIT ? OFFSET ?");
assert.equal(h3.sql, "SELECT h.article_id, h.created_at FROM reader_reading_history h JOIN articles a ON a.id = h.article_id WHERE h.reader_id = $1 AND a.publicado = 1 ORDER BY h.created_at DESC, h.id DESC LIMIT $2 OFFSET $3");
console.log("lecturas-cuenta translation tests: OK");
