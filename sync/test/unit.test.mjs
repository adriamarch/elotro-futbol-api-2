import assert from "node:assert/strict";
import { test } from "node:test";
import { TABLES, TABLES_IN_ORDER, getTable } from "../tables.mjs";
import { conReintentos } from "../retry.mjs";
import { escaparValorD1 } from "../d1-client.mjs";
import { CAMPOS_VOLATILES_COMPARADOR } from "../comparator-config.mjs";

test("todas las tablas sincronizadas están configuradas (17 de Fase 4 + las añadidas después)", () => {
  const nombres = TABLES.map((t) => t.name).sort();
  const esperadas = [
    // 17 originales de Fase 4
    "activity_log",
    "alineaciones",
    "article_slug_redirects",
    "articles",
    "club_info",
    "club_info_solicitudes",
    "comments",
    "custom_clubs",
    "edit_requests",
    "match_events",
    "media",
    "newsletter_suscriptores",
    "nivel_historial",
    "results",
    "sessions",
    "settings",
    "users",
    // añadidas después (lectores, porras, encuestas, tienda, galería...)
    "comment_reports",
    "comment_votes",
    "match_gallery",
    "noticias_rapidas",
    "poll_options",
    "poll_votes",
    "polls",
    "porras",
    "reader_sessions",
    "readers",
    "tienda_pedidos",
    "tienda_productos",
    // Fase 2 de la sincronización completa (paridad de datos del failover)
    "push_subscriptions",
    "votaciones_internas",
    "votaciones_internas_opciones",
    "votaciones_internas_participacion",
    "votaciones_internas_urna",
    "votaciones_internas_votos",
    // failover: tablas que existían en PG pero no se replicaban
    "article_media",
    "equipo_alias_externo",
    "jornadas_calendario",
    "newsletter_envios",
    "recordatorios_inactividad",
    "sync_partidos_auto",
  ].sort();
  assert.deepEqual(nombres, esperadas);
});

test("el orden de sincronización no repite posiciones y respeta dependencias básicas", () => {
  const posiciones = TABLES.map((t) => t.order);
  assert.equal(new Set(posiciones).size, posiciones.length, "hay posiciones de orden duplicadas");

  const indice = Object.fromEntries(TABLES_IN_ORDER.map((t, i) => [t.name, i]));
  // users antes que articles (autor_id -> users)
  assert.ok(indice.users < indice.articles);
  // results antes que articles (resultado_id -> results)
  assert.ok(indice.results < indice.articles);
  // results antes que match_events (resultado_id -> results)
  assert.ok(indice.results < indice.match_events);
  // articles antes que article_slug_redirects (article_id -> articles)
  assert.ok(indice.articles < indice.article_slug_redirects);
  // articles antes que comments (article_id -> articles)
  assert.ok(indice.articles < indice.comments);
  // users antes que sessions (user_id -> users)
  assert.ok(indice.users < indice.sessions);
});

test("toda tabla NO autoritativa con changeStrategy updated_at/immutable usa el cursor esperado", () => {
  // Las autoritativas releen la tabla entera en cada pasada: su cursor es
  // solo informativo (p. ej. readers usa created_at, reader_sessions
  // last_seen_at, poll_options id), así que no se les exige nada.
  for (const t of TABLES) {
    if (t.syncMode === "authoritative") continue;
    if (t.changeStrategy === "updated_at") {
      assert.equal(t.cursorColumn, "updated_at", `${t.name} debería usar updated_at como cursor`);
    }
    if (t.changeStrategy === "immutable") {
      assert.equal(t.cursorColumn, "created_at", `${t.name} debería usar created_at como cursor`);
    }
  }
});

test("getTable lanza para nombres no configurados", () => {
  assert.throws(() => getTable("tabla_inexistente"));
  assert.equal(getTable("users").name, "users");
});

test("conReintentos reintenta y finalmente lanza tras agotar intentos", async () => {
  let llamadas = 0;
  await assert.rejects(
    conReintentos(
      async () => {
        llamadas++;
        throw new Error("fallo simulado");
      },
      { intentos: 3, esperaBaseMs: 1 }
    )
  );
  assert.equal(llamadas, 3);
});

test("conReintentos devuelve el resultado si un intento posterior tiene éxito", async () => {
  let llamadas = 0;
  const resultado = await conReintentos(
    async () => {
      llamadas++;
      if (llamadas < 2) throw new Error("fallo temporal");
      return "ok";
    },
    { intentos: 3, esperaBaseMs: 1 }
  );
  assert.equal(resultado, "ok");
  assert.equal(llamadas, 2);
});

test("escaparValorD1 escapa comillas simples y respeta null/number/boolean", () => {
  assert.equal(escaparValorD1(null), "NULL");
  assert.equal(escaparValorD1(undefined), "NULL");
  assert.equal(escaparValorD1(42), "42");
  assert.equal(escaparValorD1(true), "1");
  assert.equal(escaparValorD1("O'Brien"), "'O''Brien'");
});


test("users, settings y sessions son autoritativas desde D1", () => {
  for (const name of ["users", "settings", "results", "comments", "club_info_solicitudes", "edit_requests", "sessions"]) {
    const t = getTable(name);
    assert.equal(t.syncMode, "authoritative", `${name} debe reconciliarse desde D1`);
    assert.equal(t.deleteDetection, true, `${name} debe eliminar sobrantes en PostgreSQL`);
  }
});


test("el comparador trata sessions.last_seen_at como campo volátil, sin dejar de sincronizarlo", () => {
  assert.equal(CAMPOS_VOLATILES_COMPARADOR.sessions.has("last_seen_at"), true);
  assert.equal(CAMPOS_VOLATILES_COMPARADOR.sessions.has("user_id"), false);
  assert.equal(CAMPOS_VOLATILES_COMPARADOR.sessions.has("expires_at"), false);
});
