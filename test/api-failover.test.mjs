
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const configSource = fs.readFileSync(
  new URL("../../public/js/config.js", import.meta.url),
  "utf8"
);

// IMPORTANTE: este harness debe reflejar los nombres REALES de
// public/js/config.js (PRIMARY_API, SECONDARY_API, eofApiState,
// EOF_CIRCUIT_*). Si config.js cambia esos nombres, este archivo debe
// actualizarse en el mismo commit -- de lo contrario los tests fallan en
// bloque (referencia indefinida) y dejan de proteger nada, que es
// exactamente lo que pasaba antes de esta reescritura: config.js había
// evolucionado de apiOrigin()/API_FAILOVER_STATE a
// PRIMARY_API/SECONDARY_API/eofApiState y los 7 tests fallaban en bloque
// mientras la documentación (FASE5-resultado.md) seguía afirmando
// "8/8 PASS".
function createHarness(fetchImpl, { secondaryUrl = "https://secondary.example.test" } = {}) {
  const window = { EOF_SECONDARY_API_URL: secondaryUrl };
  const context = {
    window,
    console,
    fetch: fetchImpl,
    Response,
    Headers,
    URL,
    AbortController,
    DOMException,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    Date,
    JSON,
    Math,
    String,
    Boolean,
    Number,
    Object,
    Array,
    Promise,
    Error,
    TypeError,
  };
  vm.createContext(context);
  vm.runInContext(configSource, context, { filename: "config.js" });
  return context;
}

// PRIMARY_API es una const fijada por config.js al valor real de producción
// (api.elotrofutbol.media). No se puede reasignar desde el test, así
// que en vez de sustituirla, cada test usa esa URL real como "primaria" y
// hace que el fetchImpl responda según el host recibido.
const PRIMARY = "https://api.elotrofutbol.media";
const SECONDARY = "https://secondary.example.test";

test("GET: error de red en primaria hace failover a secundaria", async () => {
  const calls = [];
  const ctx = createHarness(async (url) => {
    calls.push(String(url));
    if (String(url).startsWith(PRIMARY)) {
      throw new TypeError("network");
    }
    return new Response(JSON.stringify({ ok: true, source: "secondary" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  const response = await vm.runInContext(`apiFetch("/api/articles")`, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    `${PRIMARY}/api/articles`,
    `${SECONDARY}/api/articles`,
  ]);
  assert.equal(vm.runInContext(`eofApiState.activa`, ctx), "SECONDARY");
});

test("GET: 401 no hace failover", async () => {
  const calls = [];
  const ctx = createHarness(async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: "No autorizado" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  });

  const response = await vm.runInContext(`apiFetch("/api/me")`, ctx);
  assert.equal(response.status, 401);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], `${PRIMARY}/api/me`);
});

test("GET: 404 JSON de la app (no existe) no hace failover", async () => {
  const calls = [];
  const ctx = createHarness(async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ error: "No encontrado" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  });
  const response = await vm.runInContext(`apiFetch("/api/missing")`, ctx);
  assert.equal(response.status, 404);
  assert.deepEqual(calls, [`${PRIMARY}/api/missing`]);
});

test("GET: 404 sin JSON (Cloudflare, worker caído) SÍ hace failover", async () => {
  const calls = [];
  const ctx = createHarness(async (url) => {
    calls.push(String(url));
    if (String(url).startsWith(PRIMARY)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const response = await vm.runInContext(`apiFetch("/api/articles")`, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [`${PRIMARY}/api/articles`, `${SECONDARY}/api/articles`]);
});

test("GET: 502/503/504 de primaria hacen failover a secundaria", async () => {
  for (const status of [502, 503, 504]) {
    const calls = [];
    const ctx = createHarness(async (url) => {
      calls.push(String(url));
      if (String(url).startsWith(PRIMARY)) {
        return new Response("upstream", { status });
      }
      return new Response("secondary-ok", { status: 200 });
    });
    const response = await vm.runInContext(`apiFetch("/api/articles")`, ctx);
    assert.equal(response.status, 200);
    assert.deepEqual(calls, [
      `${PRIMARY}/api/articles`,
      `${SECONDARY}/api/articles`,
    ]);
  }
});

test("POST: error de red en primaria NO se reintenta en secundaria (evita duplicados)", async () => {
  const calls = [];
  const ctx = createHarness(async (url) => {
    calls.push(String(url));
    throw new TypeError("network");
  });

  await assert.rejects(
    vm.runInContext(`apiFetch("/api/articles", { method: "POST" })`, ctx)
  );
  assert.deepEqual(calls, [`${PRIMARY}/api/articles`]);
});

test("POST: 502 de primaria NO se reintenta en secundaria (se devuelve tal cual)", async () => {
  const calls = [];
  const ctx = createHarness(async (url) => {
    calls.push(String(url));
    if (String(url).startsWith(PRIMARY)) {
      return new Response("upstream down", { status: 502 });
    }
    return new Response("secondary-ok", { status: 200 });
  });
  const response = await vm.runInContext(
    `apiFetch("/api/articles", { method: "POST" })`,
    ctx
  );
  assert.equal(response.status, 502);
  assert.deepEqual(calls, [`${PRIMARY}/api/articles`]);
});

test("POST /api/login SÍ hace failover (no duplica datos de negocio)", async () => {
  const calls = [];
  const ctx = createHarness(async (url) => {
    calls.push(String(url));
    if (String(url).startsWith(PRIMARY)) {
      throw new TypeError("network");
    }
    return new Response(JSON.stringify({ token: "xyz" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const response = await vm.runInContext(
    `apiFetch("/api/login", { method: "POST" })`,
    ctx
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [`${PRIMARY}/api/login`, `${SECONDARY}/api/login`]);
});

test("Circuit breaker: tres fallos abren el circuito y la siguiente lectura evita primaria", async () => {
  const calls = [];
  const ctx = createHarness(async (url) => {
    calls.push(String(url));
    if (String(url).startsWith(PRIMARY)) {
      throw new TypeError("network");
    }
    return new Response("{}", { status: 200 });
  });

  for (let i = 0; i < 3; i++) {
    await vm.runInContext(`apiFetch("/api/articles")`, ctx);
  }

  assert.equal(vm.runInContext(`eofApiState.circuitoAbierto`, ctx), true);

  calls.length = 0;
  const response = await vm.runInContext(`apiFetch("/api/articles")`, ctx);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [`${SECONDARY}/api/articles`]);
});

test("Recuperación: tras abrir circuito, dos respuestas positivas de primaria lo cierran", async () => {
  const calls = [];
  let primaryShouldFail = true;
  const ctx = createHarness(async (url) => {
    calls.push(String(url));
    if (String(url).startsWith(PRIMARY) && primaryShouldFail) {
      throw new TypeError("network");
    }
    return new Response("ok", { status: 200 });
  });

  for (let i = 0; i < 3; i++) {
    await vm.runInContext(`apiFetch("/api/articles")`, ctx);
  }
  assert.equal(vm.runInContext(`eofApiState.circuitoAbierto`, ctx), true);

  primaryShouldFail = false;
  // Forzar que ya haya pasado el tiempo de espera del circuito, para no
  // depender de un sleep real de 30s en el test.
  vm.runInContext(
    `eofApiState.circuitoAbiertoDesde = Date.now() - EOF_CIRCUIT_OPEN_MS - 1`,
    ctx
  );
  await vm.runInContext(`apiFetch("/api/articles")`, ctx);
  assert.equal(vm.runInContext(`eofApiState.oksConsecutivosPrimaria`, ctx), 1);
  assert.equal(vm.runInContext(`eofApiState.circuitoAbierto`, ctx), true);

  vm.runInContext(
    `eofApiState.circuitoAbiertoDesde = Date.now() - EOF_CIRCUIT_OPEN_MS - 1`,
    ctx
  );
  await vm.runInContext(`apiFetch("/api/articles")`, ctx);
  assert.equal(vm.runInContext(`eofApiState.circuitoAbierto`, ctx), false);
  assert.equal(vm.runInContext(`eofApiState.activa`, ctx), "PRIMARY");
  assert.ok(calls.some((url) => url === `${PRIMARY}/api/articles`));
});

test("X-Failover-Backend: si la primaria ya hizo failover server-side a Railway, apiFetch lo refleja como SECONDARY", async () => {
  // Ver worker/src/index.js: fetchRailway() añade X-Failover-Backend cuando
  // el propio Worker (no el navegador) reenvió la petición a Railway y
  // devolvió 200. Sin leer esta cabecera, el navegador creería que la
  // respuesta vino de PRIMARY aunque ya se sirvió desde Railway.
  const ctx = createHarness(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json", "X-Failover-Backend": "RAILWAY" },
    })
  );
  const response = await vm.runInContext(`apiFetch("/api/articles")`, ctx);
  assert.equal(response.status, 200);
  assert.equal(vm.runInContext(`eofApiState.activa`, ctx), "SECONDARY");
});
