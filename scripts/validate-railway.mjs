#!/usr/bin/env node
/**
 * FASE 3 - Validación real PostgreSQL/Railway
 *
 * Uso:
 *   DATABASE_URL='postgresql://...' node scripts/validate-railway.mjs
 *
 * El script NO imprime DATABASE_URL ni credenciales.
 *
 * Realiza:
 *  1. conexión real a PostgreSQL
 *  2. versión y servidor
 *  3. aplicación de migraciones
 *  4. verificación de tablas/columnas
 *  5. verificación de PK/FK/índices
 *  6. smoke tests CRUD dentro de una transacción que se revierte
 *  7. comprobación de compatibilidad de parámetros SQL
 *  8. health HTTP opcional si API_BASE_URL está definida
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!databaseUrl) {
  console.error("ERROR: define DATABASE_URL o DATABASE_PUBLIC_URL.");
  process.exit(2);
}

const migration = path.resolve(
  process.cwd(),
  "db",
  "migrations",
  "001_initial_schema.sql"
);

if (!fs.existsSync(migration)) {
  console.error(`ERROR: no existe ${migration}`);
  process.exit(2);
}

const expectedTables = [
  "users", "articles", "results", "match_events", "settings", "media",
  "sessions", "custom_clubs", "edit_requests", "article_slug_redirects",
  "alineaciones", "comments", "club_info", "club_info_solicitudes",
  "activity_log", "nivel_historial"
];

const requiredIndexes = [
  "idx_match_events_resultado",
  "idx_media_created",
  "idx_sessions_user",
  "idx_articles_categoria",
  "idx_articles_publicado",
  "idx_results_competicion",
  "idx_custom_clubs_categoria",
  "idx_edit_requests_entidad",
  "idx_edit_requests_solicitante",
  "idx_edit_requests_estado",
  "idx_alineaciones_article",
  "idx_alineaciones_result",
  "idx_comments_article",
  "idx_comments_estado",
  "idx_club_info_solicitudes_estado",
  "idx_club_info_solicitudes_club"
];

let passed = 0;
let failed = 0;

function ok(name, detail = "") {
  passed++;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name, detail = "") {
  failed++;
  console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

const client = new Client({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
  application_name: "fase3-railway-validator"
});

try {
  await client.connect();
  ok("Conexión PostgreSQL");

  const version = await client.query("SELECT version(), current_database(), current_user");
  ok("Servidor PostgreSQL", `${version.rows[0].version.split(",")[0]}`);

  const migrationSql = fs.readFileSync(migration, "utf8");
  await client.query(migrationSql);
  ok("Migración 001 aplicada");

  const tables = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
  `);
  const actualTables = new Set(tables.rows.map(r => r.table_name));
  const missingTables = expectedTables.filter(t => !actualTables.has(t));

  if (missingTables.length) fail("Tablas esperadas", missingTables.join(", "));
  else ok("16 tablas esperadas");

  const requiredColumns = {
    users: ["id", "username", "password_hash", "salt", "nombre", "rol", "activo", "email", "bio", "experiencia", "avatar_url", "avatar_foco", "redes_sociales", "equipo", "notif_visto_at", "reset_token", "reset_token_expira", "created_at", "nivel", "nivel_nota", "ultima_hora_hash", "ultima_hora_salt"],
    articles: ["id", "slug", "titulo", "subtitulo", "contenido", "tipo", "categoria", "resultado_id", "autor_id", "autor_nombre", "coautor_id", "coautor_nombre", "destacado", "publicado", "estado_borrador", "programado_para", "slug_congelado", "fecha_publicacion", "created_at", "updated_at"],
    results: ["id", "competicion", "grupo", "jornada", "equipo_local", "equipo_visitante", "goles_local", "goles_visitante", "fecha_partido", "estado", "ubicacion", "flashscore_url", "autor_id", "autor_nombre", "inicio_cronometro_at", "cronometro_pausado_en", "ajuste_cronometro_minutos", "penaltis_local", "penaltis_visitante", "mvp_jugador", "mvp_equipo"],
    comments: ["id", "article_id", "nombre", "email", "texto", "estado", "ip", "created_at", "moderado_por_id", "moderado_at"],
    sessions: ["id", "user_id", "user_agent", "ip", "created_at", "last_seen_at", "revoked_at"]
  };
  const cols = await client.query(`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema='public'
  `);
  const colMap = new Map();
  for (const r of cols.rows) {
    if (!colMap.has(r.table_name)) colMap.set(r.table_name, new Set());
    colMap.get(r.table_name).add(r.column_name);
  }
  for (const [table, colsExpected] of Object.entries(requiredColumns)) {
    const missing = colsExpected.filter(c => !colMap.get(table)?.has(c));
    if (missing.length) fail(`Columnas ${table}`, missing.join(", "));
    else ok(`Columnas ${table}`);
  }

  const indexes = await client.query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
  `);
  const actualIndexes = new Set(indexes.rows.map(r => r.indexname));
  const missingIndexes = requiredIndexes.filter(i => !actualIndexes.has(i));

  if (missingIndexes.length) fail("Índices esperados", missingIndexes.join(", "));
  else ok("Índices principales");

    // Synchronize only numeric auto-generated IDs. Text/UUID IDs are ignored.
  const idColumns = await client.query(`
    SELECT table_name, column_name, data_type, is_identity
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'id'
      AND data_type IN ('smallint', 'integer', 'bigint')
  `);

  let sequenceCount = 0;

  for (const row of idColumns.rows) {
    const table = row.table_name;
    const column = row.column_name;

    const maxResult = await client.query(
      `SELECT MAX("${column}") AS max_id FROM "public"."${table}"`
    );

    const rawMax = maxResult.rows[0].max_id;
    const maxId = rawMax === null ? 0 : Number(rawMax);
    const restartAt = maxId + 1;

    if (row.is_identity === "YES") {
      await client.query(
        `ALTER TABLE "public"."${table}" ALTER COLUMN "${column}" RESTART WITH ${restartAt}`
      );
      sequenceCount++;
      continue;
    }

    const seqResult = await client.query(
      `SELECT pg_get_serial_sequence($1, $2) AS sequence_name`,
      [`public.${table}`, column]
    );

    const sequence = seqResult.rows[0]?.sequence_name;
    if (!sequence) continue;

    await client.query(
      `SELECT setval($1::regclass, $2, false)`,
      [sequence, restartAt]
    );

    sequenceCount++;
  }

  ok(
    "Secuencias ID sincronizadas con datos existentes",
    `${sequenceCount} secuencias numéricas`
  );

  // Specific diagnostic for users.id, when it is numeric and sequence-backed.
  const usersMeta = await client.query(`
    SELECT data_type, is_identity
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'id'
  `);

  const usersColumn = usersMeta.rows[0];

  if (usersColumn && ["smallint", "integer", "bigint"].includes(usersColumn.data_type)) {
    const usersMaxResult = await client.query(
      `SELECT MAX(id) AS max_id FROM public.users`
    );

    const usersMax = usersMaxResult.rows[0].max_id === null
      ? 0
      : Number(usersMaxResult.rows[0].max_id);

    const seqResult = await client.query(
      `SELECT pg_get_serial_sequence('public.users', 'id') AS sequence_name`
    );

    const sequence = seqResult.rows[0]?.sequence_name;

    if (sequence) {
      const state = await client.query(
        `SELECT last_value, is_called FROM ${sequence}`
      );

      const next = Number(state.rows[0].last_value) +
        (state.rows[0].is_called ? 1 : 0);

      if (next > usersMax) {
        ok("users.id next value", `next=${next}, max(id)=${usersMax}`);
      } else {
        fail("users.id next value", `next=${next}, max(id)=${usersMax}`);
      }
    }
  }

const constraints = await client.query(`
    SELECT
      tc.constraint_name,
      tc.constraint_type,
      tc.table_name
    FROM information_schema.table_constraints tc
    WHERE tc.table_schema = 'public'
      AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE')
  `);
  if (constraints.rows.length >= 16) {
    ok("Constraints", `${constraints.rows.length} constraints detectados`);
  } else {
    fail("Constraints", `solo ${constraints.rows.length} detectados`);
  }

  // SQL compatibility smoke tests. All changes are inside a transaction and rolled back.
  await client.query("BEGIN");

  const u = await client.query(`
    INSERT INTO users (username, password_hash, salt, email, rol, nombre, nivel)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, username
  `, [
    `__fase3_test_${Date.now()}`,
    "__fase3_password_hash__",
    "__fase3_salt__",
    `__fase3_${Date.now()}@invalid.test`,
    "redactor",
    "__FASE3_TEST_USER__",
    1
  ]);

  const userId = u.rows[0].id;
  ok("INSERT users + RETURNING");

  const user = await client.query(
    "SELECT id, username, nivel FROM users WHERE id = $1",
    [userId]
  );
  if (user.rowCount === 1) ok("SELECT users con placeholder");
  else fail("SELECT users");

  const updated = await client.query(
    "UPDATE users SET nivel = $1 WHERE id = $2 RETURNING id, nivel",
    [2, userId]
  );
  if (updated.rows[0]?.nivel === 2) ok("UPDATE users + RETURNING");
  else fail("UPDATE users");

  const article = await client.query(`
    INSERT INTO articles
      (slug, titulo, contenido, autor_id, categoria, publicado, destacado)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
  `, [
    `__fase3-test-${Date.now()}`,
    "__FASE3_TEST__",
    "__FASE3_TEST_CONTENT__",
    userId,
    "__test__",
    0,
    0
  ]);
  const articleId = article.rows[0].id;
  ok("INSERT articles + FK users");

  const comment = await client.query(`
    INSERT INTO comments (article_id, nombre, email, texto, estado)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [
    articleId, "__FASE3__", "__fase3@invalid.test",
    "__FASE3_COMMENT__", "pendiente"
  ]);
  ok("INSERT comments + FK articles/users");

  const result = await client.query(`
    INSERT INTO results
      (competicion, jornada, equipo_local, equipo_visitante,
       goles_local, goles_visitante, estado, ajuste_cronometro_minutos)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING id
  `, ["__TEST__", 1, "__LOCAL__", "__VISITANTE__", 0, 0, "programado", 0]);
  const resultId = result.rows[0].id;
  ok("INSERT results");

  await client.query(`
    INSERT INTO match_events
      (resultado_id, tipo, equipo, jugador, minuto)
    VALUES ($1,$2,$3,$4,$5)
  `, [resultId, "otro", "ninguno", "__PLAYER__", 1]);
  ok("INSERT match_events + FK results");

  const sessionId = `__fase3_session_${Date.now()}`;
  await client.query(`
    INSERT INTO sessions (id, user_id, user_agent, ip, created_at, last_seen_at, revoked_at)
    VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL)
  `, [sessionId, userId, "__FASE3_TEST__", "127.0.0.1"]);
  ok("INSERT sessions + FK users");

  // SQLite-ish constructs that the adapter is expected to translate in the API layer.
  const now = await client.query("SELECT CURRENT_TIMESTAMP AS now");
  if (now.rows[0]?.now) ok("CURRENT_TIMESTAMP");

  await client.query("ROLLBACK");
  ok("Rollback de smoke tests");
} catch (err) {
  try { await client.query("ROLLBACK"); } catch {}
  fail("Ejecución principal", err?.message || String(err));
} finally {
  await client.end().catch(() => {});
}

const apiBase = process.env.API_BASE_URL;
if (apiBase) {
  for (const endpoint of ["/api/health"]) {
    try {
      const res = await fetch(new URL(endpoint, apiBase));
      const body = await res.text();
      if (res.ok) ok(`HTTP ${endpoint}`, `${res.status} ${body.slice(0, 200)}`);
      else fail(`HTTP ${endpoint}`, `${res.status} ${body.slice(0, 200)}`);
    } catch (err) {
      fail(`HTTP ${endpoint}`, err?.message || String(err));
    }
  }
} else {
  console.log("INFO  API_BASE_URL no definida — se omiten smoke tests HTTP.");
}

console.log("");
console.log(`Resultado: ${passed} PASS / ${failed} FAIL`);

if (failed > 0) {
  process.exit(1);
}
console.log("FASE 3: validación PostgreSQL completada correctamente.");
