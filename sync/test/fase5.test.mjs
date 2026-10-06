// Pruebas de la Fase 2 de la sincronización completa (FASE5): push_subscriptions
// y las 5 tablas de votaciones internas. Sin DATABASE_URL ni D1: se usa un
// cliente de Postgres simulado y un "npx" falso que registra las consultas.

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TABLES_IN_ORDER, DEPENDENCIAS_FK, getTable } from "../tables.mjs";
import { TABLAS_PRIVADAS_COMPARADOR } from "../comparator-config.mjs";
import { ejecutarD1Paginado } from "../d1-client.mjs";
import { upsertFilaResolviendoConflicto } from "../incremental.mjs";
import { desacoplarUsuarioHuerfano, reordenarTablaPorClave } from "../pg-writer.mjs";

const NUEVAS = [
  "push_subscriptions",
  "votaciones_internas",
  "votaciones_internas_opciones",
  "votaciones_internas_votos",
  "votaciones_internas_participacion",
  "votaciones_internas_urna",
];

test("orden de claves foráneas: todo padre de DEPENDENCIAS_FK se sincroniza antes que su hija", () => {
  const orden = Object.fromEntries(TABLES_IN_ORDER.map((t) => [t.name, t.order]));
  for (const [hija, padres] of Object.entries(DEPENDENCIAS_FK)) {
    assert.ok(hija in orden, `${hija} está en DEPENDENCIAS_FK pero no en TABLES`);
    for (const padre of padres) {
      assert.ok(padre in orden, `${padre} (padre de ${hija}) no está en TABLES`);
      assert.ok(orden[padre] < orden[hija], `${padre} (${orden[padre]}) debe ir antes que ${hija} (${orden[hija]})`);
    }
  }
});

test("las 5 votaciones declaran sus dependencias, push_subscriptions no depende de nadie", () => {
  assert.deepEqual(DEPENDENCIAS_FK.votaciones_internas, ["users"]);
  assert.ok(DEPENDENCIAS_FK.votaciones_internas_opciones.includes("votaciones_internas"));
  assert.deepEqual(
    [...DEPENDENCIAS_FK.votaciones_internas_votos].sort(),
    ["users", "votaciones_internas", "votaciones_internas_opciones"]
  );
  assert.deepEqual([...DEPENDENCIAS_FK.votaciones_internas_participacion].sort(), ["users", "votaciones_internas"]);
  assert.deepEqual(
    [...DEPENDENCIAS_FK.votaciones_internas_urna].sort(),
    ["votaciones_internas", "votaciones_internas_opciones"]
  );
  assert.equal(DEPENDENCIAS_FK.push_subscriptions, undefined);
});

test("votaciones: authoritative con borrado; push_subscriptions por updated_at con detección de borrados", () => {
  for (const n of NUEVAS.filter((n) => n.startsWith("votaciones"))) {
    const t = getTable(n);
    assert.equal(t.syncMode, "authoritative", n);
    assert.equal(t.deleteDetection, true, n);
  }
  const p = getTable("push_subscriptions");
  assert.equal(p.changeStrategy, "updated_at");
  assert.equal(p.cursorColumn, "updated_at");
  assert.equal(p.deleteDetection, true);
  assert.notEqual(p.syncMode, "authoritative", "puede ser una tabla grande: no se relee entera cada pasada");
});

test("voto secreto: PK correcta, orden físico por clave, cursor nunca temporal y comparador sin claves", () => {
  const part = getTable("votaciones_internas_participacion");
  const urna = getTable("votaciones_internas_urna");
  assert.deepEqual(part.pk, ["votacion_id", "usuario_id"]);
  assert.deepEqual(urna.pk, ["token"]);
  for (const t of [part, urna]) {
    assert.equal(t.ordenFisicaPorClave, true, t.name);
    assert.ok(!/_at$|fecha|time/i.test(t.cursorColumn), `${t.name}: el cursor no puede ser una marca de tiempo (${t.cursorColumn})`);
    assert.ok(TABLAS_PRIVADAS_COMPARADOR.has(t.name), `${t.name} debe ser privada en el comparador`);
  }
  // ninguna otra tabla se reordena ni se oculta
  const conOrden = TABLES_IN_ORDER.filter((t) => t.ordenFisicaPorClave).map((t) => t.name).sort();
  assert.deepEqual(conOrden, ["votaciones_internas_participacion", "votaciones_internas_urna"]);
  assert.equal(TABLAS_PRIVADAS_COMPARADOR.size, 2);
});

// ---- ejecutarD1Paginado con PK compuesta (npx falso) ----

function conNpxFalso(respuestas, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "npx-falso-"));
  const log = path.join(dir, "log.jsonl");
  const cola = path.join(dir, "respuestas.json");
  fs.writeFileSync(cola, JSON.stringify(respuestas));
  fs.writeFileSync(
    path.join(dir, "npx"),
    `#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const q = JSON.parse(fs.readFileSync(${JSON.stringify(cola)}, "utf8"));
const r = q.shift() || [];
fs.writeFileSync(${JSON.stringify(cola)}, JSON.stringify(q));
process.stdout.write(JSON.stringify([{ results: r }]));
`,
    { mode: 0o755 }
  );
  const pathOriginal = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${pathOriginal}`;
  const restaurar = () => {
    process.env.PATH = pathOriginal;
  };
  return fn(() => fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)[JSON.parse(l).indexOf("--command") + 1]))
    .finally(restaurar);
}

test("ejecutarD1Paginado con PK compuesta pagina por valores de fila y no se salta filas de la misma votación", {
  skip: process.platform === "win32" && "usa un npx falso de shell",
}, async () => {
  const filas = [
    { votacion_id: 1, usuario_id: 2 },
    { votacion_id: 1, usuario_id: 3 },
    { votacion_id: 1, usuario_id: 4 }, // misma votacion_id que la última de la página 1
  ];
  await conNpxFalso([filas.slice(0, 2), filas.slice(2)], async (sqls) => {
    const vistas = [];
    const total = await ejecutarD1Paginado(
      "votaciones_internas_participacion",
      ["votacion_id", "usuario_id"],
      async (pagina) => vistas.push(...pagina),
      { tamanoPagina: 2 }
    );
    assert.equal(total, 3);
    assert.deepEqual(vistas, filas);
    const consultas = sqls();
    assert.equal(consultas.length, 2);
    assert.match(consultas[0], /^SELECT \* FROM votaciones_internas_participacion ORDER BY votacion_id, usuario_id ASC LIMIT 2;$/);
    assert.match(
      consultas[1],
      /WHERE \(votacion_id, usuario_id\) > \(1, 3\) ORDER BY votacion_id, usuario_id ASC LIMIT 2;$/
    );
  });
});

test("ejecutarD1Paginado con PK simple mantiene el SQL de siempre", {
  skip: process.platform === "win32" && "usa un npx falso de shell",
}, async () => {
  await conNpxFalso([[{ id: 1 }, { id: 2 }], [{ id: 3 }]], async (sqls) => {
    await ejecutarD1Paginado("polls", "id", async () => {}, { tamanoPagina: 2 });
    const c = sqls();
    assert.match(c[0], /^SELECT \* FROM polls ORDER BY id ASC LIMIT 2;$/);
    assert.match(c[1], /^SELECT \* FROM polls WHERE id > 2 ORDER BY id ASC LIMIT 2;$/);
  });
});

// ---- conflictos UNIQUE resolubles ----

function clienteFalso({ obsoletas, falloInsert }) {
  const log = [];
  let inserts = 0;
  return {
    log,
    async query(sql, params = []) {
      const texto = sql.replace(/\s+/g, " ").trim();
      log.push({ sql: texto, params });
      if (/^INSERT INTO/.test(texto)) {
        if (inserts++ === 0 && falloInsert) throw falloInsert;
        return { rows: [{ inserted: true }], rowCount: 1 };
      }
      if (/^SELECT .* FROM .* WHERE .* AND NOT/.test(texto)) return { rows: obsoletas, rowCount: obsoletas.length };
      return { rows: [], rowCount: 1 };
    },
  };
}
const error23505 = (constraint, detail) =>
  Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: "23505", constraint, detail });

test("push_subscriptions: re-suscripción con el mismo endpoint borra la fila obsoleta y reintenta", async () => {
  const client = clienteFalso({
    obsoletas: [{ id: 3 }],
    falloInsert: error23505("push_subscriptions_endpoint_key", "Key (endpoint)=(https://push.example/3) already exists."),
  });
  const fila = { id: 5, endpoint: "https://push.example/3", p256dh: "x" };
  const detalle = { deleted: 0 };
  const res = await upsertFilaResolviendoConflicto(client, "push_subscriptions", fila, ["id", "endpoint", "p256dh"], ["id"], {
    runId: "r1",
    detalle,
    leerD1: async () => [], // id 3 ya no existe en D1
  });
  assert.equal(res, "inserted");
  assert.equal(detalle.deleted, 1);
  const select = client.log.find((q) => q.sql.startsWith('SELECT "id" FROM "push_subscriptions"'));
  assert.match(select.sql, /WHERE "endpoint" = \$1 AND NOT \("id" = \$2\)/);
  assert.deepEqual(select.params, ["https://push.example/3", 5]);
  assert.ok(client.log.some((q) => q.sql.startsWith('DELETE FROM "push_subscriptions"') && q.params[0] === 3));
});

test("votos nominales: UNIQUE(opcion_id, usuario_id) compuesto se resuelve por constraint y por detalle", async () => {
  for (const err of [
    error23505("votaciones_internas_votos_opcion_id_usuario_id_key", "Key (opcion_id, usuario_id)=(1, 2) already exists."),
    // nombre de constraint distinto (p. ej. creado a mano): se reconoce por el detalle
    error23505("otro_nombre", "Key (opcion_id, usuario_id)=(1, 2) already exists."),
  ]) {
    const client = clienteFalso({ obsoletas: [{ id: 1 }], falloInsert: err });
    const fila = { id: 3, votacion_id: 1, opcion_id: 1, usuario_id: 2 };
    const res = await upsertFilaResolviendoConflicto(
      client,
      "votaciones_internas_votos",
      fila,
      ["id", "votacion_id", "opcion_id", "usuario_id"],
      ["id"],
      { leerD1: async () => [] }
    );
    assert.equal(res, "inserted");
    const select = client.log.find((q) => q.sql.startsWith('SELECT "id" FROM "votaciones_internas_votos"'));
    assert.match(select.sql, /WHERE "opcion_id" = \$1 AND "usuario_id" = \$2 AND NOT \("id" = \$3\)/);
    assert.deepEqual(select.params, [1, 2, 3]);
  }
});

test("votos nominales: si la fila vieja sigue viva en D1 no se borra nada", async () => {
  const client = clienteFalso({
    obsoletas: [{ id: 1 }],
    falloInsert: error23505("votaciones_internas_votos_opcion_id_usuario_id_key", "Key (opcion_id, usuario_id)=(1, 2) already exists."),
  });
  await assert.rejects(
    upsertFilaResolviendoConflicto(client, "votaciones_internas_votos", { id: 3, opcion_id: 1, usuario_id: 2 }, ["id", "opcion_id", "usuario_id"], ["id"], {
      leerD1: async () => [{ id: 1 }],
    }),
    /sigue existiendo en D1/
  );
  assert.ok(!client.log.some((q) => q.sql.startsWith("DELETE")));
});

test("un UNIQUE no listado (otra columna de push_subscriptions) no se toca", async () => {
  const err = error23505("push_subscriptions_auth_key", "Key (auth)=(a) already exists.");
  const client = clienteFalso({ obsoletas: [{ id: 1 }], falloInsert: err });
  await assert.rejects(
    upsertFilaResolviendoConflicto(client, "push_subscriptions", { id: 2, auth: "a" }, ["id", "auth"], ["id"], { leerD1: async () => [] }),
    err
  );
  assert.equal(client.log.length, 1);
});

// ---- desacoplar usuario / reordenar ----

test("desacoplarUsuarioHuerfano suelta creado_por y borra votos y participación del usuario", async () => {
  const sqls = [];
  await desacoplarUsuarioHuerfano({ query: async (sql, params) => { sqls.push({ sql, params }); return { rows: [], rowCount: 0 }; } }, 9);
  const t = sqls.map((q) => q.sql);
  assert.ok(t.includes("UPDATE votaciones_internas SET creado_por = NULL WHERE creado_por = $1"));
  assert.ok(t.includes("DELETE FROM votaciones_internas_votos WHERE usuario_id = $1"));
  assert.ok(t.includes("DELETE FROM votaciones_internas_participacion WHERE usuario_id = $1"));
  assert.ok(sqls.every((q) => q.params[0] === 9));
  // la urna NO tiene usuario: no se toca (y no debe poder tocarse por usuario)
  assert.ok(!t.some((q) => q.includes("votaciones_internas_urna")));
});

test("reordenarTablaPorClave hace CLUSTER por el índice de la PK; sin PK lanza", async () => {
  const log = [];
  const ok = { query: async (sql, params) => { log.push(sql.replace(/\s+/g, " ").trim()); return /pg_index/.test(sql) ? { rows: [{ indice: "votaciones_internas_urna_pkey" }] } : { rows: [] }; } };
  assert.equal(await reordenarTablaPorClave(ok, "votaciones_internas_urna"), "votaciones_internas_urna_pkey");
  assert.equal(log.at(-1), 'CLUSTER "votaciones_internas_urna" USING "votaciones_internas_urna_pkey";');
  await assert.rejects(reordenarTablaPorClave({ query: async () => ({ rows: [] }) }, "sin_pk"), /no tiene clave primaria/);
});
