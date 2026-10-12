// Regresión: 2FA con la migración SIN aplicar + CORS en las respuestas de failover.
// Bug original: /api/login/2fa/setup -> 500 "no such column: totp_secret" -> failover a
// Railway -> respuesta final sin cabeceras CORS -> el navegador solo mostraba "blocked by CORS".
//   node --test tests/dos-pasos-esquema.test.mjs
//   WORKER_ENTRY=../worker-secondary/src/index.js node --test tests/dos-pasos-esquema.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const entrada = process.env.WORKER_ENTRY
  ? new URL(process.env.WORKER_ENTRY, import.meta.url).href
  : new URL("../src/index.js", import.meta.url).href;
const worker = (await import(entrada)).default;

const JWT_SECRET = "secreto-de-pruebas-0123456789abcdef";
const ORIGEN = "https://elotrofutbol.media";

// users SIN columnas totp_* (base de datos anterior a la migración)
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, salt TEXT, nombre TEXT, rol TEXT DEFAULT 'redactor', activo INTEGER DEFAULT 1, email TEXT, avatar_url TEXT, avatar_foco TEXT, categorias_fijas TEXT, nivel INTEGER DEFAULT 1);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, user_agent TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')), last_seen_at TEXT DEFAULT (datetime('now')), revoked_at TEXT);
CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER, usuario_nombre TEXT, usuario_rol TEXT, accion TEXT, entidad TEXT, entidad_id TEXT, descripcion TEXT, detalle TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')));
`);
const limpiar = (a) => a.map((v) => (v === undefined ? null : v));
function crearDB(romperSi) {
  return {
    prepare(sql) {
      const st = sqlite.prepare(sql);
      const mk = (args) => ({
        first: async () => st.get(...limpiar(args)) ?? null,
        all: async () => ({ results: st.all(...limpiar(args)) }),
        run: async () => {
          if (romperSi && romperSi(sql)) throw new Error("fallo simulado de la base de datos");
          const r = st.run(...limpiar(args));
          return { meta: { changes: Number(r.changes) } };
        },
      });
      return { ...mk([]), bind: (...args) => mk(args) };
    },
  };
}
const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}) };

async function api(env, ruta, body) {
  const res = await worker.fetch(new Request("https://api.test" + ruta, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGEN },
    body: JSON.stringify(body),
  }), env, ctx);
  return { status: res.status, acao: res.headers.get("Access-Control-Allow-Origin"), data: await res.json().catch(() => ({})) };
}
async function pbkdf2(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256));
  return [...bits].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function base32Dec(t) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, v = 0; const out = [];
  for (const c of t.replace(/[^A-Z2-7]/g, "")) { v = (v << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return new Uint8Array(out);
}
async function totp(secretoB32, paso) {
  const k = await crypto.subtle.importKey("raw", base32Dec(secretoB32), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const c = new Uint8Array(8); let r = paso; for (let i = 7; i >= 0; i--) { c[i] = r & 255; r = Math.floor(r / 256); }
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, c)); const o = h[19] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000).padStart(6, "0");
}

const salt = "00112233445566778899aabbccddeeff";
sqlite.prepare("INSERT INTO users (username, password_hash, salt, nombre, rol, email) VALUES (?,?,?,?,?,?)")
  .run("admin1", await pbkdf2("una-clave-larga-1", salt), salt, "Admin", "admin", "a@x.es");

test("sin migración aplicada: el 2FA crea las columnas solo y se puede configurar y entrar", async () => {
  const env = { DB: crearDB(), JWT_SECRET };
  const columnasAntes = sqlite.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  assert.ok(!columnasAntes.includes("totp_secret"), "la prueba debe partir sin las columnas");

  const login = await api(env, "/api/login", { username: "admin1", password: "una-clave-larga-1" });
  assert.equal(login.status, 200);
  assert.equal(login.acao, ORIGEN);
  assert.equal(login.data.requiere_configurar_2fa, true);

  const setup = await api(env, "/api/login/2fa/setup", { desafio: login.data.desafio });
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  assert.equal(setup.acao, ORIGEN);
  assert.match(setup.data.secreto, /^[A-Z2-7]{32}$/);

  const columnasDespues = sqlite.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  for (const c of ["totp_secret", "totp_activo", "totp_ultimo_paso", "totp_recovery"]) assert.ok(columnasDespues.includes(c), "falta " + c);

  const codigo = await totp(setup.data.secreto, Math.floor(Date.now() / 30000));
  const activar = await api(env, "/api/login/2fa/activar", { desafio: login.data.desafio, codigo });
  assert.equal(activar.status, 200, JSON.stringify(activar.data));
  assert.ok(activar.data.token);
  assert.equal(activar.data.codigos_recuperacion.length, 8);
});

test("ejecutar la migración a mano DESPUÉS de la auto-reparación no rompe nada (idempotente)", async () => {
  // Las columnas ya existen: la comprobación debe pasar sin tocar nada.
  const env = { DB: crearDB(), JWT_SECRET };
  const login = await api(env, "/api/login", { username: "admin1", password: "una-clave-larga-1" });
  assert.equal(login.status, 200);
  assert.equal(login.data.requiere_2fa, true); // ya activado en la prueba anterior
});

test("si el primario falla y el failover también, el error llega CON CORS (y no como un 'CORS' engañoso)", async () => {
  // El UPDATE del setup falla -> 500 del primario -> reenvío a Railway -> Railway inalcanzable.
  const env = {
    DB: crearDB((sql) => /UPDATE users SET totp_secret/.test(sql)),
    JWT_SECRET,
    RAILWAY_URL: "http://127.0.0.1:9", // puerto cerrado: conexión rechazada al instante
  };
  sqlite.prepare("UPDATE users SET totp_activo = 0, totp_secret = NULL WHERE username = 'admin1'").run();
  const login = await api(env, "/api/login", { username: "admin1", password: "una-clave-larga-1" });
  const setup = await api(env, "/api/login/2fa/setup", { desafio: login.data.desafio });
  assert.equal(setup.status, 503);
  assert.equal(setup.acao, ORIGEN, "la respuesta de failover debe llevar Access-Control-Allow-Origin");
  assert.equal(setup.data.backend, "RAILWAY");
});

test("un origen NO permitido sigue sin recibir Access-Control-Allow-Origin en el failover", async () => {
  const env = { DB: crearDB((sql) => /UPDATE users SET totp_secret/.test(sql)), JWT_SECRET, RAILWAY_URL: "http://127.0.0.1:9" };
  const login = await api(env, "/api/login", { username: "admin1", password: "una-clave-larga-1" });
  const res = await worker.fetch(new Request("https://api.test/api/login/2fa/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://web-ajena.example" },
    body: JSON.stringify({ desafio: login.data.desafio }),
  }), env, ctx);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});
