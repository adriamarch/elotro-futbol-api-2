// Pruebas unitarias (sin DATABASE_URL ni D1) del parche de conflicto de
// username en sync/incremental.mjs: cuando el upsert de una fila de "users"
// choca con "users_username_key" porque Postgres conserva una fila obsoleta
// (usuario borrado y recreado en D1 con otro id), se borra la obsoleta y se
// reintenta. Se usa un cliente de Postgres simulado que registra las consultas.

import assert from "node:assert/strict";
import { test } from "node:test";
import { upsertFilaResolviendoConflicto } from "../incremental.mjs";

const COLUMNAS = ["id", "username", "nombre"];
const FILA_NUEVA = { id: 12, username: "ana", nombre: "Ana" };

function errorUnico(constraint = "users_username_key", detail = "Key (username)=(ana) already exists.") {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: "23505",
    constraint,
    detail,
  });
}

// obsoletas: filas que devuelve el SELECT de filas con el mismo username.
// fallosInsert: errores que lanzan los sucesivos INSERT INTO "users" (los que sobren funcionan).
function clienteFalso({ obsoletas = [{ id: 7 }], fallosInsert = [errorUnico()] } = {}) {
  const log = [];
  let inserts = 0;
  return {
    log,
    async query(sql, params = []) {
      const texto = sql.replace(/\s+/g, " ").trim();
      log.push({ sql: texto, params });
      if (/^INSERT INTO "users"/.test(texto)) {
        const fallo = fallosInsert[inserts++];
        if (fallo) throw fallo;
        return { rows: [{ inserted: true }], rowCount: 1 };
      }
      if (/^SELECT "id" FROM "users" WHERE "username"/.test(texto)) return { rows: obsoletas, rowCount: obsoletas.length };
      if (/^DELETE FROM "users"/.test(texto)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 }; // BEGIN, COMMIT, ROLLBACK, UPDATE ... SET NULL, sync_deletions
    },
  };
}
const sqls = (c) => c.log.map((q) => q.sql);

test("conflicto de username: borra la fila obsoleta (ausente en D1) y reintenta el upsert", async () => {
  const client = clienteFalso();
  const detalle = { deleted: 0 };
  const consultasD1 = [];
  const leerD1 = async (sql) => { consultasD1.push(sql); return []; }; // id 7 ya no existe en D1

  const res = await upsertFilaResolviendoConflicto(client, "users", FILA_NUEVA, COLUMNAS, ["id"], { runId: "run-1", detalle, leerD1 });

  assert.equal(res, "inserted");
  assert.equal(detalle.deleted, 1);
  assert.match(consultasD1[0], /SELECT id FROM users WHERE id = 7 LIMIT 1/);

  const s = sqls(client);
  const iBegin = s.indexOf("BEGIN");
  const iDelete = s.findIndex((q) => q.startsWith('DELETE FROM "users"'));
  const iCommit = s.indexOf("COMMIT");
  assert.ok(iBegin >= 0 && iBegin < iDelete && iDelete < iCommit, "BEGIN -> DELETE -> COMMIT");
  assert.deepEqual(client.log[iDelete].params, [7]);
  // se desacoplan FKs antes de borrar (desacoplarUsuarioHuerfano)
  assert.ok(s.slice(iBegin, iDelete).some((q) => q.startsWith("UPDATE articles SET autor_id = NULL")));
  // el SELECT de obsoletas excluye la propia PK y usa el username de la fila nueva
  const select = client.log.find((q) => q.sql.startsWith('SELECT "id" FROM "users"'));
  assert.match(select.sql, /NOT \("id" = \$2\)/);
  assert.deepEqual(select.params, ["ana", 12]);
  // dos INSERT: el que falló y el reintento tras borrar
  assert.equal(s.filter((q) => q.startsWith('INSERT INTO "users"')).length, 2);
  // queda constancia en sync_deletions
  const traza = client.log.find((q) => q.sql.startsWith("INSERT INTO sync_deletions"));
  assert.deepEqual(traza.params, ["users", "7", "run-1"]);
});

test("conflicto de username con la fila obsoleta aún viva en D1: no borra nada y falla con mensaje claro", async () => {
  const client = clienteFalso();
  const detalle = { deleted: 0 };
  const leerD1 = async () => [{ id: 7 }]; // id 7 sigue existiendo en D1

  await assert.rejects(
    upsertFilaResolviendoConflicto(client, "users", FILA_NUEVA, COLUMNAS, ["id"], { detalle, leerD1 }),
    /sigue existiendo en D1/
  );
  assert.equal(detalle.deleted, 0);
  assert.ok(!sqls(client).some((q) => q.startsWith("DELETE") || q === "BEGIN"));
});

test("si el DELETE de la obsoleta falla se hace ROLLBACK y se propaga el error", async () => {
  const client = clienteFalso();
  const original = client.query.bind(client);
  client.query = async (sql, params) => {
    if (/^\s*DELETE FROM "users"/.test(sql)) throw new Error("fk violation");
    return original(sql, params);
  };
  await assert.rejects(
    upsertFilaResolviendoConflicto(client, "users", FILA_NUEVA, COLUMNAS, ["id"], { leerD1: async () => [] }),
    /fk violation/
  );
  const s = sqls(client);
  assert.ok(s.includes("ROLLBACK") && !s.includes("COMMIT"));
});

test("errores que no son conflicto de username se propagan sin tocar nada", async () => {
  for (const err of [
    errorUnico("users_email_key", "Key (email)=(a@b.c) already exists."),
    Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
    Object.assign(new Error("null value"), { code: "23502" }),
  ]) {
    const client = clienteFalso({ fallosInsert: [err] });
    await assert.rejects(upsertFilaResolviendoConflicto(client, "users", FILA_NUEVA, COLUMNAS, ["id"], { leerD1: async () => [] }), err);
    assert.equal(client.log.length, 1, "solo el INSERT original");
  }
});

test("otras tablas con 23505 en una columna 'username' no se tocan", async () => {
  const err = errorUnico("readers_username_key");
  // tabla distinta de users -> UNICOS_RESOLUBLES no la contempla
  const c2 = { log: [], async query(sql) { this.log.push(sql); throw err; } };
  await assert.rejects(upsertFilaResolviendoConflicto(c2, "readers", { id: 1, username: "x" }, ["id", "username"], ["id"], { leerD1: async () => [] }), err);
  assert.equal(c2.log.length, 1);
});

test("sin conflicto: un único INSERT, sin consultar D1", async () => {
  const client = clienteFalso({ fallosInsert: [] });
  let d1 = 0;
  const res = await upsertFilaResolviendoConflicto(client, "users", FILA_NUEVA, COLUMNAS, ["id"], { leerD1: async () => { d1++; return []; } });
  assert.equal(res, "inserted");
  assert.equal(client.log.length, 1);
  assert.equal(d1, 0);
});

test("si el reintento tras borrar vuelve a fallar, el error se propaga (un solo reintento)", async () => {
  const client = clienteFalso({ fallosInsert: [errorUnico(), errorUnico()] });
  await assert.rejects(
    upsertFilaResolviendoConflicto(client, "users", FILA_NUEVA, COLUMNAS, ["id"], { leerD1: async () => [] }),
    (e) => e.code === "23505"
  );
  assert.equal(sqls(client).filter((q) => q.startsWith('INSERT INTO "users"')).length, 2);
});
