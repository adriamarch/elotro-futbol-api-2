// Prueba de integración del 2FA obligatorio para admins.
// Ejecuta el handler REAL (src/index.js) contra una base SQLite en memoria
// que imita la API de D1. Uso:
//   node --test tests/dos-pasos.test.mjs
//   WORKER_ENTRY=../worker-secondary/src/index.js node --test tests/dos-pasos.test.mjs
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

async function api(ruta, { method = "GET", body, token } = {}) {
  const req = new Request("https://api.test" + ruta, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
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

test("un redactor sigue entrando solo con contraseña", async () => {
  await crearUsuario("redactor1", "redactor");
  const r = await api("/api/login", { method: "POST", body: { username: "redactor1", password: "una-clave-larga-1" } });
  assert.equal(r.status, 200);
  assert.ok(r.data.token);
  assert.equal(r.data.requiere_2fa, undefined);
});

test("un admin con la contraseña correcta NO recibe sesión, solo un desafío", async () => {
  estado.adminId = await crearUsuario("admin1", "admin");
  const r = await api("/api/login", { method: "POST", body: { username: "admin1", password: "una-clave-larga-1" } });
  assert.equal(r.status, 200);
  assert.equal(r.data.token, undefined);
  assert.equal(r.data.requiere_configurar_2fa, true);
  assert.ok(r.data.desafio);
  estado.desafio = r.data.desafio;
  const mala = await api("/api/login", { method: "POST", body: { username: "admin1", password: "otra" } });
  assert.equal(mala.status, 401);
});

test("el desafío no sirve como sesión", async () => {
  const r = await api("/api/me", { token: estado.desafio });
  assert.equal(r.status, 401);
});

test("configurar: setup + código incorrecto + activar", async () => {
  const setup = await api("/api/login/2fa/setup", { method: "POST", body: { desafio: estado.desafio } });
  assert.equal(setup.status, 200);
  assert.match(setup.data.secreto, /^[A-Z2-7]{32}$/);
  assert.match(setup.data.otpauth, /^otpauth:\/\/totp\/ElOtroFutbol:admin1\?secret=/);
  const guardado = sqlite.prepare("SELECT totp_secret, totp_activo FROM users WHERE id = ?").get(estado.adminId);
  assert.ok(guardado.totp_secret.startsWith("v1:"), "el secreto se guarda cifrado");
  assert.ok(!guardado.totp_secret.includes(setup.data.secreto));
  assert.equal(guardado.totp_activo, 0);
  estado.secreto = setup.data.secreto;

  const mal = await api("/api/login/2fa/activar", { method: "POST", body: { desafio: estado.desafio, codigo: "000000" } });
  assert.equal(mal.status, 401);

  const paso = pasoActual();
  const ok = await api("/api/login/2fa/activar", { method: "POST", body: { desafio: estado.desafio, codigo: await totp(estado.secreto, paso) } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  assert.equal(ok.data.codigos_recuperacion.length, 8);
  assert.equal(ok.data.user.rol, "admin");
  estado.token = ok.data.token;
  estado.recuperacion = ok.data.codigos_recuperacion;
  estado.paso = paso;
  const fila = sqlite.prepare("SELECT totp_activo, totp_recovery FROM users WHERE id = ?").get(estado.adminId);
  assert.equal(fila.totp_activo, 1);
  assert.ok(!fila.totp_recovery.includes(estado.recuperacion[0]), "solo se guardan hashes de los códigos de recuperación");
});

test("la sesión con 2FA funciona; un token de admin SIN 2FA se rechaza", async () => {
  const bien = await api("/api/me", { token: estado.token });
  assert.equal(bien.status, 200);
  const sid = "sesion-antigua";
  sqlite.prepare("INSERT INTO sessions (id, user_id) VALUES (?, ?)").run(sid, estado.adminId);
  const viejo = await jwtFalso({ uid: estado.adminId, username: "admin1", nombre: "N", rol: "admin", sid });
  assert.equal((await api("/api/me", { token: viejo })).status, 401);
  // El servidor exige que el usuario exista y esté activo, así que el redactor debe existir de verdad.
  const redactorId = await crearUsuario("redactor-sin-2fa", "redactor");
  const redactorViejo = await jwtFalso({ uid: redactorId, username: "redactor-sin-2fa", nombre: "R", rol: "redactor" });
  assert.equal((await api("/api/me", { token: redactorViejo })).status, 200, "el resto de roles no se ve afectado");
});

test("segundo login: pide código; el código ya usado se rechaza; el del siguiente intervalo vale", async () => {
  const l = await api("/api/login", { method: "POST", body: { username: "admin1", password: "una-clave-larga-1" } });
  assert.equal(l.data.requiere_2fa, true);
  assert.equal(l.data.token, undefined);
  const desafio = l.data.desafio;
  const repetido = await api("/api/login/2fa", { method: "POST", body: { desafio, codigo: await totp(estado.secreto, estado.paso) } });
  assert.equal(repetido.status, 401, "no se puede reutilizar el código con el que se activó");
  const siguiente = await api("/api/login/2fa", { method: "POST", body: { desafio, codigo: await totp(estado.secreto, estado.paso + 1) } });
  assert.equal(siguiente.status, 200);
  assert.ok(siguiente.data.token);
  assert.equal((await api("/api/me", { token: siguiente.data.token })).status, 200);
  const otra = await api("/api/login/2fa", { method: "POST", body: { desafio, codigo: await totp(estado.secreto, estado.paso + 1) } });
  assert.equal(otra.status, 401, "tampoco el del intervalo siguiente dos veces");
  assert.equal((await api("/api/login/2fa", { method: "POST", body: { desafio: "basura", codigo: "123456" } })).status, 401);
});

test("código de recuperación: vale una sola vez", async () => {
  const l = await api("/api/login", { method: "POST", body: { username: "admin1", password: "una-clave-larga-1" } });
  const codigo = estado.recuperacion[0];
  const ok = await api("/api/login/2fa", { method: "POST", body: { desafio: l.data.desafio, codigo: codigo.toLowerCase() } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.codigos_recuperacion_restantes, 7);
  const l2 = await api("/api/login", { method: "POST", body: { username: "admin1", password: "una-clave-larga-1" } });
  const otra = await api("/api/login/2fa", { method: "POST", body: { desafio: l2.data.desafio, codigo } });
  assert.equal(otra.status, 401);
});

test("otro admin puede restablecer el 2FA; uno mismo no; un redactor no", async () => {
  const id2 = await crearUsuario("admin2", "admin");
  const l = await api("/api/login", { method: "POST", body: { username: "admin2", password: "una-clave-larga-1" } });
  assert.equal(l.data.requiere_configurar_2fa, true);
  const yo = await api(`/api/users/${estado.adminId}/reset-2fa`, { method: "PUT", token: estado.token });
  assert.equal(yo.status, 400);
  const rl = await api("/api/login", { method: "POST", body: { username: "redactor1", password: "una-clave-larga-1" } });
  assert.equal((await api(`/api/users/${id2}/reset-2fa`, { method: "PUT", token: rl.data.token })).status, 403);
  const ok = await api(`/api/users/${estado.adminId === id2 ? 0 : id2}/reset-2fa`, { method: "PUT", token: estado.token });
  assert.equal(ok.status, 200);
  // y a admin1 le restablece admin2 (tras configurar el suyo)
  const s = await api("/api/login/2fa/setup", { method: "POST", body: { desafio: l.data.desafio } });
  const act = await api("/api/login/2fa/activar", { method: "POST", body: { desafio: l.data.desafio, codigo: await totp(s.data.secreto, pasoActual()) } });
  assert.equal(act.status, 200);
  const r = await api(`/api/users/${estado.adminId}/reset-2fa`, { method: "PUT", token: act.data.token });
  assert.equal(r.status, 200);
  const fila = sqlite.prepare("SELECT totp_activo, totp_secret, totp_recovery FROM users WHERE id = ?").get(estado.adminId);
  assert.equal(fila.totp_activo, 0);
  assert.equal(fila.totp_secret, null);
  const l3 = await api("/api/login", { method: "POST", body: { username: "admin1", password: "una-clave-larga-1" } });
  assert.equal(l3.data.requiere_configurar_2fa, true, "tras el restablecimiento debe configurarlo de nuevo");
  const abiertas = sqlite.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND revoked_at IS NULL").get(estado.adminId).n;
  assert.equal(abiertas, 0, "sus sesiones quedan revocadas");
});
