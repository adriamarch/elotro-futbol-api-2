// Prueba de integración: el 2FA solo se pide en dispositivos NUEVOS (dispositivo de confianza).
// Ejecuta el handler REAL (src/index.js) contra una base SQLite en memoria que imita la API de D1. Uso:
//   node --test tests/dos-pasos-dispositivo.test.mjs
//   WORKER_ENTRY=../worker-secondary/src/index.js node --test tests/dos-pasos-dispositivo.test.mjs
//   node --test tests/dos-pasos-opcional.test.mjs
//   WORKER_ENTRY=../worker-secondary/src/index.js node --test tests/dos-pasos-opcional.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const entrada = process.env.WORKER_ENTRY
  ? new URL(process.env.WORKER_ENTRY, import.meta.url).href
  : new URL("../src/index.js", import.meta.url).href;
const worker = (await import(entrada)).default;

const JWT_SECRET = "secreto-de-pruebas-0123456789abcdef";

// ---- D1 falso sobre node:sqlite ----
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`
CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, salt TEXT, nombre TEXT, rol TEXT DEFAULT 'redactor', activo INTEGER DEFAULT 1, email TEXT, avatar_url TEXT, avatar_foco TEXT, categorias_fijas TEXT, nivel INTEGER DEFAULT 1,
  totp_secret TEXT, totp_activo INTEGER NOT NULL DEFAULT 0, totp_ultimo_paso INTEGER, totp_recovery TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER, user_agent TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')), last_seen_at TEXT DEFAULT (datetime('now')), revoked_at TEXT);
CREATE TABLE activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER, usuario_nombre TEXT, usuario_rol TEXT, accion TEXT, entidad TEXT, entidad_id TEXT, descripcion TEXT, detalle TEXT, ip TEXT, created_at TEXT DEFAULT (datetime('now')));
`);
const limpiar = (a) => a.map((v) => (v === undefined ? null : v));
const DB = {
  prepare(sql) {
    const st = sqlite.prepare(sql);
    const mk = (args) => ({
      first: async () => st.get(...limpiar(args)) ?? null,
      all: async () => ({ results: st.all(...limpiar(args)) }),
      run: async () => { const r = st.run(...limpiar(args)); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    });
    return { ...mk([]), bind: (...args) => mk(args) };
  },
};
const env = { DB, JWT_SECRET };
const ctx = { waitUntil: (p) => Promise.resolve(p).catch(() => {}) };

async function api(ruta, { method = "GET", body, token, ua } = {}) {
  const req = new Request("https://api.test" + ruta, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...(ua ? { "User-Agent": ua } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, ctx);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ---- utilidades de la prueba ----
async function pbkdf2(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256));
  return [...bits].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function crearUsuario(username, rol, password = "una-clave-larga-1") {
  const salt = "00112233445566778899aabbccddeeff";
  sqlite.prepare("INSERT INTO users (username, password_hash, salt, nombre, rol, email) VALUES (?,?,?,?,?,?)")
    .run(username, await pbkdf2(password, salt), salt, "Nombre " + username, rol, username + "@x.es");
  return sqlite.prepare("SELECT id FROM users WHERE username = ?").get(username).id;
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
const pasoActual = () => Math.floor(Date.now() / 30000);
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
async function jwtFalso(payload) {
  const data = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ ...payload, exp: Math.floor(Date.now() / 1000) + 600 })}`;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(JWT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  // Igual que signHS256 del worker: la firma (bytes) se pasa por String.fromCharCode y
  // luego por b64url (que codifica ese texto en UTF-8).
  const firma = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return data + "." + Buffer.from(new TextEncoder().encode(String.fromCharCode(...firma))).toString("base64url");
}

const estado = {};
const PW = "una-clave-larga-1";
const login = (username, extra = {}, dispositivo) => api("/api/login", { method: "POST", body: { username, password: PW, ...(dispositivo ? { dispositivo } : {}) }, ...extra });
const post = (ruta, body, token) => api(ruta, { method: "POST", body, token });

test("admin: primer acceso en un dispositivo nuevo configura el 2FA y recibe token de dispositivo", async () => {
  estado.adm = await crearUsuario("adm", "admin");
  const l = await login("adm");
  assert.equal(l.data.requiere_configurar_2fa, true);
  const s = await post("/api/login/2fa/setup", { desafio: l.data.desafio });
  estado.secreto = s.data.secreto;
  estado.paso = pasoActual();
  const ok = await post("/api/login/2fa/activar", { desafio: l.data.desafio, codigo: await totp(estado.secreto, estado.paso), recordar: true });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token && ok.data.dispositivo, "devuelve sesión y token de dispositivo");
  assert.equal(ok.data.dispositivo.split(".").length, 3);
  estado.disp = ok.data.dispositivo;
});

test("dispositivo nuevo (sin token): sigue pidiendo el código; token basura o de otro usuario tampoco vale", async () => {
  const sin = await login("adm");
  assert.equal(sin.data.requiere_2fa, true);
  assert.equal(sin.data.token, undefined);
  for (const malo of ["basura", estado.disp.slice(0, -3) + "abc", "a.b.c"]) {
    const r = await login("adm", {}, malo);
    assert.equal(r.data.requiere_2fa, true, "token no válido => código");
    assert.equal(r.data.token, undefined);
  }
  await crearUsuario("otro", "admin");
  const otro = await login("otro", {}, estado.disp);
  assert.notEqual(otro.data.token !== undefined, true, "el token de un usuario no sirve para otro");
  assert.ok(otro.data.requiere_configurar_2fa || otro.data.requiere_2fa);
});

test("dispositivo de confianza: contraseña + token => sesión directa con la marca de 2FA, y el token se renueva", async () => {
  const l = await login("adm", { ua: "Chrome-PC" }, estado.disp);
  assert.equal(l.status, 200);
  assert.equal(l.data.requiere_2fa, undefined);
  assert.ok(l.data.token, "abre sesión sin pedir el código");
  assert.equal(l.data.user.rol, "admin");
  assert.ok(l.data.dispositivo, "renueva el token");
  assert.equal((await api("/api/me", { token: l.data.token })).status, 200, "la sesión de un admin vale (lleva tfa)");
  estado.disp = l.data.dispositivo;
});

test("sin contraseña correcta el token NO basta", async () => {
  const r = await api("/api/login", { method: "POST", body: { username: "adm", password: "mala-mala-12", dispositivo: estado.disp } });
  assert.equal(r.status, 401);
  assert.equal(r.data.token, undefined);
});

test("el token de dispositivo no sirve como sesión ni como desafío", async () => {
  assert.equal((await api("/api/me", { token: estado.disp })).status, 401);
  assert.equal((await post("/api/login/2fa", { desafio: estado.disp, codigo: await totp(estado.secreto, estado.paso + 1) })).status, 401);
});

test("recordar = false (ordenador compartido): no se entrega token de dispositivo", async () => {
  const l = await login("adm");
  assert.equal(l.data.requiere_2fa, true);
  sqlite.prepare("UPDATE users SET totp_ultimo_paso = ? WHERE id = ?").run(estado.paso, estado.adm);
  const ok = await post("/api/login/2fa", { desafio: l.data.desafio, codigo: await totp(estado.secreto, estado.paso + 1) });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  assert.equal(ok.data.dispositivo, undefined);
  const ok2 = await (async () => {
    const l2 = await login("adm");
    sqlite.prepare("UPDATE users SET totp_ultimo_paso = ? WHERE id = ?").run(estado.paso, estado.adm);
    return post("/api/login/2fa", { desafio: l2.data.desafio, codigo: await totp(estado.secreto, estado.paso + 1), recordar: true });
  })();
  assert.ok(ok2.data.dispositivo, "con recordar = true sí");
});

test("cambiar la contraseña invalida todos los dispositivos de confianza", async () => {
  const l = await login("adm", {}, estado.disp);
  assert.ok(l.data.token);
  const cambio = await api("/api/me/password", { method: "PUT", token: l.data.token, body: { actual: PW, nueva: "otra-clave-larga-2" } });
  assert.equal(cambio.status, 200);
  const r = await api("/api/login", { method: "POST", body: { username: "adm", password: "otra-clave-larga-2", dispositivo: estado.disp } });
  assert.equal(r.data.requiere_2fa, true, "tras cambiar la contraseña vuelve a pedir el código");
  assert.equal(r.data.token, undefined);
});

test("restablecer el 2FA (nuevo secreto) invalida los dispositivos de confianza", async () => {
  await crearUsuario("redac", "redactor");
  const base = await login("redac");
  const tk = base.data.token;
  const s = await post("/api/me/2fa/setup", { password: PW }, tk);
  const paso = pasoActual();
  const act = await post("/api/me/2fa/activar", { codigo: await totp(s.data.secreto, paso) }, tk);
  assert.equal(act.status, 200);
  assert.ok(act.data.dispositivo, "el dispositivo donde se activa queda de confianza");
  assert.equal((await login("redac", {}, act.data.dispositivo)).data.requiere_2fa, undefined);
  assert.ok((await login("redac", {}, act.data.dispositivo)).data.token);
  assert.equal((await login("redac")).data.requiere_2fa, true, "otro dispositivo sin token => código");
  // un admin lo restablece (misma operación que la insignia "2FA activo ✕"): se borran los campos totp_*
  sqlite.prepare("UPDATE users SET totp_secret = NULL, totp_activo = 0, totp_ultimo_paso = NULL, totp_recovery = NULL WHERE username = 'redac'").run();
  sqlite.prepare("UPDATE users SET totp_secret = 'v1:nuevo', totp_activo = 1 WHERE username = 'redac'").run();
  const r = await login("redac", {}, act.data.dispositivo);
  assert.equal(r.data.requiere_2fa, true, "con otro secreto el token antiguo ya no vale");
  assert.equal(r.data.token, undefined);
});

test("sin 2FA activo el token es irrelevante: entra como siempre y no se emite token de dispositivo", async () => {
  await crearUsuario("libre", "redactor");
  const r = await login("libre", {}, estado.disp);
  assert.ok(r.data.token);
  assert.equal(r.data.dispositivo, undefined);
});

test("el token de dispositivo caduca (30 días)", async () => {
  const p = JSON.parse(Buffer.from(estado.disp.split(".")[1], "base64url").toString());
  assert.ok(p.td && p.f && !p.uid);
  const dias = (p.exp - p.iat) / 86400;
  assert.equal(Math.round(dias), 30);
});
