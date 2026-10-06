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
