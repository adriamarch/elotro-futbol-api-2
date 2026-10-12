// Prueba de integración del 2FA OPCIONAL para colaboradores (redactores y fotógrafos); obligatorio para admins.
// Ejecuta el handler REAL (src/index.js) contra una base SQLite en memoria
// que imita la API de D1. Uso:
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
const login = (username, extra = {}) => api("/api/login", { method: "POST", body: { username, password: PW }, ...extra });
const me2fa = (token) => api("/api/me/2fa", { token });
const post = (ruta, body, token) => api(ruta, { method: "POST", body, token });

test("redactor sin 2FA: entra solo con contraseña y el panel ve que está disponible pero no activo", async () => {
  estado.id = await crearUsuario("redac", "redactor");
  const l = await login("redac", { ua: "Chrome-PC" });
  assert.equal(l.status, 200);
  assert.ok(l.data.token);
  assert.equal(l.data.requiere_2fa, undefined);
  estado.tokenA = l.data.token;
  const e = await me2fa(estado.tokenA);
  assert.deepEqual({ ...e.data }, { disponible: true, obligatorio: false, activo: false, codigos_restantes: 0 });
});

test("empezar a activarlo exige la contraseña; sin sesión no se puede", async () => {
  assert.equal((await post("/api/me/2fa/setup", { password: PW })).status, 401);
  const mal = await post("/api/me/2fa/setup", { password: "otra-clave-xx" }, estado.tokenA);
  assert.equal(mal.status, 403);
  assert.equal((await post("/api/me/2fa/setup", {}, estado.tokenA)).status, 403);
  const ok = await post("/api/me/2fa/setup", { password: PW }, estado.tokenA);
  assert.equal(ok.status, 200);
  assert.match(ok.data.secreto, /^[A-Z2-7]{32}$/);
  assert.match(ok.data.otpauth, /^otpauth:\/\/totp\/ElOtroFutbol:redac\?secret=/);
  estado.secreto = ok.data.secreto;
  const fila = sqlite.prepare("SELECT totp_secret, totp_activo FROM users WHERE id = ?").get(estado.id);
  assert.ok(fila.totp_secret.startsWith("v1:") && !fila.totp_secret.includes(estado.secreto), "el secreto se guarda cifrado");
  assert.equal(fila.totp_activo, 0, "hasta confirmar un código no queda activo");
  // mientras tanto el login sigue siendo solo con contraseña (no se queda fuera a medias)
  assert.ok((await login("redac", { ua: "Otro-Navegador" })).data.token);
});

test("activar: código incorrecto no activa; el correcto da 8 códigos y cierra las demás sesiones", async () => {
  // Una sesión ya abierta en otro dispositivo, que debe caer al activar. Se fabrica
  // "antigua" (sin iat): requireAuth admite durante 5 min un JWT recién emitido aunque
  // su sesión esté revocada (margen por el lag de réplica en Railway), y ese margen
  // no es lo que se prueba aquí.
  sqlite.prepare("INSERT INTO sessions (id, user_id, user_agent) VALUES (?, ?, ?)").run("sesion-movil", estado.id, "Movil-Safari");
  const otra = { data: { token: await jwtFalso({ uid: estado.id, username: "redac", nombre: "N", rol: "redactor", sid: "sesion-movil" }) } };
  assert.equal((await api("/api/me", { token: otra.data.token })).status, 200);

  const mal = await post("/api/me/2fa/activar", { codigo: "000000" }, estado.tokenA);
  assert.equal(mal.status, 400);
  assert.equal(sqlite.prepare("SELECT totp_activo FROM users WHERE id = ?").get(estado.id).totp_activo, 0);

  estado.paso = pasoActual();
  const ok = await post("/api/me/2fa/activar", { codigo: await totp(estado.secreto, estado.paso) }, estado.tokenA);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.codigos_recuperacion.length, 8);
  estado.recuperacion = ok.data.codigos_recuperacion;
  const fila = sqlite.prepare("SELECT totp_activo, totp_recovery FROM users WHERE id = ?").get(estado.id);
  assert.equal(fila.totp_activo, 1);
  assert.ok(!fila.totp_recovery.includes(estado.recuperacion[0]), "solo se guardan hashes");

  assert.equal((await api("/api/me", { token: estado.tokenA })).status, 200, "la sesión desde la que se activa sigue valiendo");
  assert.equal((await api("/api/me", { token: otra.data.token })).status, 401, "las demás sesiones se cierran");
  assert.deepEqual({ ...(await me2fa(estado.tokenA)).data }, { disponible: true, obligatorio: false, activo: true, codigos_restantes: 8 });
  assert.equal((await post("/api/me/2fa/setup", { password: PW }, estado.tokenA)).status, 400, "no se puede regenerar el secreto estando activo");
});

test("con 2FA activo el login ya no da sesión: pide código; el código usado no se reutiliza", async () => {
  const l = await login("redac");
  assert.equal(l.status, 200);
  assert.equal(l.data.token, undefined);
  assert.equal(l.data.requiere_2fa, true);
  assert.ok(l.data.desafio);
  assert.equal((await api("/api/me", { token: l.data.desafio })).status, 401, "el desafío no sirve de sesión");

  const repetido = await post("/api/login/2fa", { desafio: l.data.desafio, codigo: await totp(estado.secreto, estado.paso) });
  assert.equal(repetido.status, 401, "el código con el que se activó ya está gastado");
  assert.equal((await post("/api/login/2fa", { desafio: l.data.desafio, codigo: "000000" })).status, 401);
  const bien = await post("/api/login/2fa", { desafio: l.data.desafio, codigo: await totp(estado.secreto, estado.paso + 1) });
  assert.equal(bien.status, 200);
  assert.equal(bien.data.user.rol, "redactor");
  assert.equal((await api("/api/me", { token: bien.data.token })).status, 200);
  estado.tokenB = bien.data.token;
  assert.equal((await post("/api/login/2fa", { desafio: l.data.desafio, codigo: await totp(estado.secreto, estado.paso + 1) })).status, 401);
});

test("el desafío de un redactor no sirve para reconfigurar su 2FA desde el login", async () => {
  const l = await login("redac");
  for (const ruta of ["/api/login/2fa/setup", "/api/login/2fa/activar"]) {
    const r = await post(ruta, { desafio: l.data.desafio, codigo: "123456" });
    assert.equal(r.status, 401, ruta);
    assert.equal(r.data.caducado, true);
  }
  assert.ok(sqlite.prepare("SELECT totp_secret FROM users WHERE id = ?").get(estado.id).totp_secret, "su secreto sigue intacto");
});

test("código de recuperación: entra una vez y se gasta", async () => {
  const codigo = estado.recuperacion[0];
  const l = await login("redac");
  const ok = await post("/api/login/2fa", { desafio: l.data.desafio, codigo: codigo.toLowerCase() });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.codigos_recuperacion_restantes, 7);
  const l2 = await login("redac");
  assert.equal((await post("/api/login/2fa", { desafio: l2.data.desafio, codigo })).status, 401);
  assert.equal((await me2fa(estado.tokenB)).data.codigos_restantes, 7);
});

test("desactivar: exige contraseña Y un código válido; después vuelve a entrar solo con contraseña", async () => {
  // Simula que han pasado >30 s: el código del paso siguiente (gastado en un login anterior)
  // vuelve a ser el "próximo" aceptable. Sin esto no queda ningún código sin usar en la ventana.
  sqlite.prepare("UPDATE users SET totp_ultimo_paso = ? WHERE id = ?").run(estado.paso, estado.id);
  const sinPw = await post("/api/me/2fa/desactivar", { password: "mala-mala-1", codigo: await totp(estado.secreto, estado.paso + 1) }, estado.tokenB);
  assert.equal(sinPw.status, 403);
  const sinCodigo = await post("/api/me/2fa/desactivar", { password: PW, codigo: "000000" }, estado.tokenB);
  assert.equal(sinCodigo.status, 403);
  assert.equal((await post("/api/me/2fa/desactivar", { password: PW }, estado.tokenB)).status, 400);
  assert.equal(sqlite.prepare("SELECT totp_activo FROM users WHERE id = ?").get(estado.id).totp_activo, 1, "los intentos fallidos no lo desactivan");

  const ok = await post("/api/me/2fa/desactivar", { password: PW, codigo: await totp(estado.secreto, estado.paso + 1) }, estado.tokenB);
  assert.equal(ok.status, 200);
  const fila = sqlite.prepare("SELECT totp_activo, totp_secret, totp_recovery, totp_ultimo_paso FROM users WHERE id = ?").get(estado.id);
  assert.deepEqual({ ...fila }, { totp_activo: 0, totp_secret: null, totp_recovery: null, totp_ultimo_paso: null });
  const l = await login("redac");
  assert.ok(l.data.token);
  assert.equal(l.data.requiere_2fa, undefined);
  assert.equal((await post("/api/me/2fa/desactivar", { password: PW, codigo: "123456" }, l.data.token)).status, 400, "ya no está activo");
});

test("se puede volver a activar y desactivar con un código de recuperación", async () => {
  const t = (await login("redac")).data.token;
  const s = await post("/api/me/2fa/setup", { password: PW }, t);
  const a = await post("/api/me/2fa/activar", { codigo: await totp(s.data.secreto, pasoActual()) }, t);
  assert.equal(a.status, 200);
  estado.recuperacion2 = a.data.codigos_recuperacion;
  const ok = await post("/api/me/2fa/desactivar", { password: PW, codigo: estado.recuperacion2[3] }, t);
  assert.equal(ok.status, 200, "sin el móvil a mano, un código de recuperación basta para quitarlo");
  assert.equal(sqlite.prepare("SELECT totp_activo FROM users WHERE id = ?").get(estado.id).totp_activo, 0);
});

test("un admin puede restablecer el 2FA de un redactor que perdió móvil y códigos", async () => {
  const t = (await login("redac")).data.token;
  const s = await post("/api/me/2fa/setup", { password: PW }, t);
  assert.equal((await post("/api/me/2fa/activar", { codigo: await totp(s.data.secreto, pasoActual()) }, t)).status, 200);
  assert.equal((await login("redac")).data.requiere_2fa, true);

  const adminId = await crearUsuario("adminx", "admin");
  const tokenAdmin = await jwtFalso({ uid: adminId, username: "adminx", nombre: "A", rol: "admin", tfa: true });
  const r = await api(`/api/users/${estado.id}/reset-2fa`, { method: "PUT", token: tokenAdmin });
  assert.equal(r.status, 200);
  const l = await login("redac");
  assert.ok(l.data.token, "tras el restablecimiento entra solo con contraseña");
  assert.equal(l.data.requiere_2fa, undefined);
  assert.equal(sqlite.prepare("SELECT totp_activo FROM users WHERE id = ?").get(estado.id).totp_activo, 0);
});

test("admin: sigue siendo obligatorio y no puede quitarlo desde el panel", async () => {
  const adminId = sqlite.prepare("SELECT id FROM users WHERE username = 'adminx'").get().id;
  const tokenAdmin = await jwtFalso({ uid: adminId, username: "adminx", nombre: "A", rol: "admin", tfa: true });
  const e = await me2fa(tokenAdmin);
  assert.equal(e.data.obligatorio, true);
  for (const ruta of ["/api/me/2fa/setup", "/api/me/2fa/activar", "/api/me/2fa/desactivar"]) {
    assert.equal((await post(ruta, { password: PW, codigo: "123456" }, tokenAdmin)).status, 403, ruta);
  }
  const l = await login("adminx");
  assert.equal(l.data.token, undefined, "el admin sigue sin sesión solo con contraseña");
  assert.ok(l.data.requiere_configurar_2fa || l.data.requiere_2fa);
});

test("fotógrafo: igual que un redactor, 2FA opcional (activar, login con código, desactivar y reset por admin)", async () => {
  const fotoId = await crearUsuario("foto", "fotografo");
  const lf = await login("foto");
  assert.ok(lf.data.token && lf.data.requiere_2fa === undefined, "sin 2FA entra solo con contraseña");
  const t = lf.data.token;
  const e = await me2fa(t);
  assert.equal(e.data.disponible, true);
  assert.equal(e.data.obligatorio, false);
  assert.equal(e.data.activo, false);

  const s = await post("/api/me/2fa/setup", { password: PW }, t);
  assert.equal(s.status, 200);
  const a = await post("/api/me/2fa/activar", { codigo: await totp(s.data.secreto, pasoActual()) }, t);
  assert.equal(a.status, 200);
  assert.equal(a.data.codigos_recuperacion.length, 8);

  const l2 = await login("foto");
  assert.equal(l2.data.token, undefined, "con 2FA activo la contraseña sola no da sesión");
  assert.equal(l2.data.requiere_2fa, true);

  // Un admin le desactiva el 2FA (botón «2FA activo» de Usuarios) y vuelve a entrar con contraseña.
  const adminId = sqlite.prepare("SELECT id FROM users WHERE username = 'adminx'").get().id;
  const tokenAdmin = await jwtFalso({ uid: adminId, username: "adminx", nombre: "A", rol: "admin", tfa: true });
  const r = await api(`/api/users/${fotoId}/reset-2fa`, { method: "PUT", token: tokenAdmin });
  assert.equal(r.status, 200);
  const l3 = await login("foto");
  assert.ok(l3.data.token && l3.data.requiere_2fa === undefined);
  assert.equal(sqlite.prepare("SELECT totp_activo FROM users WHERE id = ?").get(fotoId).totp_activo, 0);

  // Y puede volver a activarlo y quitarlo por su cuenta (contraseña + código de recuperación).
  const t2 = l3.data.token;
  const s2 = await post("/api/me/2fa/setup", { password: PW }, t2);
  const a2 = await post("/api/me/2fa/activar", { codigo: await totp(s2.data.secreto, pasoActual()) }, t2);
  assert.equal(a2.status, 200);
  const l4 = await login("foto");
  assert.equal(l4.data.requiere_2fa, true);
  const paso = await post("/api/login/2fa", { desafio: l4.data.desafio, codigo: a2.data.codigos_recuperacion[0] });
  assert.ok(paso.data.token, "login con un código de recuperación");
  const q = await post("/api/me/2fa/desactivar", { password: PW, codigo: a2.data.codigos_recuperacion[1] }, paso.data.token);
  assert.equal(q.status, 200);
  assert.equal(sqlite.prepare("SELECT totp_activo FROM users WHERE id = ?").get(fotoId).totp_activo, 0);
});
